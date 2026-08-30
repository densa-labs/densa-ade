import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import {
  eventIdSchema,
  isoTimestampSchema,
  type EventId,
  type JsonObject,
  type ProjectId,
} from "@densa-ade/protocol";

import {
  type ExecuteProjectLifecycleRequest,
  ProjectExecutionOrchestrator,
  type ProjectLifecycleResult,
} from "./execution-modes.js";
import { KeepAwakeManager } from "./keep-awake.js";
import { type DensaAdeDatabase } from "./persistence/database.js";
import {
  GitWorkspaceProbe,
  RecoveryInspector,
  type RecoveryPlan,
  type WorkspaceProbe,
  type WorkspaceSnapshot,
} from "./recovery-inspector.js";
import { stateTransitionService } from "./state-transitions.js";
import { WorkspacePreflight, type WorkspacePreflightResult } from "./workspace-preflight.js";

type ControlStatus =
  "running" | "pause_requested" | "paused" | "intervention_required" | "stop_requested" | "stopped";

interface StoredControl {
  readonly status: ControlStatus;
  readonly workspacePath: string;
  readonly requestedAt: string;
  readonly updatedAt: string;
  readonly snapshot?: Readonly<WorkspaceSnapshot>;
  readonly intervention?: RecontextualizationContext;
  readonly snapshotError?: string;
}

export interface RecontextualizationContext {
  readonly changedPaths: readonly string[];
  readonly previousGitHead: string;
  readonly currentGitHead: string;
  readonly detectedAt: string;
  readonly recoveryClassification: RecoveryPlan["classification"];
}

export interface ProjectControlRequest {
  readonly projectId: ProjectId;
  readonly workspacePath: string;
  readonly actor: string;
}

export interface ResumeProjectRequest extends ProjectControlRequest {
  /** Explicitly accepts the detected edits for task-packet rebuilding; no files are changed. */
  readonly acknowledgeIntervention?: boolean;
}

export type ProjectControlCommandResult = Readonly<{
  status: "REQUESTED" | "PAUSED" | "STOPPED" | "UNCHANGED" | "NOT_FOUND" | "REJECTED";
  projectId: ProjectId;
  reason: string;
}>;

export type ResumeProjectResult =
  | Readonly<{
      status: "RESUMED";
      projectId: ProjectId;
      recontextualization?: RecontextualizationContext;
    }>
  | Readonly<{
      status: "INTERVENTION_REQUIRED";
      projectId: ProjectId;
      recontextualization: RecontextualizationContext;
    }>
  | Readonly<{
      status: "BLOCKED" | "STOPPED" | "UNCHANGED" | "NOT_FOUND" | "REJECTED";
      projectId: ProjectId;
      reason: string;
    }>;

export type ControlledProjectLifecycleResult =
  | ProjectLifecycleResult
  | Readonly<{ status: "PAUSED" | "STOPPED"; projectId: ProjectId; reason: string }>;

interface ProjectLifecycleRunner {
  execute(request: ExecuteProjectLifecycleRequest): Promise<ProjectLifecycleResult>;
}

interface ReadonlyInspector<Result> {
  inspect(workspacePath: string): Promise<Result>;
}

interface RecoveryInspectionBoundary {
  inspect(request: { projectId: ProjectId; workspacePath: string }): Promise<RecoveryPlan>;
}

export interface ProjectExecutionControlOptions {
  readonly now?: () => string;
  readonly runner?: ProjectLifecycleRunner;
  readonly workspaceProbe?: WorkspaceProbe;
  readonly preflight?: ReadonlyInspector<WorkspacePreflightResult>;
  readonly recoveryInspector?: RecoveryInspectionBoundary;
  readonly keepAwake?: ProjectKeepAwakeBoundary;
}

export interface ProjectKeepAwakeBoundary {
  releaseProject(projectId: ProjectId, actor: string): Promise<unknown>;
}

interface ActiveExecution {
  readonly controller: AbortController;
}

const activeExecutions = new WeakMap<DensaAdeDatabase, Map<ProjectId, ActiveExecution>>();

function executionsFor(database: DensaAdeDatabase): Map<ProjectId, ActiveExecution> {
  let executions = activeExecutions.get(database);
  if (executions === undefined) {
    executions = new Map();
    activeExecutions.set(database, executions);
  }
  return executions;
}

