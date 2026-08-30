import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import {
  eventIdSchema,
  isoTimestampSchema,
  usageStateSchema,
  type EventId,
  type JsonObject,
  type Project,
  type ProjectId,
  type Task,
  type UsageState,
} from "@densa-ade/protocol";

import type { DensaAdeDatabase } from "./persistence/database.js";
import { RecoveryInspector, type RecoveryPlan, type WorkspaceProbe } from "./recovery-inspector.js";
import type { SchedulerGateSnapshot } from "./scheduler.js";
import { stateTransitionService } from "./state-transitions.js";
import { WorkspacePreflight, type WorkspacePreflightResult } from "./workspace-preflight.js";

const DEFAULT_INITIAL_BACKOFF_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_BACKOFF_MS = 60 * 60 * 1_000;
const DEFAULT_MAX_PROBE_ATTEMPTS = 8;
const MAX_TIMER_DELAY_MS = 2_147_000_000;

export type UsageAutoResumeWaitStatus =
  "scheduled" | "probing" | "blocked" | "cancelled" | "resumed";

export interface UsageAutoResumeWaitState {
  readonly taskId: Task["id"];
  readonly status: UsageAutoResumeWaitStatus;
  readonly probeAttempt: number;
  readonly nextProbeAt?: string;
  readonly resetAt?: string;
  readonly lastProbeAt?: string;
  readonly reason?: string;
}

export interface UsageAutoResumeState {
  readonly formatVersion: 1;
  readonly projectId: ProjectId;
  readonly enabled: boolean;
  readonly workspacePath: string;
  readonly actor: string;
  readonly updatedAt: string;
  readonly wait?: UsageAutoResumeWaitState;
}

export interface UsageAutoResumeRequest {
  readonly projectId: ProjectId;
  readonly workspacePath: string;
  readonly actor: string;
}

export type UsageAutoResumeResult = Readonly<{
  status:
    | "DISABLED"
    | "IDLE"
    | "SCHEDULED"
    | "BLOCKED"
    | "CANCELLED"
    | "RESUMED"
    | "NOT_FOUND"
    | "REJECTED";
  projectId: ProjectId;
  reason: string;
  nextProbeAt?: string;
  probeAttempt?: number;
}>;

export interface UsageProbe {
  getUsageState(): Promise<UsageState>;
}

export interface UsageAutoResumeGateProvider {
  inspect(projectId: ProjectId): Promise<SchedulerGateSnapshot>;
}

interface ReadonlyInspector<Result> {
  inspect(workspacePath: string): Promise<Result>;
}

interface RecoveryInspectionBoundary {
  inspect(request: { projectId: ProjectId; workspacePath: string }): Promise<RecoveryPlan>;
}

export interface UsageAutoResumeClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface UsageAutoResumeOptions {
  readonly usageProbe: UsageProbe;
  readonly gateProvider: UsageAutoResumeGateProvider;
  readonly clock?: UsageAutoResumeClock;
  readonly workspaceProbe?: WorkspaceProbe;
  readonly preflight?: ReadonlyInspector<WorkspacePreflightResult>;
  readonly recoveryInspector?: RecoveryInspectionBoundary;
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly maxProbeAttempts?: number;
  readonly onResumed?: (projectId: ProjectId) => void | Promise<void>;
}

interface WaitingBoundary {
  readonly project: Project;
  readonly task: Task;
  readonly usageState: Extract<UsageState, { status: "limited" }>;
}

