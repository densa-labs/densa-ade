import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import process from "node:process";

import {
  isoTimestampSchema,
  type AttemptId,
  type Checkpoint,
  type CheckpointId,
  type EventId,
  type ProjectId,
  type TaskId,
} from "@densa-ade/protocol";

import { GitWorkspaceProbe, type WorkspaceSnapshot } from "./recovery-inspector.js";
import { type DensaAdeDatabase } from "./persistence/database.js";
import {
  type DensaAdeRunBranchRecord,
  type DensaAdeRepositories,
} from "./persistence/repositories.js";
import {
  PermissionPolicyService,
  assertAuthorizedOperation,
  type AuthorizedOperationContext,
} from "./permission-policy.js";
import {
  DENSA_ADE_RUN_BRANCH_PREFIX,
  WorkspacePreflight,
  type WorkspacePreflightResult,
} from "./workspace-preflight.js";

const GIT_TIMEOUT_MS = 10_000;
const GIT_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const GIT_ERROR_DETAIL_LIMIT = 4_096;
const PROJECT_SLUG_LIMIT = 40;

interface GitCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly errorCode?: string;
  readonly timedOut: boolean;
}

export type RunCheckpointStopCode =
  | "PREFLIGHT_STOPPED"
  | "POLICY_ASK_USER"
  | "POLICY_DENIED"
  | "BRANCH_COLLISION"
  | "RUN_OWNERSHIP_MISMATCH"
  | "GIT_COMMAND_FAILED"
  | "WORKSPACE_CHANGED"
  | "CHECKPOINT_CONFLICT"
  | "SNAPSHOT_UNAVAILABLE";

export interface PrepareTaskCheckpointRequest {
  readonly projectId: ProjectId;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly checkpointId: CheckpointId;
  readonly runActivatedEventId: EventId;
  readonly checkpointEventId: EventId;
  readonly workspacePath: string;
  readonly createdAt: string;
  readonly actor: string;
  readonly description?: string;
}

export interface PreparedTaskCheckpoint {
  readonly status: "READY";
  readonly branchAction: "CREATED" | "REUSED";
  readonly recoveredExistingCheckpoint: boolean;
  readonly run: DensaAdeRunBranchRecord;
  readonly checkpoint: Checkpoint;
  readonly preflight: WorkspacePreflightResult;
  readonly automaticActionsPerformed: readonly (
    "CREATED_RUN_BRANCH" | "SWITCHED_RUN_BRANCH" | "RECORDED_CHECKPOINT"
  )[];
}

export interface StoppedTaskCheckpoint {
  readonly status: "STOPPED";
  readonly code: RunCheckpointStopCode;
  readonly reason: string;
  readonly preflight: WorkspacePreflightResult;
  readonly run?: DensaAdeRunBranchRecord;
  readonly automaticActionsPerformed: readonly ("CREATED_RUN_BRANCH" | "SWITCHED_RUN_BRANCH")[];
}

export type PrepareTaskCheckpointResult = PreparedTaskCheckpoint | StoppedTaskCheckpoint;

export class RunCheckpointInvariantError extends Error {
  readonly code = "INTERNAL_INVARIANT_VIOLATION" as const;

  constructor(message: string) {
    super(message);
    this.name = "RunCheckpointInvariantError";
  }
}

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

function gitFailure(command: string, result: GitCommandResult): string {
  const detail = result.timedOut
    ? "timed out"
    : result.errorCode === undefined
      ? `exited ${String(result.exitCode)}`
      : `failed with ${result.errorCode}`;
  const stderr = result.stderr.trim();
  const boundedStderr =
    stderr.length <= GIT_ERROR_DETAIL_LIMIT
      ? stderr
      : `${stderr.slice(0, GIT_ERROR_DETAIL_LIMIT)}...[truncated]`;
  return `${command} ${detail}${boundedStderr.length === 0 ? "" : `: ${boundedStderr}`}`;
}

