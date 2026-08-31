import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import type {
  AgentRun,
  Attempt,
  Checkpoint,
  Project,
  Task,
  TaskState,
  ValidationRun,
} from "@densa-ade/protocol";

import type { PersistedEvent } from "./event-publisher.js";
import type {
  DensaAdeRepositories,
  TaskPublicationIntentRecord,
} from "./persistence/repositories.js";
import { assertIsolatedRunWorkspace, workspaceGit } from "./isolated-run-workspace.js";

const execFileAsync = promisify(execFile);
const ACTIVE_TASK_STATES = new Set<TaskState>(["RUNNING", "RETRYING", "VALIDATING"]);
const GIT_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const GIT_TIMEOUT_MS = 10_000;
const UNTRACKED_ENTRY_LIMIT = 10_000;
const UNTRACKED_BYTE_LIMIT = 32 * 1024 * 1024;
const PROCESS_OUTPUT_LIMIT_BYTES = 16 * 1024;
const PROCESS_TIMEOUT_MS = 5_000;

export type ProcessStatus = "alive" | "gone" | "unknown";

export interface ProcessObservation {
  readonly processId: number;
  readonly status: ProcessStatus;
  readonly identityVerified?: boolean;
  readonly reason?: string;
}

export interface ProcessProbe {
  inspect(
    processId: number,
    expectedIdentity?: string,
  ): ProcessObservation | Promise<ProcessObservation>;
}

export interface WorkspaceSnapshot {
  readonly gitHead: string;
  readonly gitStatus: string;
  readonly fingerprint: string;
}

export type WorkspaceObservation =
  | { readonly status: "available"; readonly snapshot: Readonly<WorkspaceSnapshot> }
  | { readonly status: "unknown"; readonly reason: string };

export interface WorkspaceProbe {
  inspect(workspacePath: string): WorkspaceObservation | Promise<WorkspaceObservation>;
}

export type RecoveryClassification =
  | "CLEANLY_IDLE"
  | "ACTIVE_PROCESS_ALIVE"
  | "TASK_PROCESS_GONE"
  | "VALIDATION_INTERRUPTED"
  | "WORKSPACE_DIVERGED"
  | "UNKNOWN";

export type RecoveryAction =
  | "NONE"
  | "KEEP_MONITORING"
  | "MARK_TASK_INTERRUPTED"
  | "RERUN_VALIDATION"
  | "RECONCILE_WORKSPACE"
  | "REQUEST_USER_INSPECTION";

export interface RecoveryTaskStateRecommendation {
  readonly taskId: Task["id"];
  readonly state: "INTERRUPTED";
}

export interface RecoveryEvidence {
  readonly project: Project;
  readonly task?: Task | undefined;
  readonly attempt?: Attempt | undefined;
  readonly agentRun?: AgentRun | undefined;
  readonly validationRun?: ValidationRun | undefined;
  readonly checkpoint?: Checkpoint | undefined;
  readonly lastEvent?: PersistedEvent | undefined;
  readonly process?: ProcessObservation | undefined;
  readonly workspace: WorkspaceObservation;
  readonly executionWorkspace?: WorkspaceObservation;
  readonly publication?: TaskPublicationIntentRecord;
  readonly workspaceDiverged?: boolean;
}

export interface RecoveryPlan {
  readonly classification: RecoveryClassification;
  readonly reason: string;
  readonly actions: readonly RecoveryAction[];
  readonly taskStateRecommendation?: RecoveryTaskStateRecommendation;
  readonly automaticActionsPerformed: false;
  readonly evidence?: RecoveryEvidence;
}

