import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fileConstants, createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readlink, writeFile } from "node:fs/promises";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { isTerminalAgentEvent, type AgentAdapter, type AgentEvent } from "@densa/agent-sdk";

const DIAGNOSTIC_SCHEMA_VERSION = 1;
const COMMAND_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 15_000;
const DEFAULT_AGENT_TIMEOUT_MS = 90_000;
const DEFAULT_CANCELLATION_TIMEOUT_MS = 5_000;
const DEFAULT_RETAINED_AGENT_EVENT_LIMIT = 2_048;
const DEFAULT_RETAINED_AGENT_EVENT_BYTES = 2 * 1024 * 1024;
const INDIVIDUAL_AGENT_EVENT_LIMIT_BYTES = 64 * 1024;
const WORKSPACE_SCAN_ENTRY_LIMIT = 10_000;
const WORKSPACE_SCAN_BYTE_LIMIT = 256 * 1024 * 1024;
const COMMAND_ENV = {
  PATH: process.env["PATH"] ?? "/usr/bin:/bin",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

export interface ValidationCommand {
  command: string;
  args: string[];
}

export interface TaskAcceptanceCriterion {
  id: string;
  description: string;
  validation: ValidationCommand;
}

export interface TaskPacket {
  taskId: string;
  title: string;
  instructions: string;
  editablePaths: string[];
  acceptanceCriteria: TaskAcceptanceCriterion[];
}

export interface WorkspaceFile {
  path: string;
  kind: "file" | "symlink";
  sha256: string;
}

export interface WorkspaceChanges {
  added: string[];
  modified: string[];
  deleted: string[];
  outOfScope: string[];
  unsafeSymlinks: string[];
  head: string;
  gitStatus: string;
  gitDiff: string;
  gitHeadCommand: CommandDiagnostic;
  gitStatusCommand: CommandDiagnostic;
  gitDiffCommand: CommandDiagnostic;
  before: WorkspaceFile[];
  after: WorkspaceFile[];
  workspaceObservationError?: string;
}

export interface CommandDiagnostic {
  command: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  error?: { code?: string; message: string };
}

export interface AcceptanceResult {
  criterion: TaskAcceptanceCriterion;
  passed: boolean;
  command: CommandDiagnostic;
}

export interface TaskProofResult {
  verdict: "PASS" | "FAIL";
  failureReasons: string[];
  temporaryRoot: string;
  workspacePath: string;
  diagnosticsPath: string;
  diagnosticsRoot: string;
  taskPacket: TaskPacket;
  prompt: string;
  checkpoint: {
    head: string;
    gitStatus: string;
    files: WorkspaceFile[];
  };
  agentEvents: AgentEvent[];
  agentEventsTruncated: boolean;
  droppedAgentEventCount: number;
  workerTerminationConfirmed: boolean;
  changes: WorkspaceChanges;
  acceptanceResults: AcceptanceResult[];
}

export interface TemporaryTaskProofOptions {
  adapter: AgentAdapter;
  runId?: string;
  temporaryBaseDirectory?: string;
  agentTimeoutMs?: number;
  cancellationTimeoutMs?: number;
  retainedAgentEventLimit?: number;
  retainedAgentEventBytes?: number;
}

interface CapturedText {
  value: string;
  truncated: boolean;
}

class OutputCapture {
  private readonly chunks: Buffer[] = [];
  private byteLength = 0;
  private wasTruncated = false;

  append(chunk: Buffer): void {
    if (this.byteLength >= COMMAND_OUTPUT_LIMIT_BYTES) {
      this.wasTruncated = true;
      return;
    }
    const remaining = COMMAND_OUTPUT_LIMIT_BYTES - this.byteLength;
    const retained = chunk.subarray(0, remaining);
    this.chunks.push(retained);
    this.byteLength += retained.byteLength;
    if (retained.byteLength < chunk.byteLength) this.wasTruncated = true;
  }

  value(): CapturedText {
    return {
      value: redactSecrets(Buffer.concat(this.chunks).toString("utf8")),
      truncated: this.wasTruncated,
    };
  }
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

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactValue(entry)]));
}

