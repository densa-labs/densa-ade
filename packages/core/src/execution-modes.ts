import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import {
  eventIdSchema,
  executionModeSchema,
  isoTimestampSchema,
  usageStateSchema,
  type EventId,
  type ExecutionMode,
  type Phase,
  type PhaseId,
  type PhaseReport,
  type Project,
  type ProjectId,
  type TaskId,
  type UsageState,
} from "@densa-ade/protocol";

import { type DensaAdeDatabase } from "./persistence/database.js";
import {
  type PhaseLifecycleValidator,
  PhaseLifecycleOrchestrator,
  type PhaseTaskExecutor,
  synchronizePersistedPhaseReports,
} from "./phase-orchestrator.js";
import { type SchedulerGateSnapshot } from "./scheduler.js";
import { stateTransitionService } from "./state-transitions.js";

export interface ExecutionModeOptions {
  readonly now?: () => string;
}

function eventKey(...parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24);
}

function modeEventId(
  projectId: ProjectId,
  previousMode: ExecutionMode,
  mode: ExecutionMode,
  occurredAt: string,
): EventId {
  return eventIdSchema.parse(
    `execution-mode-${eventKey(projectId, previousMode, mode, occurredAt)}`,
  );
}

function projectEventId(projectId: ProjectId, scope: string): EventId {
  return eventIdSchema.parse(`project-execution-${eventKey(projectId)}-${scope}`);
}

function phaseBoundaryEventId(projectId: ProjectId, phaseId: PhaseId, scope: string): EventId {
  return eventIdSchema.parse(`phase-boundary-${eventKey(projectId, phaseId)}-${scope}`);
}

export type ChangeExecutionModeResult =
  | Readonly<{ status: "CHANGED"; project: Project }>
  | Readonly<{ status: "UNCHANGED"; project: Project }>
  | Readonly<{ status: "NOT_FOUND" }>;

/** Persists execution-mode changes immediately; orchestrators observe them at safe boundaries. */
export class ExecutionModeService {
  readonly #now: () => string;

  constructor(
    private readonly database: DensaAdeDatabase,
    options: ExecutionModeOptions = {},
  ) {
    const clock = options.now ?? (() => new Date().toISOString());
    this.#now = () => isoTimestampSchema.parse(clock());
  }

  change(
    projectId: ProjectId,
    requestedMode: ExecutionMode,
    actor: string,
  ): ChangeExecutionModeResult {
    const mode = executionModeSchema.parse(requestedMode);
    if (actor.trim().length === 0) throw new Error("Execution mode changes require an actor");
    const project = this.database.repositories.projects.findById(projectId);
    if (project === undefined) return Object.freeze({ status: "NOT_FOUND" as const });
    if (project.executionMode === mode) {
      return Object.freeze({ status: "UNCHANGED" as const, project });
    }
    const occurredAt = this.#now();
    this.database.persistExecutionModeChange({
      projectId,
      previousMode: project.executionMode,
      mode,
      occurredAt,
      actor,
      eventId: modeEventId(projectId, project.executionMode, mode, occurredAt),
    });
    const changed = this.database.repositories.projects.findById(projectId);
    if (changed === undefined) throw new Error("Changed project disappeared");
    return Object.freeze({ status: "CHANGED" as const, project: changed });
  }
}

export interface ExecuteProjectLifecycleRequest {
  readonly projectId: ProjectId;
  readonly workspacePath: string;
  readonly gates: SchedulerGateSnapshot;
  readonly taskExecutor: PhaseTaskExecutor;
  readonly validator: PhaseLifecycleValidator;
  readonly actor: string;
  readonly guidedTaskApproval?: Readonly<{ taskId: TaskId }>;
  readonly phaseApproval?: Readonly<{ phaseId: PhaseId }>;
  readonly signal?: AbortSignal;
  readonly cancellationDisposition?: "cancel" | "interrupt";
  readonly controlBoundary?: () => "pause" | "stop" | undefined;
}