export interface RecoveryInspectionRequest {
  readonly projectId: Project["id"];
  readonly workspacePath: string;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export type ProcessIdentitySource = (processId: number) => string | Promise<string>;

async function psProcessIdentity(processId: number): Promise<string> {
  const observation = await execFileAsync(
    "ps",
    ["-p", String(processId), "-o", "lstart=", "-o", "comm="],
    {
      encoding: "utf8",
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        LC_ALL: "C",
      },
      maxBuffer: PROCESS_OUTPUT_LIMIT_BYTES,
      timeout: PROCESS_TIMEOUT_MS,
    },
  );
  return observation.stdout;
}

/** Signal-zero liveness plus hashed OS start-time/executable identity to reject PID reuse. */
export class NodeProcessProbe implements ProcessProbe {
  constructor(private readonly identitySource: ProcessIdentitySource = psProcessIdentity) {}

  async captureIdentity(processId: number): Promise<string> {
    const identity = (await this.identitySource(processId)).trim();
    if (identity.length === 0) {
      throw new Error(`Process ${String(processId)} has no observable identity`);
    }
    return hashText(identity);
  }

  async inspect(processId: number, expectedIdentity?: string): Promise<ProcessObservation> {
    try {
      process.kill(processId, 0);
    } catch (error) {
      const code = errorCode(error);
      if (code === "ESRCH") {
        return Object.freeze({ processId, status: "gone" as const });
      }
      if (code !== "EPERM") {
        return Object.freeze({
          processId,
          status: "unknown" as const,
          reason:
            code === undefined ? "Process liveness probe failed" : `Process probe failed: ${code}`,
        });
      }
    }

    if (expectedIdentity === undefined) {
      return Object.freeze({
        processId,
        status: "unknown" as const,
        reason: "The PID exists but no persisted process identity can exclude PID reuse",
      });
    }
    try {
      const observedIdentity = await this.captureIdentity(processId);
      if (observedIdentity !== expectedIdentity) {
        return Object.freeze({
          processId,
          status: "gone" as const,
          identityVerified: false,
          reason: "The recorded PID now belongs to a different process identity",
        });
      }
      return Object.freeze({ processId, status: "alive" as const, identityVerified: true });
    } catch (error) {
      const code = errorCode(error);
      return Object.freeze({
        processId,
        status: "unknown" as const,
        reason:
          code === undefined
            ? "Process identity inspection failed"
            : `Process identity inspection failed: ${code}`,
      });
    }
  }
}

function gitOptions(workspacePath: string) {
  return {
    cwd: workspacePath,
    encoding: "utf8" as const,
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
    },
    maxBuffer: GIT_OUTPUT_LIMIT_BYTES,
    timeout: GIT_TIMEOUT_MS,
  };
}

async function hashUntrackedEntries(workspacePath: string, rawPaths: string): Promise<string> {
  const relativePaths = rawPaths
    .split("\0")
    .filter((entry) => entry.length > 0)
    .sort();
  if (relativePaths.length > UNTRACKED_ENTRY_LIMIT) {
    throw new Error(`Workspace has more than ${String(UNTRACKED_ENTRY_LIMIT)} untracked entries`);
  }

  const root = path.resolve(workspacePath);
  const rootPrefix = `${root}${path.sep}`;
  const aggregate = createHash("sha256");
  let retainedBytes = 0;
  for (const relativePath of relativePaths) {
    const absolutePath = path.resolve(root, relativePath);
    if (!absolutePath.startsWith(rootPrefix)) {
      throw new Error("Git returned an untracked path outside the workspace");
    }
    const metadata = await lstat(absolutePath);
    aggregate.update(`path\0${relativePath}\0mode\0${String(metadata.mode)}\0`);
    if (metadata.isSymbolicLink()) {
      aggregate.update(`symlink\0${await readlink(absolutePath)}\0`);
      continue;
    }
    if (!metadata.isFile()) {
      throw new Error(`Unsupported untracked entry type: ${relativePath}`);
    }
    const fileHash = createHash("sha256");
    for await (const chunk of createReadStream(absolutePath)) {
      const buffer = chunk as Buffer;
      retainedBytes += buffer.byteLength;
      if (retainedBytes > UNTRACKED_BYTE_LIMIT) {
        throw new Error(
          `Untracked workspace content exceeds ${String(UNTRACKED_BYTE_LIMIT)} bytes`,
        );
      }
      fileHash.update(buffer);
    }
    aggregate.update(`file\0${fileHash.digest("hex")}\0`);
  }
  return aggregate.digest("hex");
}

