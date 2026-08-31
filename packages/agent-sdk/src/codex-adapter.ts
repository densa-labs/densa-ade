import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { StringDecoder } from "node:string_decoder";

import { usageStateSchema, type UsageState } from "@densa-ade/protocol";

import type {
  AgentAdapter,
  AgentDetection,
  AgentError,
  AgentEvent,
  AgentRunRequest,
  AgentStatus,
} from "./contracts.js";
import { redactAgentText, RedactedAgentTextStream } from "./redaction.js";

const DEFAULT_CAPTURE_LIMIT = 64 * 1024;
const DEFAULT_EVENT_TEXT_LIMIT = 16 * 1024;
const DEFAULT_JSON_LINE_LIMIT = 1024 * 1024;
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_CANCELLATION_GRACE_MS = 2_000;
const DEFAULT_EVENT_BUFFER_LIMIT = 512;
const OBSERVED_CODEX_VERSION = "0.147.0";
const SAFE_ENVIRONMENT_KEYS = [
  "CODEX_HOME",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "XDG_CONFIG_HOME",
] as const;

export interface CodexAdapterOptions {
  command?: string;
  captureLimitBytes?: number;
  eventTextLimitBytes?: number;
  jsonLineLimitBytes?: number;
  probeTimeoutMs?: number;
  cancellationGraceMs?: number;
  eventBufferLimit?: number;
  /** Parent environment source; only the adapter's explicit non-secret allowlist is inherited. */
  environment?: Readonly<NodeJS.ProcessEnv>;
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

interface StartingRun {
  controller: AbortController;
  done: Promise<void>;
  resolveDone: () => void;
}

interface TerminalSignal {
  kind: "completed" | "failed";
  message?: string;
  errorCode?: AgentError["code"];
  usageState?: Extract<UsageState, { status: "limited" }>;
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly readers: Array<(value: IteratorResult<T>) => void> = [];
  private ended = false;

  droppedValueCount = 0;

  constructor(private readonly bufferLimit: number) {}

  push(value: T): void {
    if (this.ended) return;
    const reader = this.readers.shift();
    if (reader === undefined) {
      if (this.values.length >= this.bufferLimit) {
        this.droppedValueCount += 1;
        return;
      }
      this.values.push(value);
    } else reader({ value, done: false });
  }

  reserveFinalSlots(count: number): void {
    while (this.values.length > this.bufferLimit - count) {
      this.values.pop();
      this.droppedValueCount += 1;
    }
  }

  pushFinal(value: T): void {
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

  replace(value: string): void {
    const result = truncateText(value, this.limitBytes);
    this.value = result.text;
    this.wasTruncated = result.truncated;
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
  let start = keepEnd ? bytes.length - limitBytes : 0;
  while (keepEnd && start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
  const sliced = bytes.subarray(start, keepEnd ? bytes.length : limitBytes);
  return { text: new StringDecoder("utf8").write(sliced), truncated: true };
}

function codexEnvironment(source: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: source["PATH"] ?? "/usr/bin:/bin",
  };
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function usageResetAt(value: unknown): string | undefined {
  const resetAtSeconds = numberValue(value);
  if (resetAtSeconds === undefined || !Number.isInteger(resetAtSeconds) || resetAtSeconds < 0) {
    return undefined;
  }
  try {
    const parsed = usageStateSchema.safeParse({
      status: "limited",
      resetAt: new Date(resetAtSeconds * 1_000).toISOString(),
    });
    return parsed.success && parsed.data.status === "limited" ? parsed.data.resetAt : undefined;
  } catch {
    return undefined;
  }
}

/** Exact machine-readable Codex signal mapping; presentation text is deliberately ignored. */
function usageStateFromCodexError(
  value: unknown,
): Extract<UsageState, { status: "limited" }> | undefined {
  const error = objectValue(value);
  if (stringValue(error?.["codex_error_info"]) !== "usage_limit_exceeded") return undefined;
  const resetAt = usageResetAt(error?.["reset_at"]);
  return resetAt === undefined ? { status: "limited" } : { status: "limited", resetAt };
}

function errorCodeFromCodexError(value: unknown): AgentError["code"] | undefined {
  const error = objectValue(value);
  const code = stringValue(error?.["codex_error_info"]);
  if (code === "usage_limit_exceeded") return "USAGE_LIMITED";
  if (code === "unauthorized") return "AUTHENTICATION_REQUIRED";
  return undefined;
}

function normalizeVersion(stdout: string): string | undefined {
  const value = stdout.trim();
  if (value.length === 0) return undefined;
  return value.replace(/^codex-cli\s+/u, "");
}

const terminatedProcessTrees = new WeakSet<ChildProcess>();

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || terminatedProcessTrees.has(child)) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") throw error;
  }
  // Exit, close, timeout, and cancellation share cleanup ownership. A second signal after
  // SIGKILL can hit a reaped/reused process group and must not target that identity again.
  if (signal === "SIGKILL") terminatedProcessTrees.add(child);
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
  private readonly eventBufferLimit: number;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly now: () => string;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly startingRuns = new Map<string, StartingRun>();
  private usageState: UsageState = Object.freeze({
    status: "unknown",
    reason: "No reliable Codex usage signal has been observed",
  });

