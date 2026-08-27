import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import type { UsageState } from "@densa/protocol";

import type {
  AgentAdapter,
  AgentDetection,
  AgentError,
  AgentEvent,
  AgentRunRequest,
  AgentStatus,
} from "./contracts.js";

const DEFAULT_CAPTURE_LIMIT = 64 * 1024;
const DEFAULT_EVENT_TEXT_LIMIT = 16 * 1024;
const DEFAULT_JSON_LINE_LIMIT = 1024 * 1024;
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_CANCELLATION_GRACE_MS = 2_000;
const OBSERVED_CODEX_VERSION = "0.147.0";

export interface CodexAdapterOptions {
  command?: string;
  captureLimitBytes?: number;
  eventTextLimitBytes?: number;
  jsonLineLimitBytes?: number;
  probeTimeoutMs?: number;
  cancellationGraceMs?: number;
  now?: () => string;
}

interface ProbeResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
  timedOut: boolean;
}

interface ActiveRun {
  child: ChildProcessWithoutNullStreams;
  cancelRequested: boolean;
  done: Promise<void>;
  resolveDone: () => void;
  killTimer?: NodeJS.Timeout;
}

interface TerminalSignal {
  kind: "completed" | "failed";
  message?: string;
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly readers: Array<(value: IteratorResult<T>) => void> = [];
  private ended = false;

  push(value: T): void {
    if (this.ended) return;
    const reader = this.readers.shift();
    if (reader === undefined) this.values.push(value);
    else reader({ value, done: false });
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const reader of this.readers.splice(0)) reader({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<T>>((resolve) => this.readers.push(resolve));
      },
    };
  }
}

class BoundedText {
  private value = "";
  private wasTruncated = false;

  constructor(private readonly limitBytes: number) {}

  append(value: string): void {
    const combined = `${this.value}${value}`;
    const result = truncateText(combined, this.limitBytes, true);
    this.value = result.text;
    this.wasTruncated ||= result.truncated;
  }

  snapshot(): { text: string; truncated: boolean } {
    return { text: this.value, truncated: this.wasTruncated };
  }
}

function truncateText(
  value: string,
  limitBytes: number,
  keepEnd = false,
): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value);
  if (bytes.length <= limitBytes) return { text: value, truncated: false };
  const sliced = keepEnd
    ? bytes.subarray(bytes.length - limitBytes)
    : bytes.subarray(0, limitBytes);
  return { text: sliced.toString("utf8"), truncated: true };
}

function redactSecrets(value: string): string {
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/giu, "$1[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED]")
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password)["']?\s*[:=]\s*["']?)[^"',\s}]+/giu,
      "$1[REDACTED]",
    );
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeVersion(stdout: string): string | undefined {
  const value = stdout.trim();
  if (value.length === 0) return undefined;
  return value.replace(/^codex-cli\s+/u, "");
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") throw error;
  }
}

/**
 * Version-scoped adapter for the supported `codex exec --json` process boundary.
 * Codex JSONL never crosses this class; callers only observe provider-neutral AgentEvents.
 */
export class CodexAdapter implements AgentAdapter {
  readonly adapterId = "codex";

  private readonly command: string;
  private readonly captureLimitBytes: number;
  private readonly eventTextLimitBytes: number;
  private readonly jsonLineLimitBytes: number;
  private readonly probeTimeoutMs: number;
  private readonly cancellationGraceMs: number;
  private readonly now: () => string;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly startingRunIds = new Set<string>();

