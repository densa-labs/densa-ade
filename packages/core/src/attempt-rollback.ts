import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import process from "node:process";

import {
  isoTimestampSchema,
  jsonObjectSchema,
  type AgentRunId,
  type AttemptId,
  type EventId,
  type JsonObject,
  type JsonValue,
  type ProjectId,
  type TaskId,
} from "@densa/protocol";

import { type DensaDatabase } from "./persistence/database.js";
import {
  type AttemptRollbackPlanRecord,
  type RollbackPathSnapshot,
} from "./persistence/repositories.js";
import { GitWorkspaceProbe } from "./recovery-inspector.js";

const GIT_TIMEOUT_MS = 10_000;
const GIT_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;
const DIAGNOSTICS_LIMIT_BYTES = 64 * 1024;
const SECRET_KEY_SUFFIX_PATTERN =
  /(?:secret|password|passwd|token|apikey|privatekey|authorization|cookie)$/u;

interface GitResult {
  readonly exitCode: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly errorCode?: string;
  readonly timedOut: boolean;
}

export type AttemptRollbackStopCode =
  | "INVALID_REQUEST"
  | "ATTEMPT_MISMATCH"
  | "NOT_FAILED"
  | "WORKSPACE_MISMATCH"
  | "ROLLBACK_PLAN_CONFLICT"
  | "HUMAN_EDIT_OVERLAP"
  | "UNSUPPORTED_PATH"
  | "GIT_COMMAND_FAILED"
  | "ROLLBACK_VERIFICATION_FAILED"
  | "PERSISTENCE_FAILED";

export interface CaptureAttemptOutputRequest {
  readonly projectId: ProjectId;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly agentRunId: AgentRunId;
  readonly workspacePath: string;
  readonly ownedPaths: readonly string[];
  readonly temporaryPaths?: readonly string[];
  readonly recordedAt: string;
  readonly actor: string;
  readonly eventId: EventId;
}

export interface RecordFailedAttemptRequest {
  readonly projectId: ProjectId;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly diagnostics: Readonly<JsonObject>;
  readonly recordedAt: string;
  readonly actor: string;
  readonly eventId: EventId;
}

export interface RollbackFailedAttemptRequest {
  readonly projectId: ProjectId;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly workspacePath: string;
  readonly rolledBackAt: string;
  readonly actor: string;
  readonly appliedEventId: EventId;
  readonly conflictEventId: EventId;
}

export interface RecordedAttemptRollback {
  readonly status: "RECORDED";
  readonly plan: AttemptRollbackPlanRecord;
  readonly recoveredExistingPlan: boolean;
}

export interface CapturedAttemptOutput {
  readonly status: "CAPTURED";
  readonly plan: AttemptRollbackPlanRecord;
  readonly recoveredExistingCapture: boolean;
}

export interface AppliedAttemptRollback {
  readonly status: "ROLLED_BACK";
  readonly plan: AttemptRollbackPlanRecord;
  readonly restoredPaths: readonly string[];
  readonly cleanedTemporaryPaths: readonly string[];
  readonly preservedHumanPaths: readonly string[];
  readonly workspaceReadyForRetry: boolean;
  readonly recoveredExistingRollback: boolean;
}

export interface StoppedAttemptRollback {
  readonly status: "STOPPED";
  readonly code: AttemptRollbackStopCode;
  readonly reason: string;
  readonly conflictingPaths: readonly string[];
  readonly preservedHumanPaths: readonly string[];
}

export type RecordFailedAttemptResult = RecordedAttemptRollback | StoppedAttemptRollback;
export type CaptureAttemptOutputResult = CapturedAttemptOutput | StoppedAttemptRollback;
export type RollbackFailedAttemptResult = AppliedAttemptRollback | StoppedAttemptRollback;

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

async function runGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  return await new Promise<GitResult>((resolveResult) => {
    let timedOut = false;
    const child = execFile(
      "git",
      ["-c", "core.fsmonitor=false", ...args],
      { cwd, encoding: "buffer", env: gitEnvironment(), maxBuffer: GIT_OUTPUT_LIMIT_BYTES },
      (error, stdout, stderr) => {
        clearTimeout(timeoutHandle);
        const commandError = error as NodeJS.ErrnoException | null;
        resolveResult({
          exitCode:
            commandError === null
              ? 0
              : typeof commandError.code === "number"
                ? commandError.code
                : child.exitCode,
          stdout,
          stderr,
          ...(commandError?.code === undefined || typeof commandError.code === "number"
            ? {}
            : { errorCode: commandError.code }),
          timedOut,
        });
      },
    );
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, GIT_TIMEOUT_MS);
    timeoutHandle.unref();
  });
}