function truncateText(value: string, limitBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value);
  if (bytes.length <= limitBytes) return { text: value, truncated: false };
  return { text: bytes.subarray(0, limitBytes).toString("utf8"), truncated: true };
}

interface BoundedAgentEvent {
  event: AgentEvent;
  truncated: boolean;
}

function boundedAgentEvent(event: AgentEvent): BoundedAgentEvent {
  const redacted = redactValue(event) as AgentEvent;
  if (Buffer.byteLength(JSON.stringify(redacted)) <= INDIVIDUAL_AGENT_EVENT_LIMIT_BYTES) {
    return { event: redacted, truncated: false };
  }
  if (redacted.type === "run.terminal") {
    const finalMessage =
      redacted.finalMessage === undefined
        ? undefined
        : truncateText(redacted.finalMessage, 16 * 1024).text;
    const error =
      redacted.error === undefined
        ? undefined
        : {
            code: redacted.error.code,
            message: truncateText(redacted.error.message, 16 * 1024).text,
          };
    return {
      event: {
        type: "run.terminal",
        runId: redacted.runId,
        occurredAt: redacted.occurredAt,
        outcome: redacted.outcome,
        ...(redacted.exitCode === undefined ? {} : { exitCode: redacted.exitCode }),
        ...(finalMessage === undefined ? {} : { finalMessage }),
        ...(error === undefined ? {} : { error }),
      },
      truncated: true,
    };
  }
  return {
    event: {
      type: "diagnostic",
      runId: redacted.runId,
      occurredAt: redacted.occurredAt,
      stream: "adapter",
      text: `Oversized ${redacted.type} event omitted from retained diagnostics`,
      truncated: true,
    },
    truncated: true,
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  return value;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

interface WorkspaceScanState {
  entries: number;
  bytes: number;
}

async function workspaceFiles(
  root: string,
  relativeDirectory = "",
  state: WorkspaceScanState = { entries: 0, bytes: 0 },
): Promise<WorkspaceFile[]> {
  const directory = path.join(root, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const files: WorkspaceFile[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (relativeDirectory.length === 0 && entry.name === ".git") continue;
    state.entries += 1;
    if (state.entries > WORKSPACE_SCAN_ENTRY_LIMIT) {
      throw new Error(`Workspace scan exceeded ${WORKSPACE_SCAN_ENTRY_LIMIT} entries`);
    }
    const relativePath = path.posix.join(
      relativeDirectory.split(path.sep).join(path.posix.sep),
      entry.name,
    );
    const absolutePath = path.join(root, relativePath);
    if (entry.isDirectory()) {
      files.push(...(await workspaceFiles(root, relativePath, state)));
      continue;
    }
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) {
      files.push({
        path: relativePath,
        kind: "symlink",
        sha256: sha256(await readlink(absolutePath)),
      });
    } else if (metadata.isFile()) {
      state.bytes += metadata.size;
      if (state.bytes > WORKSPACE_SCAN_BYTE_LIMIT) {
        throw new Error(`Workspace scan exceeded ${WORKSPACE_SCAN_BYTE_LIMIT} bytes`);
      }
      files.push({
        path: relativePath,
        kind: "file",
        sha256: await sha256File(absolutePath),
      });
    }
  }

  return files;
}

function changedFiles(
  before: WorkspaceFile[],
  after: WorkspaceFile[],
): Pick<WorkspaceChanges, "added" | "modified" | "deleted"> {
  const beforeMap = new Map(before.map((file) => [file.path, `${file.kind}:${file.sha256}`]));
  const afterMap = new Map(after.map((file) => [file.path, `${file.kind}:${file.sha256}`]));
  return {
    added: [...afterMap.keys()].filter((file) => !beforeMap.has(file)).sort(),
    modified: [...afterMap.keys()]
      .filter((file) => beforeMap.has(file) && beforeMap.get(file) !== afterMap.get(file))
      .sort(),
    deleted: [...beforeMap.keys()].filter((file) => !afterMap.has(file)).sort(),
  };
}

interface AgentCollection {
  events: AgentEvent[];
  terminal?: Extract<AgentEvent, { type: "run.terminal" }>;
  droppedEventCount: number;
  individualEventTruncated: boolean;
  timedOut: boolean;
  workerTerminationConfirmed: boolean;
  failure?: string;
}

type SettledWithin<T> =
  | { settled: true; status: "fulfilled"; value: T }
  | { settled: true; status: "rejected"; reason: unknown }
  | { settled: false };

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<SettledWithin<T>> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeout = new Promise<SettledWithin<T>>((resolve) => {
    timeoutHandle = setTimeout(() => resolve({ settled: false }), timeoutMs);
  });
  const settlement: Promise<SettledWithin<T>> = promise.then(
    (value): SettledWithin<T> => ({ settled: true, status: "fulfilled", value }),
    (reason: unknown): SettledWithin<T> => ({ settled: true, status: "rejected", reason }),
  );
  const result = await Promise.race([settlement, timeout]);
  if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  return result;
}

interface CancellationConfirmation {
  confirmed: boolean;
  failure?: string;
}

async function requestCancellation(
  adapter: AgentAdapter,
  runId: string,
  timeoutMs: number,
): Promise<CancellationConfirmation> {
  const cancellation = await settleWithin(
    Promise.resolve().then(async () => await adapter.cancel(runId)),
    timeoutMs,
  );
  if (!cancellation.settled) {
    return {
      confirmed: false,
      failure: "Agent cancellation did not settle before the cancellation deadline",
    };
  }
  if (cancellation.status === "rejected") {
    return {
      confirmed: false,
      failure: `Agent cancellation failed: ${redactSecrets(
        cancellation.reason instanceof Error
          ? cancellation.reason.message
          : String(cancellation.reason),
      )}`,
    };
  }
  return { confirmed: true };
}

async function collectAgentEvents(input: {
  adapter: AgentAdapter;
  runId: string;
  cwd: string;
  prompt: string;
  timeoutMs: number;
  cancellationTimeoutMs: number;
  retainedEventLimit: number;
  retainedEventBytes: number;
}): Promise<AgentCollection> {
  const iterable = input.adapter.execute({
    runId: input.runId,
    cwd: input.cwd,
    prompt: input.prompt,
  });
  const iterator = iterable[Symbol.asyncIterator]();
  const events: AgentEvent[] = [];
  let retainedBytes = 0;
  let droppedEventCount = 0;
  let individualEventTruncated = false;
  let terminal: AgentCollection["terminal"];
  let timedOut = false;
  let workerTerminationConfirmed = false;
  let failure: string | undefined;
  let timeoutHandle: NodeJS.Timeout | undefined;
  const deadline = Date.now() + input.timeoutMs;
  const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
    timeoutHandle = setTimeout(() => resolve({ kind: "timeout" }), input.timeoutMs);
  });

  const retain = (rawEvent: AgentEvent): void => {
    const bounded = boundedAgentEvent(rawEvent);
    const event = bounded.event;
    if (bounded.truncated) individualEventTruncated = true;
    if (isTerminalAgentEvent(event)) terminal = event;
    const eventBytes = Buffer.byteLength(JSON.stringify(event));
    const mustRetain = isTerminalAgentEvent(event);
    if (
      !mustRetain &&
      (events.length >= input.retainedEventLimit ||
        retainedBytes + eventBytes > input.retainedEventBytes)
    ) {
      droppedEventCount += 1;
      return;
    }
    if (mustRetain) {
      while (
        events.length > 0 &&
        (events.length >= input.retainedEventLimit ||
          retainedBytes + eventBytes > input.retainedEventBytes)
      ) {
        const removed = events.pop();
        if (removed !== undefined) retainedBytes -= Buffer.byteLength(JSON.stringify(removed));
        droppedEventCount += 1;
      }
    }
    events.push(event);
    retainedBytes += eventBytes;
  };

  const recordFailure = (message: string): void => {
    const redacted = redactSecrets(message);
    failure = failure === undefined ? redacted : `${failure}; ${redacted}`;
  };

  const cancelAndConfirmTermination = async (
    pendingNext?: Promise<IteratorResult<AgentEvent>>,
  ): Promise<void> => {
    const cancellation = await requestCancellation(
      input.adapter,
      input.runId,
      input.cancellationTimeoutMs,
    );
    if (cancellation.failure !== undefined) recordFailure(cancellation.failure);

    let pendingNextCompleted = false;
    if (pendingNext !== undefined) {
      const next = await settleWithin(pendingNext, input.cancellationTimeoutMs);
      if (next.settled && next.status === "fulfilled") {
        if (next.value.done) pendingNextCompleted = true;
        else retain(next.value.value);
      }
    }

    const returned =
      pendingNextCompleted || iterator.return === undefined
        ? ({ settled: false } as const)
        : await settleWithin(
            Promise.resolve().then(async () => await iterator.return?.()),
            input.cancellationTimeoutMs,
          );
    const iteratorCloseConfirmed =
      returned.settled && returned.status === "fulfilled" && returned.value?.done === true;
    workerTerminationConfirmed =
      cancellation.confirmed && (pendingNextCompleted || iteratorCloseConfirmed);
    if (!workerTerminationConfirmed && cancellation.failure === undefined) {
      recordFailure("Agent termination could not be confirmed after cancellation");
    }
  };

  try {
    for (;;) {
      if (Date.now() >= deadline) {
        timedOut = true;
        await cancelAndConfirmTermination();
        break;
      }
      const nextPromise = iterator.next();
      const next = await Promise.race([
        nextPromise.then((value) => ({ kind: "next" as const, value })),
        timeout,
      ]);
      if (next.kind === "timeout") {
        timedOut = true;
        await cancelAndConfirmTermination(nextPromise);
        break;
      }
      if (next.value.done) {
        workerTerminationConfirmed = true;
        break;
      }
      retain(next.value.value);
    }
  } catch (error) {
    recordFailure(error instanceof Error ? error.message : String(error));
    await cancelAndConfirmTermination();
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }

  return {
    events,
    ...(terminal === undefined ? {} : { terminal }),
    droppedEventCount,
    individualEventTruncated,
    timedOut,
    workerTerminationConfirmed,
    ...(failure === undefined ? {} : { failure }),
  };
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<CommandDiagnostic> {
  const stdout = new OutputCapture();
  const stderr = new OutputCapture();

  return await new Promise<CommandDiagnostic>((resolve) => {
    let timedOut = false;
    let spawnError: NodeJS.ErrnoException | undefined;
    const child = spawn(command, args, {
      cwd,
      env: COMMAND_ENV,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref();

    child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));
    child.once("error", (error: NodeJS.ErrnoException) => {
      spawnError = error;
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      const capturedStdout = stdout.value();
      const capturedStderr = stderr.value();
      resolve({
        command,
        args,
        exitCode,
        signal,
        stdout: capturedStdout.value,
        stderr: capturedStderr.value,
        stdoutTruncated: capturedStdout.truncated,
        stderrTruncated: capturedStderr.truncated,
        timedOut,
        ...(spawnError === undefined
          ? {}
          : {
              error: {
                ...(spawnError.code === undefined ? {} : { code: spawnError.code }),
                message: spawnError.message,
              },
            }),
      });
    });
  });
}