async function captureWorkspaceSnapshot(workspacePath: string): Promise<WorkspaceSnapshot> {
  const options = gitOptions(workspacePath);
  const [head, status, diff, untracked, indexDiff] = await Promise.all([
    execFileAsync("git", ["-c", "core.fsmonitor=false", "rev-parse", "--verify", "HEAD"], options),
    execFileAsync(
      "git",
      [
        "-c",
        "core.fsmonitor=false",
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--no-renames",
      ],
      options,
    ),
    execFileAsync(
      "git",
      [
        "-c",
        "core.fsmonitor=false",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--binary",
        "HEAD",
        "--",
      ],
      options,
    ),
    execFileAsync(
      "git",
      ["-c", "core.fsmonitor=false", "ls-files", "--others", "--exclude-standard", "-z"],
      options,
    ),
    execFileAsync(
      "git",
      [
        "-c",
        "core.fsmonitor=false",
        "diff",
        "--cached",
        "--no-ext-diff",
        "--no-textconv",
        "--binary",
        "HEAD",
        "--",
      ],
      options,
    ),
  ]);
  const gitHead = head.stdout.trim();
  const gitStatus = status.stdout;
  const untrackedHash = await hashUntrackedEntries(workspacePath, untracked.stdout);
  const fingerprint = hashText(
    JSON.stringify({
      gitHead,
      gitStatus,
      diff: diff.stdout,
      untrackedHash,
      ...(indexDiff.stdout.length === 0 ? {} : { indexDiff: indexDiff.stdout }),
    }),
  );
  return Object.freeze({ gitHead, gitStatus, fingerprint });
}

/** Read-only, bounded Git snapshot used only to compare against a persisted checkpoint. */
export class GitWorkspaceProbe implements WorkspaceProbe {
  async inspect(workspacePath: string): Promise<WorkspaceObservation> {
    try {
      const first = await captureWorkspaceSnapshot(workspacePath);
      const second = await captureWorkspaceSnapshot(workspacePath);
      if (
        first.gitHead !== second.gitHead ||
        first.gitStatus !== second.gitStatus ||
        first.fingerprint !== second.fingerprint
      ) {
        return Object.freeze({
          status: "unknown" as const,
          reason: "Git workspace changed while recovery evidence was being captured",
        });
      }
      return Object.freeze({
        status: "available" as const,
        snapshot: second,
      });
    } catch (error) {
      const code = errorCode(error);
      return Object.freeze({
        status: "unknown" as const,
        reason:
          code === undefined ? "Git workspace inspection failed" : `Git inspection failed: ${code}`,
      });
    }
  }
}

function latest<Value>(values: readonly Value[]): Value | undefined {
  return values.at(-1);
}

function immutablePlan(
  plan: Omit<RecoveryPlan, "actions" | "automaticActionsPerformed"> & {
    readonly actions: readonly RecoveryAction[];
  },
): RecoveryPlan {
  return Object.freeze({
    ...plan,
    actions: Object.freeze([...plan.actions]),
    automaticActionsPerformed: false as const,
  });
}