  constructor(options: CodexAdapterOptions = {}) {
    this.command = options.command ?? "codex";
    this.captureLimitBytes = options.captureLimitBytes ?? DEFAULT_CAPTURE_LIMIT;
    this.eventTextLimitBytes = options.eventTextLimitBytes ?? DEFAULT_EVENT_TEXT_LIMIT;
    this.jsonLineLimitBytes = options.jsonLineLimitBytes ?? DEFAULT_JSON_LINE_LIMIT;
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.cancellationGraceMs = options.cancellationGraceMs ?? DEFAULT_CANCELLATION_GRACE_MS;
    this.eventBufferLimit = options.eventBufferLimit ?? DEFAULT_EVENT_BUFFER_LIMIT;
    this.environment = codexEnvironment(options.environment ?? process.env);
    this.now = options.now ?? (() => new Date().toISOString());

    for (const [name, value] of [
      ["captureLimitBytes", this.captureLimitBytes],
      ["eventTextLimitBytes", this.eventTextLimitBytes],
      ["jsonLineLimitBytes", this.jsonLineLimitBytes],
      ["probeTimeoutMs", this.probeTimeoutMs],
      ["cancellationGraceMs", this.cancellationGraceMs],
      ["eventBufferLimit", this.eventBufferLimit],
    ] as const) {
      if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be positive`);
    }
    if (this.eventBufferLimit < 3) throw new RangeError("eventBufferLimit must be at least 3");
  }

  async detect(signal?: AbortSignal): Promise<AgentDetection> {
    const result = await this.runProbe(["--version"], signal);
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

  async getStatus(signal?: AbortSignal): Promise<AgentStatus> {
    const detection = await this.detect(signal);
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

    const result = await this.runProbe(["login", "status"], signal);
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
    this.usageState = Object.freeze({
      status: "unknown",
      reason: "The current execution has not established usage availability",
    });
    if (request.runId.length === 0 || request.prompt.length === 0 || request.cwd.length === 0) {
      yield this.startedEvent(request.runId);
      yield this.failureEvent(request.runId, {
        code: "USER_CONFIGURATION_ERROR",
        message: "Agent runId, cwd, and prompt must be non-empty",
      });
      return;
    }
    if (this.activeRuns.has(request.runId) || this.startingRuns.has(request.runId)) {
      yield this.startedEvent(request.runId);
      yield this.failureEvent(request.runId, {
        code: "INTERNAL_INVARIANT_VIOLATION",
        message: `Agent run is already active: ${request.runId}`,
      });
      return;
    }
    let resolveStarting = (): void => undefined;
    const starting: StartingRun = {
      controller: new AbortController(),
      done: new Promise<void>((resolve) => {
        resolveStarting = resolve;
      }),
      resolveDone: () => resolveStarting(),
    };
    this.startingRuns.set(request.runId, starting);
    const finishStarting = (): void => {
      this.startingRuns.delete(request.runId);
      starting.resolveDone();
    };
    try {
      if (!(await stat(request.cwd)).isDirectory()) throw new Error("not a directory");
    } catch {
      finishStarting();
      yield this.startedEvent(request.runId);
      yield this.failureEvent(request.runId, {
        code: "USER_CONFIGURATION_ERROR",
        message: `Agent working directory is not available: ${request.cwd}`,
      });
      return;
    }
    let status: AgentStatus;
    try {
      status = await this.getStatus(starting.controller.signal);
    } catch (error) {
      finishStarting();
      yield this.startedEvent(request.runId);
      yield this.failureEvent(request.runId, this.spawnError(error));
      return;
    }
    if (starting.controller.signal.aborted) {
      finishStarting();
      yield this.startedEvent(request.runId);
      yield {
        type: "run.terminal",
        runId: request.runId,
        occurredAt: this.now(),
        outcome: "cancelled",
      };
      return;
    }
    if (status.status === "unavailable") {
      finishStarting();
      yield this.startedEvent(request.runId);
      yield this.failureEvent(request.runId, {
        code: "AGENT_UNAVAILABLE",
        message: status.reason,
      });
      return;
    }
    if (status.status === "authentication-required") {
      finishStarting();
      yield this.startedEvent(request.runId);
      yield this.failureEvent(request.runId, {
        code: "AUTHENTICATION_REQUIRED",
        message: "Codex authentication is required",
      });
      return;
    }
    if (status.status === "unknown") {
      finishStarting();
      yield this.startedEvent(request.runId);
      yield this.failureEvent(request.runId, {
        code: "PROTOCOL_VERSION_MISMATCH",
        message: status.reason,
      });
      return;
    }

    const queue = new AsyncEventQueue<AgentEvent>(this.eventBufferLimit);
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
        finishStarting();
        yield this.startedEvent(request.runId);
        yield this.failureEvent(request.runId, {
          code: "PROCESS_FAILURE",
          message: "Agent response schema could not be prepared",
        });
        return;
      }
    }
    if (starting.controller.signal.aborted) {
      if (outputSchemaDirectory !== undefined) {
        await rm(outputSchemaDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
      finishStarting();
      yield this.startedEvent(request.runId);
      yield {
        type: "run.terminal",
        runId: request.runId,
        occurredAt: this.now(),
        outcome: "cancelled",
      };
      return;
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        this.command,
        this.executionArguments(request.cwd, outputSchemaPath, request.accessMode),
        {
          cwd: request.cwd,
          detached: process.platform !== "win32",
          env: this.environment,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    } catch (error) {
      if (outputSchemaDirectory !== undefined) {
        await rm(outputSchemaDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
      finishStarting();
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
    finishStarting();

    let terminalSignal: TerminalSignal | undefined;
    let observedUsageState: Extract<UsageState, { status: "limited" }> | undefined;
    let observedErrorCode: AgentError["code"] | undefined;
    let spawnError: NodeJS.ErrnoException | undefined;
    let malformedJson = false;
    let stdoutBuffer = "";
    let discardingOversizedLine = false;

    const emitMappedEvent = (value: unknown): void => {
      const mapped = this.mapCodexEvent(request.runId, value, finalMessage);
      if (mapped.event !== undefined) queue.push(mapped.event);
      if (mapped.usageState !== undefined) observedUsageState = mapped.usageState;
      if (mapped.errorCode !== undefined) observedErrorCode = mapped.errorCode;
      if (mapped.terminal !== undefined) {
        if (terminalSignal !== undefined) malformedJson = true;
        else terminalSignal = mapped.terminal;
      }
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

    const stderrStream = new RedactedAgentTextStream(this.jsonLineLimitBytes, (text, truncated) => {
      stderr.append(text);
      queue.push(this.diagnosticEvent(request.runId, "stderr", text, truncated));
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => stderrStream.append(chunk));
    child.once("error", (error: NodeJS.ErrnoException) => {
      spawnError = error;
    });
    child.once("exit", () => signalProcessTree(child, "SIGKILL"));

    child.once("close", (exitCode) => {
      stderrStream.finish();
      if (stdoutBuffer.length > 0 && !discardingOversizedLine) processStdoutLine(stdoutBuffer);
      // A detached tool may close inherited stdio and outlive its parent. The process group is
      // still ours after parent close; finish its cleanup before publishing terminal evidence.
      signalProcessTree(child, "SIGKILL");
      if (active.killTimer !== undefined) clearTimeout(active.killTimer);
      this.activeRuns.delete(request.runId);

      const terminal = this.terminalEvent({
        request,
        active,
        exitCode,
        terminalSignal,
        observedUsageState,
        observedErrorCode,
        spawnError,
        malformedJson,
        stderr: stderr.snapshot(),
        finalMessage: finalMessage.snapshot(),
      });
      queue.reserveFinalSlots(queue.droppedValueCount > 0 ? 2 : 1);
      if (queue.droppedValueCount > 0) {
        queue.reserveFinalSlots(2);
        queue.pushFinal(
          this.diagnosticEvent(
            request.runId,
            "adapter",
            `Codex event buffer dropped ${String(queue.droppedValueCount)} events because the consumer was too slow`,
            true,
          ),
        );
      }
      queue.pushFinal(terminal);
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
    const starting = this.startingRuns.get(runId);
    if (starting !== undefined) {
      starting.controller.abort();
      await starting.done;
      return;
    }
    const active = this.activeRuns.get(runId);
    if (active === undefined) return;
    this.requestCancellation(active);
    await active.done;
  }

  async getUsageState(): Promise<UsageState> {
    return this.usageState;
  }

  private executionArguments(
    cwd: string,
    outputSchemaPath?: string,
    accessMode: "read-only" | "workspace-write" = "workspace-write",
  ): string[] {
    const arguments_ = [
      "--ask-for-approval",
      "never",
      "--sandbox",
      accessMode,
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
    const result = truncateText(redactAgentText(value), this.eventTextLimitBytes);
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
  ): {
    event?: AgentEvent;
    terminal?: TerminalSignal;
    usageState?: Extract<UsageState, { status: "limited" }>;
    errorCode?: AgentError["code"];
  } {
    const record = objectValue(value);
    const type = stringValue(record?.["type"]);
    if (record === undefined || type === undefined || type.length === 0) {
      throw new Error("Invalid Codex event envelope");
    }

    if (type === "turn.completed") return { terminal: { kind: "completed" } };
    if (type === "turn.failed") {
      const error = objectValue(record["error"]);
      const message = stringValue(error?.["message"]);
      const usageState = usageStateFromCodexError(error);
      const errorCode = errorCodeFromCodexError(error);
      return {
        terminal: {
          kind: "failed",
          ...(message === undefined ? {} : { message }),
          ...(errorCode === undefined ? {} : { errorCode }),
          ...(usageState === undefined ? {} : { usageState }),
        },
        ...(usageState === undefined ? {} : { usageState }),
        ...(errorCode === undefined ? {} : { errorCode }),
      };
    }
    if (type === "error") {
      const message = stringValue(record["message"]);
      if (message === undefined) return {};
      const usageState = usageStateFromCodexError(record);
      const errorCode = errorCodeFromCodexError(record);
      return {
        event: this.diagnosticEvent(runId, "adapter", message, false),
        ...(usageState === undefined ? {} : { usageState }),
        ...(errorCode === undefined ? {} : { errorCode }),
      };
    }
    if (type === "turn.started" || type === "thread.started") {
      return {
        event: { type: "progress", runId, occurredAt: this.now(), stage: type },
      };
    }
    if (type !== "item.started" && type !== "item.completed") return {};

    const item = objectValue(record["item"]);
    const itemType = stringValue(item?.["type"]);
    if (item === undefined || itemType === undefined || itemType.length === 0) {
      throw new Error("Invalid Codex item envelope");
    }

    if (itemType === "agent_message") {
      const text = stringValue(item["text"]);
      if (text === undefined) throw new Error("Invalid Codex message payload");
      const redacted = redactAgentText(text);
      const result = truncateText(redacted, this.eventTextLimitBytes);
      if (type === "item.completed") finalMessage.replace(redacted);
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
          : truncateText(redactAgentText(command), this.eventTextLimitBytes);
      const outputResult =
        output === undefined
          ? undefined
          : truncateText(redactAgentText(output), this.eventTextLimitBytes);
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
        stage: truncateText(redactAgentText(`${type}:${itemType}`), this.eventTextLimitBytes).text,
      },
    };
  }

  private terminalEvent(input: {
    request: AgentRunRequest;
    active: ActiveRun;
    exitCode: number | null;
    terminalSignal: TerminalSignal | undefined;
    observedUsageState: Extract<UsageState, { status: "limited" }> | undefined;
    observedErrorCode: AgentError["code"] | undefined;
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
      this.usageState = Object.freeze({ status: "available" });
      return {
        ...base,
        outcome: "succeeded",
        ...(input.finalMessage.text.length === 0 ? {} : { finalMessage: input.finalMessage.text }),
      };
    }

    const limited = input.terminalSignal.usageState ?? input.observedUsageState;
    if (limited !== undefined) {
      this.usageState = Object.freeze(limited);
      return {
        ...base,
        outcome: "failed",
        error: {
          code: "USAGE_LIMITED",
          message: "Codex reported that usage is limited",
          details: {
            usageState:
              limited.resetAt === undefined
                ? { status: "limited" }
                : { status: "limited", resetAt: limited.resetAt },
          },
        },
      };
    }

    const structuredErrorCode = input.terminalSignal.errorCode ?? input.observedErrorCode;
    if (structuredErrorCode === "AUTHENTICATION_REQUIRED") {
      this.usageState = Object.freeze({
        status: "unknown",
        reason: "Codex authentication is required",
      });
      return {
        ...base,
        outcome: "failed",
        error: {
          code: "AUTHENTICATION_REQUIRED",
          message: "Codex authentication is required",
        },
      };
    }

    this.usageState = Object.freeze({
      status: "unknown",
      reason: "Codex execution failed without a reliable usage classification",
    });

    const failureMessage = truncateText(
      redactAgentText(input.terminalSignal.message ?? "Codex execution failed"),
      this.eventTextLimitBytes,
    ).text;
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

  private async runProbe(arguments_: string[], signal?: AbortSignal): Promise<ProbeResult> {
    if (signal?.aborted === true) {
      return { exitCode: null, stdout: "", stderr: "", timedOut: false };
    }
    return await new Promise<ProbeResult>((resolve) => {
      const stdout = new BoundedText(this.captureLimitBytes);
      const stderr = new BoundedText(this.captureLimitBytes);
      let error: NodeJS.ErrnoException | undefined;
      let timedOut = false;
      let settled = false;
      const child = spawn(this.command, arguments_, {
        detached: process.platform !== "win32",
        env: this.environment,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const timer = setTimeout(() => {
        timedOut = true;
        signalProcessTree(child, "SIGKILL");
      }, this.probeTimeoutMs);
      timer.unref();
      const cancel = (): void => signalProcessTree(child, "SIGKILL");
      signal?.addEventListener("abort", cancel, { once: true });

      const stdoutStream = new RedactedAgentTextStream(this.captureLimitBytes, (text) =>
        stdout.append(text),
      );
      const stderrStream = new RedactedAgentTextStream(this.captureLimitBytes, (text) =>
        stderr.append(text),
      );
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => stdoutStream.append(chunk));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => stderrStream.append(chunk));
      child.once("error", (spawnError: NodeJS.ErrnoException) => {
        error = spawnError;
      });
      child.once("exit", () => signalProcessTree(child, "SIGKILL"));
      child.once("close", (exitCode) => {
        if (settled) return;
        settled = true;
        stdoutStream.finish();
        stderrStream.finish();
        signal?.removeEventListener("abort", cancel);
        signalProcessTree(child, "SIGKILL");
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
