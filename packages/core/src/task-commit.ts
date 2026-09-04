import { publishTaskCommit } from "./task-publication.js";
import { assertIsolatedRunWorkspace } from "./isolated-run-workspace.js";
import {
  inspectCurrentPath,
  inspectCheckpointPath,
  inspectChangedPaths,
  sameWorktree,
} from "./workspace-path-evidence.js";
import {
  readValidationWorkspace,
  assertValidationWorkspaceUnchanged,
  type ValidationWorkspaceEvidence,
} from "./validation-workspace.js";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, posix } from "node:path";
import process from "node:process";

import {
  isoTimestampSchema,
  eventIdSchema,
  type AttemptId,
  type EventId,
  type ProjectId,
  type TaskId,
  type ValidationRunId,
} from "@densa-ade/protocol";

import { type DensaAdeDatabase } from "./persistence/database.js";
import { type TaskCommitIntentRecord } from "./persistence/repositories.js";
import { buildAcceptanceReport } from "./acceptance-evidence.js";
import {
  PermissionPolicyService,
  assertAuthorizedOperation,
  type AuthorizedOperationContext,
} from "./permission-policy.js";
import { stateTransitionService } from "./state-transitions.js";

const GIT_TIMEOUT_MS = 10_000;
const GIT_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const GIT_ERROR_DETAIL_LIMIT = 4_096;
const COMMIT_SUBJECT_LIMIT = 240;

interface GitCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly errorCode?: string;
  readonly timedOut: boolean;
}

export type TaskCommitStopCode =
  | "INVALID_INTENDED_PATH"
  | "POLICY_ASK_USER"
  | "POLICY_DENIED"
  | "NOT_VALIDATED"
  | "ATTEMPT_MISMATCH"
  | "COMMIT_INTENT_CONFLICT"
  | "WORKSPACE_MISMATCH"
  | "NO_INTENDED_CHANGES"
  | "GIT_COMMAND_FAILED"
  | "COMMIT_VERIFICATION_FAILED"
  | "PERSISTENCE_FAILED"
  | "PUBLICATION_STOPPED";

export interface CommitPassingTaskRequest {
  readonly projectId: ProjectId;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly validationRunId: ValidationRunId;
  readonly workspacePath: string;
  readonly intendedPaths: readonly string[];
  readonly committedAt: string;
  readonly actor: string;
  readonly commitRecordedEventId: EventId;
  readonly completionEventId: EventId;
  readonly attemptCompletedEventId?: EventId;
  readonly gitAuthorization?: AuthorizedOperationContext;
}

export interface CommittedPassingTask {
  readonly status: "COMMITTED";
  readonly commitSha: string;
  readonly commitMessage: string;
  readonly intendedPaths: readonly string[];
  readonly preservedChangedPaths: readonly string[];
  readonly recoveredExistingCommit: boolean;
}

export interface StoppedPassingTaskCommit {
  readonly status: "STOPPED";
  readonly code: TaskCommitStopCode;
  readonly reason: string;
  readonly commitSha?: string;
  readonly preservedChangedPaths: readonly string[];
}

export type CommitPassingTaskResult = CommittedPassingTask | StoppedPassingTaskCommit;

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