function persistedEventContradiction(
  project: Project,
  tasks: readonly Task[],
  repositories: DensaAdeRepositories,
): string | undefined {
  const facts = [
    {
      entity: project,
      event: repositories.events.latest(project.id, { types: ["PROJECT_STATE_CHANGED"] }),
    },
    ...repositories.phases.listByProjectId(project.id).map((phase) => ({
      entity: phase,
      event: repositories.events.latest(project.id, {
        phaseId: phase.id,
        types: ["PHASE_STATE_CHANGED"],
      }),
    })),
    ...tasks.map((task) => ({
      entity: task,
      event: repositories.events.latest(project.id, {
        taskId: task.id,
        types: ["TASK_STATE_CHANGED"],
      }),
    })),
  ];
  for (const { entity, event } of facts) {
    if (
      event !== undefined &&
      (event.eventVersion !== 1 || event.payload["state"] !== entity.state)
    ) {
      return "The latest lifecycle state event disagrees with its snapshot or has an unsupported version";
    }
  }
  return undefined;
}

interface AttemptHistoryEntry {
  readonly attempt: Attempt;
  readonly agentRun?: AgentRun | undefined;
}

interface AttemptHistoryInspection {
  readonly latest?: AttemptHistoryEntry | undefined;
  readonly unfinished?: AttemptHistoryEntry | undefined;
  readonly issue?: string | undefined;
}

function inspectAttemptHistory(
  task: Task,
  repositories: DensaAdeRepositories,
): AttemptHistoryInspection {
  const entries = repositories.attempts.listByTaskId(task.id).map((attempt) => ({
    attempt,
    agentRun: repositories.agentRuns.findByAttemptId(attempt.id),
  }));
  for (const entry of entries) {
    if (
      (entry.attempt.completedAt === undefined &&
        entry.agentRun?.completedAt !== undefined &&
        task.state !== "VALIDATING") ||
      (entry.attempt.completedAt !== undefined &&
        entry.agentRun !== undefined &&
        entry.agentRun.completedAt === undefined)
    ) {
      return {
        latest: latest(entries),
        issue: `Attempt ${entry.attempt.id} disagrees with its agent-run outcome`,
      };
    }
  }
  const unfinished = entries.filter(
    (entry) =>
      entry.attempt.completedAt === undefined ||
      (entry.agentRun !== undefined && entry.agentRun.completedAt === undefined),
  );
  if (unfinished.length > 1) {
    return {
      latest: latest(entries),
      issue: `Task ${task.id} has more than one unfinished attempt/run`,
    };
  }
  const unfinishedEntry = unfinished[0];
  if (unfinishedEntry !== undefined && unfinishedEntry !== latest(entries)) {
    return {
      latest: latest(entries),
      unfinished: unfinishedEntry,
      issue: `Task ${task.id} has an unfinished older attempt/run`,
    };
  }
  return { latest: latest(entries), unfinished: unfinishedEntry };
}

function inactiveLifecycleContradiction(
  project: Project,
  tasks: readonly Task[],
  repositories: DensaAdeRepositories,
): string | undefined {
  if (project.state === "RUNNING") {
    return "Project is RUNNING but no active task is recoverably identified";
  }
  if (tasks.some((task) => task.state === "INTERRUPTED")) {
    return "An INTERRUPTED task still requires an explicit recovery decision";
  }
  if (
    project.state === "COMPLETED" &&
    tasks.some((task) => task.state !== "COMPLETED" && task.state !== "CANCELLED")
  ) {
    return "Completed project contains a nonterminal task";
  }
  if (
    project.state === "WAITING_FOR_USER" &&
    !tasks.some((task) => task.state === "WAITING_FOR_USER")
  ) {
    return "Project waits for the user but no task records that wait";
  }
  if (
    project.state === "WAITING_FOR_USAGE" &&
    !tasks.some((task) => task.state === "WAITING_FOR_USAGE")
  ) {
    return "Project waits for usage but no task records that wait";
  }
  for (const task of tasks) {
    const attemptHistory = inspectAttemptHistory(task, repositories);
    if (attemptHistory.issue !== undefined) return attemptHistory.issue;
    if (attemptHistory.unfinished !== undefined) {
      return `Inactive task ${task.id} has an unfinished attempt/run`;
    }
    if (
      repositories.validationRuns
        .listByTaskId(task.id)
        .some((validationRun) => validationRun.completedAt === undefined)
    ) {
      return `Inactive task ${task.id} has an unfinished validation run`;
    }
  }
  return undefined;
}

