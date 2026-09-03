// Copyright 2026 Densa Labs
// SPDX-License-Identifier: Apache-2.0

/**
 * Densa ADE Dashboard command center (Phase 11 Milestone 1).
 *
 * The Dashboard answers: "What is happening to my project?" It renders the
 * PROJECT, CURRENT, HEALTH, CHANGES, AGENTS/USAGE, and EVENTS sections from
 * Core truth only, and every meaningful metric resolves to an existing Core
 * v1 drill-down operation.
 *
 * This module is pure and protocol-only:
 *
 * - it imports `@densa-ade/protocol` types only, never `@densa-ade/core`,
 *   `@densa-ade/cli`, SQLite, or `vscode` / `vs/workbench`;
 * - every fact comes from versioned Core v1 operations (`dashboard.get` for
 *   the aggregate plus `projects.get` for verbatim phase/task progress,
 *   `events.replay` for the recent timeline, and optional `git.status` for
 *   workspace changes). The IDE never invents project, phase, task, usage,
 *   reset, token, cost, or Git state;
 * - the UI never marks work complete optimistically. Resolvers below return
 *   Core request payloads to send; only Core outcomes and `core.event`
 *   notifications (as refresh hints) change the model
 *   (`DASHBOARD_LIFECYCLE.optimisticComplete` is `false`);
 * - token/cost metrics do not exist in Core v1 and are never shown. Usage
 *   `resetAt` is exposed only when the persisted `UsageState` actually
 *   carries it; otherwise the model says unknown and offers no countdown;
 * - the agent backend/version is not exposed by Core v1 dashboard views, so
 *   the model reports it as unknown instead of guessing;
 * - additions/deletions are not provided by Core v1 Git views, so the
 *   CHANGES section reports them as unavailable instead of fabricating
 *   numbers;
 * - a reconnect or reload rebuilds the model from fresh `dashboard.get` +
 *   `projects.get` (+ `events.replay` for the timeline). Identical Core
 *   snapshots rebuild to identical Dashboard facts.
 *
 * Standard VS Code contribution mechanisms only (AGENTS.md §1.3): the surface
 * itself is the `densa-ade.dashboard` editor-area tab contributed in M3. This
 * milestone adds its content model, not new workbench patches.
 */

import {
  CORE_V1_METHODS,
  type CoreV1Dashboard,
  type CoreV1Method,
  type CoreV1PersistedEvent,
  type CoreV1ProjectSnapshot,
  type CoreV1Result,
  type ExecutionMode,
  type PhaseState,
  type ProjectState,
  type TaskState,
  type UsageState,
} from "@densa-ade/protocol";

/** Authoritative `git.status` result, when the CHANGES section is observed. */
export type DashboardGitStatus = CoreV1Result<"git.status">;

/** Command that opens the Dashboard editor-area tab (contributed in M3). */
export const DASHBOARD_COMMAND = "densa-ade.showDashboard" as const;

/** Editor-area tab viewType hosting Dashboard content beside source tabs. */
export const DASHBOARD_EDITOR_VIEW_TYPE = "densa-ade.dashboard" as const;

/** Canonical project states from AGENTS.md §2.2. Rendered verbatim, never remapped. */
export const DASHBOARD_CANONICAL_PROJECT_STATES: readonly ProjectState[] = Object.freeze([
  "DRAFT",
  "PLANNING",
  "READY",
  "RUNNING",
  "PAUSED",
  "WAITING_FOR_USER",
  "WAITING_FOR_USAGE",
  "BLOCKED",
  "COMPLETED",
  "FAILED",
]);

/** Canonical phase states from AGENTS.md §2.3. Rendered verbatim, never remapped. */
export const DASHBOARD_CANONICAL_PHASE_STATES: readonly PhaseState[] = Object.freeze([
  "PENDING",
  "READY",
  "RUNNING",
  "VALIDATING",
  "AWAITING_APPROVAL",
  "COMPLETED",
  "BLOCKED",
]);

/** Canonical task states from AGENTS.md §2.4. Rendered verbatim, never remapped. */
export const DASHBOARD_CANONICAL_TASK_STATES: readonly TaskState[] = Object.freeze([
  "PENDING",
  "READY",
  "RUNNING",
  "VALIDATING",
  "RETRYING",
  "WAITING_FOR_USER",
  "WAITING_FOR_USAGE",
  "BLOCKED",
  "INTERRUPTED",
  "COMPLETED",
  "CANCELLED",
]);

/**
 * Snapshot reads backing first render and every reconnect/reload, in refresh
 * order. `dashboard.get` is the aggregate; `projects.get` supplies verbatim
 * phase/task progress; `events.replay` restores the recent timeline from the
 * last applied sequence.
 */
export const DASHBOARD_OPEN_REFRESH_METHODS: readonly CoreV1Method[] = Object.freeze([
  "dashboard.get",
  "projects.get",
  "events.replay",
]);