  constructor(options: CodexAdapterOptions = {}) {
    this.command = options.command ?? "codex";
    this.captureLimitBytes = options.captureLimitBytes ?? DEFAULT_CAPTURE_LIMIT;
    this.eventTextLimitBytes = options.eventTextLimitBytes ?? DEFAULT_EVENT_TEXT_LIMIT;
    this.jsonLineLimitBytes = options.jsonLineLimitBytes ?? DEFAULT_JSON_LINE_LIMIT;
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.cancellationGraceMs = options.cancellationGraceMs ?? DEFAULT_CANCELLATION_GRACE_MS;
    this.now = options.now ?? (() => new Date().toISOString());

    for (const [name, value] of [
      ["captureLimitBytes", this.captureLimitBytes],
      ["eventTextLimitBytes", this.eventTextLimitBytes],
      ["jsonLineLimitBytes", this.jsonLineLimitBytes],
      ["probeTimeoutMs", this.probeTimeoutMs],
      ["cancellationGraceMs", this.cancellationGraceMs],
    ] as const) {
      if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be positive`);
    }
  }

  async detect(): Promise<AgentDetection> {
    const result = await this.runProbe(["--version"]);
    if (result.error?.code === "ENOENT") {
      return {
        status: "unavailable",
        adapterId: this.adapterId,
        reason: `Codex executable was not found: ${this.command}`,
      };
    }
    if (result.timedOut) {
      return {
        status: "unavailable",
        adapterId: this.adapterId,
        reason: "Codex version probe timed out",
      };
    }

    const version = normalizeVersion(result.stdout);
    if (result.exitCode !== 0 || version === undefined) {
      return {
        status: "unavailable",
        adapterId: this.adapterId,
        reason: "Codex version probe did not return a supported result",
      };
    }

    return { status: "available", adapterId: this.adapterId, command: this.command, version };
  }

  async getStatus(): Promise<AgentStatus> {
    const detection = await this.detect();
    if (detection.status === "unavailable") {
      return { status: "unavailable", reason: detection.reason };
    }
    if (detection.version !== OBSERVED_CODEX_VERSION) {
      return {
        status: "unknown",
        version: detection.version,
        reason: `Codex authentication signals are not verified for version ${detection.version}`,
      };
    }

    const result = await this.runProbe(["login", "status"]);
    if (result.exitCode === 0) return { status: "available", version: detection.version };
    if (result.exitCode === 1 && !result.timedOut && result.error === undefined) {
      return { status: "authentication-required", version: detection.version };
    }
    return {
      status: "unknown",
      version: detection.version,
      reason: result.timedOut
        ? "Codex authentication probe timed out"
        : "Codex authentication probe returned an unrecognized result",
    };
  }

  async *execute(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    if (request.runId.length === 0 || request.prompt.length === 0 || request.cwd.length === 0) {
      yield this.startedEvent(request.runId);
      yield this.failureEvent(request.runId, {
        code: "USER_CONFIGURATION_ERROR",
        message: "Agent runId, cwd, and prompt must be non-empty",
      });
      return;
    }
    try {
      if (!(await stat(request.cwd)).isDirectory()) throw new Error("not a directory");
    } catch {
      yield this.startedEvent(request.runId);
      yield this.failureEvent(request.runId, {
        code: "USER_CONFIGURATION_ERROR",
        message: `Agent working directory is not available: ${request.cwd}`,
      });
      return;
    }
    if (this.activeRuns.has(request.runId) || this.startingRunIds.has(request.runId)) {
      yield this.startedEvent(request.runId);
      yield this.failureEvent(request.runId, {
        code: "INTERNAL_INVARIANT_VIOLATION",
        message: `Agent run is already active: ${request.runId}`,
      });
      return;
    }
    this.startingRunIds.add(request.runId);

    const status = await this.getStatus();
    if (status.status === "unavailable") {
      this.startingRunIds.delete(request.runId);
      yield this.startedEvent(request.runId);
      yield this.failureEvent(request.runId, {
        code: "AGENT_UNAVAILABLE",
        message: status.reason,
      });
      return;
    }
    if (status.status === "authentication-required") {
      this.startingRunIds.delete(request.runId);
      yield this.startedEvent(request.runId);
      yield this.failureEvent(request.runId, {
        code: "AUTHENTICATION_REQUIRED",
        message: "Codex authentication is required",
      });
      return;
    }

    const queue = new AsyncEventQueue<AgentEvent>();
    const stderr = new BoundedText(this.captureLimitBytes);
    const finalMessage = new BoundedText(this.captureLimitBytes);
    let outputSchemaDirectory: string | undefined;
    let outputSchemaPath: string | undefined;
    if (request.outputSchema !== undefined) {
      try {
        outputSchemaDirectory = await mkdtemp(path.join(tmpdir(), "densa-agent-schema-"));
        outputSchemaPath = path.join(outputSchemaDirectory, "response.schema.json");
        await writeFile(outputSchemaPath, JSON.stringify(request.outputSchema), {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
      } catch {
        if (outputSchemaDirectory !== undefined) {
          await rm(outputSchemaDirectory, { recursive: true, force: true }).catch(() => undefined);
        }
        this.startingRunIds.delete(request.runId);
        yield this.startedEvent(request.runId);
        yield this.failureEvent(request.runId, {
          code: "PROCESS_FAILURE",
          message: "Agent response schema could not be prepared",
        });
        return;
      }
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.command, this.executionArguments(request.cwd, outputSchemaPath), {
        cwd: request.cwd,
        detached: process.platform !== "win32",
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      if (outputSchemaDirectory !== undefined) {
        await rm(outputSchemaDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
      this.startingRunIds.delete(request.runId);
      yield this.startedEvent(request.runId);
      yield this.failureEvent(request.runId, this.spawnError(error));
      return;
    }

    let resolveDone = (): void => undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const active: ActiveRun = { child, cancelRequested: false, done, resolveDone };
    this.activeRuns.set(request.runId, active);
    this.startingRunIds.delete(request.runId);

    let terminalSignal: TerminalSignal | undefined;
    let spawnError: NodeJS.ErrnoException | undefined;
    let malformedJson = false;
    let stdoutBuffer = "";
    let discardingOversizedLine = false;

    const emitMappedEvent = (value: unknown): void => {
      const mapped = this.mapCodexEvent(request.runId, value, finalMessage);
      if (mapped.event !== undefined) queue.push(mapped.event);
      if (mapped.terminal !== undefined) terminalSignal = mapped.terminal;
    };

    const processStdoutLine = (line: string): void => {
      if (line.trim().length === 0) return;
      if (Buffer.byteLength(line) > this.jsonLineLimitBytes) {
        malformedJson = true;
        queue.push(
          this.diagnosticEvent(
            request.runId,
            "adapter",
            "Codex emitted an oversized JSONL event",
            true,
          ),
        );
        return;
      }
      try {
        emitMappedEvent(JSON.parse(line) as unknown);
      } catch {
        malformedJson = true;
        queue.push(
          this.diagnosticEvent(request.runId, "adapter", "Codex emitted malformed JSONL", false),
        );
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let newline = stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (discardingOversizedLine) discardingOversizedLine = false;
        else processStdoutLine(line);
        newline = stdoutBuffer.indexOf("\n");
      }
      if (Buffer.byteLength(stdoutBuffer) > this.jsonLineLimitBytes) {
        stdoutBuffer = "";
        discardingOversizedLine = true;
        malformedJson = true;
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const redacted = redactSecrets(chunk);
      stderr.append(redacted);
      queue.push(this.diagnosticEvent(request.runId, "stderr", redacted, false));
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      spawnError = error;
    });

    child.once("close", (exitCode) => {
      if (stdoutBuffer.length > 0 && !discardingOversizedLine) processStdoutLine(stdoutBuffer);
      if (active.killTimer !== undefined) clearTimeout(active.killTimer);
      this.activeRuns.delete(request.runId);

      const terminal = this.terminalEvent({
        request,
        active,
        exitCode,
        terminalSignal,
        spawnError,
        malformedJson,
        stderr: stderr.snapshot(),
        finalMessage: finalMessage.snapshot(),
      });
      queue.push(terminal);
      queue.end();
      active.resolveDone();
    });

    child.stdin.on("error", () => undefined);
    child.stdin.end(request.prompt);
    queue.push(this.startedEvent(request.runId));

    try {
      for await (const event of queue) yield event;
    } finally {
      if (this.activeRuns.get(request.runId) === active) {
        this.requestCancellation(active);
        await active.done;
      }
      if (outputSchemaDirectory !== undefined) {
        await rm(outputSchemaDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  async cancel(runId: string): Promise<void> {
    const active = this.activeRuns.get(runId);
    if (active === undefined) return;
    this.requestCancellation(active);
    await active.done;
  }

  async getUsageState(): Promise<UsageState> {
    return {
      status: "unknown",
      reason: "Installed Codex CLI exposes no supported machine-readable usage/reset status",
    };
  }

  private executionArguments(cwd: string, outputSchemaPath?: string): string[] {
    const arguments_ = [
      "--ask-for-approval",
      "never",
      "--sandbox",
      "workspace-write",
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--ignore-rules",
      "--color",
      "never",
      "--cd",
      cwd,
    ];
    if (outputSchemaPath !== undefined) {
      arguments_.push("--output-schema", outputSchemaPath);
    }
    arguments_.push("-");
    return arguments_;
  }

  private requestCancellation(active: ActiveRun): void {
    if (active.cancelRequested) return;
    active.cancelRequested = true;
    signalProcessTree(active.child, "SIGINT");
    active.killTimer = setTimeout(() => {
      signalProcessTree(active.child, "SIGKILL");
    }, this.cancellationGraceMs);
    active.killTimer.unref();
  }

  private startedEvent(runId: string): AgentEvent {
    return { type: "run.started", runId, occurredAt: this.now() };
  }

  private failureEvent(runId: string, error: AgentError): AgentEvent {
    return {
      type: "run.terminal",
      runId,
      occurredAt: this.now(),
      outcome: "failed",
      error,
    };
  }

  private diagnosticEvent(
    runId: string,
    stream: "adapter" | "stderr",
    value: string,
    alreadyTruncated: boolean,
  ): AgentEvent {
    const result = truncateText(redactSecrets(value), this.eventTextLimitBytes);
    return {
      type: "diagnostic",
      runId,
      occurredAt: this.now(),
      stream,
      text: result.text,
      truncated: alreadyTruncated || result.truncated,
    };
  }

  private mapCodexEvent(
    runId: string,
    value: unknown,
    finalMessage: BoundedText,
  ): { event?: AgentEvent; terminal?: TerminalSignal } {
    const record = objectValue(value);
    const type = stringValue(record?.["type"]);
    if (record === undefined || type === undefined) return {};

    if (type === "turn.completed") return { terminal: { kind: "completed" } };
    if (type === "turn.failed") {
      const error = objectValue(record["error"]);
      const message = stringValue(error?.["message"]);
      return {
        terminal: message === undefined ? { kind: "failed" } : { kind: "failed", message },
      };
    }
    if (type === "error") {
      const message = stringValue(record["message"]);
      if (message === undefined) return {};
      return { event: this.diagnosticEvent(runId, "adapter", message, false) };
    }
    if (type === "turn.started" || type === "thread.started") {
      return {
        event: { type: "progress", runId, occurredAt: this.now(), stage: type },
      };
    }
    if (type !== "item.started" && type !== "item.completed") return {};

    const item = objectValue(record["item"]);
    const itemType = stringValue(item?.["type"]);
    if (item === undefined || itemType === undefined) return {};

    if (itemType === "agent_message") {
      const text = stringValue(item["text"]);
      if (text === undefined) return {};
      const redacted = redactSecrets(text);
      const result = truncateText(redacted, this.eventTextLimitBytes);
      finalMessage.append(redacted);
      return {
        event: {
          type: "message",
          runId,
          occurredAt: this.now(),
          text: result.text,
          truncated: result.truncated,
        },
      };
    }

    if (itemType === "command_execution") {
      const rawStatus = stringValue(item["status"]);
      const status =
        type === "item.started" ? "started" : rawStatus === "failed" ? "failed" : "completed";
      const command = stringValue(item["command"]);
      const output = stringValue(item["aggregated_output"]);
      const commandResult =
        command === undefined
          ? undefined
          : truncateText(redactSecrets(command), this.eventTextLimitBytes);
      const outputResult =
        output === undefined
          ? undefined
          : truncateText(redactSecrets(output), this.eventTextLimitBytes);
      const exitCode = numberValue(item["exit_code"]);
      return {
        event: {
          type: "tool",
          runId,
          occurredAt: this.now(),
          toolType: "command",
          status,
          ...(commandResult === undefined ? {} : { command: commandResult.text }),
          ...(outputResult === undefined ? {} : { output: outputResult.text }),
          ...(exitCode === undefined ? {} : { exitCode }),
          truncated: (commandResult?.truncated ?? false) || (outputResult?.truncated ?? false),
        },
      };
    }

    return {
      event: {
        type: "progress",
        runId,
        occurredAt: this.now(),
        stage: `${type}:${itemType}`,
      },
    };
  }

  private terminalEvent(input: {
    request: AgentRunRequest;
    active: ActiveRun;
    exitCode: number | null;
    terminalSignal: TerminalSignal | undefined;
    spawnError: NodeJS.ErrnoException | undefined;
    malformedJson: boolean;
    stderr: { text: string; truncated: boolean };
    finalMessage: { text: string; truncated: boolean };
  }): AgentEvent {
    const base = {
      type: "run.terminal" as const,
      runId: input.request.runId,
      occurredAt: this.now(),
      ...(input.exitCode === null ? {} : { exitCode: input.exitCode }),
    };
    if (input.active.cancelRequested) return { ...base, outcome: "cancelled" };
    if (input.spawnError !== undefined) {
      return { ...base, outcome: "failed", error: this.spawnError(input.spawnError) };
    }
    if (input.malformedJson || input.terminalSignal === undefined) {
      return {
        ...base,
        outcome: "failed",
        error: {
          code: "PROTOCOL_VERSION_MISMATCH",
          message: "Codex JSONL did not provide a valid terminal contract",
          ...(input.stderr.text.length === 0
            ? {}
            : { details: { stderr: input.stderr.text, truncated: input.stderr.truncated } }),
        },
      };
    }
    if (input.exitCode === 0 && input.terminalSignal.kind === "completed") {
      return {
        ...base,
        outcome: "succeeded",
        ...(input.finalMessage.text.length === 0 ? {} : { finalMessage: input.finalMessage.text }),
      };
    }

    const failureMessage = redactSecrets(input.terminalSignal.message ?? "Codex execution failed");
    return {
      ...base,
      outcome: "failed",
      error: {
        code: "PROCESS_FAILURE",
        message: failureMessage,
        details: {
          ...(input.exitCode === null ? {} : { exitCode: input.exitCode }),
          ...(input.stderr.text.length === 0
            ? {}
            : { stderr: input.stderr.text, truncated: input.stderr.truncated }),
        },
      },
    };
  }

  private spawnError(error: unknown): AgentError {
    const spawnError = error as NodeJS.ErrnoException;
    if (spawnError.code === "ENOENT") {
      return {
        code: "AGENT_UNAVAILABLE",
        message: `Codex executable was not found: ${this.command}`,
      };
    }
    return {
      code: "PROCESS_FAILURE",
      message: "Codex process could not be started",
      ...(spawnError.code === undefined ? {} : { details: { code: spawnError.code } }),
    };
  }

  private async runProbe(arguments_: string[]): Promise<ProbeResult> {
    return await new Promise<ProbeResult>((resolve) => {
      const stdout = new BoundedText(this.captureLimitBytes);
      const stderr = new BoundedText(this.captureLimitBytes);
      let error: NodeJS.ErrnoException | undefined;
      let timedOut = false;
      let settled = false;
      const child = spawn(this.command, arguments_, {
        detached: process.platform !== "win32",
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const timer = setTimeout(() => {
        timedOut = true;
        signalProcessTree(child, "SIGKILL");
      }, this.probeTimeoutMs);
      timer.unref();

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => stdout.append(redactSecrets(chunk)));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => stderr.append(redactSecrets(chunk)));
      child.once("error", (spawnError: NodeJS.ErrnoException) => {
        error = spawnError;
      });
      child.once("close", (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          exitCode,
          stdout: stdout.snapshot().text,
          stderr: stderr.snapshot().text,
          ...(error === undefined ? {} : { error }),
          timedOut,
        });
      });
    });
  }
}