export interface RecoveryInspectorOptions {
  readonly processProbe?: ProcessProbe;
  readonly workspaceProbe?: WorkspaceProbe;
}

/**
 * Reconstructs restart evidence without mutating authoritative state, the workspace, or processes.
 * The returned recommendation must later pass through StateTransitionService before persistence.
 */
export class RecoveryInspector {
  readonly #processProbe: ProcessProbe;
  readonly #workspaceProbe: WorkspaceProbe;

  constructor(
    private readonly repositories: DensaAdeRepositories,
    options: RecoveryInspectorOptions = {},
  ) {
    this.#processProbe = options.processProbe ?? new NodeProcessProbe();
    this.#workspaceProbe = options.workspaceProbe ?? new GitWorkspaceProbe();
  }

  async inspect(request: RecoveryInspectionRequest): Promise<RecoveryPlan> {
    try {
      const before = this.#persistedEvidence(request.projectId);
      const result = await this.#inspect(request);
      if (before !== this.#persistedEvidence(request.projectId)) {
        return immutablePlan({
          classification: "UNKNOWN",
          reason: "Authoritative recovery evidence changed during inspection",
          actions: ["REQUEST_USER_INSPECTION"],
        });
      }
      return result;
    } catch {
      return immutablePlan({
        classification: "UNKNOWN",
        reason: "Recovery evidence could not be safely inspected",
        actions: ["REQUEST_USER_INSPECTION"],
      });
    }
  }