function skippedCommandDiagnostic(
  command: string,
  args: string[],
  reason: string,
): CommandDiagnostic {
  return {
    command,
    args,
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    error: { code: "AGENT_TERMINATION_UNCONFIRMED", message: reason },
  };
}

async function requireSuccessfulCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<CommandDiagnostic> {
  const result = await runCommand(command, args, cwd);
  if (result.exitCode !== 0) {
    throw new Error(`Fixture command failed: ${command} ${args.join(" ")}\n${result.stderr}`);
  }
  return result;
}

function buildDefaultTaskPacket(): TaskPacket {
  return {
    taskId: "PROOF-001",
    title: "Implement integer addition",
    instructions:
      "Implement the exported sum(a, b) function in src/sum.js so it returns the sum of two integers.",
    editablePaths: ["src/sum.js"],
    acceptanceCriteria: [
      {
        id: "PROOF-001-AC1",
        description:
          "The fixture test suite accepts positive, negative, and zero-valued integer addition.",
        validation: { command: process.execPath, args: ["test.mjs"] },
      },
    ],
  };
}

export function buildTaskPacketPrompt(packet: TaskPacket): string {
  const criteria = packet.acceptanceCriteria
    .map(
      (criterion) =>
        `- ${criterion.id}: ${criterion.description}\n  Validate with: ${criterion.validation.command} ${criterion.validation.args.join(" ")}`,
    )
    .join("\n");
  return [
    `Task ${packet.taskId}: ${packet.title}`,
    "",
    packet.instructions,
    "",
    `You may edit only: ${packet.editablePaths.join(", ")}`,
    "Do not change test files or acceptance criteria. Do not commit the changes.",
    "",
    "Acceptance criteria:",
    criteria,
  ].join("\n");
}