async function runGit(cwd: string, args: readonly string[]): Promise<GitCommandResult> {
  return await new Promise<GitCommandResult>((resolve) => {
    let timedOut = false;
    const child = execFile(
      "git",
      ["-c", "core.fsmonitor=false", ...args],
      {
        cwd,
        encoding: "utf8",
        env: gitEnvironment(),
        maxBuffer: GIT_OUTPUT_LIMIT_BYTES,
      },
      (error, stdout, stderr) => {
        clearTimeout(timeoutHandle);
        const commandError = error as NodeJS.ErrnoException | null;
        resolve({
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

async function runAuthorizedGitMutation(
  authorization: AuthorizedOperationContext,
  projectId: ProjectId,
  cwd: string,
  args: readonly string[],
): Promise<GitCommandResult> {
  assertAuthorizedOperation(authorization, projectId, "git_mutation");
  return await runGit(cwd, args);
}

function gitFailure(command: string, result: GitCommandResult): string {
  const detail = result.timedOut
    ? "timed out"
    : result.errorCode === undefined
      ? `exited ${String(result.exitCode)}`
      : `failed with ${result.errorCode}`;
  const stderr = result.stderr.trim();
  const bounded =
    stderr.length <= GIT_ERROR_DETAIL_LIMIT
      ? stderr
      : `${stderr.slice(0, GIT_ERROR_DETAIL_LIMIT)}...[truncated]`;
  return `${command} ${detail}${bounded.length === 0 ? "" : `: ${bounded}`}`;
}

function immutableStrings(values: Iterable<string>): readonly string[] {
  return Object.freeze([...values].sort((left, right) => left.localeCompare(right)));
}

function nulSeparated(output: string): readonly string[] {
  return immutableStrings(output.split("\0").filter((path) => path.length > 0));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function stopped(
  code: TaskCommitStopCode,
  reason: string,
  preservedChangedPaths: readonly string[] = [],
  commitSha?: string,
): StoppedPassingTaskCommit {
  return Object.freeze({
    status: "STOPPED" as const,
    code,
    reason,
    ...(commitSha === undefined ? {} : { commitSha }),
    preservedChangedPaths: immutableStrings(preservedChangedPaths),
  });
}

function sanitizeSubjectPart(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export function taskCommitMessage(taskId: TaskId | string, title: string): string {
  const subject = `densa-ade: ${sanitizeSubjectPart(taskId)} ${sanitizeSubjectPart(title)}`.trim();
  return subject.slice(0, COMMIT_SUBJECT_LIMIT).trimEnd();
}

function normalizeIntendedPaths(paths: readonly string[]): readonly string[] | undefined {
  if (paths.length === 0) return undefined;
  const normalized = new Set<string>();
  for (const path of paths) {
    if (
      path.length === 0 ||
      isAbsolute(path) ||
      path.includes("\\") ||
      [...path].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || codePoint === 127;
      }) ||
      posix.normalize(path) !== path ||
      path === "." ||
      path === ".." ||
      path.startsWith("../") ||
      path === ".git" ||
      path.startsWith(".git/")
    ) {
      return undefined;
    }
    normalized.add(path);
  }
  return immutableStrings(normalized);
}

async function requiredGit(
  cwd: string,
  args: readonly string[],
  command: string,
): Promise<{ readonly value?: string; readonly failure?: string }> {
  const result = await runGit(cwd, args);
  return result.exitCode === 0
    ? { value: result.stdout.trim() }
    : { failure: gitFailure(command, result) };
}

async function changedPaths(
  cwd: string,
): Promise<
  | { readonly status: "AVAILABLE"; readonly paths: readonly string[] }
  | { readonly status: "FAILED"; readonly reason: string }
> {
  try {
    return { status: "AVAILABLE", paths: await inspectChangedPaths(cwd) };
  } catch (error) {
    return {
      status: "FAILED",
      reason: error instanceof Error ? error.message : "Git inspection failed",
    };
  }
}

function intentMatches(
  intent: TaskCommitIntentRecord,
  request: CommitPassingTaskRequest,
  workspaceRoot: string,
  branchName: string,
  expectedHead: string,
  commitMessage: string,
  intendedPaths: readonly string[],
): boolean {
  return (
    intent.projectId === request.projectId &&
    intent.taskId === request.taskId &&
    intent.attemptId === request.attemptId &&
    intent.workspacePath === workspaceRoot &&
    intent.branchName === branchName &&
    intent.expectedHead === expectedHead &&
    intent.commitMessage === commitMessage &&
    sameStrings(intent.intendedPaths, intendedPaths)
  );
}

async function verifyCommit(
  workspaceRoot: string,
  commitSha: string,
  intent: TaskCommitIntentRecord,
  evidence: ValidationWorkspaceEvidence,
): Promise<string | undefined> {
  const [head, parents, message, paths, branch] = await Promise.all([
    requiredGit(workspaceRoot, ["rev-parse", "HEAD"], "git rev-parse HEAD"),
    requiredGit(workspaceRoot, ["rev-list", "--parents", "-n", "1", commitSha], "git rev-list"),
    requiredGit(workspaceRoot, ["log", "-1", "--format=%B", commitSha], "git log"),
    runGit(workspaceRoot, [
      "diff-tree",
      "--no-renames",
      "--no-commit-id",
      "--name-only",
      "-r",
      "-z",
      commitSha,
      "--",
    ]),
    requiredGit(workspaceRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"], "git symbolic-ref"),
  ]);
  if (branch.failure !== undefined || branch.value !== intent.branchName)
    return "Workspace is no longer on the owned run branch";
  if (head.failure !== undefined) return head.failure;
  if (parents.failure !== undefined) return parents.failure;
  if (message.failure !== undefined) return message.failure;
  if (paths.exitCode !== 0) return gitFailure("git diff-tree", paths);
  if (head.value !== commitSha) return "The owned run branch no longer points at the task commit";
  const parentFields = parents.value?.split(" ") ?? [];
  if (parentFields.length !== 2 || parentFields[0] !== commitSha) {
    return "The task commit is not a single-parent commit";
  }
  if (parentFields[1] !== intent.expectedHead) {
    return "The task commit parent does not match the attempt checkpoint";
  }
  if (message.value !== intent.commitMessage)
    return "The task commit message does not match intent";
  if (!sameStrings(nulSeparated(paths.stdout), intent.intendedPaths)) {
    return "The task commit does not contain exactly the intended paths";
  }
  for (const path of intent.intendedPaths) {
    const expected = evidence.paths.find((entry) => entry.path === path);
    const actual = await inspectCheckpointPath(workspaceRoot, commitSha, path, false);
    if (expected === undefined || "failure" in actual || !sameWorktree(expected, actual)) {
      return "Task commit content or mode differs from the validated workspace";
    }
  }
  return undefined;
}

/** P3M2 boundary for turning a passing validation into a verified local task commit. */
export class TaskCommitService {
  constructor(private readonly database: DensaAdeDatabase) {}

  async commitPassingTask(request: CommitPassingTaskRequest): Promise<CommitPassingTaskResult> {
    isoTimestampSchema.parse(request.committedAt);
    if (request.actor.trim().length === 0) {
      return stopped("ATTEMPT_MISMATCH", "Task commit actor must not be empty");
    }
    const intendedPaths = normalizeIntendedPaths(request.intendedPaths);
    if (intendedPaths === undefined) {
      return stopped(
        "INVALID_INTENDED_PATH",
        "Intended paths must be explicit normalized repository-relative paths outside .git",
      );
    }

    const repositories = this.database.repositories;
    if (intendedPaths.some((path) => path.split("/").at(-1) === ".env")) {
      return stopped(
        "POLICY_DENIED",
        "Automatic task commits cannot include .env secret material; user handling is required",
      );
    }
    const project = repositories.projects.findById(request.projectId);
    const task = repositories.tasks.findById(request.taskId);
    const attempt = repositories.attempts.findById(request.attemptId);
    const validation = repositories.validationRuns.findById(request.validationRunId);
    const checkpoint = repositories.checkpoints.findByAttemptId(request.attemptId);
    const run = repositories.densaAdeRunBranches.findByProjectId(request.projectId);
    if (
      project === undefined ||
      task?.projectId !== request.projectId ||
      attempt?.taskId !== request.taskId ||
      repositories.attempts.listByTaskId(request.taskId).at(-1)?.id !== request.attemptId ||
      checkpoint?.projectId !== request.projectId ||
      checkpoint.taskId !== request.taskId ||
      checkpoint.attemptId !== request.attemptId ||
      run === undefined ||
      checkpoint.runBranch !== run.branchName
    ) {
      return stopped(
        "ATTEMPT_MISMATCH",
        "Task commit graph does not match one checkpointed attempt",
      );
    }
    if (
      validation?.taskId !== request.taskId ||
      validation.attemptId !== request.attemptId ||
      validation.completedAt === undefined ||
      validation.passed !== true
    ) {
      return stopped("NOT_VALIDATED", "The selected attempt has no completed passing validation");
    }
    if (validation.planId === undefined || validation.planVersion === undefined) {
      return stopped(
        "NOT_VALIDATED",
        "The selected validation has no current plan or criterion evidence and requires revalidation",
      );
    }
    let acceptanceComplete: boolean;
    try {
      acceptanceComplete = buildAcceptanceReport({
        task,
        run: validation,
        results: repositories.validationResults.listByRunId(validation.id),
        manualReviews: repositories.manualAcceptanceReviews.listByRunId(validation.id),
        generatedAt: request.committedAt,
      }).canComplete;
    } catch {
      return stopped("NOT_VALIDATED", "Acceptance evidence is internally inconsistent");
    }
    if (!acceptanceComplete) {
      return stopped(
        "NOT_VALIDATED",
        "Required acceptance criteria remain failed, unevaluated, or awaiting manual approval",
      );
    }
    const evidence = readValidationWorkspace(this.database, validation.id);
    if (
      evidence === undefined ||
      evidence.snapshot.gitHead !== checkpoint.gitHead ||
      evidence.workspaceRoot !== run.workspacePath ||
      intendedPaths.some((path) => !evidence.paths.some((entry) => entry.path === path))
    ) {
      return stopped(
        "NOT_VALIDATED",
        "Validation lacks durable evidence for the exact workspace and intended contents",
      );
    }
    const latestValidation = repositories.validationRuns
      .listByTaskId(task.id)
      .filter((candidate) => candidate.attemptId === attempt.id)
      .at(-1);
    if (latestValidation?.id !== validation.id)
      return stopped("NOT_VALIDATED", "A newer validation supersedes the selected outcome");
    if (checkpoint.gitHead === undefined || run.status !== "ACTIVE") {
      return stopped("ATTEMPT_MISMATCH", "The selected attempt has no active Git checkpoint");
    }
    if (task.state !== "VALIDATING" && task.state !== "COMPLETED") {
      return stopped("ATTEMPT_MISMATCH", "Only a VALIDATING task can receive a task commit");
    }

    const rootResult = await requiredGit(
      request.workspacePath,
      ["rev-parse", "--show-toplevel"],
      "git rev-parse --show-toplevel",
    );
    if (rootResult.failure !== undefined || rootResult.value === undefined) {
      return stopped("GIT_COMMAND_FAILED", rootResult.failure ?? "Git root is unavailable");
    }
    const requestedRoot = await realpath(rootResult.value);
    const workspaceRoot =
      requestedRoot === run.sourceWorkspacePath ? run.workspacePath : requestedRoot;
    const [branchResult, headResult] = await Promise.all([
      requiredGit(
        workspaceRoot,
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
        "git symbolic-ref",
      ),
      requiredGit(workspaceRoot, ["rev-parse", "HEAD"], "git rev-parse HEAD"),
    ]);
    if (branchResult.failure !== undefined || headResult.failure !== undefined) {
      return stopped(
        "GIT_COMMAND_FAILED",
        branchResult.failure ?? headResult.failure ?? "Git identity is unavailable",
      );
    }
    if (workspaceRoot !== run.workspacePath || branchResult.value !== run.branchName) {
      return stopped("WORKSPACE_MISMATCH", "Workspace is not on the persisted owned run branch");
    }

    try {
      await assertIsolatedRunWorkspace(run);
    } catch (error) {
      return stopped(
        "WORKSPACE_MISMATCH",
        error instanceof Error ? error.message : "Execution isolation is unverified",
      );
    }
    const commitMessage = taskCommitMessage(task.id, task.title);
    let intent = repositories.taskCommitIntents.findByAttemptId(attempt.id);
    if (intent !== undefined) {
      if (
        !intentMatches(
          intent,
          request,
          workspaceRoot,
          run.branchName,
          checkpoint.gitHead,
          commitMessage,
          intendedPaths,
        )
      ) {
        return stopped("COMMIT_INTENT_CONFLICT", "Attempt already has different commit intent");
      }
    } else {
      if (task.state !== "VALIDATING" || headResult.value !== checkpoint.gitHead) {
        return stopped(
          "WORKSPACE_MISMATCH",
          "Workspace HEAD does not match the attempt checkpoint",
        );
      }
      const changes = await changedPaths(workspaceRoot);
      if (changes.status === "FAILED") {
        return stopped("GIT_COMMAND_FAILED", changes.reason);
      }
      const changedSet = new Set(changes.paths);
      if (intendedPaths.some((path) => !changedSet.has(path))) {
        return stopped(
          "NO_INTENDED_CHANGES",
          "Every intended path must have an observed change before commit",
          changes.paths.filter((path) => !intendedPaths.includes(path)),
        );
      }
      try {
        intent = repositories.taskCommitIntents.create({
          attemptId: request.attemptId,
          projectId: request.projectId,
          taskId: request.taskId,
          workspacePath: workspaceRoot,
          branchName: run.branchName,
          expectedHead: checkpoint.gitHead,
          commitMessage,
          intendedPaths,
          createdAt: request.committedAt,
        });
      } catch (error) {
        return stopped(
          "PERSISTENCE_FAILED",
          error instanceof Error ? error.message : "Could not persist task commit intent",
          changes.paths.filter((path) => !intendedPaths.includes(path)),
        );
      }
    }

    if (task.state === "COMPLETED") {
      if (
        attempt.commitSha === undefined ||
        intent.commitSha !== attempt.commitSha ||
        headResult.value !== attempt.commitSha
      ) {
        return stopped("WORKSPACE_MISMATCH", "Completed task commit evidence is inconsistent");
      }
      const verificationFailure = await verifyCommit(
        workspaceRoot,
        attempt.commitSha,
        intent,
        evidence,
      );
      if (verificationFailure !== undefined) {
        return stopped("COMMIT_VERIFICATION_FAILED", verificationFailure, [], attempt.commitSha);
      }
      return Object.freeze({
        status: "COMMITTED" as const,
        commitSha: attempt.commitSha,
        commitMessage,
        intendedPaths,
        preservedChangedPaths: Object.freeze([]),
        recoveredExistingCommit: true,
      });
    }

    let commitSha = intent.commitSha;
    let recoveredExistingCommit = commitSha !== undefined;
    if (commitSha === undefined && headResult.value !== intent.expectedHead) {
      if (headResult.value === undefined) {
        return stopped("GIT_COMMAND_FAILED", "Git HEAD is unavailable");
      }
      commitSha = headResult.value;
      const recoveryFailure = await verifyCommit(workspaceRoot, commitSha, intent, evidence);
      if (recoveryFailure !== undefined) {
        return stopped("WORKSPACE_MISMATCH", recoveryFailure, [], commitSha);
      }
      recoveredExistingCommit = true;
    }

    let preservedChangedPaths: readonly string[] = [];
    if (commitSha === undefined) {
      const permission =
        request.gitAuthorization === undefined
          ? new PermissionPolicyService(this.database).authorize({
              projectId: request.projectId,
              operation: "git_mutation",
              actor: request.actor,
              reason: `Create the validated atomic task commit for ${request.taskId}`,
              occurredAt: request.committedAt,
            })
          : { authorization: request.gitAuthorization };
      if (permission.authorization === undefined) {
        return stopped(
          permission.decision.disposition === "deny" ? "POLICY_DENIED" : "POLICY_ASK_USER",
          permission.decision.reason,
        );
      }
      const before = await changedPaths(workspaceRoot);
      if (before.status === "FAILED") return stopped("GIT_COMMAND_FAILED", before.reason);
      preservedChangedPaths = immutableStrings(
        before.paths.filter((path) => !intendedPaths.includes(path)),
      );
      try {
        await assertValidationWorkspaceUnchanged(evidence, intendedPaths);
      } catch (error) {
        return stopped(
          "WORKSPACE_MISMATCH",
          error instanceof Error ? error.message : "Validation workspace changed",
          preservedChangedPaths,
        );
      }
      const stagePaths: string[] = [];
      for (const path of intendedPaths) {
        const current = await inspectCurrentPath(workspaceRoot, path, false);
        if (current.kind !== "ABSENT" || current.indexHash !== undefined) stagePaths.push(path);
      }
      const stage =
        stagePaths.length === 0
          ? { exitCode: 0, stdout: "", stderr: "", timedOut: false }
          : await runAuthorizedGitMutation(
              permission.authorization,
              request.projectId,
              workspaceRoot,
              ["add", "--all", "--", ...stagePaths.map((path) => `:(literal)${path}`)],
            );
      if (stage.exitCode !== 0) {
        return stopped("GIT_COMMAND_FAILED", gitFailure("git add", stage), preservedChangedPaths);
      }
      const commit = await runAuthorizedGitMutation(
        permission.authorization,
        request.projectId,
        workspaceRoot,
        [
          "commit",
          "--quiet",
          "--only",
          "--message",
          intent.commitMessage,
          "--",
          ...intendedPaths.map((path) => `:(literal)${path}`),
        ],
      );
      if (commit.exitCode !== 0) {
        return stopped(
          "GIT_COMMAND_FAILED",
          gitFailure("git commit", commit),
          preservedChangedPaths,
        );
      }
      const committedHead = await requiredGit(
        workspaceRoot,
        ["rev-parse", "HEAD"],
        "git rev-parse HEAD",
      );
      if (committedHead.failure !== undefined || committedHead.value === undefined) {
        return stopped(
          "COMMIT_VERIFICATION_FAILED",
          committedHead.failure ?? "Committed HEAD is unavailable",
          preservedChangedPaths,
        );
      }
      commitSha = committedHead.value;
      const verificationFailure = await verifyCommit(workspaceRoot, commitSha, intent, evidence);
      if (verificationFailure !== undefined) {
        return stopped(
          "COMMIT_VERIFICATION_FAILED",
          verificationFailure,
          preservedChangedPaths,
          commitSha,
        );
      }
      try {
        intent = repositories.taskCommitIntents.recordCommit(
          request.attemptId,
          commitSha,
          request.committedAt,
        );
      } catch (error) {
        return stopped(
          "PERSISTENCE_FAILED",
          error instanceof Error ? error.message : "Could not persist the Git commit outcome",
          preservedChangedPaths,
          commitSha,
        );
      }
    } else {
      const verificationFailure = await verifyCommit(workspaceRoot, commitSha, intent, evidence);
      if (verificationFailure !== undefined) {
        return stopped(
          "COMMIT_VERIFICATION_FAILED",
          verificationFailure,
          preservedChangedPaths,
          commitSha,
        );
      }
    }

    if (intent.commitSha === undefined) {
      try {
        intent = repositories.taskCommitIntents.recordCommit(
          request.attemptId,
          commitSha,
          request.committedAt,
        );
      } catch (error) {
        return stopped(
          "PERSISTENCE_FAILED",
          error instanceof Error ? error.message : "Could not persist the recovered Git commit",
          preservedChangedPaths,
          commitSha,
        );
      }
    }

    try {
      const sourcePreserved = await publishTaskCommit(this.database, {
        run,
        attemptId: attempt.id,
        expectedHead: intent.expectedHead,
        commitSha,
        intendedPaths,
        occurredAt: request.committedAt,
        actor: request.actor,
        ...(request.gitAuthorization === undefined
          ? {}
          : { gitAuthorization: request.gitAuthorization }),
      });
      preservedChangedPaths = immutableStrings(
        new Set([...preservedChangedPaths, ...sourcePreserved]),
      );
    } catch (error) {
      return stopped(
        "PUBLICATION_STOPPED",
        error instanceof Error ? error.message : "Source publication stopped safely",
        preservedChangedPaths,
        commitSha,
      );
    }
    const latestTask = repositories.tasks.findById(task.id);
    if (
      repositories.validationRuns
        .listByTaskId(task.id)
        .filter((candidate) => candidate.attemptId === attempt.id)
        .at(-1)?.id !== validation.id
    ) {
      return stopped(
        "NOT_VALIDATED",
        "Validation was superseded before task completion",
        preservedChangedPaths,
        commitSha,
      );
    }
    if (
      latestTask?.state !== "VALIDATING" ||
      repositories.attempts.listByTaskId(task.id).at(-1)?.id !== attempt.id
    ) {
      return stopped(
        "ATTEMPT_MISMATCH",
        "Task state changed before commit completion",
        [],
        commitSha,
      );
    }
    const transition = stateTransitionService.transitionTask(latestTask, "COMPLETED", {
      actor: request.actor,
      occurredAt: request.committedAt,
      reason: `Validation passed and task commit ${commitSha} was verified`,
    });
    try {
      this.database.persistTaskCommitCompletion({
        attemptId: request.attemptId,
        validationRunId: request.validationRunId,
        commitSha,
        commitRecordedEventId: request.commitRecordedEventId,
        completionEventId: request.completionEventId,
        attemptCompletedEventId:
          request.attemptCompletedEventId ??
          eventIdSchema.parse(`${request.completionEventId}:attempt`),
        transition,
      });
    } catch (error) {
      return stopped(
        "PERSISTENCE_FAILED",
        error instanceof Error ? error.message : "Could not atomically complete the task",
        preservedChangedPaths,
        commitSha,
      );
    }

    return Object.freeze({
      status: "COMMITTED" as const,
      commitSha,
      commitMessage,
      intendedPaths,
      preservedChangedPaths,
      recoveredExistingCommit,
    });
  }
}