/** Frozen-catalog Core operations the Dashboard surface may use once open. */
export const DASHBOARD_CAPABILITY_METHODS: readonly CoreV1Method[] = Object.freeze([
  "dashboard.get",
  "projects.get",
  "events.replay",
  "events.subscribe",
  "attempts.list",
  "validation.list",
  "validation.get",
  "logs.list",
  "git.status",
  "git.commit.get",
  "usage.get",
  "phases.report.get",
  "decisions.list",
]);

/**
 * Disposable-view lifecycle contract. The Dashboard tab renders Core truth;
 * closing it disposes the local handle only, and content never completes
 * work without a Core outcome.
 */
export const DASHBOARD_LIFECYCLE = Object.freeze({
  /** Closing disposes the local editor tab handle only. */
  closeDisposes: "view-handle-only",
  /** Core keeps running while project policy allows it. */
  coreContinuesAfterClose: true,
  /** Reopening replays from the last applied sequence, then refreshes. */
  reopenRefreshesSnapshot: true,
  /** The UI never marks phases or tasks complete optimistically. */
  optimisticComplete: false,
});

export type DashboardConnectionState =
  "disconnected" | "connecting" | "connected" | "version-mismatch" | "auth-failed";

export interface DashboardStateCount {
  readonly state: string;
  readonly count: number;
}

export interface DashboardProjectSection {
  readonly id: string;
  readonly name: string;
  /** Authoritative project state, rendered verbatim. */
  readonly state: ProjectState;
  readonly executionMode: ExecutionMode;
  readonly workspacePath: string;
  readonly completedTaskCount: number;
  readonly totalTaskCount: number;
  readonly attentionRequired: boolean;
  /** Deterministic elapsed time from persisted createdAt/updatedAt, when parseable. */
  readonly elapsedMs?: number;
  readonly elapsedKnown: boolean;
  readonly phaseCounts: readonly DashboardStateCount[];
  readonly taskCounts: readonly DashboardStateCount[];
}

export interface DashboardCurrentSection {
  readonly lifecycleState: ProjectState;
  readonly phaseId?: string;
  readonly phaseTitle?: string;
  readonly phaseState?: PhaseState;
  readonly taskId?: string;
  readonly taskTitle?: string;
  readonly taskState?: TaskState;
  readonly pendingApprovalCount: number;
  readonly hasCurrentWork: boolean;
}

export interface DashboardHealthSection {
  readonly passed: number;
  readonly failed: number;
  readonly incomplete: number;
  readonly recentFailureCount: number;
  readonly retryCount: number;
  readonly hasFailures: boolean;
}

export interface DashboardChangesSection {
  /** True only when a `git.status` result was supplied for this project. */
  readonly gitObserved: boolean;
  readonly available?: boolean;
  readonly headSha?: string;
  readonly branch?: string;
  readonly dirty?: boolean;
  readonly changedPaths?: readonly string[];
  readonly changedPathCount?: number;
  /**
   * Core v1 Git views do not report additions/deletions, so the Dashboard
   * always reports them as unavailable instead of fabricating numbers.
   */
  readonly additionsDeletionsAvailable: false;
}

export interface DashboardAgentsUsageSection {
  /**
   * Core v1 dashboard views do not expose the agent adapter id/version, so
   * the Dashboard always reports the backend as unknown instead of guessing.
   */
  readonly backend: "unknown";
  readonly usage: UsageState;
  /** Verbatim `resetAt` only when the persisted usage observation carries it. */
  readonly usageResetAt?: string;
  readonly usageResetKnown: boolean;
  readonly retryCount: number;
  readonly recentFailureCount: number;
}

export interface DashboardRecentEvent {
  readonly id: string;
  readonly type: string;
  readonly sequenceNumber: number;
  readonly occurredAt: string;
}

export interface DashboardEventsSection {
  readonly latestEventSequence: number;
  readonly recentEventCount: number;
  readonly recentEvents: readonly DashboardRecentEvent[];
}

export interface DashboardPhaseProgress {
  readonly id: string;
  readonly title: string;
  /** Authoritative runtime state, rendered verbatim. */
  readonly state: PhaseState;
  readonly position: number;
  readonly completedTaskCount: number;
  readonly totalTaskCount: number;
}

export interface DashboardPendingApproval {
  readonly kind: string;
  readonly summary: string;
  readonly requestedAt: string;
  readonly phaseId?: string;
  readonly taskId?: string;
}

export type DashboardBannerKind =
  "ok" | "attention" | "waiting-for-user" | "waiting-for-usage" | "blocked" | "failed";

export interface DashboardStatusBanner {
  readonly kind: DashboardBannerKind;
  readonly title: string;
  readonly detail: string;
  /** Actionable Core-backed next steps; never a fabricated countdown. */
  readonly nextActions: readonly string[];
}