function gitFailure(command: string, result: GitResult): string {
  const detail = result.timedOut
    ? "timed out"
    : result.errorCode === undefined
      ? `exited ${String(result.exitCode)}`
      : `failed with ${result.errorCode}`;
  return `${command} ${detail}${result.stderr.length === 0 ? "" : `: ${result.stderr.toString("utf8").slice(0, 4096).trim()}`}`;
}

function immutableStrings(values: Iterable<string>): readonly string[] {
  return Object.freeze([...values].sort((left, right) => left.localeCompare(right)));
}

function redactDiagnosticText(value: string): string {
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/giu, "$1[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED]")
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password)["']?\s*[:=]\s*["']?)[^"',\s}]+/giu,
      "$1[REDACTED]",
    );
}

function redactDiagnosticValue(value: JsonValue, key?: string): JsonValue {
  if (
    key !== undefined &&
    SECRET_KEY_SUFFIX_PATTERN.test(key.replace(/[^a-z0-9]/giu, "").toLowerCase())
  )
    return "[REDACTED]";
  if (typeof value === "string") return redactDiagnosticText(value);
  if (Array.isArray(value)) return value.map((entry) => redactDiagnosticValue(entry));
  if (value !== null && typeof value === "object") {
    const redacted: JsonObject = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      if (childValue !== undefined) {
        redacted[childKey] = redactDiagnosticValue(childValue, childKey);
      }
    }
    return redacted;
  }
  return value;
}

function safeDiagnostics(input: Readonly<JsonObject>): Readonly<JsonObject> {
  return Object.freeze(jsonObjectSchema.parse(redactDiagnosticValue(input)));
}

function stopped(
  code: AttemptRollbackStopCode,
  reason: string,
  conflictingPaths: readonly string[] = [],
  preservedHumanPaths: readonly string[] = [],
): StoppedAttemptRollback {
  return Object.freeze({
    status: "STOPPED" as const,
    code,
    reason,
    conflictingPaths: immutableStrings(conflictingPaths),
    preservedHumanPaths: immutableStrings(preservedHumanPaths),
  });
}

function normalizePaths(paths: readonly string[]): readonly string[] | undefined {
  if (paths.length === 0) return undefined;
  const normalized = new Set<string>();
  for (const path of paths) {
    if (
      path.length === 0 ||
      isAbsolute(path) ||
      path.includes("\\") ||
      posix.normalize(path) !== path ||
      path === "." ||
      path === ".." ||
      path.startsWith("../") ||
      path === ".git" ||
      path.startsWith(".git/") ||
      [...path].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || codePoint === 127;
      })
    ) {
      return undefined;
    }
    normalized.add(path);
  }
  return immutableStrings(normalized);
}

function literalPathspec(path: string): string {
  return `:(literal)${path}`;
}

function contentHash(kind: "FILE" | "SYMLINK", executable: boolean, content: Buffer): string {
  return createHash("sha256")
    .update(kind)
    .update("\0")
    .update(executable ? "EXECUTABLE" : "REGULAR")
    .update("\0")
    .update(content)
    .digest("hex");
}

function sameState(left: RollbackPathSnapshot, right: RollbackPathSnapshot): boolean {
  return (
    left.kind === right.kind &&
    left.contentHash === right.contentHash &&
    left.indexHash === right.indexHash
  );
}

function sameWorktree(left: RollbackPathSnapshot, right: RollbackPathSnapshot): boolean {
  return left.kind === right.kind && left.contentHash === right.contentHash;
}

/** A crash may persist the index and worktree halves of one scoped restore independently. */
function isRecoverablePartialState(
  current: RollbackPathSnapshot,
  failed: RollbackPathSnapshot,
  checkpoint: RollbackPathSnapshot,
): boolean {
  return (
    (sameWorktree(current, failed) || sameWorktree(current, checkpoint)) &&
    (current.indexHash === failed.indexHash || current.indexHash === checkpoint.indexHash)
  );
}