function systemClock(): UsageAutoResumeClock {
  return {
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) =>
      globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseWaitState(value: unknown): UsageAutoResumeWaitState | undefined {
  if (!isRecord(value)) return undefined;
  const statuses = new Set<UsageAutoResumeWaitStatus>([
    "scheduled",
    "probing",
    "blocked",
    "cancelled",
    "resumed",
  ]);
  if (
    typeof value["taskId"] !== "string" ||
    typeof value["status"] !== "string" ||
    !statuses.has(value["status"] as UsageAutoResumeWaitStatus) ||
    typeof value["probeAttempt"] !== "number" ||
    !Number.isInteger(value["probeAttempt"]) ||
    value["probeAttempt"] < 0
  ) {
    return undefined;
  }
  for (const field of ["nextProbeAt", "resetAt", "lastProbeAt"] as const) {
    const timestamp = optionalString(value[field]);
    if (timestamp !== undefined && !isoTimestampSchema.safeParse(timestamp).success)
      return undefined;
  }
  const nextProbeAt = optionalString(value["nextProbeAt"]);
  const resetAt = optionalString(value["resetAt"]);
  const lastProbeAt = optionalString(value["lastProbeAt"]);
  const reason = optionalString(value["reason"]);
  return Object.freeze({
    taskId: value["taskId"] as Task["id"],
    status: value["status"] as UsageAutoResumeWaitStatus,
    probeAttempt: value["probeAttempt"],
    ...(nextProbeAt === undefined ? {} : { nextProbeAt }),
    ...(resetAt === undefined ? {} : { resetAt }),
    ...(lastProbeAt === undefined ? {} : { lastProbeAt }),
    ...(reason === undefined ? {} : { reason }),
  });
}

function parseState(value: unknown): UsageAutoResumeState | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value["formatVersion"] !== 1 ||
    typeof value["projectId"] !== "string" ||
    typeof value["enabled"] !== "boolean" ||
    typeof value["workspacePath"] !== "string" ||
    !isAbsolute(value["workspacePath"]) ||
    typeof value["actor"] !== "string" ||
    value["actor"].trim().length === 0 ||
    typeof value["updatedAt"] !== "string" ||
    !isoTimestampSchema.safeParse(value["updatedAt"]).success
  ) {
    return undefined;
  }
  const wait = value["wait"] === undefined ? undefined : parseWaitState(value["wait"]);
  if (value["wait"] !== undefined && wait === undefined) return undefined;
  return Object.freeze({
    formatVersion: 1 as const,
    projectId: value["projectId"] as ProjectId,
    enabled: value["enabled"],
    workspacePath: value["workspacePath"],
    actor: value["actor"],
    updatedAt: value["updatedAt"],
    ...(wait === undefined ? {} : { wait }),
  });
}

function jsonState(state: UsageAutoResumeState): JsonObject {
  return {
    formatVersion: 1,
    projectId: state.projectId,
    enabled: state.enabled,
    workspacePath: state.workspacePath,
    actor: state.actor,
    updatedAt: state.updatedAt,
    ...(state.wait === undefined
      ? {}
      : {
          wait: {
            taskId: state.wait.taskId,
            status: state.wait.status,
            probeAttempt: state.wait.probeAttempt,
            ...(state.wait.nextProbeAt === undefined
              ? {}
              : { nextProbeAt: state.wait.nextProbeAt }),
            ...(state.wait.resetAt === undefined ? {} : { resetAt: state.wait.resetAt }),
            ...(state.wait.lastProbeAt === undefined
              ? {}
              : { lastProbeAt: state.wait.lastProbeAt }),
            ...(state.wait.reason === undefined ? {} : { reason: state.wait.reason }),
          },
        }),
  };
}

function eventId(
  projectId: ProjectId,
  action: string,
  occurredAt: string,
  discriminator = "",
): EventId {
  const digest = createHash("sha256")
    .update(projectId)
    .update("\0")
    .update(action)
    .update("\0")
    .update(occurredAt)
    .update("\0")
    .update(discriminator)
    .digest("hex")
    .slice(0, 24);
  return eventIdSchema.parse(`usage-auto-resume-${digest}`);
}