export type ProjectLifecycleResult =
  | Readonly<{ status: "COMPLETED"; projectId: ProjectId }>
  | Readonly<{
      status: "AWAITING_TASK_APPROVAL";
      projectId: ProjectId;
      phaseId: PhaseId;
      taskId: TaskId;
    }>
  | Readonly<{
      status: "AWAITING_PHASE_APPROVAL";
      projectId: ProjectId;
      phaseId: PhaseId;
      report: PhaseReport;
    }>
  | Readonly<{
      status: "WAITING_FOR_USAGE";
      projectId: ProjectId;
      phaseId: PhaseId;
      taskId: TaskId;
      usageState: Extract<UsageState, { status: "limited" }>;
    }>
  | Readonly<{
      status: "BLOCKED" | "STOPPED";
      projectId: ProjectId;
      reason: string;
      phaseId?: PhaseId;
    }>;

/** P5M4 project loop implementing Guided, Phase, and Continuous stop boundaries. */
export class ProjectExecutionOrchestrator {
  readonly #now: () => string;
  readonly #phaseOrchestrator: PhaseLifecycleOrchestrator;
  #active = false;

  constructor(
    private readonly database: DensaAdeDatabase,
    options: ExecutionModeOptions = {},
  ) {
    const clock = options.now ?? (() => new Date().toISOString());
    this.#now = () => isoTimestampSchema.parse(clock());
    this.#phaseOrchestrator = new PhaseLifecycleOrchestrator(database, { now: this.#now });
  }

  async execute(request: ExecuteProjectLifecycleRequest): Promise<ProjectLifecycleResult> {
    if (this.#active) {
      return Object.freeze({
        status: "STOPPED" as const,
        projectId: request.projectId,
        reason: "This orchestrator already owns the serial project execution slot",
      });
    }
    this.#active = true;
    try {
      return await this.#execute(request);
    } finally {
      this.#active = false;
    }
  }

