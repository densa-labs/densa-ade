import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { isTerminalAgentEvent, type AgentAdapter, type AgentEvent } from "@densa/agent-sdk";

const DIAGNOSTIC_SCHEMA_VERSION = 1;
const COMMAND_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 15_000;
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
  head: string;
  gitStatus: string;
  gitDiff: string;
  gitHeadCommand: CommandDiagnostic;
  gitStatusCommand: CommandDiagnostic;
  gitDiffCommand: CommandDiagnostic;
  before: WorkspaceFile[];
  after: WorkspaceFile[];
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
  taskPacket: TaskPacket;
  prompt: string;
  checkpoint: {
    head: string;
    gitStatus: string;
    files: WorkspaceFile[];
  };
  agentEvents: AgentEvent[];
  changes: WorkspaceChanges;
  acceptanceResults: AcceptanceResult[];
}

export interface TemporaryTaskProofOptions {
  adapter: AgentAdapter;
  runId?: string;
  temporaryBaseDirectory?: string;
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
    return { value: Buffer.concat(this.chunks).toString("utf8"), truncated: this.wasTruncated };
  }
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function workspaceFiles(root: string, relativeDirectory = ""): Promise<WorkspaceFile[]> {
  const directory = path.join(root, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const files: WorkspaceFile[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (relativeDirectory.length === 0 && entry.name === ".git") continue;
    const relativePath = path.posix.join(
      relativeDirectory.split(path.sep).join(path.posix.sep),
      entry.name,
    );
    const absolutePath = path.join(root, relativePath);
    if (entry.isDirectory()) {
      files.push(...(await workspaceFiles(root, relativePath)));
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
      files.push({
        path: relativePath,
        kind: "file",
        sha256: sha256(await readFile(absolutePath)),
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
  diagnosticsPath: string;
  taskPacket: TaskPacket;
}> {
  const baseDirectory = temporaryBaseDirectory ?? tmpdir();
  await mkdir(baseDirectory, { recursive: true });
  const temporaryRoot = await mkdtemp(path.join(baseDirectory, "densa-task-proof-"));
  const workspacePath = path.join(temporaryRoot, "workspace");
  const diagnosticsPath = path.join(temporaryRoot, "diagnostics", "attempt.json");
  await mkdir(path.join(workspacePath, "src"), { recursive: true });
  await mkdir(path.dirname(diagnosticsPath), { recursive: true });

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
    diagnosticsPath,
    taskPacket: buildDefaultTaskPacket(),
  };
}

/**
 * Non-persistent P1M2 proof loop. The returned temporary directory is intentionally retained so
 * callers can inspect the complete attempt diagnostic; callers own its eventual cleanup.
 */
export async function runTemporaryRepoTaskProof(
  options: TemporaryTaskProofOptions,
): Promise<TaskProofResult> {
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
  const agentEvents: AgentEvent[] = [];
  let adapterFailure: string | undefined;
  try {
    for await (const event of options.adapter.execute({
      runId,
      cwd: fixture.workspacePath,
      prompt,
    })) {
      agentEvents.push(event);
    }
  } catch (error) {
    adapterFailure = error instanceof Error ? error.message : String(error);
  }

  const afterFiles = await workspaceFiles(fixture.workspacePath);
  const gitStatus = await runCommand("git", ["status", "--porcelain=v1"], fixture.workspacePath);
  const gitHead = await runCommand("git", ["rev-parse", "HEAD"], fixture.workspacePath);
  const gitDiff = await runCommand(
    "git",
    ["diff", "--no-ext-diff", "--binary", checkpoint.head, "--"],
    fixture.workspacePath,
  );
  const changes: WorkspaceChanges = {
    ...changedFiles(checkpointFiles, afterFiles),
    outOfScope: [],
    head: gitHead.stdout.trim(),
    gitStatus: gitStatus.stdout,
    gitDiff: gitDiff.stdout,
    gitHeadCommand: gitHead,
    gitStatusCommand: gitStatus,
    gitDiffCommand: gitDiff,
    before: checkpointFiles,
    after: afterFiles,
  };
  const changedPaths = [...changes.added, ...changes.modified, ...changes.deleted];
  changes.outOfScope = changedPaths.filter(
    (changedPath) => !fixture.taskPacket.editablePaths.includes(changedPath),
  );

  const acceptanceResults: AcceptanceResult[] = [];
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

  const terminal = agentEvents.findLast(isTerminalAgentEvent);
  const changedPathCount = changes.added.length + changes.modified.length + changes.deleted.length;
  const failureReasons: string[] = [];
  if (adapterFailure !== undefined) failureReasons.push(`AgentAdapter threw: ${adapterFailure}`);
  if (terminal?.outcome !== "succeeded") {
    failureReasons.push(
      terminal === undefined
        ? "Agent run emitted no terminal event"
        : `Agent run ended ${terminal.outcome}`,
    );
  }
  if (changedPathCount === 0) failureReasons.push("Agent run made no workspace file changes");
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
  for (const acceptanceResult of acceptanceResults) {
    if (!acceptanceResult.passed) {
      failureReasons.push(`Acceptance criterion failed: ${acceptanceResult.criterion.id}`);
    }
  }

  const verdict = failureReasons.length === 0 ? "PASS" : "FAIL";
  const result: TaskProofResult = {
    verdict,
    failureReasons,
    temporaryRoot: fixture.temporaryRoot,
    workspacePath: fixture.workspacePath,
    diagnosticsPath: fixture.diagnosticsPath,
    taskPacket: fixture.taskPacket,
    prompt,
    checkpoint,
    agentEvents,
    changes,
    acceptanceResults,
  };

  await writeFile(
    fixture.diagnosticsPath,
    `${JSON.stringify({ schemaVersion: DIAGNOSTIC_SCHEMA_VERSION, ...result }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return result;
}