async function createFixture(temporaryBaseDirectory?: string): Promise<{
  temporaryRoot: string;
  workspacePath: string;
  taskPacket: TaskPacket;
}> {
  const baseDirectory = temporaryBaseDirectory ?? tmpdir();
  await mkdir(baseDirectory, { recursive: true });
  const temporaryRoot = await mkdtemp(path.join(baseDirectory, "densa-task-proof-"));
  const workspacePath = path.join(temporaryRoot, "workspace");
  await mkdir(path.join(workspacePath, "src"), { recursive: true });

  await writeFile(
    path.join(workspacePath, "package.json"),
    `${JSON.stringify(
      {
        name: "densa-task-proof-fixture",
        private: true,
        type: "module",
        scripts: { test: "node test.mjs" },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    path.join(workspacePath, "src", "sum.js"),
    'export function sum(_a, _b) {\n  throw new Error("PROOF-001 is not implemented");\n}\n',
    "utf8",
  );
  await writeFile(
    path.join(workspacePath, "test.mjs"),
    'import assert from "node:assert/strict";\nimport { sum } from "./src/sum.js";\n\nassert.equal(sum(2, 3), 5);\nassert.equal(sum(-4, 7), 3);\nassert.equal(sum(0, 0), 0);\n',
    "utf8",
  );

  await requireSuccessfulCommand(
    "git",
    ["init", "--quiet", "--initial-branch=main"],
    workspacePath,
  );
  await requireSuccessfulCommand("git", ["add", "--all"], workspacePath);
  await requireSuccessfulCommand(
    "git",
    [
      "-c",
      "user.name=Densa Fixture",
      "-c",
      "user.email=densa-fixture@localhost",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "fixture: establish PROOF-001 checkpoint",
    ],
    workspacePath,
  );

  return {
    temporaryRoot,
    workspacePath,
    taskPacket: buildDefaultTaskPacket(),
  };
}

async function createDiagnosticDestination(): Promise<{
  diagnosticsRoot: string;
  diagnosticsPath: string;
}> {
  const diagnosticsRoot = await mkdtemp(path.join(tmpdir(), "densa-task-proof-diagnostics-"));
  return { diagnosticsRoot, diagnosticsPath: path.join(diagnosticsRoot, "attempt.json") };
}

async function writeDiagnosticExclusive(diagnosticsPath: string, value: unknown): Promise<void> {
  const handle = await open(
    diagnosticsPath,
    fileConstants.O_WRONLY |
      fileConstants.O_CREAT |
      fileConstants.O_EXCL |
      fileConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("Attempt diagnostic target is not a regular file");
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(redactValue(value), null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Non-persistent P1M2 proof loop. The returned workspace and bounded-diagnostics directories are
 * intentionally retained for inspection. Callers own eventual cleanup, but must quarantine an
 * unconfirmed worker instead of inspecting or removing its workspace.
 */
export async function runTemporaryRepoTaskProof(
  options: TemporaryTaskProofOptions,
): Promise<TaskProofResult> {
  const agentTimeoutMs = positiveInteger(
    options.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
    "agentTimeoutMs",
  );
  const cancellationTimeoutMs = positiveInteger(
    options.cancellationTimeoutMs ?? DEFAULT_CANCELLATION_TIMEOUT_MS,
    "cancellationTimeoutMs",
  );
  const retainedEventLimit = positiveInteger(
    options.retainedAgentEventLimit ?? DEFAULT_RETAINED_AGENT_EVENT_LIMIT,
    "retainedAgentEventLimit",
  );
  const retainedEventBytes = positiveInteger(
    options.retainedAgentEventBytes ?? DEFAULT_RETAINED_AGENT_EVENT_BYTES,
    "retainedAgentEventBytes",
  );
  const fixture = await createFixture(options.temporaryBaseDirectory);
  const checkpointFiles = await workspaceFiles(fixture.workspacePath);
  const checkpointStatus = await requireSuccessfulCommand(
    "git",
    ["status", "--porcelain=v1"],
    fixture.workspacePath,
  );
  const checkpointHead = await requireSuccessfulCommand(
    "git",
    ["rev-parse", "HEAD"],
    fixture.workspacePath,
  );
  const checkpoint = {
    head: checkpointHead.stdout.trim(),
    gitStatus: checkpointStatus.stdout,
    files: checkpointFiles,
  };
  if (checkpoint.gitStatus.length !== 0) {
    throw new Error("Fixture checkpoint is unexpectedly dirty");
  }

  const prompt = buildTaskPacketPrompt(fixture.taskPacket);
  const runId = options.runId ?? `proof-${Date.now().toString(36)}`;
  let agent: AgentCollection;
  try {
    agent = await collectAgentEvents({
      adapter: options.adapter,
      runId,
      cwd: fixture.workspacePath,
      prompt,
      timeoutMs: agentTimeoutMs,
      cancellationTimeoutMs,
      retainedEventLimit,
      retainedEventBytes,
    });
  } catch (error) {
    const cancellation = await requestCancellation(options.adapter, runId, cancellationTimeoutMs);
    const executionFailure = redactSecrets(error instanceof Error ? error.message : String(error));
    agent = {
      events: [],
      droppedEventCount: 0,
      individualEventTruncated: false,
      timedOut: false,
      workerTerminationConfirmed: false,
      failure:
        cancellation.failure === undefined
          ? `${executionFailure}; Agent iterator setup failed, so termination could not be confirmed`
          : `${executionFailure}; ${cancellation.failure}`,
    };
  }
  const diagnosticDestination = await createDiagnosticDestination();

  let workspaceObservationError: string | undefined;
  let changes: WorkspaceChanges;
  let acceptanceResults: AcceptanceResult[];
  if (!agent.workerTerminationConfirmed) {
    const skippedObservationReason =
      "Workspace observation skipped because agent termination was not confirmed";
    workspaceObservationError = skippedObservationReason;
    const gitStatus = skippedCommandDiagnostic(
      "git",
      ["status", "--porcelain=v1"],
      skippedObservationReason,
    );
    const gitHead = skippedCommandDiagnostic(
      "git",
      ["rev-parse", "HEAD"],
      skippedObservationReason,
    );
    const gitDiff = skippedCommandDiagnostic(
      "git",
      ["diff", "--no-ext-diff", "--binary", checkpoint.head, "--"],
      skippedObservationReason,
    );
    changes = {
      added: [],
      modified: [],
      deleted: [],
      outOfScope: [],
      unsafeSymlinks: [],
      head: checkpoint.head,
      gitStatus: "",
      gitDiff: "",
      gitHeadCommand: gitHead,
      gitStatusCommand: gitStatus,
      gitDiffCommand: gitDiff,
      before: checkpointFiles,
      after: [],
      workspaceObservationError: skippedObservationReason,
    };
    acceptanceResults = fixture.taskPacket.acceptanceCriteria.map((criterion) => ({
      criterion,
      passed: false,
      command: skippedCommandDiagnostic(
        criterion.validation.command,
        criterion.validation.args,
        skippedObservationReason,
      ),
    }));
  } else {
    let afterFiles: WorkspaceFile[] = [];
    try {
      afterFiles = await workspaceFiles(fixture.workspacePath);
    } catch (error) {
      workspaceObservationError = redactSecrets(
        error instanceof Error ? error.message : String(error),
      );
    }
    const gitStatus = await runCommand("git", ["status", "--porcelain=v1"], fixture.workspacePath);
    const gitHead = await runCommand("git", ["rev-parse", "HEAD"], fixture.workspacePath);
    const gitDiff = await runCommand(
      "git",
      ["diff", "--no-ext-diff", "--binary", checkpoint.head, "--"],
      fixture.workspacePath,
    );
    changes = {
      ...changedFiles(checkpointFiles, afterFiles),
      outOfScope: [],
      unsafeSymlinks: afterFiles.filter((file) => file.kind === "symlink").map((file) => file.path),
      head: gitHead.stdout.trim(),
      gitStatus: gitStatus.stdout,
      gitDiff: gitDiff.stdout,
      gitHeadCommand: gitHead,
      gitStatusCommand: gitStatus,
      gitDiffCommand: gitDiff,
      before: checkpointFiles,
      after: afterFiles,
      ...(workspaceObservationError === undefined ? {} : { workspaceObservationError }),
    };
    const changedPaths = [...changes.added, ...changes.modified, ...changes.deleted];
    changes.outOfScope = changedPaths.filter(
      (changedPath) => !fixture.taskPacket.editablePaths.includes(changedPath),
    );

    acceptanceResults = [];
    for (const criterion of fixture.taskPacket.acceptanceCriteria) {
      const command = await runCommand(
        criterion.validation.command,
        criterion.validation.args,
        fixture.workspacePath,
      );
      acceptanceResults.push({
        criterion,
        passed: command.exitCode === 0 && !command.timedOut,
        command,
      });
    }
  }

  const terminal = agent.terminal;
  const changedPathCount = changes.added.length + changes.modified.length + changes.deleted.length;
  const failureReasons: string[] = [];
  if (agent.failure !== undefined) failureReasons.push(`AgentAdapter failed: ${agent.failure}`);
  if (agent.timedOut) {
    failureReasons.push("Agent run timed out and cancellation was requested");
  } else if (terminal?.outcome !== "succeeded") {
    failureReasons.push(
      terminal === undefined
        ? "Agent run emitted no terminal event"
        : `Agent run ended ${terminal.outcome}`,
    );
  }
  if (workspaceObservationError !== undefined) {
    failureReasons.push(`Workspace observation failed: ${workspaceObservationError}`);
  }
  if (!agent.workerTerminationConfirmed) {
    failureReasons.push("Agent termination was not confirmed; inspection requires escalation");
  } else if (changedPathCount === 0) {
    failureReasons.push("Agent run made no workspace file changes");
  }
  if (agent.workerTerminationConfirmed) {
    if (
      changes.gitHeadCommand.exitCode !== 0 ||
      changes.gitStatusCommand.exitCode !== 0 ||
      changes.gitDiffCommand.exitCode !== 0
    ) {
      failureReasons.push("Workspace Git observation failed");
    } else if (changes.head !== checkpoint.head) {
      failureReasons.push("Agent run changed the fixture checkpoint");
    }
    if (changes.outOfScope.length > 0) {
      failureReasons.push(`Out-of-scope workspace changes: ${changes.outOfScope.join(", ")}`);
    }
    if (changes.unsafeSymlinks.length > 0) {
      failureReasons.push(
        `Symbolic links are not valid task changes: ${changes.unsafeSymlinks.join(", ")}`,
      );
    }
    for (const acceptanceResult of acceptanceResults) {
      if (!acceptanceResult.passed) {
        failureReasons.push(`Acceptance criterion failed: ${acceptanceResult.criterion.id}`);
      }
    }
  }

  const verdict = failureReasons.length === 0 ? "PASS" : "FAIL";
  const result: TaskProofResult = {
    verdict,
    failureReasons,
    temporaryRoot: fixture.temporaryRoot,
    workspacePath: fixture.workspacePath,
    diagnosticsPath: diagnosticDestination.diagnosticsPath,
    diagnosticsRoot: diagnosticDestination.diagnosticsRoot,
    taskPacket: fixture.taskPacket,
    prompt,
    checkpoint,
    agentEvents: agent.events,
    agentEventsTruncated: agent.droppedEventCount > 0 || agent.individualEventTruncated,
    droppedAgentEventCount: agent.droppedEventCount,
    workerTerminationConfirmed: agent.workerTerminationConfirmed,
    changes,
    acceptanceResults,
  };

  await writeDiagnosticExclusive(result.diagnosticsPath, {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    ...result,
  });
  return result;
}