function result(
  projectId: ProjectId,
  status: UsageAutoResumeResult["status"],
  reason: string,
  wait?: UsageAutoResumeWaitState,
): UsageAutoResumeResult {
  return Object.freeze({
    status,
    projectId,
    reason,
    ...(wait?.nextProbeAt === undefined ? {} : { nextProbeAt: wait.nextProbeAt }),
    ...(wait === undefined ? {} : { probeAttempt: wait.probeAttempt }),
  });
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be positive`);
  return value;
}

/**
 * Durable, provider-neutral P7M1 usage auto-resume coordinator.
 *
 * Core state and the project setting are authoritative. Timers merely wake the coordinator; every
 * wake repeats all state, workspace, decision, and backend checks before any transition occurs.
 */
export class UsageAutoResumeService {
  readonly #clock: UsageAutoResumeClock;
  readonly #preflight: ReadonlyInspector<WorkspacePreflightResult>;
  readonly #recovery: RecoveryInspectionBoundary;
  readonly #initialBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #maxProbeAttempts: number;
  readonly #timers = new Map<ProjectId, unknown>();
  readonly #probing = new Set<ProjectId>();

  constructor(
    private readonly database: DensaAdeDatabase,
    private readonly options: UsageAutoResumeOptions,
  ) {
    this.#clock = options.clock ?? systemClock();
    this.#initialBackoffMs = positiveInteger(
      options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS,
      "initialBackoffMs",
    );
    this.#maxBackoffMs = positiveInteger(
      options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
      "maxBackoffMs",
    );
    this.#maxProbeAttempts = positiveInteger(
      options.maxProbeAttempts ?? DEFAULT_MAX_PROBE_ATTEMPTS,
      "maxProbeAttempts",
    );
    if (this.#maxBackoffMs < this.#initialBackoffMs) {
      throw new Error("maxBackoffMs must be at least initialBackoffMs");
    }
    const workspaceProbe = options.workspaceProbe;
    this.#preflight = options.preflight ?? new WorkspacePreflight();
    this.#recovery =
      options.recoveryInspector ??
      new RecoveryInspector(database.repositories, {
        ...(workspaceProbe === undefined ? {} : { workspaceProbe }),
      });
  }

  state(projectId: ProjectId): UsageAutoResumeState | undefined {
    const settings = this.database.repositories.projectSettings.findByProjectId(projectId);
    const parsed = parseState(settings?.values["usageAutoResume"]);
    return parsed?.projectId === projectId ? parsed : undefined;
  }

  enable(request: UsageAutoResumeRequest): UsageAutoResumeResult {
    if (!this.#validRequest(request))
      return result(request.projectId, "REJECTED", "Invalid opt-in");
    const project = this.database.repositories.projects.findById(request.projectId);
    if (project === undefined) return result(request.projectId, "NOT_FOUND", "Project not found");
    const now = this.#now();
    const previous = this.state(project.id);
    const state: UsageAutoResumeState = Object.freeze({
      formatVersion: 1,
      projectId: project.id,
      enabled: true,
      workspacePath: request.workspacePath,
      actor: request.actor,
      updatedAt: now,
      ...(previous?.wait === undefined ? {} : { wait: previous.wait }),
    });
    this.#persist(state, "USAGE_AUTO_RESUME_ENABLED", { enabled: true });
    if (project.state === "WAITING_FOR_USAGE") return this.handleUsageWait(project.id);
    return result(project.id, "IDLE", "Auto-resume is enabled and awaiting a usage-limit wait");
  }

  disable(projectId: ProjectId, actor: string): UsageAutoResumeResult {
    const state = this.state(projectId);
    if (state === undefined) return result(projectId, "DISABLED", "Auto-resume is not configured");
    if (actor.trim().length === 0)
      return result(projectId, "REJECTED", "Disable requires an actor");
    this.#disarm(projectId);
    const now = this.#now();
    const disabled: UsageAutoResumeState = Object.freeze({
      ...state,
      enabled: false,
      actor,
      updatedAt: now,
      ...(state.wait === undefined
        ? {}
        : {
            wait: Object.freeze({
              ...state.wait,
              status: "cancelled" as const,
              reason: "Auto-resume was disabled",
            }),
          }),
    });
    this.#persist(disabled, "USAGE_AUTO_RESUME_DISABLED", { enabled: false });
    return result(projectId, "DISABLED", "Auto-resume is disabled", disabled.wait);
  }

  cancel(projectId: ProjectId, actor: string): UsageAutoResumeResult {
    const state = this.state(projectId);
    if (state === undefined || state.wait === undefined) {
      return result(projectId, "CANCELLED", "No future usage probe is scheduled");
    }
    if (actor.trim().length === 0) return result(projectId, "REJECTED", "Cancel requires an actor");
    this.#disarm(projectId);
    const cancelled: UsageAutoResumeState = Object.freeze({
      ...state,
      actor,
      updatedAt: this.#now(),
      wait: Object.freeze({
        ...state.wait,
        status: "cancelled" as const,
        reason: "Future usage probes were cancelled",
      }),
    });
    this.#persist(cancelled, "USAGE_AUTO_RESUME_CANCELLED", {
      taskId: state.wait.taskId,
      probeAttempt: state.wait.probeAttempt,
    });
    return result(projectId, "CANCELLED", "Future usage probes were cancelled", cancelled.wait);
  }

  /** Re-arms a persisted schedule after a Core restart without changing its due time. */
  restore(projectId: ProjectId): UsageAutoResumeResult {
    const state = this.state(projectId);
    if (state === undefined || !state.enabled) {
      return result(projectId, "DISABLED", "Auto-resume is not enabled");
    }
    if (state.wait === undefined) return this.handleUsageWait(projectId);
    if (state.wait.status === "blocked") {
      return result(
        projectId,
        "BLOCKED",
        state.wait.reason ?? "Auto-resume is blocked",
        state.wait,
      );
    }
    if (state.wait.status === "cancelled") {
      return result(
        projectId,
        "CANCELLED",
        state.wait.reason ?? "Auto-resume is cancelled",
        state.wait,
      );
    }
    if (state.wait.status === "resumed") {
      return result(
        projectId,
        "RESUMED",
        state.wait.reason ?? "Project already resumed",
        state.wait,
      );
    }
    if (state.wait.nextProbeAt === undefined) {
      return this.#block(state, "Persisted usage probe schedule has no due time");
    }
    this.#arm(projectId, state.wait.nextProbeAt);
    return result(projectId, "SCHEDULED", "Persisted usage probe schedule restored", state.wait);
  }

  /** Called when project execution returns WAITING_FOR_USAGE. */
  handleUsageWait(projectId: ProjectId): UsageAutoResumeResult {
    const state = this.state(projectId);
    if (state === undefined || !state.enabled) {
      return result(projectId, "DISABLED", "Auto-resume requires explicit project opt-in");
    }
    const boundary = this.#waitingBoundary(projectId);
    if (typeof boundary === "string") return this.#block(state, boundary);
    if (
      state.wait?.taskId === boundary.task.id &&
      (state.wait.status === "scheduled" || state.wait.status === "probing") &&
      state.wait.nextProbeAt !== undefined
    ) {
      this.#arm(projectId, state.wait.nextProbeAt);
      return result(projectId, "SCHEDULED", "Usage probe is already scheduled", state.wait);
    }
    const nowMs = this.#clock.now();
    const resetMs =
      boundary.usageState.resetAt === undefined
        ? undefined
        : Date.parse(boundary.usageState.resetAt);
    const nextMs =
      resetMs !== undefined && resetMs > nowMs ? resetMs : nowMs + this.#initialBackoffMs;
    return this.#schedule(
      state,
      Object.freeze({
        taskId: boundary.task.id,
        status: "scheduled" as const,
        probeAttempt: 0,
        nextProbeAt: this.#iso(nextMs),
        ...(boundary.usageState.resetAt === undefined
          ? {}
          : { resetAt: boundary.usageState.resetAt }),
      }),
      "Initial conservative usage probe scheduled",
    );
  }

  /** Runs the due check; callers cannot bypass a persisted future nextProbeAt. */
  async probe(projectId: ProjectId): Promise<UsageAutoResumeResult> {
    if (this.#probing.has(projectId)) {
      const current = this.state(projectId);
      return result(projectId, "SCHEDULED", "A usage probe is already running", current?.wait);
    }
    const state = this.state(projectId);
    if (state === undefined || !state.enabled) {
      return result(projectId, "DISABLED", "Auto-resume is not enabled");
    }
    const wait = state.wait;
    if (wait === undefined || (wait.status !== "scheduled" && wait.status !== "probing")) {
      return result(projectId, "IDLE", "No active usage probe schedule exists", wait);
    }
    if (wait.nextProbeAt === undefined) return this.#block(state, "Probe schedule has no due time");
    if (this.#clock.now() < Date.parse(wait.nextProbeAt)) {
      this.#arm(projectId, wait.nextProbeAt);
      return result(projectId, "SCHEDULED", "Usage probe is not due yet", wait);
    }

    this.#probing.add(projectId);
    this.#disarm(projectId);
    try {
      const probingAt = this.#now();
      const attempt = wait.probeAttempt + 1;
      const probing: UsageAutoResumeState = Object.freeze({
        ...state,
        updatedAt: probingAt,
        wait: Object.freeze({
          ...wait,
          status: "probing" as const,
          probeAttempt: attempt,
          lastProbeAt: probingAt,
        }),
      });
      this.#persist(probing, "USAGE_PROBE_STARTED", {
        taskId: wait.taskId,
        probeAttempt: attempt,
      });

      const boundary = this.#waitingBoundary(projectId);
      if (typeof boundary === "string") return this.#block(probing, boundary);
      if (boundary.task.id !== wait.taskId) {
        return this.#block(probing, "The usage-wait task changed before probing");
      }

      let preflight: WorkspacePreflightResult;
      let recovery: RecoveryPlan;
      try {
        [preflight, recovery] = await Promise.all([
          this.#preflight.inspect(state.workspacePath),
          this.#recovery.inspect({ projectId, workspacePath: state.workspacePath }),
        ]);
      } catch (error) {
        const superseded = this.#supersededResult(probing);
        if (superseded !== undefined) return superseded;
        return this.#block(
          probing,
          `Workspace inspection failed closed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const workspaceSuperseded = this.#supersededResult(probing);
      if (workspaceSuperseded !== undefined) return workspaceSuperseded;
      const workspaceBlock = this.#workspaceBlock(preflight, recovery);
      if (workspaceBlock !== undefined) return this.#block(probing, workspaceBlock);

      let gates: SchedulerGateSnapshot;
      try {
        gates = await this.options.gateProvider.inspect(projectId);
      } catch (error) {
        const superseded = this.#supersededResult(probing);
        if (superseded !== undefined) return superseded;
        return this.#block(
          probing,
          `Mandatory decision inspection failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const gateSuperseded = this.#supersededResult(probing);
      if (gateSuperseded !== undefined) return gateSuperseded;
      const gateBlock = this.#gateBlock(gates);
      if (gateBlock !== undefined) return this.#block(probing, gateBlock);

      let observed: UsageState;
      try {
        observed = usageStateSchema.parse(await this.options.usageProbe.getUsageState());
      } catch (error) {
        observed = {
          status: "unknown",
          reason: `Usage probe failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const probeSuperseded = this.#supersededResult(probing);
      if (probeSuperseded !== undefined) return probeSuperseded;
      this.#appendEvent(probing, "USAGE_PROBE_COMPLETED", {
        taskId: wait.taskId,
        probeAttempt: attempt,
        usageStatus: observed.status,
        ...(observed.status === "limited" && observed.resetAt !== undefined
          ? { resetAt: observed.resetAt }
          : {}),
      });
      if (observed.status !== "available") {
        if (attempt >= this.#maxProbeAttempts) {
          return this.#block(
            probing,
            `Usage remained ${observed.status} after ${attempt} conservative probes`,
          );
        }
        const nowMs = this.#clock.now();
        const observedReset =
          observed.status === "limited" && observed.resetAt !== undefined
            ? Date.parse(observed.resetAt)
            : undefined;
        const exponential = this.#backoffFor(attempt);
        const nextMs =
          observedReset !== undefined && observedReset > nowMs
            ? observedReset
            : nowMs + exponential;
        return this.#schedule(
          probing,
          Object.freeze({
            ...wait,
            probeAttempt: attempt,
            lastProbeAt: probingAt,
            status: "scheduled" as const,
            nextProbeAt: this.#iso(nextMs),
            ...(observed.status === "limited" && observed.resetAt !== undefined
              ? { resetAt: observed.resetAt }
              : {}),
          }),
          `Agent usage remains ${observed.status}; next bounded probe scheduled`,
        );
      }
      return await this.#resume(probing, boundary);
    } finally {
      this.#probing.delete(projectId);
    }
  }

  /** Cancels only in-memory timers; durable schedules remain available to restore(). */
  dispose(): void {
    for (const projectId of this.#timers.keys()) this.#disarm(projectId);
  }

  #validRequest(request: UsageAutoResumeRequest): boolean {
    return (
      request.actor.trim().length > 0 &&
      isAbsolute(request.workspacePath) &&
      request.workspacePath.trim().length > 0
    );
  }

  #waitingBoundary(projectId: ProjectId): WaitingBoundary | string {
    const project = this.database.repositories.projects.findById(projectId);
    if (project === undefined) return "Project does not exist";
    if (project.state !== "WAITING_FOR_USAGE") {
      return `Project state is ${project.state}, not WAITING_FOR_USAGE`;
    }
    const waitingTasks = this.database.repositories.tasks
      .listByProjectId(projectId)
      .filter((task) => task.state === "WAITING_FOR_USAGE");
    if (waitingTasks.length !== 1) {
      return "Exactly one task must own the serial usage-wait boundary";
    }
    const task = waitingTasks[0];
    if (task === undefined) return "Usage-wait task is unavailable";
    const attempt = this.database.repositories.attempts.listByTaskId(task.id).at(-1);
    const run =
      attempt === undefined
        ? undefined
        : this.database.repositories.agentRuns.findByAttemptId(attempt.id);
    const rollback =
      attempt === undefined
        ? undefined
        : this.database.repositories.attemptRollbackPlans.findByAttemptId(attempt.id);
    if (
      attempt?.completedAt === undefined ||
      run?.completedAt === undefined ||
      rollback?.appliedAt === undefined
    ) {
      return "Usage-wait task is not at a confirmed rolled-back attempt boundary";
    }
    const usageEvent = this.database.eventJournal
      .replay({ projectId, types: ["USAGE_LIMIT_REACHED"], limit: 1_000 })
      .findLast((event) => event.taskId === task.id && event.payload["attemptId"] === attempt.id);
    const usage = usageStateSchema.safeParse(usageEvent?.payload["usageState"]);
    if (!usage.success || usage.data.status !== "limited") {
      return "Usage-wait task has no matching reliable usage-limit evidence";
    }
    return Object.freeze({ project, task, usageState: usage.data });
  }

  #workspaceBlock(preflight: WorkspacePreflightResult, recovery: RecoveryPlan): string | undefined {
    if (preflight.decision.outcome !== "PROCEED" || preflight.decision.requiresUserDecision) {
      return `Workspace preflight blocked auto-resume: ${preflight.decision.reason}`;
    }
    if (recovery.classification !== "CLEANLY_IDLE") {
      return `Workspace recovery blocked auto-resume: ${recovery.reason}`;
    }
    return undefined;
  }

  #gateBlock(gates: SchedulerGateSnapshot): string | undefined {
    if (
      !Array.isArray(gates.outstandingUserDecisionIds) ||
      !Array.isArray(gates.permissionBlockers)
    ) {
      return "Mandatory decision inspection returned an invalid gate snapshot";
    }
    if (
      gates.outstandingUserDecisionIds.some(
        (decisionId) => typeof decisionId !== "string" || decisionId.length === 0,
      ) ||
      gates.permissionBlockers.some(
        (blocker) =>
          blocker === null ||
          typeof blocker !== "object" ||
          typeof blocker.id !== "string" ||
          blocker.id.length === 0,
      )
    ) {
      return "Mandatory decision inspection returned malformed gate evidence";
    }
    if (gates.outstandingUserDecisionIds.length > 0) {
      return `Mandatory user decisions remain unresolved: ${gates.outstandingUserDecisionIds.join(", ")}`;
    }
    if (gates.permissionBlockers.length > 0) {
      return `Permission blockers prevent auto-resume: ${gates.permissionBlockers.map((item) => item.id).join(", ")}`;
    }
    return undefined;
  }

  async #resume(
    state: UsageAutoResumeState,
    boundary: WaitingBoundary,
  ): Promise<UsageAutoResumeResult> {
    const occurredAt = this.#now();
    const resumedWait: UsageAutoResumeWaitState = Object.freeze({
      ...(state.wait ?? {
        taskId: boundary.task.id,
        probeAttempt: 1,
      }),
      status: "resumed" as const,
      reason: "Agent usage availability was independently confirmed",
    });
    const resumedState: UsageAutoResumeState = Object.freeze({
      ...state,
      updatedAt: occurredAt,
      wait: resumedWait,
    });
    try {
      this.database.transaction((repositories) => {
        const currentProject = repositories.projects.findById(boundary.project.id);
        const currentTask = repositories.tasks.findById(boundary.task.id);
        if (
          currentProject?.state !== "WAITING_FOR_USAGE" ||
          currentTask?.state !== "WAITING_FOR_USAGE"
        ) {
          throw new Error("Authoritative usage-wait state changed before resume persistence");
        }
        const settings = repositories.projectSettings.findByProjectId(currentProject.id);
        const currentAutoResume = parseState(settings?.values["usageAutoResume"]);
        if (
          currentAutoResume?.enabled !== true ||
          currentAutoResume.wait?.status !== "probing" ||
          currentAutoResume.wait.taskId !== currentTask.id ||
          currentAutoResume.wait.probeAttempt !== resumedWait.probeAttempt
        ) {
          throw new Error("Auto-resume was disabled, cancelled, or superseded during probing");
        }
        repositories.projectSettings.set({
          projectId: currentProject.id,
          values: { ...(settings?.values ?? {}), usageAutoResume: jsonState(resumedState) },
          updatedAt: occurredAt,
        });
        repositories.events.append({
          id: eventId(currentProject.id, "usage-available", occurredAt),
          projectId: currentProject.id,
          phaseId: currentTask.phaseId,
          taskId: currentTask.id,
          type: "USAGE_AVAILABILITY_CONFIRMED",
          eventVersion: 1,
          occurredAt,
          actor: state.actor,
          payload: { probeAttempt: resumedWait.probeAttempt },
        });
        this.database.persistStateTransition(
          stateTransitionService.transitionTask(currentTask, "RETRYING", {
            actor: state.actor,
            occurredAt,
            reason: "Usage returned after the failed attempt was rolled back",
          }),
          eventId(currentProject.id, "task-retrying", occurredAt, currentTask.id),
        );
        this.database.persistStateTransition(
          stateTransitionService.transitionProject(currentProject, "RUNNING", {
            actor: state.actor,
            occurredAt,
            reason: "All conservative usage auto-resume checks passed",
          }),
          eventId(currentProject.id, "project-running", occurredAt),
        );
        repositories.events.append({
          id: eventId(currentProject.id, "project-resumed", occurredAt),
          projectId: currentProject.id,
          phaseId: currentTask.phaseId,
          taskId: currentTask.id,
          type: "PROJECT_RESUMED",
          eventVersion: 1,
          occurredAt,
          actor: state.actor,
          payload: {
            cause: "usage_available",
            recoverableTaskState: "RETRYING",
            probeAttempt: resumedWait.probeAttempt,
          },
        });
      });
    } catch (error) {
      const superseded = this.#supersededResult(state);
      if (superseded !== undefined) return superseded;
      return this.#block(
        state,
        `Auto-resume persistence failed closed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.#disarm(boundary.project.id);
    try {
      await this.options.onResumed?.(boundary.project.id);
    } catch (error) {
      this.#appendEvent(resumedState, "USAGE_AUTO_RESUME_CONTINUATION_FAILED", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    return result(
      boundary.project.id,
      "RESUMED",
      "Project resumed from the rolled-back task boundary",
      resumedWait,
    );
  }

  #schedule(
    state: UsageAutoResumeState,
    wait: UsageAutoResumeWaitState,
    reason: string,
  ): UsageAutoResumeResult {
    if (wait.nextProbeAt === undefined)
      return this.#block(state, "Scheduled probe has no due time");
    const scheduled: UsageAutoResumeState = Object.freeze({
      ...state,
      updatedAt: this.#now(),
      wait,
    });
    this.#persist(scheduled, "USAGE_AUTO_RESUME_SCHEDULED", {
      taskId: wait.taskId,
      probeAttempt: wait.probeAttempt,
      nextProbeAt: wait.nextProbeAt,
      ...(wait.resetAt === undefined ? {} : { resetAt: wait.resetAt }),
    });
    this.#arm(scheduled.projectId, wait.nextProbeAt);
    return result(state.projectId, "SCHEDULED", reason, wait);
  }

  #block(state: UsageAutoResumeState, reason: string): UsageAutoResumeResult {
    const projectId = this.#projectIdFor(state);
    this.#disarm(projectId);
    const blocked: UsageAutoResumeState = Object.freeze({
      ...state,
      updatedAt: this.#now(),
      ...(state.wait === undefined
        ? {}
        : { wait: Object.freeze({ ...state.wait, status: "blocked" as const, reason }) }),
    });
    this.#persist(blocked, "USAGE_AUTO_RESUME_BLOCKED", {
      reason,
      ...(blocked.wait === undefined ? {} : { taskId: blocked.wait.taskId }),
    });
    return result(projectId, "BLOCKED", reason, blocked.wait);
  }

  #persist(state: UsageAutoResumeState, type: string, payload: JsonObject): void {
    const projectId = this.#projectIdFor(state);
    this.database.transaction((repositories) => {
      const settings = repositories.projectSettings.findByProjectId(projectId);
      repositories.projectSettings.set({
        projectId,
        values: { ...(settings?.values ?? {}), usageAutoResume: jsonState(state) },
        updatedAt: state.updatedAt,
      });
      repositories.events.append({
        id: eventId(
          projectId,
          type,
          state.updatedAt,
          `${state.wait?.probeAttempt ?? 0}:${state.wait?.nextProbeAt ?? ""}:${repositories.events.latest(projectId)?.sequenceNumber ?? 0}`,
        ),
        projectId,
        type,
        eventVersion: 1,
        occurredAt: state.updatedAt,
        actor: state.actor,
        payload,
      });
    });
  }

  #appendEvent(state: UsageAutoResumeState, type: string, payload: JsonObject): void {
    const projectId = this.#projectIdFor(state);
    const occurredAt = this.#now();
    const latestSequence = this.database.repositories.events.latest(projectId)?.sequenceNumber ?? 0;
    this.database.repositories.events.append({
      id: eventId(
        projectId,
        type,
        occurredAt,
        `${state.wait?.probeAttempt ?? 0}:${latestSequence}`,
      ),
      projectId,
      type,
      eventVersion: 1,
      occurredAt,
      actor: state.actor,
      payload,
    });
  }

  #projectIdFor(state: UsageAutoResumeState): ProjectId {
    return state.projectId;
  }

  #supersededResult(probing: UsageAutoResumeState): UsageAutoResumeResult | undefined {
    const current = this.state(probing.projectId);
    if (current === undefined || !current.enabled) {
      return result(probing.projectId, "DISABLED", "Auto-resume was disabled during probing");
    }
    if (
      current.wait?.status === "probing" &&
      current.wait.taskId === probing.wait?.taskId &&
      current.wait.probeAttempt === probing.wait?.probeAttempt
    ) {
      return undefined;
    }
    if (current.wait?.status === "cancelled") {
      return result(
        probing.projectId,
        "CANCELLED",
        current.wait.reason ?? "Auto-resume was cancelled during probing",
        current.wait,
      );
    }
    if (current.wait?.status === "blocked") {
      return result(
        probing.projectId,
        "BLOCKED",
        current.wait.reason ?? "Auto-resume was blocked during probing",
        current.wait,
      );
    }
    return result(probing.projectId, "IDLE", "Usage probe was superseded", current.wait);
  }

  #arm(projectId: ProjectId, nextProbeAt: string): void {
    this.#disarm(projectId);
    const remaining = Math.max(0, Date.parse(nextProbeAt) - this.#clock.now());
    const handle = this.#clock.setTimeout(
      () => {
        this.#timers.delete(projectId);
        if (remaining > MAX_TIMER_DELAY_MS) {
          const current = this.state(projectId);
          if (current?.wait?.nextProbeAt !== undefined)
            this.#arm(projectId, current.wait.nextProbeAt);
          return;
        }
        void this.probe(projectId).catch(() => undefined);
      },
      Math.min(remaining, MAX_TIMER_DELAY_MS),
    );
    this.#timers.set(projectId, handle);
  }

  #disarm(projectId: ProjectId): void {
    const handle = this.#timers.get(projectId);
    if (handle !== undefined) this.#clock.clearTimeout(handle);
    this.#timers.delete(projectId);
  }

  #backoffFor(attempt: number): number {
    return Math.min(this.#maxBackoffMs, this.#initialBackoffMs * 2 ** Math.min(attempt, 30));
  }

  #now(): string {
    return isoTimestampSchema.parse(new Date(this.#clock.now()).toISOString());
  }

  #iso(milliseconds: number): string {
    return isoTimestampSchema.parse(new Date(milliseconds).toISOString());
  }
}