  #persistedEvidence(projectId: Project["id"]): string {
    const tasks = this.repositories.tasks.listByProjectId(projectId);
    return JSON.stringify({
      project: this.repositories.projects.findById(projectId),
      phases: this.repositories.phases.listByProjectId(projectId),
      tasks: tasks.map((task) => ({
        task,
        attempts: this.repositories.attempts.listByTaskId(task.id).map((attempt) => ({
          attempt,
          run: this.repositories.agentRuns.findByAttemptId(attempt.id),
          publication: this.repositories.taskPublicationIntents.findByAttemptId(attempt.id),
        })),
        validations: this.repositories.validationRuns.listByTaskId(task.id),
      })),
      checkpoints: this.repositories.checkpoints.listByProjectId(projectId),
      workspaceOwnership: this.repositories.densaAdeRunBranches.findByProjectId(projectId),
      lastEvent: this.repositories.events.latest(projectId),
    });
  }

  async #inspect(request: RecoveryInspectionRequest): Promise<RecoveryPlan> {
    const project = this.repositories.projects.findById(request.projectId);
    if (project === undefined) {
      return immutablePlan({
        classification: "UNKNOWN",
        reason: `Project ${request.projectId} is not present in authoritative state`,
        actions: ["REQUEST_USER_INSPECTION"],
      });
    }

    const tasks = this.repositories.tasks.listByProjectId(project.id);
    const activeTasks = tasks.filter((task) => ACTIVE_TASK_STATES.has(task.state));
    const checkpoint = latest(this.repositories.checkpoints.listByProjectId(project.id));
    const lastEvent = this.repositories.events.latest(project.id);
    const ownership = this.repositories.densaAdeRunBranches.findByProjectId(project.id);
    let executionWorkspace: WorkspaceObservation | undefined;
    if (ownership?.sourceWorkspacePath !== undefined) {
      if (
        ![ownership.sourceWorkspacePath, ownership.workspacePath].includes(
          await realpath(request.workspacePath),
        )
      )
        throw new Error("Recovery request does not match persisted workspace ownership");
      await assertIsolatedRunWorkspace(ownership);
      if (
        (
          await workspaceGit(ownership.sourceWorkspacePath, [
            "symbolic-ref",
            "--quiet",
            "--short",
            "HEAD",
          ])
        ).trim() !== ownership.sourceBranch
      )
        throw new Error("Recovery source branch no longer matches persisted ownership");
      executionWorkspace = await this.#workspaceProbe.inspect(ownership.workspacePath);
    }
    const workspace = await this.#workspaceProbe.inspect(
      ownership?.sourceWorkspacePath ?? request.workspacePath,
    );
    const common = {
      project,
      checkpoint,
      lastEvent,
      workspace,
      ...(executionWorkspace === undefined ? {} : { executionWorkspace }),
    };

    if (workspace.status === "unknown") {
      return immutablePlan({
        classification: "UNKNOWN",
        reason: workspace.reason,
        actions: ["REQUEST_USER_INSPECTION"],
        evidence: common,
      });
    }
    if (executionWorkspace?.status === "unknown")
      return immutablePlan({
        classification: "UNKNOWN",
        reason: executionWorkspace.reason,
        actions: ["REQUEST_USER_INSPECTION"],
        evidence: common,
      });
    if (
      checkpoint?.gitHead === undefined ||
      checkpoint.gitStatus === undefined ||
      checkpoint.workspaceFingerprint === undefined
    ) {
      return immutablePlan({
        classification: "UNKNOWN",
        reason: "The latest persisted checkpoint has no complete Git snapshot",
        actions: ["REQUEST_USER_INSPECTION"],
        evidence: common,
      });
    }

    const workspaceDiverged =
      workspace.snapshot.gitHead !== checkpoint.gitHead ||
      workspace.snapshot.gitStatus !== checkpoint.gitStatus ||
      workspace.snapshot.fingerprint !== checkpoint.workspaceFingerprint ||
      (executionWorkspace?.status === "available" &&
        (executionWorkspace.snapshot.gitHead !== checkpoint.gitHead ||
          executionWorkspace.snapshot.gitStatus !== checkpoint.gitStatus ||
          executionWorkspace.snapshot.fingerprint !== checkpoint.workspaceFingerprint));
    const eventContradiction = persistedEventContradiction(project, tasks, this.repositories);
    if (eventContradiction !== undefined) {
      return immutablePlan({
        classification: "UNKNOWN",
        reason: eventContradiction,
        actions: ["REQUEST_USER_INSPECTION"],
        evidence: { ...common, workspaceDiverged },
      });
    }
    if (activeTasks.length > 1) {
      return immutablePlan({
        classification: "UNKNOWN",
        reason: "More than one task is active despite the v0.1 serial-worker invariant",
        actions: ["REQUEST_USER_INSPECTION"],
        evidence: { ...common, workspaceDiverged },
      });
    }
    if (activeTasks.length === 1 && project.state !== "RUNNING") {
      return immutablePlan({
        classification: "UNKNOWN",
        reason: `An active task conflicts with project state ${project.state}`,
        actions: ["REQUEST_USER_INSPECTION"],
        evidence: { ...common, task: activeTasks[0], workspaceDiverged },
      });
    }

    const task = activeTasks[0];
    for (const inactiveTask of tasks.filter(
      (candidate) => !ACTIVE_TASK_STATES.has(candidate.state),
    )) {
      const history = inspectAttemptHistory(inactiveTask, this.repositories);
      if (
        history.issue !== undefined ||
        history.unfinished !== undefined ||
        this.repositories.validationRuns
          .listByTaskId(inactiveTask.id)
          .some((run) => run.completedAt === undefined)
      ) {
        return immutablePlan({
          classification: "UNKNOWN",
          reason:
            history.issue ?? `Inactive task ${inactiveTask.id} has unfinished lifecycle evidence`,
          actions: ["REQUEST_USER_INSPECTION"],
          evidence: { ...common, workspaceDiverged },
        });
      }
    }
    if (task === undefined) {
      const contradiction = inactiveLifecycleContradiction(project, tasks, this.repositories);
      if (contradiction !== undefined) {
        return immutablePlan({
          classification: "UNKNOWN",
          reason: contradiction,
          actions: ["REQUEST_USER_INSPECTION"],
          evidence: { ...common, workspaceDiverged },
        });
      }
      if (workspaceDiverged) {
        return immutablePlan({
          classification: "WORKSPACE_DIVERGED",
          reason: "The current Git snapshot differs from the last persisted checkpoint",
          actions: ["RECONCILE_WORKSPACE"],
          evidence: { ...common, workspaceDiverged },
        });
      }
      return immutablePlan({
        classification: "CLEANLY_IDLE",
        reason: "No task is active and the workspace matches the last checkpoint",
        actions: ["NONE"],
        evidence: { ...common, workspaceDiverged },
      });
    }

    const attemptHistory = inspectAttemptHistory(task, this.repositories);
    const attempt = attemptHistory.latest?.attempt;
    const agentRun = attemptHistory.latest?.agentRun;
    if (attemptHistory.issue !== undefined) {
      return immutablePlan({
        classification: "UNKNOWN",
        reason: attemptHistory.issue,
        actions: ["REQUEST_USER_INSPECTION"],
        evidence: { ...common, task, attempt, agentRun, workspaceDiverged },
      });
    }
    if (task.state === "VALIDATING") {
      const validationRuns = this.repositories.validationRuns.listByTaskId(task.id);
      const validationRun = latest(validationRuns);
      if (validationRun?.attemptId !== undefined && validationRun.attemptId !== attempt?.id) {
        return immutablePlan({
          classification: "UNKNOWN",
          reason: "Validation run does not belong to the current attempt",
          actions: ["REQUEST_USER_INSPECTION"],
          evidence: { ...common, task, attempt, agentRun, validationRun, workspaceDiverged },
        });
      }
      const unfinishedValidationRuns = validationRuns.filter(
        (run) => run.completedAt === undefined,
      );
      if (
        unfinishedValidationRuns.length > 1 ||
        (unfinishedValidationRuns[0] !== undefined && unfinishedValidationRuns[0] !== validationRun)
      ) {
        return immutablePlan({
          classification: "UNKNOWN",
          reason: "VALIDATING task has an unfinished older or duplicate validation run",
          actions: ["REQUEST_USER_INSPECTION"],
          evidence: { ...common, task, attempt, agentRun, validationRun, workspaceDiverged },
        });
      }
      if (validationRun?.completedAt !== undefined) {
        const publication =
          attempt === undefined
            ? undefined
            : this.repositories.taskPublicationIntents.findByAttemptId(attempt.id);
        return immutablePlan({
          classification: "UNKNOWN",
          reason:
            publication === undefined
              ? "Task is VALIDATING but its latest validation run already has an outcome"
              : "A durable task publication intent requires verification of both workspaces and any retained publication locks before completion recovery",
          actions: ["REQUEST_USER_INSPECTION"],
          evidence: {
            ...common,
            task,
            attempt,
            agentRun,
            validationRun,
            workspaceDiverged,
            ...(publication === undefined ? {} : { publication }),
          },
        });
      }
      const unfinishedAttempt = attemptHistory.unfinished;
      if (
        unfinishedAttempt !== undefined &&
        unfinishedAttempt.agentRun?.completedAt === undefined
      ) {
        const unfinishedAgentRun = unfinishedAttempt.agentRun;
        if (unfinishedAgentRun === undefined) {
          return immutablePlan({
            classification: "UNKNOWN",
            reason: "VALIDATING task has an unfinished attempt without agent-run metadata",
            actions: ["REQUEST_USER_INSPECTION"],
            evidence: {
              ...common,
              task,
              attempt: unfinishedAttempt.attempt,
              validationRun,
              workspaceDiverged,
            },
          });
        }
        if (unfinishedAgentRun.processId === undefined) {
          return immutablePlan({
            classification: "UNKNOWN",
            reason: "VALIDATING task has no recorded worker process metadata",
            actions: ["REQUEST_USER_INSPECTION"],
            evidence: {
              ...common,
              task,
              attempt: unfinishedAttempt.attempt,
              agentRun: unfinishedAgentRun,
              validationRun,
              workspaceDiverged,
            },
          });
        }
        const processObservation = await this.#processProbe.inspect(
          unfinishedAgentRun.processId,
          unfinishedAgentRun.processIdentity,
        );
        const evidence = {
          ...common,
          task,
          attempt: unfinishedAttempt.attempt,
          agentRun: unfinishedAgentRun,
          validationRun,
          process: processObservation,
          workspaceDiverged,
        };
        if (processObservation.status === "unknown") {
          return immutablePlan({
            classification: "UNKNOWN",
            reason: processObservation.reason ?? "Process identity is unknown",
            actions: ["REQUEST_USER_INSPECTION"],
            evidence,
          });
        }
        if (processObservation.status === "alive" && processObservation.identityVerified === true) {
          return immutablePlan({
            classification: "ACTIVE_PROCESS_ALIVE",
            reason: "A verified worker is still alive while validation is pending",
            actions: ["KEEP_MONITORING"],
            evidence,
          });
        }
        if (processObservation.status === "alive") {
          return immutablePlan({
            classification: "UNKNOWN",
            reason: "The PID exists but worker identity was not verified",
            actions: ["REQUEST_USER_INSPECTION"],
            evidence,
          });
        }
      }
      return immutablePlan({
        classification: "VALIDATION_INTERRUPTED",
        reason:
          validationRun === undefined
            ? "Validation intent was persisted but no validation run was recorded"
            : "The recorded validation run has no persisted outcome",
        actions: ["MARK_TASK_INTERRUPTED", "RERUN_VALIDATION"],
        taskStateRecommendation: Object.freeze({ taskId: task.id, state: "INTERRUPTED" }),
        evidence: { ...common, task, attempt, agentRun, validationRun, workspaceDiverged },
      });
    }

    if (
      attempt === undefined ||
      attempt.completedAt !== undefined ||
      agentRun === undefined ||
      agentRun.completedAt !== undefined ||
      agentRun.processId === undefined
    ) {
      return immutablePlan({
        classification: "UNKNOWN",
        reason: "Active task has incomplete or contradictory attempt/agent process metadata",
        actions: ["REQUEST_USER_INSPECTION"],
        evidence: { ...common, task, attempt, agentRun, workspaceDiverged },
      });
    }

    const processObservation = await this.#processProbe.inspect(
      agentRun.processId,
      agentRun.processIdentity,
    );
    const evidence = {
      ...common,
      task,
      attempt,
      agentRun,
      process: processObservation,
      workspaceDiverged,
    };
    if (processObservation.status === "unknown") {
      return immutablePlan({
        classification: "UNKNOWN",
        reason: processObservation.reason ?? "Process liveness is unknown",
        actions: ["REQUEST_USER_INSPECTION"],
        evidence,
      });
    }
    if (processObservation.status === "alive" && processObservation.identityVerified !== true) {
      return immutablePlan({
        classification: "UNKNOWN",
        reason: "The PID exists but worker identity was not verified",
        actions: ["REQUEST_USER_INSPECTION"],
        evidence,
      });
    }
    if (processObservation.status === "alive") {
      return immutablePlan({
        classification: "ACTIVE_PROCESS_ALIVE",
        reason: "The persisted worker process still exists",
        actions: ["KEEP_MONITORING"],
        evidence,
      });
    }
    return immutablePlan({
      classification: "TASK_PROCESS_GONE",
      reason: "The task is active but its recorded worker process no longer exists",
      actions: ["MARK_TASK_INTERRUPTED"],
      taskStateRecommendation: Object.freeze({ taskId: task.id, state: "INTERRUPTED" }),
      evidence,
    });
  }
}