  async #execute(request: ExecuteProjectLifecycleRequest): Promise<ProjectLifecycleResult> {
    if (
      request.actor.trim().length === 0 ||
      !isAbsolute(request.workspacePath) ||
      !Array.isArray(request.gates.outstandingUserDecisionIds) ||
      !Array.isArray(request.gates.permissionBlockers)
    ) {
      return this.#stopped(
        request,
        "Project execution requires an absolute workspace, actor, and complete gate snapshot",
      );
    }
    for (;;) {
      const control = request.controlBoundary?.();
      if (control !== undefined) {
        return this.#stopped(request, `Project ${control} was requested at a safe boundary`);
      }
      const policyReason = this.#policyReason(request.gates);
      if (policyReason !== undefined) return this.#blocked(request, policyReason);
      const project = this.database.repositories.projects.findById(request.projectId);
      if (project === undefined) return this.#stopped(request, "Project does not exist");
      if (project.state === "COMPLETED") {
        return Object.freeze({ status: "COMPLETED" as const, projectId: project.id });
      }
      if (project.state === "WAITING_FOR_USAGE") {
        const waitingTask = this.database.repositories.tasks
          .listByProjectId(project.id)
          .find((task) => task.state === "WAITING_FOR_USAGE");
        const usageEvent = this.database.eventJournal
          .replay({ projectId: project.id, types: ["USAGE_LIMIT_REACHED"], limit: 1_000 })
          .findLast((event) => event.taskId === waitingTask?.id);
        const parsedUsage = usageStateSchema.safeParse(usageEvent?.payload["usageState"]);
        if (
          waitingTask === undefined ||
          !parsedUsage.success ||
          parsedUsage.data.status !== "limited"
        ) {
          return this.#stopped(
            request,
            "Project usage-wait state is missing its matching task or durable usage evidence",
          );
        }
        return Object.freeze({
          status: "WAITING_FOR_USAGE" as const,
          projectId: project.id,
          phaseId: waitingTask.phaseId,
          taskId: waitingTask.id,
          usageState: parsedUsage.data,
        });
      }
      if (project.state !== "RUNNING") {
        return this.#stopped(request, `Project must be RUNNING, not ${project.state}`);
      }

      const phases = this.database.repositories.phases.listByProjectId(project.id);
      const blockedPhase = phases.find((phase) => phase.state === "BLOCKED");
      if (blockedPhase !== undefined) {
        return this.#blocked(
          request,
          `Required phase ${blockedPhase.id} is BLOCKED`,
          blockedPhase.id,
        );
      }
      const awaiting = phases.find((phase) => phase.state === "AWAITING_APPROVAL");
      if (awaiting !== undefined) {
        const report = this.database.repositories.phaseReports.findByPhaseId(awaiting.id);
        if (report === undefined || report.outcome !== "awaiting_approval") {
          return this.#stopped(
            request,
            "Awaiting phase has no matching durable report",
            awaiting.id,
          );
        }
        if (project.executionMode === "phase" && request.phaseApproval?.phaseId !== awaiting.id) {
          return Object.freeze({
            status: "AWAITING_PHASE_APPROVAL" as const,
            projectId: project.id,
            phaseId: awaiting.id,
            report,
          });
        }
        this.#releasePhaseBoundary(
          project,
          awaiting,
          request.actor,
          project.executionMode === "phase" ? "approved" : "superseded",
        );
        continue;
      }

      const activePhase = phases.find(
        (phase) =>
          phase.state === "READY" || phase.state === "RUNNING" || phase.state === "VALIDATING",
      );
      if (activePhase === undefined) {
        if (phases.length > 0 && phases.every((phase) => phase.state === "COMPLETED")) {
          try {
            await synchronizePersistedPhaseReports(
              this.database,
              project.id,
              request.workspacePath,
            );
            this.#recordReportSynchronization(project, request.actor);
          } catch (error) {
            return this.#stopped(
              request,
              `Authoritative reports are durable but final portable report synchronization failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          this.#completeProject(project, request.actor);
          return Object.freeze({ status: "COMPLETED" as const, projectId: project.id });
        }
        return this.#stopped(request, "No executable phase is at a safe runnable boundary");
      }

      const phaseResult = await this.#phaseOrchestrator.execute({
        projectId: request.projectId,
        phaseId: activePhase.id,
        workspacePath: request.workspacePath,
        gates: request.gates,
        taskExecutor: request.taskExecutor,
        validator: request.validator,
        actor: request.actor,
        ...(request.guidedTaskApproval === undefined
          ? {}
          : { guidedTaskApproval: request.guidedTaskApproval }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(request.cancellationDisposition === undefined
          ? {}
          : { cancellationDisposition: request.cancellationDisposition }),
        ...(request.controlBoundary === undefined
          ? {}
          : { controlBoundary: request.controlBoundary }),
      });
      if (phaseResult.status === "COMPLETED") continue;
      if (phaseResult.status === "AWAITING_TASK_APPROVAL") {
        return Object.freeze({
          status: "AWAITING_TASK_APPROVAL" as const,
          projectId: request.projectId,
          phaseId: phaseResult.phaseId,
          taskId: phaseResult.taskId,
        });
      }
      if (phaseResult.status === "AWAITING_APPROVAL") {
        return Object.freeze({
          status: "AWAITING_PHASE_APPROVAL" as const,
          projectId: request.projectId,
          phaseId: phaseResult.phaseId,
          report: phaseResult.report,
        });
      }
      if (phaseResult.status === "WAITING_FOR_USAGE") {
        const waitingProject = this.database.repositories.projects.findById(request.projectId);
        if (waitingProject?.state !== "WAITING_FOR_USAGE") {
          return this.#stopped(
            request,
            "Phase reported usage waiting without matching persisted project state",
            phaseResult.phaseId,
          );
        }
        return Object.freeze({
          status: "WAITING_FOR_USAGE" as const,
          projectId: request.projectId,
          phaseId: phaseResult.phaseId,
          taskId: phaseResult.taskId,
          usageState: phaseResult.usageState,
        });
      }
      if (phaseResult.status === "BLOCKED") {
        return this.#blocked(
          request,
          "Phase execution or validation is blocked",
          phaseResult.phaseId,
        );
      }
      if (phaseResult.status === "STOPPED") {
        return this.#stopped(
          request,
          `${phaseResult.code}: ${phaseResult.reason}`,
          phaseResult.phaseId,
        );
      }
      return this.#stopped(request, "Phase orchestrator returned an unknown boundary");
    }
  }

  #policyReason(gates: SchedulerGateSnapshot): string | undefined {
    if (gates.outstandingUserDecisionIds.length > 0) {
      return `Mandatory user decisions remain unresolved: ${gates.outstandingUserDecisionIds.join(", ")}`;
    }
    if (gates.permissionBlockers.length > 0) {
      return `Non-overridable permission or safety blockers remain: ${gates.permissionBlockers.map((blocker) => blocker.id).join(", ")}`;
    }
    return undefined;
  }

  #releasePhaseBoundary(
    project: Project,
    phase: Phase,
    actor: string,
    outcome: "approved" | "superseded",
  ): void {
    const occurredAt = this.#now();
    const phases = this.database.repositories.phases.listByProjectId(project.id);
    const nextPhase = phases.find((entry) => entry.position === phase.position + 1);
    if (nextPhase !== undefined && nextPhase.state !== "PENDING") {
      throw new Error("Phase approval may only release a PENDING next phase");
    }
    this.database.transaction((repositories) => {
      repositories.events.append({
        id: phaseBoundaryEventId(project.id, phase.id, outcome),
        projectId: project.id,
        phaseId: phase.id,
        type: outcome === "approved" ? "PHASE_APPROVED" : "PHASE_APPROVAL_SUPERSEDED",
        eventVersion: 1,
        occurredAt,
        actor,
        payload: { mode: project.executionMode },
      });
      this.database.persistStateTransition(
        stateTransitionService.transitionPhase(phase, "COMPLETED", {
          actor,
          occurredAt,
          reason:
            outcome === "approved"
              ? "User approved the validated phase boundary"
              : `Execution mode ${project.executionMode} no longer requires phase approval`,
        }),
        phaseBoundaryEventId(project.id, phase.id, "completed"),
      );
      if (nextPhase !== undefined) {
        this.database.persistStateTransition(
          stateTransitionService.transitionPhase(nextPhase, "READY", {
            actor,
            occurredAt,
            reason: `Approved phase ${phase.id} released the next phase`,
          }),
          phaseBoundaryEventId(project.id, phase.id, "next-ready"),
        );
      }
    });
  }

  #completeProject(project: Project, actor: string): void {
    const occurredAt = this.#now();
    this.database.persistStateTransition(
      stateTransitionService.transitionProject(project, "COMPLETED", {
        actor,
        occurredAt,
        reason: "Every required phase completed with passing validation",
      }),
      projectEventId(project.id, "completed"),
    );
  }

  #recordReportSynchronization(project: Project, actor: string): void {
    const id = projectEventId(project.id, "reports-synchronized");
    if (this.database.eventJournal.findById(id) !== undefined) return;
    const occurredAt = this.#now();
    const reports = this.database.repositories.phaseReports.listByProjectId(project.id);
    this.database.repositories.events.append({
      id,
      projectId: project.id,
      type: "PHASE_REPORTS_SYNCHRONIZED",
      eventVersion: 1,
      occurredAt,
      actor,
      payload: { reportPaths: reports.map((report) => report.reportPath) },
    });
  }

  #blocked(
    request: ExecuteProjectLifecycleRequest,
    reason: string,
    phaseId?: PhaseId,
  ): ProjectLifecycleResult {
    return Object.freeze({
      status: "BLOCKED" as const,
      projectId: request.projectId,
      reason,
      ...(phaseId === undefined ? {} : { phaseId }),
    });
  }

  #stopped(
    request: ExecuteProjectLifecycleRequest,
    reason: string,
    phaseId?: PhaseId,
  ): ProjectLifecycleResult {
    return Object.freeze({
      status: "STOPPED" as const,
      projectId: request.projectId,
      reason,
      ...(phaseId === undefined ? {} : { phaseId }),
    });
  }
}