type BranchObservation =
  | { readonly status: "EXISTS"; readonly commit: string }
  | { readonly status: "MISSING" }
  | { readonly status: "FAILED"; readonly reason: string };

async function inspectBranch(
  workspacePath: string,
  branchName: string,
): Promise<BranchObservation> {
  const result = await runGit(workspacePath, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${branchName}^{commit}`,
  ]);
  if (result.exitCode === 1) return Object.freeze({ status: "MISSING" as const });
  if (result.exitCode !== 0) {
    return Object.freeze({
      status: "FAILED" as const,
      reason: gitFailure("git rev-parse", result),
    });
  }
  const commit = result.stdout.trim();
  if (commit.length === 0) {
    return Object.freeze({
      status: "FAILED" as const,
      reason: "git rev-parse returned an empty branch object ID",
    });
  }
  return Object.freeze({ status: "EXISTS" as const, commit });
}

async function switchBranch(
  authorization: AuthorizedOperationContext,
  projectId: ProjectId,
  workspacePath: string,
  branchName: string,
  startingCommit?: string,
): Promise<string | undefined> {
  assertAuthorizedOperation(authorization, projectId, "git_mutation");
  const args =
    startingCommit === undefined
      ? ["switch", "--quiet", branchName]
      : ["switch", "--quiet", "--create", branchName, "--no-track", startingCommit];
  const result = await runGit(workspacePath, args);
  return result.exitCode === 0 ? undefined : gitFailure("git switch", result);
}

function immutableActions<Action extends string>(actions: readonly Action[]): readonly Action[] {
  return Object.freeze([...actions]);
}

function stopped(
  code: RunCheckpointStopCode,
  reason: string,
  preflight: WorkspacePreflightResult,
  actions: StoppedTaskCheckpoint["automaticActionsPerformed"],
  run?: DensaAdeRunBranchRecord,
): StoppedTaskCheckpoint {
  return Object.freeze({
    status: "STOPPED" as const,
    code,
    reason,
    preflight,
    ...(run === undefined ? {} : { run }),
    automaticActionsPerformed: immutableActions(actions),
  });
}

function validateRequestGraph(
  repositories: DensaAdeRepositories,
  request: PrepareTaskCheckpointRequest,
): void {
  const project = repositories.projects.findById(request.projectId);
  const task = repositories.tasks.findById(request.taskId);
  const attempt = repositories.attempts.findById(request.attemptId);
  if (project === undefined) throw new RunCheckpointInvariantError("Checkpoint project is missing");
  if (task === undefined || task.projectId !== project.id) {
    throw new RunCheckpointInvariantError("Checkpoint task does not belong to the project");
  }
  if (attempt === undefined || attempt.taskId !== task.id) {
    throw new RunCheckpointInvariantError("Checkpoint attempt does not belong to the task");
  }
  isoTimestampSchema.parse(request.createdAt);
  if (request.actor.trim().length === 0) {
    throw new RunCheckpointInvariantError("Checkpoint actor must not be empty");
  }
}

function slugProjectId(projectId: string): string {
  const slug = projectId
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, PROJECT_SLUG_LIMIT)
    .replace(/-+$/gu, "");
  return slug.length === 0 ? "project" : slug;
}

/** Predictable, Git-safe name that does not expose an unbounded or unsafe project identifier. */
export function densaAdeRunBranchName(projectId: ProjectId | string): string {
  const hash = createHash("sha256").update(projectId).digest("hex").slice(0, 10);
  return `${DENSA_ADE_RUN_BRANCH_PREFIX}${slugProjectId(projectId)}-${hash}`;
}

/** @deprecated Use densaAdeRunBranchName. Retained for package consumer compatibility. */
export const densaRunBranchName = densaAdeRunBranchName;

function checkpointMatches(
  checkpoint: Checkpoint,
  request: PrepareTaskCheckpointRequest,
  run: DensaAdeRunBranchRecord,
): boolean {
  return (
    checkpoint.id === request.checkpointId &&
    checkpoint.projectId === request.projectId &&
    checkpoint.taskId === request.taskId &&
    checkpoint.attemptId === request.attemptId &&
    checkpoint.runBranch === run.branchName
  );
}

function snapshotMatchesCheckpoint(snapshot: WorkspaceSnapshot, checkpoint: Checkpoint): boolean {
  return (
    checkpoint.gitHead === snapshot.gitHead &&
    checkpoint.gitStatus === snapshot.gitStatus &&
    checkpoint.workspaceFingerprint === snapshot.fingerprint
  );
}

/**
 * The only P3M1 boundary allowed to establish a Densa ADE run branch and task checkpoint.
 * It persists branch intent before Git mutation and persists the verified outcome afterwards.
 */
export class RunCheckpointService {
  readonly #preflight: WorkspacePreflight;
  readonly #workspaceProbe: GitWorkspaceProbe;

  constructor(
    private readonly database: DensaAdeDatabase,
    options: {
      readonly preflight?: WorkspacePreflight;
      readonly workspaceProbe?: GitWorkspaceProbe;
    } = {},
  ) {
    this.#preflight = options.preflight ?? new WorkspacePreflight();
    this.#workspaceProbe = options.workspaceProbe ?? new GitWorkspaceProbe();
  }

  async prepareTask(request: PrepareTaskCheckpointRequest): Promise<PrepareTaskCheckpointResult> {
    validateRequestGraph(this.database.repositories, request);
    const actions: Array<"CREATED_RUN_BRANCH" | "SWITCHED_RUN_BRANCH"> = [];
    let preflight = await this.#preflight.inspect(request.workspacePath);
    if (preflight.decision.outcome === "STOP") {
      return stopped(
        "PREFLIGHT_STOPPED",
        preflight.decision.reason,
        preflight,
        actions,
        this.database.repositories.densaAdeRunBranches.findByProjectId(request.projectId),
      );
    }
    const workspaceRoot = preflight.repository.root;
    if (workspaceRoot === undefined || preflight.head.commit === undefined) {
      return stopped(
        "PREFLIGHT_STOPPED",
        "Workspace preflight did not resolve a Git root and starting commit",
        preflight,
        actions,
      );
    }

    const permission = new PermissionPolicyService(this.database).authorize({
      projectId: request.projectId,
      operation: "git_mutation",
      actor: request.actor,
      reason: `Prepare the owned run branch and checkpoint for task ${request.taskId}`,
      occurredAt: request.createdAt,
    });
    if (permission.authorization === undefined) {
      return stopped(
        permission.decision.disposition === "deny" ? "POLICY_DENIED" : "POLICY_ASK_USER",
        permission.decision.reason,
        preflight,
        actions,
      );
    }
    const authorization = permission.authorization;

    let run = this.database.repositories.densaAdeRunBranches.findByProjectId(request.projectId);
    let branchAction: "CREATED" | "REUSED" = "REUSED";
    if (run === undefined) {
      if (preflight.densaAdeRun.currentBranchOwned) {
        return stopped(
          "RUN_OWNERSHIP_MISMATCH",
          "Current reserved Densa ADE run branch has no persisted ownership for this project",
          preflight,
          actions,
        );
      }
      if (preflight.head.branch === undefined) {
        return stopped(
          "PREFLIGHT_STOPPED",
          "A source branch is required before Densa ADE can create a run branch",
          preflight,
          actions,
        );
      }
      const branchName = densaAdeRunBranchName(request.projectId);
      const collision = await inspectBranch(workspaceRoot, branchName);
      if (collision.status === "FAILED") {
        return stopped("GIT_COMMAND_FAILED", collision.reason, preflight, actions);
      }
      if (collision.status === "EXISTS") {
        return stopped(
          "BRANCH_COLLISION",
          `Run branch ${branchName} already exists without persisted Densa ADE ownership`,
          preflight,
          actions,
        );
      }
      run = this.database.repositories.densaAdeRunBranches.createCreating({
        projectId: request.projectId,
        workspacePath: workspaceRoot,
        branchName,
        sourceBranch: preflight.head.branch,
        startingCommit: preflight.head.commit,
        createdAt: request.createdAt,
      });
      const failure = await switchBranch(
        authorization,
        request.projectId,
        workspaceRoot,
        branchName,
        run.startingCommit,
      );
      if (failure !== undefined) {
        const createdRef = await inspectBranch(workspaceRoot, branchName);
        if (createdRef.status === "FAILED") {
          return stopped(
            "GIT_COMMAND_FAILED",
            `${failure}; branch verification also failed: ${createdRef.reason}`,
            preflight,
            actions,
            run,
          );
        }
        if (createdRef.status === "MISSING") {
          run = this.database.repositories.densaAdeRunBranches.fail(request.projectId, failure);
        }
        return stopped("GIT_COMMAND_FAILED", failure, preflight, actions, run);
      }
      actions.push("CREATED_RUN_BRANCH", "SWITCHED_RUN_BRANCH");
      branchAction = "CREATED";
    } else {
      if (run.workspacePath !== workspaceRoot) {
        return stopped(
          "RUN_OWNERSHIP_MISMATCH",
          "Persisted Densa ADE run belongs to a different workspace",
          preflight,
          actions,
          run,
        );
      }
      if (run.status === "FAILED") {
        return stopped(
          "RUN_OWNERSHIP_MISMATCH",
          `Persisted Densa ADE run creation failed: ${run.failureReason ?? "unknown failure"}`,
          preflight,
          actions,
          run,
        );
      }
      if (preflight.densaAdeRun.currentBranchOwned && preflight.head.branch !== run.branchName) {
        return stopped(
          "RUN_OWNERSHIP_MISMATCH",
          "Workspace is on a different reserved Densa ADE run branch",
          preflight,
          actions,
          run,
        );
      }
      const branch = await inspectBranch(workspaceRoot, run.branchName);
      if (branch.status === "FAILED") {
        return stopped("GIT_COMMAND_FAILED", branch.reason, preflight, actions, run);
      }
      const persistedBranchCommit = branch.status === "EXISTS" ? branch.commit : undefined;
      if (run.status === "CREATING") {
        if (persistedBranchCommit !== undefined && persistedBranchCommit !== run.startingCommit) {
          return stopped(
            "RUN_OWNERSHIP_MISMATCH",
            "Creating Densa ADE run branch no longer points at its persisted starting commit",
            preflight,
            actions,
            run,
          );
        }
        if (persistedBranchCommit === undefined) {
          const failure = await switchBranch(
            authorization,
            request.projectId,
            workspaceRoot,
            run.branchName,
            run.startingCommit,
          );
          if (failure !== undefined) {
            return stopped("GIT_COMMAND_FAILED", failure, preflight, actions, run);
          }
          actions.push("CREATED_RUN_BRANCH", "SWITCHED_RUN_BRANCH");
          branchAction = "CREATED";
        } else if (preflight.head.branch !== run.branchName) {
          const failure = await switchBranch(
            authorization,
            request.projectId,
            workspaceRoot,
            run.branchName,
          );
          if (failure !== undefined) {
            return stopped("GIT_COMMAND_FAILED", failure, preflight, actions, run);
          }
          actions.push("SWITCHED_RUN_BRANCH");
        }
      } else {
        if (persistedBranchCommit === undefined) {
          return stopped(
            "RUN_OWNERSHIP_MISMATCH",
            "Persisted active Densa ADE run branch is missing",
            preflight,
            actions,
            run,
          );
        }
        if (preflight.head.branch !== run.branchName) {
          const failure = await switchBranch(
            authorization,
            request.projectId,
            workspaceRoot,
            run.branchName,
          );
          if (failure !== undefined) {
            return stopped("GIT_COMMAND_FAILED", failure, preflight, actions, run);
          }
          actions.push("SWITCHED_RUN_BRANCH");
        }
      }
    }

    preflight = await this.#preflight.inspect(workspaceRoot);
    if (
      preflight.decision.outcome === "STOP" ||
      preflight.head.branch !== run.branchName ||
      preflight.head.commit === undefined
    ) {
      return stopped(
        "WORKSPACE_CHANGED",
        "Workspace changed while Densa ADE was establishing the run branch",
        preflight,
        actions,
        run,
      );
    }

    if (run.status === "CREATING") {
      const task = this.database.repositories.tasks.findById(request.taskId);
      if (task === undefined) throw new RunCheckpointInvariantError("Checkpoint task disappeared");
      run = this.database.transaction((repositories) => {
        const activated = repositories.densaAdeRunBranches.activate(
          request.projectId,
          request.createdAt,
        );
        repositories.events.append({
          id: request.runActivatedEventId,
          projectId: request.projectId,
          type: "DENSA_RUN_BRANCH_ACTIVATED",
          eventVersion: 1,
          occurredAt: request.createdAt,
          actor: request.actor,
          payload: {
            branchName: activated.branchName,
            sourceBranch: activated.sourceBranch,
            startingCommit: activated.startingCommit,
          },
        });
        return activated;
      });
    }

    const observation = await this.#workspaceProbe.inspect(workspaceRoot);
    if (observation.status !== "available") {
      return stopped("SNAPSHOT_UNAVAILABLE", observation.reason, preflight, actions, run);
    }
    const existing = this.database.repositories.checkpoints.findByAttemptId(request.attemptId);
    if (existing !== undefined) {
      if (!checkpointMatches(existing, request, run)) {
        return stopped(
          "CHECKPOINT_CONFLICT",
          "Attempt already has different persisted checkpoint metadata",
          preflight,
          actions,
          run,
        );
      }
      if (!snapshotMatchesCheckpoint(observation.snapshot, existing)) {
        return stopped(
          "WORKSPACE_CHANGED",
          "Workspace no longer matches the persisted attempt checkpoint",
          preflight,
          actions,
          run,
        );
      }
      return Object.freeze({
        status: "READY" as const,
        branchAction,
        recoveredExistingCheckpoint: true,
        run,
        checkpoint: existing,
        preflight,
        automaticActionsPerformed: immutableActions(actions),
      });
    }

    const task = this.database.repositories.tasks.findById(request.taskId);
    if (task === undefined) throw new RunCheckpointInvariantError("Checkpoint task disappeared");
    const checkpoint: Checkpoint = {
      id: request.checkpointId,
      projectId: request.projectId,
      taskId: request.taskId,
      attemptId: request.attemptId,
      runBranch: run.branchName,
      createdAt: request.createdAt,
      description: request.description ?? `Starting checkpoint for ${request.taskId}`,
      gitHead: observation.snapshot.gitHead,
      gitStatus: observation.snapshot.gitStatus,
      workspaceFingerprint: observation.snapshot.fingerprint,
    };
    this.database.transaction((repositories) => {
      repositories.checkpoints.create(checkpoint);
      repositories.events.append({
        id: request.checkpointEventId,
        projectId: request.projectId,
        phaseId: task.phaseId,
        taskId: request.taskId,
        type: "TASK_CHECKPOINT_CREATED",
        eventVersion: 1,
        occurredAt: request.createdAt,
        actor: request.actor,
        payload: {
          checkpointId: request.checkpointId,
          attemptId: request.attemptId,
          runBranch: run.branchName,
          startingCommit: observation.snapshot.gitHead,
          workspaceFingerprint: observation.snapshot.fingerprint,
        },
      });
    });

    return Object.freeze({
      status: "READY" as const,
      branchAction,
      recoveredExistingCheckpoint: false,
      run,
      checkpoint: Object.freeze(checkpoint),
      preflight,
      automaticActionsPerformed: immutableActions([...actions, "RECORDED_CHECKPOINT"]),
    });
  }
}