export interface DashboardModelInput {
  /** Authoritative `dashboard.get` aggregate. */
  readonly dashboard: CoreV1Dashboard;
  /** Authoritative `projects.get` snapshot with verbatim phases/tasks. */
  readonly snapshot: CoreV1ProjectSnapshot;
  /** Authoritative `events.replay` page in Core order, when the timeline is shown. */
  readonly recentEvents?: readonly CoreV1PersistedEvent[];
  /** Authoritative `git.status` result, when the CHANGES section is observed. */
  readonly gitStatus?: DashboardGitStatus;
  readonly connectionState?: DashboardConnectionState;
  readonly coreDetail?: string;
}

export interface DashboardModel {
  readonly projectId: string;
  readonly project: DashboardProjectSection;
  readonly current: DashboardCurrentSection;
  readonly health: DashboardHealthSection;
  readonly changes: DashboardChangesSection;
  readonly agentsUsage: DashboardAgentsUsageSection;
  readonly events: DashboardEventsSection;
  readonly phases: readonly DashboardPhaseProgress[];
  readonly pendingApprovals: readonly DashboardPendingApproval[];
  readonly statusBanner: DashboardStatusBanner;
  readonly latestEventSequence: number;
  readonly keepAwakeState?: string;
  readonly keepAwakeSystemSleepPrevented?: boolean;
  readonly capabilityMethods: readonly CoreV1Method[];
  readonly optimisticComplete: false;
  readonly enabled: boolean;
  readonly reason?: string;
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function assertKnownMethod(method: string): asserts method is CoreV1Method {
  if ((CORE_V1_METHODS as readonly string[]).includes(method) !== true) {
    throw new Error(`Dashboard surface maps to unknown Core method ${method}.`);
  }
}

function blockedReason(connectionState: DashboardConnectionState, coreDetail?: string): string {
  const suffix = isNonEmptyText(coreDetail) === true ? ` (${coreDetail.trim()})` : "";
  switch (connectionState) {
    case "connected":
      return "";
    case "connecting":
      return `Densa ADE Core is connecting. Wait for the connection before using the Dashboard${suffix}.`;
    case "version-mismatch":
      return (
        "Densa ADE IDE client protocol mismatch. Update Densa ADE so the IDE and Core agree on the protocol version" +
        `${suffix}. Standard editor actions remain available.`
      );
    case "auth-failed":
      return (
        "Densa ADE Core rejected the IDE session. Restart the IDE or run `densa-ade core start` to refresh local trust" +
        `${suffix}. Standard editor actions remain available.`
      );
    case "disconnected":
    default:
      return (
        "Densa ADE Core is not connected. Start it with `densa-ade core start` and reconnect" +
        `${suffix}. Standard editor actions remain available.`
      );
  }
}

function elapsedMsBetween(createdAt: string, updatedAt: string): number | undefined {
  const created = Date.parse(createdAt);
  const updated = Date.parse(updatedAt);
  if (Number.isFinite(created) !== true || Number.isFinite(updated) !== true) {
    return undefined;
  }
  if (updated < created) {
    return undefined;
  }
  return updated - created;
}

function usageResetOf(usage: UsageState): { readonly resetAt?: string; readonly known: boolean } {
  if (usage.status === "limited" && usage.resetAt !== undefined) {
    return { resetAt: usage.resetAt, known: true };
  }
  return { known: false };
}

function buildStatusBanner(input: {
  readonly projectState: ProjectState;
  readonly attentionRequired: boolean;
  readonly pendingApprovalCount: number;
  readonly pendingSummaries: readonly string[];
  readonly usage: UsageState;
  readonly blockedTaskCount: number;
  readonly blockedPhaseCount: number;
  readonly retryCount: number;
  readonly recentFailureCount: number;
}): DashboardStatusBanner {
  if (input.projectState === "WAITING_FOR_USAGE") {
    const reset = usageResetOf(input.usage);
    const resetDetail =
      reset.known === true && reset.resetAt !== undefined
        ? `Core observed a usage reset at ${reset.resetAt}.`
        : "Core has no observed usage reset time, so the Dashboard shows no countdown.";
    const usageDetail =
      input.usage.status === "limited"
        ? `Agent usage is limited. ${resetDetail}`
        : input.usage.status === "unknown"
          ? `Agent usage is unknown${isNonEmptyText(input.usage.reason) === true ? `: ${String(input.usage.reason).trim()}` : ""}. The wait is preserved; availability is probed conservatively.`
          : "Agent usage wait is recorded. The wait is preserved; availability is probed conservatively.";
    return Object.freeze({
      kind: "waiting-for-usage",
      title: "Waiting for agent usage",
      detail:
        `${usageDetail} Project checkpoint and attempt diagnostics are persisted; ` +
        "nothing is retried blindly while waiting.",
      nextActions: Object.freeze([
        "Inspect usage.get for the persisted provider observation before expecting a resume.",
        "Verify the workspace checkpoint with git.status before resuming.",
        "Use project settings to enable or disable auto-resume after usage returns (opt-in).",
      ]),
    });
  }
  if (
    input.projectState === "BLOCKED" ||
    input.blockedTaskCount > 0 ||
    input.blockedPhaseCount > 0
  ) {
    return Object.freeze({
      kind: "blocked",
      title: "Blocked and awaiting a decision",
      detail:
        `The project requires intervention: ${String(input.blockedTaskCount)} blocked task(s), ` +
        `${String(input.blockedPhaseCount)} blocked phase(s), ${String(input.retryCount)} retries, ` +
        `${String(input.recentFailureCount)} recent validation failure(s). Attempt history and ` +
        "diagnostics are preserved; nothing was skipped silently.",
      nextActions: Object.freeze([
        "Open attempts.list for the blocked task to read attempt diagnostics.",
        "Open validation.list and validation.get for the failing acceptance evidence.",
        "Steer the roadmap through the Roadmap or Master Agent revision flow; retries need new evidence.",
      ]),
    });
  }
  if (input.projectState === "FAILED") {
    return Object.freeze({
      kind: "failed",
      title: "Project failed",
      detail:
        "Core recorded a project failure. Diagnostics and the event timeline are preserved; " +
        "no further work is scheduled until the failure is addressed.",
      nextActions: Object.freeze([
        "Open the recent event timeline and run logs for the failure sequence.",
        "Inspect validation evidence and attempt history for the failing task.",
        "Resume or revise the roadmap only after the underlying cause is addressed.",
      ]),
    });
  }
  if (input.projectState === "WAITING_FOR_USER" || input.pendingApprovalCount > 0) {
    const first =
      input.pendingSummaries[0] === undefined
        ? "A user decision is pending."
        : input.pendingSummaries[0];
    return Object.freeze({
      kind: "waiting-for-user",
      title: "Waiting for your decision",
      detail:
        `${String(input.pendingApprovalCount)} approval(s) pending. ${first} ` +
        "Nothing advances until the decision is recorded through Core.",
      nextActions: Object.freeze([
        "Review pending approvals, then approve or reject through the Roadmap surface.",
        "Permission approvals resolve through permissions.resolve with an explicit rationale.",
      ]),
    });
  }
  if (input.attentionRequired === true) {
    return Object.freeze({
      kind: "attention",
      title: "Needs attention",
      detail:
        "Core flagged this project as needing attention. Review pending approvals, " +
        "validation failures, or paused state before continuing.",
      nextActions: Object.freeze([
        "Review pending approvals and validation health below.",
        "Open the event timeline for the latest persisted facts.",
      ]),
    });
  }
  return Object.freeze({
    kind: "ok",
    title: "On track",
    detail:
      "No Core attention flag is set. Progress, health, and changes below reflect persisted facts.",
    nextActions: Object.freeze(["Open the Roadmap for the full phase plan."]),
  });
}

/**
 * Build the Dashboard content model from Core truth only.
 *
 * - `dashboard` provides the aggregate (project summary, state counts,
 *   current phase/task pointers, validation totals, retry/recent-failure
 *   counts, usage, keep-awake, pending approvals, latest event sequence);
 * - `snapshot` provides verbatim phase/task rows used for per-phase progress
 *   and for cross-checking the aggregate totals;
 * - `recentEvents` (when shown) provides the recent persisted timeline page;
 * - `gitStatus` (when observed) provides the CHANGES section.
 *
 * Any project-boundary disagreement or aggregate/snapshot total mismatch
 * throws with a refresh hint instead of inventing a fact. Missing optionals
 * degrade to explicit "not yet observed" sections with drill-downs, never to
 * fabricated numbers. Usage reset, token, and cost values are never invented:
 * reset appears only when the persisted `UsageState` carries it.
 */
export function buildDashboardModel(input: DashboardModelInput): DashboardModel {
  for (const method of [...DASHBOARD_OPEN_REFRESH_METHODS, ...DASHBOARD_CAPABILITY_METHODS]) {
    assertKnownMethod(method);
  }
  const dashboard = input.dashboard;
  const snapshot = input.snapshot;
  const projectId = dashboard.project.project.id;
  if (snapshot.summary.project.id !== projectId) {
    throw new Error(
      "Dashboard and project snapshot disagree on projectId; refresh dashboard.get and projects.get before rendering.",
    );
  }
  if (dashboard.project.workspacePath !== snapshot.summary.workspacePath) {
    throw new Error(
      "Dashboard and project snapshot disagree on workspacePath; refresh dashboard.get and projects.get before rendering.",
    );
  }
  const snapshotCompleted = snapshot.tasks.filter((task) => task.state === "COMPLETED").length;
  if (
    dashboard.project.completedTaskCount !== snapshotCompleted ||
    dashboard.project.totalTaskCount !== snapshot.tasks.length
  ) {
    throw new Error(
      "Dashboard aggregate and project snapshot disagree on task progress; refresh dashboard.get and projects.get before rendering.",
    );
  }
  if (dashboard.latestEventSequence !== snapshot.latestEventSequence) {
    throw new Error(
      "Dashboard aggregate and project snapshot disagree on latestEventSequence; refresh dashboard.get and projects.get before rendering.",
    );
  }
  for (const approval of dashboard.pendingApprovals) {
    if (approval.projectId !== projectId) {
      throw new Error("Dashboard approval crossed the requested project boundary.");
    }
  }
  const recentEvents = input.recentEvents ?? [];
  for (const event of recentEvents) {
    if (event.projectId !== projectId) {
      throw new Error("Dashboard event crossed the requested project boundary.");
    }
  }
  if (input.gitStatus !== undefined && input.gitStatus.projectId !== projectId) {
    throw new Error("Dashboard Git status crossed the requested project boundary.");
  }
  if (dashboard.currentPhase !== undefined && dashboard.currentPhase.projectId !== projectId) {
    throw new Error("Dashboard current phase crossed the requested project boundary.");
  }
  if (dashboard.currentTask !== undefined && dashboard.currentTask.projectId !== projectId) {
    throw new Error("Dashboard current task crossed the requested project boundary.");
  }

  const runtimePhaseById = new Map(snapshot.phases.map((phase) => [String(phase.id), phase]));
  if (
    dashboard.currentPhase !== undefined &&
    runtimePhaseById.has(dashboard.currentPhase.id) !== true
  ) {
    throw new Error(
      `Dashboard current phase ${dashboard.currentPhase.id} has no runtime row; refresh dashboard.get and projects.get before rendering.`,
    );
  }
  const runtimeTaskById = new Map(snapshot.tasks.map((task) => [String(task.id), task]));
  if (
    dashboard.currentTask !== undefined &&
    runtimeTaskById.has(dashboard.currentTask.id) !== true
  ) {
    throw new Error(
      `Dashboard current task ${dashboard.currentTask.id} has no runtime row; refresh dashboard.get and projects.get before rendering.`,
    );
  }

  const orderedPhases = [...snapshot.phases].sort((a, b) => a.position - b.position);
  const tasksByPhase = new Map<string, { readonly completed: number; readonly total: number }>();
  for (const phase of orderedPhases) {
    const rows = snapshot.tasks.filter((task) => String(task.phaseId) === String(phase.id));
    tasksByPhase.set(String(phase.id), {
      completed: rows.filter((task) => task.state === "COMPLETED").length,
      total: rows.length,
    });
  }
  const phases: readonly DashboardPhaseProgress[] = Object.freeze(
    orderedPhases.map((phase) => {
      const counts = tasksByPhase.get(String(phase.id)) ?? { completed: 0, total: 0 };
      return Object.freeze({
        id: phase.id,
        title: phase.title,
        state: phase.state,
        position: phase.position,
        completedTaskCount: counts.completed,
        totalTaskCount: counts.total,
      });
    }),
  );

  const elapsedMs = elapsedMsBetween(
    dashboard.project.project.createdAt,
    dashboard.project.project.updatedAt,
  );

  const project: DashboardProjectSection = Object.freeze({
    id: projectId,
    name: dashboard.project.project.name,
    state: dashboard.project.project.state,
    executionMode: dashboard.project.project.executionMode,
    workspacePath: dashboard.project.workspacePath,
    completedTaskCount: dashboard.project.completedTaskCount,
    totalTaskCount: dashboard.project.totalTaskCount,
    attentionRequired: dashboard.project.attentionRequired,
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
    elapsedKnown: elapsedMs !== undefined,
    phaseCounts: Object.freeze(dashboard.phaseCounts.map((entry) => Object.freeze({ ...entry }))),
    taskCounts: Object.freeze(dashboard.taskCounts.map((entry) => Object.freeze({ ...entry }))),
  });

  const currentPhaseRow =
    dashboard.currentPhase === undefined
      ? undefined
      : runtimePhaseById.get(dashboard.currentPhase.id);
  const currentTaskRow =
    dashboard.currentTask === undefined ? undefined : runtimeTaskById.get(dashboard.currentTask.id);
  const current: DashboardCurrentSection = Object.freeze({
    lifecycleState: dashboard.project.project.state,
    ...(currentPhaseRow === undefined
      ? {}
      : {
          phaseId: currentPhaseRow.id,
          phaseTitle: currentPhaseRow.title,
          phaseState: currentPhaseRow.state,
        }),
    ...(currentTaskRow === undefined
      ? {}
      : {
          taskId: currentTaskRow.id,
          taskTitle: currentTaskRow.title,
          taskState: currentTaskRow.state,
        }),
    pendingApprovalCount: dashboard.pendingApprovals.length,
    hasCurrentWork: currentPhaseRow !== undefined || currentTaskRow !== undefined,
  });

  const health: DashboardHealthSection = Object.freeze({
    passed: dashboard.validation.passed,
    failed: dashboard.validation.failed,
    incomplete: dashboard.validation.incomplete,
    recentFailureCount: dashboard.recentFailureCount,
    retryCount: dashboard.retryCount,
    hasFailures: dashboard.validation.failed > 0 || dashboard.recentFailureCount > 0,
  });

  const gitStatus = input.gitStatus;
  const changes: DashboardChangesSection = Object.freeze({
    gitObserved: gitStatus !== undefined,
    ...(gitStatus === undefined
      ? {}
      : {
          available: gitStatus.available,
          ...(gitStatus.headSha === undefined ? {} : { headSha: gitStatus.headSha }),
          ...(gitStatus.branch === undefined ? {} : { branch: gitStatus.branch }),
          ...(gitStatus.dirty === undefined ? {} : { dirty: gitStatus.dirty }),
          changedPaths: Object.freeze([...gitStatus.changedPaths]),
          changedPathCount: gitStatus.changedPaths.length,
        }),
    additionsDeletionsAvailable: false as const,
  });

  const reset = usageResetOf(dashboard.usage);
  const agentsUsage: DashboardAgentsUsageSection = Object.freeze({
    backend: "unknown" as const,
    usage: dashboard.usage,
    ...(reset.resetAt === undefined ? {} : { usageResetAt: reset.resetAt }),
    usageResetKnown: reset.known,
    retryCount: dashboard.retryCount,
    recentFailureCount: dashboard.recentFailureCount,
  });

  const recent: readonly DashboardRecentEvent[] = Object.freeze(
    [...recentEvents]
      .sort((a, b) => a.sequenceNumber - b.sequenceNumber)
      .map((event) =>
        Object.freeze({
          id: event.id,
          type: event.type,
          sequenceNumber: event.sequenceNumber,
          occurredAt: event.occurredAt,
        }),
      ),
  );
  const events: DashboardEventsSection = Object.freeze({
    latestEventSequence: dashboard.latestEventSequence,
    recentEventCount: recent.length,
    recentEvents: recent,
  });

  const pendingApprovals: readonly DashboardPendingApproval[] = Object.freeze(
    dashboard.pendingApprovals.map((approval) =>
      Object.freeze({
        kind: approval.kind,
        summary: approval.summary,
        requestedAt: approval.requestedAt,
        ...(approval.kind === "phase" || approval.kind === "task"
          ? { phaseId: approval.phaseId }
          : {}),
        ...(approval.kind === "task" ? { taskId: approval.taskId } : {}),
      }),
    ),
  );

  const blockedTaskCount =
    dashboard.taskCounts.find((entry) => entry.state === "BLOCKED")?.count ?? 0;
  const blockedPhaseCount =
    dashboard.phaseCounts.find((entry) => entry.state === "BLOCKED")?.count ?? 0;
  const statusBanner = buildStatusBanner({
    projectState: dashboard.project.project.state,
    attentionRequired: dashboard.project.attentionRequired,
    pendingApprovalCount: dashboard.pendingApprovals.length,
    pendingSummaries: dashboard.pendingApprovals.map((approval) => approval.summary),
    usage: dashboard.usage,
    blockedTaskCount,
    blockedPhaseCount,
    retryCount: dashboard.retryCount,
    recentFailureCount: dashboard.recentFailureCount,
  });

  const connectionState = input.connectionState ?? "connected";
  const enabled = connectionState === "connected";
  const reason = enabled === true ? undefined : blockedReason(connectionState, input.coreDetail);

  return Object.freeze({
    projectId,
    project,
    current,
    health,
    changes,
    agentsUsage,
    events,
    phases,
    pendingApprovals,
    statusBanner,
    latestEventSequence: dashboard.latestEventSequence,
    ...(dashboard.keepAwake === undefined ? {} : { keepAwakeState: dashboard.keepAwake.state }),
    ...(dashboard.keepAwake === undefined
      ? {}
      : { keepAwakeSystemSleepPrevented: dashboard.keepAwake.systemSleepPrevented }),
    capabilityMethods: DASHBOARD_CAPABILITY_METHODS,
    optimisticComplete: false as const,
    enabled,
    ...(reason === undefined ? {} : { reason }),
  });
}

/** Look up one per-phase progress row. Throws on unknown ids instead of guessing. */
export function dashboardPhaseProgressById(
  model: DashboardModel,
  phaseId: string,
): DashboardPhaseProgress {
  const found = model.phases.find((entry) => entry.id === phaseId);
  if (found === undefined) {
    throw new Error(`Unknown dashboard phase: ${phaseId}.`);
  }
  return found;
}

/**
 * True when a persisted `core.event` notification is only a refresh hint.
 * Dashboard notifications never mutate the model directly; the caller
 * re-requests `dashboard.get`/`projects.get` (and `events.replay` for the
 * timeline) and rebuilds via `buildDashboardModel()`.
 */
export function dashboardEventIsRefreshHint(eventType: string): boolean {
  return eventType.trim().length > 0;
}

export type DashboardDrilldown =
  | {
      readonly kind: "dashboard-refresh";
      readonly method: "dashboard.get";
      readonly projectId: string;
    }
  | {
      readonly kind: "project-snapshot";
      readonly method: "projects.get";
      readonly projectId: string;
    }
  | {
      readonly kind: "events";
      readonly method: "events.replay";
      readonly projectId: string;
      readonly afterSequence: number;
    }
  | {
      readonly kind: "run-logs";
      readonly method: "logs.list";
      readonly projectId: string;
      readonly phaseId?: string;
      readonly taskId?: string;
      readonly attemptId?: string;
    }
  | {
      readonly kind: "attempts";
      readonly method: "attempts.list";
      readonly projectId: string;
      readonly taskId: string;
    }
  | {
      readonly kind: "validation-runs";
      readonly method: "validation.list";
      readonly projectId: string;
      readonly taskId: string;
    }
  | {
      readonly kind: "validation-detail";
      readonly method: "validation.get";
      readonly projectId: string;
      readonly validationRunId: string;
    }
  | {
      readonly kind: "git-status";
      readonly method: "git.status";
      readonly projectId: string;
      readonly workspacePath: string;
    }
  | {
      readonly kind: "git-commit";
      readonly method: "git.commit.get";
      readonly projectId: string;
      readonly sha: string;
    }
  | {
      readonly kind: "usage";
      readonly method: "usage.get";
      readonly projectId: string;
    }
  | {
      readonly kind: "phase-report";
      readonly method: "phases.report.get";
      readonly projectId: string;
      readonly phaseId: string;
    }
  | {
      readonly kind: "decisions";
      readonly method: "decisions.list";
      readonly projectId: string;
    };

/**
 * Resolve a Dashboard metric to the existing Core v1 operation that backs
 * its drill-down. Tests/retries/commits/events each map to their persisted
 * source: validation runs to `validation.list`/`validation.get`, retries to
 * `attempts.list`, commits to `git.status`/`git.commit.get`, events to
 * `events.replay`/`logs.list`, phase progress to `phases.report.get`,
 * usage to `usage.get`. The IDE carries persisted IDs through to Core and
 * never fabricates detail locally.
 */
export function resolveDashboardDrilldown(
  model: DashboardModel,
  selection:
    | { readonly kind: "dashboard-refresh" }
    | { readonly kind: "project-snapshot" }
    | { readonly kind: "events"; readonly afterSequence?: number }
    | {
        readonly kind: "run-logs";
        readonly phaseId?: string;
        readonly taskId?: string;
        readonly attemptId?: string;
      }
    | { readonly kind: "attempts"; readonly taskId: string }
    | { readonly kind: "validation-runs"; readonly taskId: string }
    | { readonly kind: "validation-detail"; readonly validationRunId: string }
    | { readonly kind: "git-status" }
    | { readonly kind: "git-commit"; readonly sha: string }
    | { readonly kind: "usage" }
    | { readonly kind: "phase-report"; readonly phaseId: string }
    | { readonly kind: "decisions" },
): DashboardDrilldown {
  switch (selection.kind) {
    case "dashboard-refresh": {
      assertKnownMethod("dashboard.get");
      return Object.freeze({
        kind: "dashboard-refresh" as const,
        method: "dashboard.get" as const,
        projectId: model.projectId,
      });
    }
    case "project-snapshot": {
      assertKnownMethod("projects.get");
      return Object.freeze({
        kind: "project-snapshot" as const,
        method: "projects.get" as const,
        projectId: model.projectId,
      });
    }
    case "events": {
      assertKnownMethod("events.replay");
      const afterSequence =
        selection.afterSequence === undefined ? model.latestEventSequence : selection.afterSequence;
      if (Number.isInteger(afterSequence) !== true || afterSequence < 0) {
        throw new Error("Dashboard events drill-down requires a non-negative afterSequence.");
      }
      return Object.freeze({
        kind: "events" as const,
        method: "events.replay" as const,
        projectId: model.projectId,
        afterSequence,
      });
    }
    case "run-logs": {
      assertKnownMethod("logs.list");
      const phaseId =
        isNonEmptyText(selection.phaseId) === true ? selection.phaseId.trim() : undefined;
      const taskId =
        isNonEmptyText(selection.taskId) === true ? selection.taskId.trim() : undefined;
      const attemptId =
        isNonEmptyText(selection.attemptId) === true ? selection.attemptId.trim() : undefined;
      if (phaseId !== undefined) {
        dashboardPhaseProgressById(model, phaseId);
      }
      return Object.freeze({
        kind: "run-logs" as const,
        method: "logs.list" as const,
        projectId: model.projectId,
        ...(phaseId === undefined ? {} : { phaseId }),
        ...(taskId === undefined ? {} : { taskId }),
        ...(attemptId === undefined ? {} : { attemptId }),
      });
    }
    case "attempts": {
      if (isNonEmptyText(selection.taskId) !== true) {
        throw new Error("Dashboard attempts drill-down requires a persisted taskId.");
      }
      assertKnownMethod("attempts.list");
      return Object.freeze({
        kind: "attempts" as const,
        method: "attempts.list" as const,
        projectId: model.projectId,
        taskId: selection.taskId.trim(),
      });
    }
    case "validation-runs": {
      if (isNonEmptyText(selection.taskId) !== true) {
        throw new Error("Dashboard validation drill-down requires a persisted taskId.");
      }
      assertKnownMethod("validation.list");
      return Object.freeze({
        kind: "validation-runs" as const,
        method: "validation.list" as const,
        projectId: model.projectId,
        taskId: selection.taskId.trim(),
      });
    }
    case "validation-detail": {
      if (isNonEmptyText(selection.validationRunId) !== true) {
        throw new Error("Dashboard validation drill-down requires a persisted validationRunId.");
      }
      assertKnownMethod("validation.get");
      return Object.freeze({
        kind: "validation-detail" as const,
        method: "validation.get" as const,
        projectId: model.projectId,
        validationRunId: selection.validationRunId.trim(),
      });
    }
    case "git-status": {
      if (isNonEmptyText(model.project.workspacePath) !== true) {
        throw new Error("Dashboard Git drill-down requires the persisted workspacePath.");
      }
      assertKnownMethod("git.status");
      return Object.freeze({
        kind: "git-status" as const,
        method: "git.status" as const,
        projectId: model.projectId,
        workspacePath: model.project.workspacePath,
      });
    }
    case "git-commit": {
      if (isNonEmptyText(selection.sha) !== true) {
        throw new Error("Dashboard commit drill-down requires a persisted commit SHA.");
      }
      assertKnownMethod("git.commit.get");
      return Object.freeze({
        kind: "git-commit" as const,
        method: "git.commit.get" as const,
        projectId: model.projectId,
        sha: selection.sha.trim(),
      });
    }
    case "usage": {
      assertKnownMethod("usage.get");
      return Object.freeze({
        kind: "usage" as const,
        method: "usage.get" as const,
        projectId: model.projectId,
      });
    }
    case "phase-report": {
      if (isNonEmptyText(selection.phaseId) !== true) {
        throw new Error("Dashboard phase-report drill-down requires a persisted phaseId.");
      }
      const phase = dashboardPhaseProgressById(model, selection.phaseId.trim());
      assertKnownMethod("phases.report.get");
      return Object.freeze({
        kind: "phase-report" as const,
        method: "phases.report.get" as const,
        projectId: model.projectId,
        phaseId: phase.id,
      });
    }
    case "decisions": {
      assertKnownMethod("decisions.list");
      return Object.freeze({
        kind: "decisions" as const,
        method: "decisions.list" as const,
        projectId: model.projectId,
      });
    }
  }
}

export interface DashboardReopenRefresh {
  readonly action: "refresh-before-render";
  readonly refreshMethods: readonly CoreV1Method[];
  readonly projectId: string;
  readonly reason: string;
}

/**
 * Reconnect/reload recipe for the Dashboard: refresh `dashboard.get` and
 * `projects.get`, replay `events.replay` from the last applied sequence
 * (then re-subscribe for live hints), and rebuild via
 * `buildDashboardModel()`. Identical Core snapshots rebuild to identical
 * Dashboard facts; live `core.event` notifications are refresh hints only.
 */
export function resolveDashboardReopenRefresh(projectId: string): DashboardReopenRefresh {
  if (isNonEmptyText(projectId) !== true) {
    throw new Error(
      "Dashboard reopen requires a persisted projectId from Core (projects.list); the IDE does not invent one.",
    );
  }
  return Object.freeze({
    action: "refresh-before-render",
    refreshMethods: DASHBOARD_OPEN_REFRESH_METHODS,
    projectId: projectId.trim(),
    reason:
      "Refresh dashboard.get and projects.get, replay events.replay from the last applied sequence, " +
      "then rebuild the Dashboard model. Live core.event notifications are hints to refresh, never direct edits.",
  });
}