async function inspectIndexHash(workspaceRoot: string, path: string): Promise<string | undefined> {
  const result = await runGit(workspaceRoot, [
    "ls-files",
    "--stage",
    "-z",
    "--",
    literalPathspec(path),
  ]);
  if (result.exitCode !== 0) throw new Error(gitFailure("git ls-files --stage", result));
  const entries = result.stdout
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) return undefined;
  if (entries.length !== 1) throw new Error(`Index has unmerged entries for ${path}`);
  const header = entries[0]?.split("\t", 1)[0] ?? "";
  const [mode, objectId, stage] = header.split(" ");
  if (
    stage !== "0" ||
    objectId === undefined ||
    (mode !== "100644" && mode !== "100755" && mode !== "120000")
  ) {
    throw new Error(`Index path ${path} is not a supported file or symbolic link`);
  }
  const blob = await runGit(workspaceRoot, ["cat-file", "blob", objectId]);
  if (blob.exitCode !== 0) throw new Error(gitFailure("git cat-file", blob));
  const kind = mode === "120000" ? "SYMLINK" : "FILE";
  return contentHash(kind, mode === "100755", blob.stdout);
}

async function assertSafeParent(workspaceRoot: string, relativePath: string): Promise<void> {
  let candidate = dirname(resolve(workspaceRoot, relativePath));
  for (;;) {
    try {
      const parent = await realpath(candidate);
      const escaped = relative(workspaceRoot, parent);
      if (escaped === ".." || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) {
        throw new Error("Path parent resolves outside the workspace");
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const next = dirname(candidate);
      if (next === candidate) throw error;
      candidate = next;
    }
  }
}

async function inspectCurrentPath(
  workspaceRoot: string,
  path: string,
  temporary: boolean,
): Promise<RollbackPathSnapshot> {
  await assertSafeParent(workspaceRoot, path);
  const absolutePath = resolve(workspaceRoot, path);
  const indexHash = await inspectIndexHash(workspaceRoot, path);
  try {
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      return Object.freeze({
        path,
        kind: "SYMLINK" as const,
        contentHash: contentHash("SYMLINK", false, Buffer.from(await readlink(absolutePath))),
        ...(indexHash === undefined ? {} : { indexHash }),
        temporary,
      });
    }
    if (!stats.isFile())
      throw new Error("Only regular files and symbolic links can be rolled back");
    return Object.freeze({
      path,
      kind: "FILE" as const,
      contentHash: contentHash("FILE", (stats.mode & 0o111) !== 0, await readFile(absolutePath)),
      ...(indexHash === undefined ? {} : { indexHash }),
      temporary,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return Object.freeze({
        path,
        kind: "ABSENT" as const,
        ...(indexHash === undefined ? {} : { indexHash }),
        temporary,
      });
    }
    throw error;
  }
}

async function inspectCheckpointPath(
  workspaceRoot: string,
  checkpointHead: string,
  path: string,
  temporary: boolean,
): Promise<RollbackPathSnapshot | { readonly failure: string }> {
  const tree = await runGit(workspaceRoot, [
    "ls-tree",
    "-z",
    checkpointHead,
    "--",
    literalPathspec(path),
  ]);
  if (tree.exitCode !== 0) return { failure: gitFailure("git ls-tree", tree) };
  if (tree.stdout.length === 0) {
    return Object.freeze({ path, kind: "ABSENT" as const, temporary });
  }
  const header = tree.stdout.toString("utf8").split("\t", 1)[0] ?? "";
  const [mode, type, objectId] = header.split(" ");
  if (
    type !== "blob" ||
    objectId === undefined ||
    (mode !== "100644" && mode !== "100755" && mode !== "120000")
  ) {
    return { failure: `Checkpoint path ${path} is not a supported file or symbolic link` };
  }
  const blob = await runGit(workspaceRoot, ["cat-file", "blob", objectId]);
  if (blob.exitCode !== 0) return { failure: gitFailure("git cat-file", blob) };
  const kind = mode === "120000" ? "SYMLINK" : "FILE";
  return Object.freeze({
    path,
    kind,
    contentHash: contentHash(kind, mode === "100755", blob.stdout),
    indexHash: contentHash(kind, mode === "100755", blob.stdout),
    temporary,
  });
}

async function gitIdentity(workspacePath: string): Promise<{
  readonly root?: string;
  readonly branch?: string;
  readonly head?: string;
  readonly failure?: string;
}> {
  const rootResult = await runGit(workspacePath, ["rev-parse", "--show-toplevel"]);
  if (rootResult.exitCode !== 0) return { failure: gitFailure("git rev-parse", rootResult) };
  const root = await realpath(rootResult.stdout.toString("utf8").trim());
  const [branchResult, headResult] = await Promise.all([
    runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    runGit(root, ["rev-parse", "HEAD"]),
  ]);
  if (branchResult.exitCode !== 0 || headResult.exitCode !== 0) {
    return {
      failure: gitFailure(
        "Git workspace identity",
        branchResult.exitCode === 0 ? headResult : branchResult,
      ),
    };
  }
  return {
    root,
    branch: branchResult.stdout.toString("utf8").trim(),
    head: headResult.stdout.toString("utf8").trim(),
  };
}

async function changedPaths(
  workspaceRoot: string,
): Promise<readonly string[] | { readonly failure: string }> {
  const [tracked, untracked] = await Promise.all([
    runGit(workspaceRoot, ["diff", "--name-only", "-z", "HEAD", "--"]),
    runGit(workspaceRoot, ["ls-files", "--others", "--exclude-standard", "-z", "--"]),
  ]);
  if (tracked.exitCode !== 0 || untracked.exitCode !== 0) {
    return {
      failure: gitFailure(
        "git changed-path inspection",
        tracked.exitCode === 0 ? untracked : tracked,
      ),
    };
  }
  return immutableStrings(
    Buffer.concat([tracked.stdout, untracked.stdout])
      .toString("utf8")
      .split("\0")
      .filter((path) => path.length > 0),
  );
}

function planMatches(
  plan: AttemptRollbackPlanRecord,
  request: CaptureAttemptOutputRequest,
  workspaceRoot: string,
  snapshots: readonly RollbackPathSnapshot[],
): boolean {
  return (
    plan.agentRunId === request.agentRunId &&
    plan.projectId === request.projectId &&
    plan.taskId === request.taskId &&
    plan.workspacePath === workspaceRoot &&
    JSON.stringify(plan.ownedPaths) === JSON.stringify(snapshots)
  );
}

/** P3M3 boundary for durable diagnostics and path-scoped retry rollback. */
export class AttemptRollbackService {
  readonly #workspaceProbe = new GitWorkspaceProbe();

  constructor(private readonly database: DensaDatabase) {}

  async captureAttemptOutput(
    request: CaptureAttemptOutputRequest,
  ): Promise<CaptureAttemptOutputResult> {
    try {
      try {
        isoTimestampSchema.parse(request.recordedAt);
      } catch {
        return stopped("INVALID_REQUEST", "Rollback recordedAt must be an ISO timestamp");
      }
      if (request.actor.trim().length === 0)
        return stopped("INVALID_REQUEST", "Rollback actor must not be empty");
      const ownedPaths = normalizePaths(request.ownedPaths);
      const temporaryPaths =
        request.temporaryPaths === undefined || request.temporaryPaths.length === 0
          ? Object.freeze([])
          : normalizePaths(request.temporaryPaths);
      if (
        ownedPaths === undefined ||
        temporaryPaths === undefined ||
        temporaryPaths.some((path) => !ownedPaths.includes(path))
      ) {
        return stopped(
          "INVALID_REQUEST",
          "Owned paths must be explicit normalized files and temporary paths must be a subset",
        );
      }
      const repositories = this.database.repositories;
      const task = repositories.tasks.findById(request.taskId);
      const attempt = repositories.attempts.findById(request.attemptId);
      const latestAttempt = repositories.attempts.listByTaskId(request.taskId).at(-1);
      const agentRun = repositories.agentRuns.findByAttemptId(request.attemptId);
      const checkpoint = repositories.checkpoints.findByAttemptId(request.attemptId);
      const run = repositories.densaRunBranches.findByProjectId(request.projectId);
      if (
        task?.projectId !== request.projectId ||
        attempt?.taskId !== request.taskId ||
        attempt.commitSha !== undefined ||
        latestAttempt?.id !== request.attemptId ||
        agentRun?.id !== request.agentRunId ||
        checkpoint?.taskId !== request.taskId ||
        checkpoint.projectId !== request.projectId ||
        run === undefined ||
        checkpoint.runBranch !== run.branchName ||
        checkpoint.gitHead === undefined
      ) {
        return stopped(
          "ATTEMPT_MISMATCH",
          "Rollback graph does not match one checkpointed attempt",
        );
      }
      const validations = repositories.validationRuns
        .listByTaskId(request.taskId)
        .filter((validation) => validation.attemptId === request.attemptId);
      if (task.state !== "RUNNING" || validations.length !== 0) {
        return stopped(
          "ATTEMPT_MISMATCH",
          "Attempt output must be captured at the RUNNING worker boundary before validation",
        );
      }
      const identity = await gitIdentity(request.workspacePath);
      if (identity.failure !== undefined || identity.root === undefined)
        return stopped("GIT_COMMAND_FAILED", identity.failure ?? "Git identity is unavailable");
      if (
        identity.root !== run.workspacePath ||
        identity.branch !== run.branchName ||
        identity.head !== checkpoint.gitHead
      ) {
        return stopped(
          "WORKSPACE_MISMATCH",
          "Workspace is not at the attempt checkpoint on the owned run branch",
        );
      }
      const temporarySet = new Set(temporaryPaths);
      const snapshots: RollbackPathSnapshot[] = [];
      for (const path of ownedPaths) {
        try {
          snapshots.push(await inspectCurrentPath(identity.root, path, temporarySet.has(path)));
        } catch (error) {
          return stopped(
            "UNSUPPORTED_PATH",
            error instanceof Error ? error.message : `Could not inspect owned path ${path}`,
            [path],
          );
        }
      }
      const existing = repositories.attemptRollbackPlans.findByAttemptId(request.attemptId);
      if (existing !== undefined) {
        return agentRun.completedAt === existing.recordedAt &&
          planMatches(existing, request, identity.root, snapshots)
          ? Object.freeze({
              status: "CAPTURED" as const,
              plan: existing,
              recoveredExistingCapture: true,
            })
          : stopped(
              "ROLLBACK_PLAN_CONFLICT",
              "Attempt already has different durable rollback evidence",
            );
      }
      if (agentRun.completedAt !== undefined) {
        return stopped(
          "ATTEMPT_MISMATCH",
          "A completed worker run without an atomic output manifest is not rollback eligible",
        );
      }
      const plan = this.database.transaction((transactionRepositories) => {
        transactionRepositories.agentRuns.recordCompleted(request.agentRunId, request.recordedAt);
        const stored = transactionRepositories.attemptRollbackPlans.create({
          attemptId: request.attemptId,
          agentRunId: request.agentRunId,
          projectId: request.projectId,
          taskId: request.taskId,
          workspacePath: identity.root as string,
          branchName: run.branchName,
          checkpointHead: checkpoint.gitHead as string,
          ownedPaths: snapshots,
          recordedAt: request.recordedAt,
        });
        transactionRepositories.events.append({
          id: request.eventId,
          projectId: request.projectId,
          phaseId: task.phaseId,
          taskId: request.taskId,
          type: "ATTEMPT_OUTPUT_CAPTURED",
          eventVersion: 1,
          occurredAt: request.recordedAt,
          actor: request.actor,
          payload: {
            attemptId: request.attemptId,
            agentRunId: request.agentRunId,
            checkpointHead: checkpoint.gitHead as string,
            ownedPaths: [...ownedPaths],
          },
        });
        return stored;
      });
      return Object.freeze({
        status: "CAPTURED" as const,
        plan,
        recoveredExistingCapture: false,
      });
    } catch (error) {
      return stopped(
        "PERSISTENCE_FAILED",
        error instanceof Error ? error.message : "Could not capture attempt output evidence",
      );
    }
  }

  async recordFailedAttempt(
    request: RecordFailedAttemptRequest,
  ): Promise<RecordFailedAttemptResult> {
    try {
      try {
        isoTimestampSchema.parse(request.recordedAt);
      } catch {
        return stopped("INVALID_REQUEST", "Failure recordedAt must be an ISO timestamp");
      }
      if (request.actor.trim().length === 0)
        return stopped("INVALID_REQUEST", "Failure actor must not be empty");
      let diagnostics: Readonly<JsonObject>;
      try {
        diagnostics = safeDiagnostics(request.diagnostics);
      } catch {
        return stopped("INVALID_REQUEST", "Attempt diagnostics must be a JSON object");
      }
      if (Buffer.byteLength(JSON.stringify(diagnostics), "utf8") > DIAGNOSTICS_LIMIT_BYTES) {
        return stopped(
          "INVALID_REQUEST",
          "Attempt diagnostics exceed the 64 KiB persistence limit",
        );
      }
      const repositories = this.database.repositories;
      const task = repositories.tasks.findById(request.taskId);
      const attempt = repositories.attempts.findById(request.attemptId);
      const latestAttempt = repositories.attempts.listByTaskId(request.taskId).at(-1);
      const plan = repositories.attemptRollbackPlans.findByAttemptId(request.attemptId);
      const agentRun = repositories.agentRuns.findByAttemptId(request.attemptId);
      const validations = repositories.validationRuns
        .listByTaskId(request.taskId)
        .filter((validation) => validation.attemptId === request.attemptId);
      const failed = validations.some(
        (validation) => validation.completedAt !== undefined && validation.passed === false,
      );
      const interrupted = task?.state === "INTERRUPTED" || task?.state === "RETRYING";
      if (
        task?.projectId !== request.projectId ||
        attempt?.taskId !== request.taskId ||
        attempt.commitSha !== undefined ||
        latestAttempt?.id !== request.attemptId ||
        plan?.projectId !== request.projectId ||
        plan.taskId !== request.taskId ||
        agentRun?.id !== plan.agentRunId ||
        agentRun.completedAt !== plan.recordedAt
      ) {
        return stopped("ATTEMPT_MISMATCH", "Failure does not match the latest captured attempt");
      }
      if (
        (!failed && !interrupted) ||
        !(task.state === "VALIDATING" || interrupted) ||
        validations.some((validation) => validation.passed === true)
      ) {
        return stopped(
          "NOT_FAILED",
          "Rollback requires a failed or interrupted attempt and no passing validation",
        );
      }
      if (plan.failureRecordedAt !== undefined) {
        return plan.failureRecordedAt === request.recordedAt &&
          JSON.stringify(plan.diagnostics) === JSON.stringify(diagnostics)
          ? Object.freeze({ status: "RECORDED" as const, plan, recoveredExistingPlan: true })
          : stopped("ROLLBACK_PLAN_CONFLICT", "Attempt already records different failure evidence");
      }
      const recorded = this.database.transaction((transactionRepositories) => {
        const stored = transactionRepositories.attemptRollbackPlans.recordFailure(
          request.attemptId,
          diagnostics,
          request.recordedAt,
        );
        transactionRepositories.events.append({
          id: request.eventId,
          projectId: request.projectId,
          phaseId: task.phaseId,
          taskId: request.taskId,
          type: "ATTEMPT_ROLLBACK_PLANNED",
          eventVersion: 1,
          occurredAt: request.recordedAt,
          actor: request.actor,
          payload: { attemptId: request.attemptId, diagnostics },
        });
        return stored;
      });
      return Object.freeze({
        status: "RECORDED" as const,
        plan: recorded,
        recoveredExistingPlan: false,
      });
    } catch (error) {
      return stopped(
        "PERSISTENCE_FAILED",
        error instanceof Error ? error.message : "Could not record failed-attempt evidence",
      );
    }
  }

  async rollbackFailedAttempt(
    request: RollbackFailedAttemptRequest,
  ): Promise<RollbackFailedAttemptResult> {
    try {
      try {
        isoTimestampSchema.parse(request.rolledBackAt);
      } catch {
        return stopped("INVALID_REQUEST", "Rollback rolledBackAt must be an ISO timestamp");
      }
      if (request.actor.trim().length === 0)
        return stopped("INVALID_REQUEST", "Rollback actor must not be empty");
      const repositories = this.database.repositories;
      const plan = repositories.attemptRollbackPlans.findByAttemptId(request.attemptId);
      const task = repositories.tasks.findById(request.taskId);
      const attempt = repositories.attempts.findById(request.attemptId);
      const latestAttempt = repositories.attempts.listByTaskId(request.taskId).at(-1);
      const checkpoint = repositories.checkpoints.findByAttemptId(request.attemptId);
      const run = repositories.densaRunBranches.findByProjectId(request.projectId);
      const agentRun = repositories.agentRuns.findByAttemptId(request.attemptId);
      const validations = repositories.validationRuns
        .listByTaskId(request.taskId)
        .filter((validation) => validation.attemptId === request.attemptId);
      if (
        plan === undefined ||
        task?.projectId !== request.projectId ||
        attempt?.taskId !== request.taskId ||
        attempt.commitSha !== undefined ||
        latestAttempt?.id !== request.attemptId ||
        plan.projectId !== request.projectId ||
        plan.taskId !== request.taskId ||
        agentRun?.id !== plan.agentRunId ||
        agentRun.completedAt !== plan.recordedAt ||
        plan.failureRecordedAt === undefined ||
        checkpoint?.gitHead !== plan.checkpointHead ||
        run?.branchName !== plan.branchName
      ) {
        return stopped(
          "ATTEMPT_MISMATCH",
          "No matching durable rollback plan and checkpoint exist",
        );
      }
      const failed = validations.some(
        (validation) => validation.completedAt !== undefined && validation.passed === false,
      );
      const interrupted = task.state === "INTERRUPTED" || task.state === "RETRYING";
      if (
        (!failed && !interrupted) ||
        !(task.state === "VALIDATING" || interrupted) ||
        validations.some((validation) => validation.passed === true)
      ) {
        return stopped(
          "NOT_FAILED",
          "Rollback eligibility changed after failure evidence was recorded",
        );
      }
      const identity = await gitIdentity(request.workspacePath);
      if (identity.failure !== undefined || identity.root === undefined)
        return stopped("GIT_COMMAND_FAILED", identity.failure ?? "Git identity is unavailable");
      if (
        identity.root !== plan.workspacePath ||
        identity.branch !== plan.branchName ||
        identity.head !== plan.checkpointHead
      ) {
        return stopped(
          "WORKSPACE_MISMATCH",
          "Workspace moved away from the persisted rollback boundary",
        );
      }
      const changed = await changedPaths(identity.root);
      if ("failure" in changed) return stopped("GIT_COMMAND_FAILED", changed.failure);
      const ownedSet = new Set(plan.ownedPaths.map((entry) => entry.path));
      const preservedHumanPaths = changed.filter((path) => !ownedSet.has(path));
      const baselines = new Map<string, RollbackPathSnapshot>();
      const conflicts: string[] = [];
      for (const snapshot of plan.ownedPaths) {
        const baseline = await inspectCheckpointPath(
          identity.root,
          plan.checkpointHead,
          snapshot.path,
          snapshot.temporary,
        );
        if ("failure" in baseline)
          return stopped("UNSUPPORTED_PATH", baseline.failure, [], preservedHumanPaths);
        baselines.set(snapshot.path, baseline);
        const current = await inspectCurrentPath(identity.root, snapshot.path, snapshot.temporary);
        if (
          (plan.appliedAt !== undefined && !sameState(current, baseline)) ||
          (plan.appliedAt === undefined && !isRecoverablePartialState(current, snapshot, baseline))
        )
          conflicts.push(snapshot.path);
      }
      if (conflicts.length > 0) {
        try {
          repositories.events.append({
            id: request.conflictEventId,
            projectId: request.projectId,
            phaseId: task.phaseId,
            taskId: request.taskId,
            type: "ATTEMPT_ROLLBACK_BLOCKED",
            eventVersion: 1,
            occurredAt: request.rolledBackAt,
            actor: request.actor,
            payload: {
              attemptId: request.attemptId,
              conflictingPaths: conflicts,
              preservedHumanPaths,
            },
          });
        } catch (error) {
          return stopped(
            "PERSISTENCE_FAILED",
            error instanceof Error ? error.message : "Could not record rollback conflict",
            conflicts,
            preservedHumanPaths,
          );
        }
        return stopped(
          "HUMAN_EDIT_OVERLAP",
          "An owned path changed after failure evidence was recorded; resolution is required",
          conflicts,
          preservedHumanPaths,
        );
      }
      if (plan.appliedAt !== undefined) {
        const observation = await this.#workspaceProbe.inspect(identity.root);
        const workspaceReadyForRetry =
          observation.status === "available" &&
          preservedHumanPaths.length === 0 &&
          observation.snapshot.gitHead === checkpoint.gitHead &&
          observation.snapshot.gitStatus === checkpoint.gitStatus &&
          observation.snapshot.fingerprint === checkpoint.workspaceFingerprint;
        return Object.freeze({
          status: "ROLLED_BACK" as const,
          plan,
          restoredPaths: Object.freeze([]),
          cleanedTemporaryPaths: Object.freeze([]),
          preservedHumanPaths,
          workspaceReadyForRetry,
          recoveredExistingRollback: true,
        });
      }
      const restored: string[] = [];
      const cleanedTemporary: string[] = [];
      for (const snapshot of plan.ownedPaths) {
        const baseline = baselines.get(snapshot.path);
        if (baseline === undefined)
          return stopped(
            "ROLLBACK_VERIFICATION_FAILED",
            "Rollback baseline disappeared",
            [snapshot.path],
            preservedHumanPaths,
          );
        const current = await inspectCurrentPath(identity.root, snapshot.path, snapshot.temporary);
        if (sameState(current, baseline)) continue;
        if (!isRecoverablePartialState(current, snapshot, baseline))
          return stopped(
            "HUMAN_EDIT_OVERLAP",
            "An owned path changed while rollback was in progress",
            [snapshot.path],
            preservedHumanPaths,
          );
        if (baseline.kind === "ABSENT") {
          const staged = await runGit(identity.root, [
            "diff",
            "--cached",
            "--quiet",
            "--",
            literalPathspec(snapshot.path),
          ]);
          if (staged.exitCode === 1) {
            const unstage = await runGit(identity.root, [
              "restore",
              `--source=${plan.checkpointHead}`,
              "--staged",
              "--",
              literalPathspec(snapshot.path),
            ]);
            if (unstage.exitCode !== 0)
              return stopped(
                "GIT_COMMAND_FAILED",
                gitFailure("git restore --staged", unstage),
                [snapshot.path],
                preservedHumanPaths,
              );
          } else if (staged.exitCode !== 0) {
            return stopped(
              "GIT_COMMAND_FAILED",
              gitFailure("git diff --cached", staged),
              [snapshot.path],
              preservedHumanPaths,
            );
          }
          if (current.kind !== "ABSENT") await unlink(resolve(identity.root, snapshot.path));
          if (snapshot.temporary) cleanedTemporary.push(snapshot.path);
        } else {
          const restore = await runGit(identity.root, [
            "restore",
            `--source=${plan.checkpointHead}`,
            "--staged",
            "--worktree",
            "--",
            literalPathspec(snapshot.path),
          ]);
          if (restore.exitCode !== 0)
            return stopped(
              "GIT_COMMAND_FAILED",
              gitFailure("git restore", restore),
              [snapshot.path],
              preservedHumanPaths,
            );
        }
        restored.push(snapshot.path);
      }
      for (const snapshot of plan.ownedPaths) {
        const baseline = baselines.get(snapshot.path);
        const current = await inspectCurrentPath(identity.root, snapshot.path, snapshot.temporary);
        if (baseline === undefined || !sameState(current, baseline)) {
          return stopped(
            "ROLLBACK_VERIFICATION_FAILED",
            "A scoped path did not return to its checkpoint content",
            [snapshot.path],
            preservedHumanPaths,
          );
        }
      }
      const observation = await this.#workspaceProbe.inspect(identity.root);
      const workspaceReadyForRetry =
        observation.status === "available" &&
        preservedHumanPaths.length === 0 &&
        observation.snapshot.gitHead === checkpoint.gitHead &&
        observation.snapshot.gitStatus === checkpoint.gitStatus &&
        observation.snapshot.fingerprint === checkpoint.workspaceFingerprint;
      try {
        const appliedPlan = this.database.transaction((transactionRepositories) => {
          const stored = transactionRepositories.attemptRollbackPlans.recordApplied(
            request.attemptId,
            request.rolledBackAt,
          );
          transactionRepositories.events.append({
            id: request.appliedEventId,
            projectId: request.projectId,
            phaseId: task.phaseId,
            taskId: request.taskId,
            type: "ATTEMPT_ROLLED_BACK",
            eventVersion: 1,
            occurredAt: request.rolledBackAt,
            actor: request.actor,
            payload: {
              attemptId: request.attemptId,
              checkpointHead: plan.checkpointHead,
              restoredPaths: restored,
              cleanedTemporaryPaths: cleanedTemporary,
              preservedHumanPaths,
              workspaceReadyForRetry,
            },
          });
          return stored;
        });
        return Object.freeze({
          status: "ROLLED_BACK" as const,
          plan: appliedPlan,
          restoredPaths: immutableStrings(restored),
          cleanedTemporaryPaths: immutableStrings(cleanedTemporary),
          preservedHumanPaths: immutableStrings(preservedHumanPaths),
          workspaceReadyForRetry,
          recoveredExistingRollback: false,
        });
      } catch (error) {
        return stopped(
          "PERSISTENCE_FAILED",
          error instanceof Error ? error.message : "Could not record rollback outcome",
          [],
          preservedHumanPaths,
        );
      }
    } catch (error) {
      return stopped(
        "ROLLBACK_VERIFICATION_FAILED",
        error instanceof Error ? error.message : "Rollback could not be completed safely",
      );
    }
  }
}