function controlEventId(projectId: ProjectId, action: string, occurredAt: string): EventId {
  const key = createHash("sha256")
    .update(projectId)
    .update("\0")
    .update(action)
    .update("\0")
    .update(occurredAt)
    .digest("hex")
    .slice(0, 24);
  return eventIdSchema.parse(`project-control-${key}`);
}

function validRequest(request: ProjectControlRequest): boolean {
  return (
    request.actor.trim().length > 0 &&
    isAbsolute(request.workspacePath) &&
    request.workspacePath.trim().length > 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const recoveryClassifications = new Set<RecoveryPlan["classification"]>([
  "CLEANLY_IDLE",
  "ACTIVE_PROCESS_ALIVE",
  "TASK_PROCESS_GONE",
  "VALIDATION_INTERRUPTED",
  "WORKSPACE_DIVERGED",
  "UNKNOWN",
]);

function parseSnapshot(value: unknown): WorkspaceSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const { gitHead, gitStatus, fingerprint } = value;
  return typeof gitHead === "string" &&
    typeof gitStatus === "string" &&
    typeof fingerprint === "string"
    ? Object.freeze({ gitHead, gitStatus, fingerprint })
    : undefined;
}

function parseStoredControl(value: unknown): StoredControl | undefined {
  if (!isRecord(value)) return undefined;
  const statuses = new Set<ControlStatus>([
    "running",
    "pause_requested",
    "paused",
    "intervention_required",
    "stop_requested",
    "stopped",
  ]);
  if (
    typeof value["status"] !== "string" ||
    !statuses.has(value["status"] as ControlStatus) ||
    typeof value["workspacePath"] !== "string" ||
    typeof value["requestedAt"] !== "string" ||
    typeof value["updatedAt"] !== "string"
  ) {
    return undefined;
  }
  const snapshot = parseSnapshot(value["snapshot"]);
  const rawIntervention = value["intervention"];
  const intervention =
    isRecord(rawIntervention) &&
    Array.isArray(rawIntervention["changedPaths"]) &&
    rawIntervention["changedPaths"].every((path) => typeof path === "string") &&
    typeof rawIntervention["previousGitHead"] === "string" &&
    typeof rawIntervention["currentGitHead"] === "string" &&
    typeof rawIntervention["detectedAt"] === "string" &&
    typeof rawIntervention["recoveryClassification"] === "string" &&
    recoveryClassifications.has(
      rawIntervention["recoveryClassification"] as RecoveryPlan["classification"],
    )
      ? Object.freeze({
          changedPaths: Object.freeze([...rawIntervention["changedPaths"]]),
          previousGitHead: rawIntervention["previousGitHead"],
          currentGitHead: rawIntervention["currentGitHead"],
          detectedAt: rawIntervention["detectedAt"],
          recoveryClassification: rawIntervention[
            "recoveryClassification"
          ] as RecoveryPlan["classification"],
        })
      : undefined;
  return Object.freeze({
    status: value["status"] as ControlStatus,
    workspacePath: value["workspacePath"],
    requestedAt: value["requestedAt"],
    updatedAt: value["updatedAt"],
    ...(snapshot === undefined ? {} : { snapshot }),
    ...(intervention === undefined ? {} : { intervention }),
    ...(typeof value["snapshotError"] === "string"
      ? { snapshotError: value["snapshotError"] }
      : {}),
  });
}

function jsonControl(control: StoredControl): JsonObject {
  return {
    status: control.status,
    workspacePath: control.workspacePath,
    requestedAt: control.requestedAt,
    updatedAt: control.updatedAt,
    ...(control.snapshot === undefined
      ? {}
      : {
          snapshot: {
            gitHead: control.snapshot.gitHead,
            gitStatus: control.snapshot.gitStatus,
            fingerprint: control.snapshot.fingerprint,
          },
        }),
    ...(control.intervention === undefined
      ? {}
      : {
          intervention: {
            changedPaths: [...control.intervention.changedPaths],
            previousGitHead: control.intervention.previousGitHead,
            currentGitHead: control.intervention.currentGitHead,
            detectedAt: control.intervention.detectedAt,
            recoveryClassification: control.intervention.recoveryClassification,
          },
        }),
    ...(control.snapshotError === undefined ? {} : { snapshotError: control.snapshotError }),
  };
}

function changedPaths(preflight: WorkspacePreflightResult): readonly string[] {
  return Object.freeze(
    [
      ...preflight.changes.staged.map((change) => change.path),
      ...preflight.changes.unstaged.map((change) => change.path),
      ...preflight.changes.untracked,
    ]
      .filter((path, index, all) => all.indexOf(path) === index)
      .sort((left, right) => left.localeCompare(right)),
  );
}

/**
 * Durable Core boundary for live-project pause, cancellation, stop, resume, and intervention.
 * It never deletes, resets, stashes, checks out, or writes user files.
 */
export class ProjectExecutionControlService {
  readonly #now: () => string;
  readonly #runner: ProjectLifecycleRunner;
  readonly #workspaceProbe: WorkspaceProbe;
  readonly #preflight: ReadonlyInspector<WorkspacePreflightResult>;
  readonly #recovery: RecoveryInspectionBoundary;
  readonly #keepAwake: ProjectKeepAwakeBoundary;

  constructor(
    private readonly database: DensaAdeDatabase,
    options: ProjectExecutionControlOptions = {},
  ) {
    const clock = options.now ?? (() => new Date().toISOString());
    this.#now = () => isoTimestampSchema.parse(clock());
    this.#runner = options.runner ?? new ProjectExecutionOrchestrator(database, { now: this.#now });
    this.#workspaceProbe = options.workspaceProbe ?? new GitWorkspaceProbe();
    this.#preflight = options.preflight ?? new WorkspacePreflight();
    this.#recovery =
      options.recoveryInspector ??
      new RecoveryInspector(database.repositories, {
        workspaceProbe: this.#workspaceProbe,
      });
    this.#keepAwake = options.keepAwake ?? new KeepAwakeManager(database);
  }

  async execute(
    request: ExecuteProjectLifecycleRequest,
  ): Promise<ControlledProjectLifecycleResult> {
    const existing = this.#control(request.projectId);
    if (existing?.status === "stopped") {
      return Object.freeze({
        status: "STOPPED" as const,
        projectId: request.projectId,
        reason: "Project was explicitly stopped",
      });
    }
    if (
      existing?.status === "paused" ||
      existing?.status === "intervention_required" ||
      existing?.status === "pause_requested" ||
      existing?.status === "stop_requested"
    ) {
      if (existing.status === "pause_requested" || existing.status === "stop_requested") {
        if (this.#hasPersistedActiveTask(request.projectId)) {
          return Object.freeze({
            status: "STOPPED" as const,
            projectId: request.projectId,
            reason: "A persisted active task requires recovery before control finalization",
          });
        }
        return await this.#finalize(request.projectId, existing, request.actor);
      }
      return Object.freeze({
        status: existing.status === "paused" ? ("PAUSED" as const) : ("STOPPED" as const),
        projectId: request.projectId,
        reason: "Project control state must be resolved before execution",
      });
    }

    const executions = executionsFor(this.database);
    if (executions.has(request.projectId)) {
      return Object.freeze({
        status: "STOPPED" as const,
        projectId: request.projectId,
        reason: "A controlled project execution is already active",
      });
    }
    const controller = new AbortController();
    executions.set(request.projectId, { controller });
    const signal =
      request.signal === undefined
        ? controller.signal
        : AbortSignal.any([request.signal, controller.signal]);
    try {
      const result = await this.#runner.execute({
        ...request,
        signal,
        cancellationDisposition: "interrupt",
        controlBoundary: () => {
          const control = this.#control(request.projectId);
          if (control?.status === "pause_requested") return "pause";
          if (control?.status === "stop_requested") return "stop";
          return undefined;
        },
      });
      const requested = this.#control(request.projectId);
      if (requested?.status === "pause_requested" || requested?.status === "stop_requested") {
        return await this.#finalize(request.projectId, requested, request.actor);
      }
      return result;
    } finally {
      executions.delete(request.projectId);
    }
  }

  async pause(request: ProjectControlRequest): Promise<ProjectControlCommandResult> {
    return await this.#requestBoundary(request, "pause_requested");
  }

  async cancelCurrentAgent(request: ProjectControlRequest): Promise<ProjectControlCommandResult> {
    const result = await this.#requestBoundary(request, "pause_requested", true);
    if (result.status === "REQUESTED" || result.status === "UNCHANGED") {
      executionsFor(this.database).get(request.projectId)?.controller.abort();
    }
    return result;
  }

  async stop(request: ProjectControlRequest): Promise<ProjectControlCommandResult> {
    const result = await this.#requestBoundary(request, "stop_requested");
    if (result.status === "REQUESTED" || result.status === "STOPPED") {
      await this.#keepAwake.releaseProject(request.projectId, request.actor);
    }
    return result;
  }

  async resume(request: ResumeProjectRequest): Promise<ResumeProjectResult> {
    if (!validRequest(request)) return this.#resumeRejected(request, "Invalid resume request");
    const project = this.database.repositories.projects.findById(request.projectId);
    if (project === undefined) {
      return Object.freeze({
        status: "NOT_FOUND" as const,
        projectId: request.projectId,
        reason: "Project does not exist",
      });
    }

    // Both inspections are mandatory and read-only, including for rejected or stopped resumes.
    const [preflight, recovery, observation] = await Promise.all([
      this.#preflight.inspect(request.workspacePath),
      this.#recovery.inspect({
        projectId: request.projectId,
        workspacePath: request.workspacePath,
      }),
      this.#workspaceProbe.inspect(request.workspacePath),
    ]);
    const control = this.#control(request.projectId);
    if (control?.status === "stopped") {
      return Object.freeze({
        status: "STOPPED" as const,
        projectId: request.projectId,
        reason: "A stopped project cannot be resumed without an explicit new start decision",
      });
    }
    if (project.state === "RUNNING" && (control === undefined || control.status === "running")) {
      return Object.freeze({
        status: "UNCHANGED" as const,
        projectId: request.projectId,
        reason: "Project is already running",
      });
    }
    if (
      project.state !== "PAUSED" ||
      control === undefined ||
      (control.status !== "paused" && control.status !== "intervention_required")
    ) {
      return this.#resumeBlocked(request, "Project has no durable paused boundary to resume");
    }
    if (control.workspacePath !== request.workspacePath) {
      return this.#resumeBlocked(request, "Resume workspace differs from the paused workspace");
    }
    if (observation.status === "unknown" || control.snapshot === undefined) {
      return this.#resumeBlocked(
        request,
        observation.status === "unknown"
          ? observation.reason
          : (control.snapshotError ?? "Paused workspace snapshot is unavailable"),
      );
    }
    if (
      (preflight.head.commit !== undefined &&
        preflight.head.commit !== observation.snapshot.gitHead) ||
      (recovery.evidence?.workspace.status === "available" &&
        recovery.evidence.workspace.snapshot.fingerprint !== observation.snapshot.fingerprint)
    ) {
      return this.#resumeBlocked(request, "Workspace changed while resume checks were running");
    }

    const projectTasks = this.database.repositories.tasks.listByProjectId(project.id);
    const hasAttempts = projectTasks.some(
      (task) => this.database.repositories.attempts.listByTaskId(task.id).length > 0,
    );
    const interrupted = projectTasks.filter((task) => task.state === "INTERRUPTED");
    const confirmedInterruptedRecovery =
      interrupted.length > 0 &&
      interrupted.every((task) => {
        const attempt = this.database.repositories.attempts.listByTaskId(task.id).at(-1);
        if (attempt?.completedAt === undefined) return false;
        const run = this.database.repositories.agentRuns.findByAttemptId(attempt.id);
        const rollback = this.database.repositories.attemptRollbackPlans.findByAttemptId(
          attempt.id,
        );
        return run?.completedAt !== undefined && rollback?.appliedAt !== undefined;
      });
    const recoverySafe =
      recovery.classification === "CLEANLY_IDLE" ||
      recovery.classification === "WORKSPACE_DIVERGED" ||
      (recovery.classification === "UNKNOWN" && (!hasAttempts || confirmedInterruptedRecovery));
    if (!recoverySafe) return this.#resumeBlocked(request, recovery.reason);

    const intervened = observation.snapshot.fingerprint !== control.snapshot.fingerprint;
    if (
      preflight.decision.outcome === "STOP" &&
      !(intervened && preflight.decision.code === "USER_CHANGES_PRESENT")
    ) {
      return this.#resumeBlocked(request, preflight.decision.reason);
    }

    let recontextualization: RecontextualizationContext | undefined;
    if (intervened) {
      const recordedIntervention = control.intervention;
      recontextualization =
        recordedIntervention?.previousGitHead === control.snapshot.gitHead &&
        recordedIntervention.currentGitHead === observation.snapshot.gitHead
          ? recordedIntervention
          : Object.freeze({
              changedPaths: changedPaths(preflight),
              previousGitHead: control.snapshot.gitHead,
              currentGitHead: observation.snapshot.gitHead,
              detectedAt: this.#now(),
              recoveryClassification: recovery.classification,
            });
      if (request.acknowledgeIntervention !== true) {
        if (recordedIntervention !== recontextualization) {
          this.#persistControl(
            project.id,
            {
              ...control,
              status: "intervention_required",
              updatedAt: recontextualization.detectedAt,
              intervention: recontextualization,
            },
            request.actor,
            "HUMAN_INTERVENTION_DETECTED",
            {
              changedPaths: [...recontextualization.changedPaths],
              recoveryClassification: recovery.classification,
            },
          );
        }
        return Object.freeze({
          status: "INTERVENTION_REQUIRED" as const,
          projectId: request.projectId,
          recontextualization,
        });
      }
    }

    const occurredAt = this.#now();
    const runningControl: StoredControl = {
      status: "running",
      workspacePath: request.workspacePath,
      requestedAt: control.requestedAt,
      updatedAt: occurredAt,
      snapshot: observation.snapshot,
      ...(recontextualization === undefined ? {} : { intervention: recontextualization }),
    };
    try {
      this.database.transaction((repositories) => {
        const previousSettings = repositories.projectSettings.findByProjectId(project.id);
        repositories.projectSettings.set({
          projectId: project.id,
          values: {
            ...(previousSettings?.values ?? {}),
            executionControl: jsonControl(runningControl),
          },
          updatedAt: occurredAt,
        });
        repositories.events.append({
          id: controlEventId(project.id, "resumed", occurredAt),
          projectId: project.id,
          type: "PROJECT_RESUMED",
          eventVersion: 1,
          occurredAt,
          actor: request.actor,
          payload: {
            recoveryClassification: recovery.classification,
            preflightCode: preflight.decision.code,
            recontextualized: recontextualization !== undefined,
            ...(recontextualization === undefined
              ? {}
              : { changedPaths: [...recontextualization.changedPaths] }),
          },
        });
        this.database.persistStateTransition(
          stateTransitionService.transitionProject(project, "RUNNING", {
            actor: request.actor,
            occurredAt,
            reason: "Recovery and workspace checks cleared project resume",
          }),
          controlEventId(project.id, "resumed-state", occurredAt),
        );
        for (const task of interrupted) {
          this.database.persistStateTransition(
            stateTransitionService.transitionTask(task, "RETRYING", {
              actor: request.actor,
              occurredAt,
              reason: "Interrupted worker was reconciled before project resume",
            }),
            controlEventId(project.id, `resume-task-${task.id}`, occurredAt),
          );
        }
      });
    } catch (error) {
      return this.#resumeBlocked(
        request,
        `Resume state changed concurrently: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return Object.freeze({
      status: "RESUMED" as const,
      projectId: project.id,
      ...(recontextualization === undefined ? {} : { recontextualization }),
    });
  }

  #control(projectId: ProjectId): StoredControl | undefined {
    const settings = this.database.repositories.projectSettings.findByProjectId(projectId);
    return parseStoredControl(settings?.values["executionControl"]);
  }

  async #requestBoundary(
    request: ProjectControlRequest,
    status: "pause_requested" | "stop_requested",
    forceRequested = false,
  ): Promise<ProjectControlCommandResult> {
    if (!validRequest(request)) return this.#commandRejected(request, "Invalid control request");
    const project = this.database.repositories.projects.findById(request.projectId);
    if (project === undefined) {
      return Object.freeze({
        status: "NOT_FOUND" as const,
        projectId: request.projectId,
        reason: "Project does not exist",
      });
    }
    const current = this.#control(project.id);
    if (
      (status === "pause_requested" &&
        (current?.status === "pause_requested" ||
          current?.status === "paused" ||
          current?.status === "intervention_required" ||
          current?.status === "stop_requested" ||
          current?.status === "stopped")) ||
      (status === "stop_requested" &&
        (current?.status === "stop_requested" || current?.status === "stopped"))
    ) {
      return Object.freeze({
        status: "UNCHANGED" as const,
        projectId: project.id,
        reason: "Requested control boundary is already durable",
      });
    }
    if (project.state !== "RUNNING" && project.state !== "PAUSED") {
      return this.#commandRejected(request, `Project state ${project.state} cannot be controlled`);
    }
    const occurredAt = this.#now();
    const requested: StoredControl = {
      status,
      workspacePath: request.workspacePath,
      requestedAt: occurredAt,
      updatedAt: occurredAt,
    };
    this.#persistControl(
      project.id,
      requested,
      request.actor,
      status === "pause_requested" ? "PROJECT_PAUSE_REQUESTED" : "PROJECT_STOP_REQUESTED",
      { immediateAgentCancellation: forceRequested },
    );
    if (executionsFor(this.database).has(project.id)) {
      return Object.freeze({
        status: "REQUESTED" as const,
        projectId: project.id,
        reason:
          status === "pause_requested"
            ? "Pause will take effect at the current safe boundary"
            : "Stop will take effect after the current safe task boundary",
      });
    }
    if (this.#hasPersistedActiveTask(project.id)) {
      return Object.freeze({
        status: "REQUESTED" as const,
        projectId: project.id,
        reason: "Control intent is durable; persisted active work requires recovery inspection",
      });
    }
    return await this.#finalize(project.id, requested, request.actor);
  }

  async #finalize(
    projectId: ProjectId,
    requested: StoredControl,
    actor: string,
  ): Promise<Readonly<{ status: "PAUSED" | "STOPPED"; projectId: ProjectId; reason: string }>> {
    const project = this.database.repositories.projects.findById(projectId);
    if (project === undefined) {
      return Object.freeze({
        status: "STOPPED" as const,
        projectId,
        reason: "Project disappeared before the control boundary",
      });
    }
    const observation = await this.#workspaceProbe.inspect(requested.workspacePath);
    const occurredAt = this.#now();
    const stopped = requested.status === "stop_requested";
    const finalized: StoredControl = {
      status: stopped ? "stopped" : "paused",
      workspacePath: requested.workspacePath,
      requestedAt: requested.requestedAt,
      updatedAt: occurredAt,
      ...(observation.status === "available"
        ? { snapshot: observation.snapshot }
        : { snapshotError: observation.reason }),
    };
    this.database.transaction((repositories) => {
      const previousSettings = repositories.projectSettings.findByProjectId(projectId);
      repositories.projectSettings.set({
        projectId,
        values: { ...(previousSettings?.values ?? {}), executionControl: jsonControl(finalized) },
        updatedAt: occurredAt,
      });
      repositories.events.append({
        id: controlEventId(projectId, stopped ? "stopped" : "paused", occurredAt),
        projectId,
        type: stopped ? "PROJECT_STOPPED" : "PROJECT_PAUSED",
        eventVersion: 1,
        occurredAt,
        actor,
        payload: {
          workspaceSnapshotAvailable: observation.status === "available",
          workDeleted: false,
        },
      });
      if (project.state !== "PAUSED") {
        this.database.persistStateTransition(
          stateTransitionService.transitionProject(project, "PAUSED", {
            actor,
            occurredAt,
            reason: stopped
              ? "User stopped scheduling without deleting project work"
              : "User paused project execution at a safe boundary",
          }),
          controlEventId(projectId, stopped ? "stopped-state" : "paused-state", occurredAt),
        );
      }
    });
    return Object.freeze({
      status: stopped ? ("STOPPED" as const) : ("PAUSED" as const),
      projectId,
      reason: stopped ? "Project stopped without deleting work" : "Project paused",
    });
  }

  #persistControl(
    projectId: ProjectId,
    control: StoredControl,
    actor: string,
    eventType: string,
    payload: JsonObject,
  ): void {
    this.database.transaction((repositories) => {
      const projectSettings = repositories.projectSettings.findByProjectId(projectId);
      repositories.projectSettings.set({
        projectId,
        values: { ...(projectSettings?.values ?? {}), executionControl: jsonControl(control) },
        updatedAt: control.updatedAt,
      });
      repositories.events.append({
        id: controlEventId(projectId, eventType, control.updatedAt),
        projectId,
        type: eventType,
        eventVersion: 1,
        occurredAt: control.updatedAt,
        actor,
        payload,
      });
    });
  }

  #hasPersistedActiveTask(projectId: ProjectId): boolean {
    return this.database.repositories.tasks
      .listByProjectId(projectId)
      .some(
        (task) =>
          task.state === "RUNNING" || task.state === "RETRYING" || task.state === "VALIDATING",
      );
  }

  #commandRejected(request: ProjectControlRequest, reason: string): ProjectControlCommandResult {
    return Object.freeze({ status: "REJECTED" as const, projectId: request.projectId, reason });
  }

  #resumeRejected(request: ResumeProjectRequest, reason: string): ResumeProjectResult {
    return Object.freeze({ status: "REJECTED" as const, projectId: request.projectId, reason });
  }

  #resumeBlocked(request: ResumeProjectRequest, reason: string): ResumeProjectResult {
    return Object.freeze({ status: "BLOCKED" as const, projectId: request.projectId, reason });
  }
}
