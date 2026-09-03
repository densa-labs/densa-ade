// Copyright 2026 Densa Labs
// SPDX-License-Identifier: Apache-2.0

/**
 * Densa ADE pause/intervene/live-run UX (Phase 11 Milestone 4).
 *
 * Live autonomous execution answers: "What is running right now, and how do
 * I stay in control?" The surface exposes Pause, Cancel current run (where
 * supported), Stop Project, Open current task, View Agent Run, View Changes,
 * and Resume after intervention, while rendering the current lifecycle state
 * accurately (`RUNNING`, `VALIDATING`, `RETRYING`, `WAITING_FOR_USAGE`,
 * `WAITING_FOR_USER`, `BLOCKED`, and the rest verbatim). When the workspace
 * changes while paused, the model surfaces the detected changes and explains
 * that resume revalidates and recontextualizes before scheduling more work.
 *
 * This module is pure and protocol-only:
 *
 * - it imports `@densa-ade/protocol` types only, never `@densa-ade/core`,
 *   `@densa-ade/cli`, SQLite, or `vscode` / `vs/workbench`;
 * - every fact comes from versioned Core v1 operations (`projects.get` for
 *   the authoritative project/task/phase snapshot, `dashboard.get` for the
 *   aggregate current-work pointers and retry counts, `git.status` for the
 *   observed workspace). The IDE never invents project, task, usage, reset,
 *   token, cost, or Git state;
 * - the UI never changes lifecycle state optimistically. Resolvers below
 *   return Core request payloads to send; only Core outcomes and `core.event`
 *   notifications (as refresh hints) change what is shown
 *   (`LIVE_RUN_LIFECYCLE.optimisticComplete` is `false`). Control outcomes
 *   are applied through `applyLiveRunControlOutcome()`, which never edits
 *   the snapshot model: it returns a refresh recipe plus a notice, and the
 *   caller rebuilds via `buildLiveRunModel()` from fresh Core reads;
 * - commands are idempotent by construction. Repeated pause/stop requests
 *   observe Core's durable control record and return `UNCHANGED`; the effect
 *   mapper reports the no-op instead of appending a conflicting local fact;
 * - Cancel resolves to the daemon-supported `project.cancel` transport alias
 *   (same payload shape as `projects.pause`; see
 *   `docs/execution-controls.md`) with the frozen `projects.pause` method as
 *   the fallback for strictly-v1 transports. Immediate cancellation aborts
 *   the active worker through Core; it never orphans the process and never
 *   deletes project work — Core leaves the task `INTERRUPTED` and finalizes
 *   the pause boundary;
 * - intervention is reported, never auto-resolved. A `PAUSED` project with
 *   observed workspace changes (or a Core `INTERVENTION_REQUIRED` outcome)
 *   shows the changed paths and requires an explicit
 *   `acknowledgeIntervention` resume. The IDE never overwrites manual edits.
 *
 * Standard VS Code contribution mechanisms only (AGENTS.md §1.3): the surface
 * renders inside the existing `densa-ade.dashboard` editor-area tab
 * contributed in M3 (Open current task / View Agent Run / View Changes are
 * drill-downs, not new views). This milestone adds its content model, not
 * new workbench patches or new activity-bar entries.
 */

import {
  CORE_V1_METHODS,
  type CoreV1Dashboard,
  type CoreV1Method,
  type CoreV1ProjectSnapshot,
  type CoreV1Result,
  type ExecutionMode,
  type ProjectState,
  type TaskState,
} from "@densa-ade/protocol";

/** Authoritative `git.status` result, when the workspace is observed. */
export type LiveRunGitStatus = CoreV1Result<"git.status">;

/** Authoritative Core control outcome (`projects.pause`/`resume`/`stop`). */
export type LiveRunControlOutcome =
  CoreV1Result<"projects.pause"> | CoreV1Result<"projects.resume"> | CoreV1Result<"projects.stop">;

/** Canonical project states from AGENTS.md §2.2. Rendered verbatim. */
export const LIVE_RUN_CANONICAL_PROJECT_STATES: readonly ProjectState[] = Object.freeze([
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

/** Canonical task states from AGENTS.md §2.4. Rendered verbatim. */
export const LIVE_RUN_CANONICAL_TASK_STATES: readonly TaskState[] = Object.freeze([
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
 * Snapshot reads backing first render and every reopen, in refresh order.
 * `projects.get` is authoritative; `dashboard.get` supplies the aggregate
 * current-work pointers and retry counts used for the CURRENT section.
 */
export const LIVE_RUN_OPEN_REFRESH_METHODS: readonly CoreV1Method[] = Object.freeze([
  "projects.get",
  "dashboard.get",
]);

/** Frozen-catalog Core operations the live-run surface may use once open. */
export const LIVE_RUN_CAPABILITY_METHODS: readonly CoreV1Method[] = Object.freeze([
  "projects.get",
  "dashboard.get",
  "projects.pause",
  "projects.resume",
  "projects.stop",
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
]);

/**
 * Immediate-cancel transport alias accepted by the authenticated Core daemon
 * alongside the frozen v1 catalog (see `docs/execution-controls.md`). The
 * payload shape is identical to `projects.pause`; the daemon parses it with
 * the same contract and routes it to immediate worker cancellation instead
 * of a graceful safe-boundary pause.
 */
export const LIVE_RUN_CANCEL_TRANSPORT_METHOD = "project.cancel" as const;

/** Frozen-catalog fallback for Cancel on strictly-v1 transports. */
export const LIVE_RUN_CANCEL_FALLBACK_METHOD = "projects.pause" as const satisfies CoreV1Method;

/**
 * Disposable-view lifecycle contract. The live-run surface renders Core
 * truth; closing it disposes the local handle only, and content never
 * changes lifecycle state without a Core outcome.
 */
export const LIVE_RUN_LIFECYCLE = Object.freeze({
  /** Closing disposes the local editor tab handle only. */
  closeDisposes: "view-handle-only",
  /** Core keeps running while project policy allows it. */
  coreContinuesAfterClose: true,
  /** Reopening replays from the last applied sequence, then refreshes. */
  reopenRefreshesSnapshot: true,
  /** The UI never pauses, resumes, stops, or completes work optimistically. */
  optimisticComplete: false,
});

export type LiveRunConnectionState =
  "disconnected" | "connecting" | "connected" | "version-mismatch" | "auth-failed";

export type LiveRunLifecycleKind =
  | "running"
  | "validating"
  | "retrying"
  | "paused"
  | "waiting-for-usage"
  | "waiting-for-user"
  | "blocked"
  | "idle"
  | "completed"
  | "failed";

export interface LiveRunLifecycle {
  readonly kind: LiveRunLifecycleKind;
  /** Authoritative project state, rendered verbatim. */
  readonly projectState: ProjectState;
  /** Authoritative current task state when a current task is known. */
  readonly taskState?: TaskState;
  readonly title: string;
  readonly detail: string;
}

export interface LiveRunCurrentTask {
  readonly id: string;
  readonly title: string;
  readonly phaseId: string;
  /** Authoritative runtime state, rendered verbatim. */
  readonly state: TaskState;
  readonly phaseTitle?: string;
  readonly phaseState?: string;
}

export type LiveRunControlId = "pause" | "cancel" | "stop" | "resume";

export interface LiveRunControlDescriptor {
  readonly id: LiveRunControlId;
  readonly label: string;
  readonly enabled: boolean;
  /** Human-readable explanation when `enabled` is false. Always present then. */
  readonly reason?: string;
  /** True when sending is safe but Core answers UNCHANGED (already applied). */
  readonly idempotentNoop?: boolean;
}

export interface LiveRunIntervention {
  readonly detected: boolean;
  readonly changedPaths: readonly string[];
  readonly dirty?: boolean;
  readonly message?: string;
  /** True when resume without `acknowledgeIntervention` returns INTERVENTION_REQUIRED. */
  readonly resumeRequiresAck: boolean;
  /** Verbatim Core outcome status when the detection came from a control outcome. */
  readonly outcomeStatus?: string;
}

export interface LiveRunLastControl {
  /** Verbatim Core outcome status. */
  readonly status: string;
  readonly reason?: string;
  readonly changedPaths: readonly string[];
}

export interface LiveRunModelInput {
  /** Authoritative `projects.get` snapshot. */
  readonly snapshot: CoreV1ProjectSnapshot;
  /** Authoritative `dashboard.get` aggregate, when the CURRENT section is shown. */
  readonly dashboard?: CoreV1Dashboard;
  /** Authoritative `git.status` result, when the workspace is observed. */
  readonly gitStatus?: LiveRunGitStatus;
  /** Last Core control outcome applied to this surface, when one exists. */
  readonly lastControl?: LiveRunControlOutcome;
  readonly connectionState?: LiveRunConnectionState;
  readonly coreDetail?: string;
}

export interface LiveRunModel {
  readonly projectId: string;
  readonly projectName: string;
  /** Authoritative project state, rendered verbatim. */
  readonly projectState: ProjectState;
  readonly executionMode: ExecutionMode;
  readonly workspacePath: string;
  readonly lifecycle: LiveRunLifecycle;
  readonly currentTask?: LiveRunCurrentTask;
  readonly retryCount: number;
  readonly recentFailureCount: number;
  readonly controls: Record<LiveRunControlId, LiveRunControlDescriptor>;
  readonly intervention: LiveRunIntervention;
  readonly lastControl?: LiveRunLastControl;
  readonly latestEventSequence: number;
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
    throw new Error(`Live-run surface maps to unknown Core method ${method}.`);
  }
}

function blockedReason(connectionState: LiveRunConnectionState, coreDetail?: string): string {
  const suffix = isNonEmptyText(coreDetail) === true ? ` (${coreDetail.trim()})` : "";
  switch (connectionState) {
    case "connected":
      return "";
    case "connecting":
      return `Densa ADE Core is connecting. Wait for the connection before using live-run controls${suffix}.`;
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

const ACTIVE_TASK_STATES: readonly TaskState[] = Object.freeze([
  "RUNNING",
  "VALIDATING",
  "RETRYING",
  "WAITING_FOR_USER",
  "WAITING_FOR_USAGE",
]);

function deriveLifecycle(input: {
  readonly projectState: ProjectState;
  readonly taskState?: TaskState;
  readonly taskId?: string;
  readonly taskTitle?: string;
}): LiveRunLifecycle {
  const { projectState, taskState, taskId, taskTitle } = input;
  const taskSuffix =
    taskId === undefined ? "" : ` Current task ${taskId}${taskTitle ?? ""} is ${taskState}.`;
  switch (projectState) {
    case "RUNNING": {
      if (taskState === "VALIDATING") {
        return Object.freeze({
          kind: "validating" as const,
          projectState,
          ...(taskState === undefined ? {} : { taskState }),
          title: "Validating",
          detail: `Core is independently validating worker output.${taskSuffix} Only the validation pipeline may mark work complete.`,
        });
      }
      if (taskState === "RETRYING") {
        return Object.freeze({
          kind: "retrying" as const,
          projectState,
          ...(taskState === undefined ? {} : { taskState }),
          title: "Retrying with new evidence",
          detail: `Core is retrying after a recorded failure.${taskSuffix} Attempt diagnostics are preserved; retries carry fresh failure evidence.`,
        });
      }
      return Object.freeze({
        kind: "running" as const,
        projectState,
        ...(taskState === undefined ? {} : { taskState }),
        title: "Running",
        detail:
          taskId === undefined
            ? "Core is scheduling the next ready task. Pause takes effect at the current safe boundary."
            : `Core is executing work.${taskSuffix} Pause takes effect at the current safe boundary; Cancel interrupts the current worker where supported.`,
      });
    }
    case "PAUSED":
      return Object.freeze({
        kind: "paused" as const,
        projectState,
        ...(taskState === undefined ? {} : { taskState }),
        title: "Paused",
        detail: `Core holds a durable paused boundary; no worker is scheduled.${taskSuffix} Resume revalidates recovery and workspace state first.`,
      });
    case "WAITING_FOR_USAGE":
      return Object.freeze({
        kind: "waiting-for-usage" as const,
        projectState,
        ...(taskState === undefined ? {} : { taskState }),
        title: "Waiting for agent usage",
        detail: `Core checkpointed the run and waits for agent availability.${taskSuffix} Nothing is retried blindly while waiting.`,
      });
    case "WAITING_FOR_USER":
      return Object.freeze({
        kind: "waiting-for-user" as const,
        projectState,
        ...(taskState === undefined ? {} : { taskState }),
        title: "Waiting for your decision",
        detail: `Core needs an explicit user decision before continuing.${taskSuffix} Nothing advances until the decision is recorded through Core.`,
      });
    case "BLOCKED":
      return Object.freeze({
        kind: "blocked" as const,
        projectState,
        ...(taskState === undefined ? {} : { taskState }),
        title: "Blocked",
        detail: `Core stopped scheduling after repeated failures or a workspace conflict.${taskSuffix} Attempt history and diagnostics are preserved; retries need new evidence.`,
      });
    case "FAILED":
      return Object.freeze({
        kind: "failed" as const,
        projectState,
        ...(taskState === undefined ? {} : { taskState }),
        title: "Failed",
        detail:
          "Core recorded a project failure. Diagnostics and the event timeline are preserved; no further work is scheduled until the failure is addressed.",
      });
    case "COMPLETED":
      return Object.freeze({
        kind: "completed" as const,
        projectState,
        ...(taskState === undefined ? {} : { taskState }),
        title: "Completed",
        detail: "Core finished the project. Run controls are no longer applicable.",
      });
    case "DRAFT":
    case "PLANNING":
    case "READY":
    default:
      return Object.freeze({
        kind: "idle" as const,
        projectState,
        ...(taskState === undefined ? {} : { taskState }),
        title: "Not running",
        detail: `The project is ${projectState}; no live worker is active. Start execution through Core before run controls apply.`,
      });
  }
}

function describeControls(
  projectState: ProjectState,
): Record<LiveRunControlId, LiveRunControlDescriptor> {
  const running = projectState === "RUNNING";
  const paused = projectState === "PAUSED";
  const stoppable =
    running ||
    paused ||
    projectState === "WAITING_FOR_USER" ||
    projectState === "WAITING_FOR_USAGE" ||
    projectState === "BLOCKED";
  return Object.freeze({
    pause: running
      ? Object.freeze({
          id: "pause" as const,
          label: "Pause",
          enabled: true,
        })
      : Object.freeze({
          id: "pause" as const,
          label: "Pause",
          enabled: false,
          ...(paused ? { idempotentNoop: true as const } : {}),
          reason:
            paused === true
              ? "The project is already paused; Core would return UNCHANGED without appending a new fact."
              : `Pause is available while the project is RUNNING; the current state is ${projectState}. Refresh projects.get before controlling a live run.`,
        }),
    cancel: running
      ? Object.freeze({
          id: "cancel" as const,
          label: "Cancel current run",
          enabled: true,
        })
      : Object.freeze({
          id: "cancel" as const,
          label: "Cancel current run",
          enabled: false,
          reason: `Cancel is available while a worker is active; the project is ${projectState}. Refresh projects.get before controlling a live run.`,
        }),
    stop: stoppable
      ? Object.freeze({
          id: "stop" as const,
          label: "Stop Project",
          enabled: true,
        })
      : Object.freeze({
          id: "stop" as const,
          label: "Stop Project",
          enabled: false,
          reason: `Stop is available for a live or paused project; the current state is ${projectState}. Stopping never deletes project work.`,
        }),
    resume: paused
      ? Object.freeze({
          id: "resume" as const,
          label: "Resume",
          enabled: true,
        })
      : Object.freeze({
          id: "resume" as const,
          label: "Resume",
          enabled: false,
          reason: `Resume needs a durable paused boundary; the project is ${projectState}, not PAUSED. Refresh projects.get before resuming.`,
        }),
  });
}

/**
 * Build the live-run content model from Core truth only.
 *
 * - `snapshot` (`projects.get`) provides the authoritative project state,
 *   workspace path, runtime phase/task rows, and latest event sequence;
 * - `dashboard` (`dashboard.get`, when shown) provides the aggregate
 *   current phase/task pointers plus retry/recent-failure counts;
 * - `gitStatus` (`git.status`, when observed) provides the workspace
 *   observation used for the paused-intervention panel;
 * - `lastControl` is the verbatim Core outcome of the most recent
 *   pause/resume/stop request issued from this surface, when one exists.
 *
 * Any project-boundary disagreement throws with a refresh hint instead of
 * inventing a fact. Lifecycle kinds, task states, and control outcomes are
 * rendered verbatim from Core; only Core outcomes and refreshed snapshots
 * change the model.
 */
export function buildLiveRunModel(input: LiveRunModelInput): LiveRunModel {
  for (const method of [...LIVE_RUN_OPEN_REFRESH_METHODS, ...LIVE_RUN_CAPABILITY_METHODS]) {
    assertKnownMethod(method);
  }
  const snapshot = input.snapshot;
  const projectId = snapshot.summary.project.id;
  if (isNonEmptyText(projectId) !== true) {
    throw new Error("Live-run model requires a persisted projectId from Core.");
  }
  const workspacePath = snapshot.summary.workspacePath;
  if (isNonEmptyText(workspacePath) !== true) {
    throw new Error("Live-run model requires the persisted workspacePath from Core.");
  }
  const dashboard = input.dashboard;
  if (dashboard !== undefined) {
    if (dashboard.project.project.id !== projectId) {
      throw new Error(
        "Live-run dashboard and project snapshot disagree on projectId; refresh dashboard.get and projects.get before rendering.",
      );
    }
    if (dashboard.project.workspacePath !== workspacePath) {
      throw new Error(
        "Live-run dashboard and project snapshot disagree on workspacePath; refresh dashboard.get and projects.get before rendering.",
      );
    }
    if (dashboard.latestEventSequence !== snapshot.latestEventSequence) {
      throw new Error(
        "Live-run dashboard and project snapshot disagree on latestEventSequence; refresh dashboard.get and projects.get before rendering.",
      );
    }
    if (dashboard.currentPhase !== undefined && dashboard.currentPhase.projectId !== projectId) {
      throw new Error("Live-run current phase crossed the requested project boundary.");
    }
    if (dashboard.currentTask !== undefined && dashboard.currentTask.projectId !== projectId) {
      throw new Error("Live-run current task crossed the requested project boundary.");
    }
  }
  const gitStatus = input.gitStatus;
  if (gitStatus !== undefined && gitStatus.projectId !== projectId) {
    throw new Error("Live-run Git status crossed the requested project boundary.");
  }
  const lastControl = input.lastControl;
  if (lastControl !== undefined && lastControl.projectId !== projectId) {
    throw new Error("Live-run control outcome crossed the requested project boundary.");
  }

  const runtimeTaskById = new Map(snapshot.tasks.map((task) => [String(task.id), task]));
  const runtimePhaseById = new Map(snapshot.phases.map((phase) => [String(phase.id), phase]));
  if (
    dashboard?.currentTask !== undefined &&
    runtimeTaskById.has(dashboard.currentTask.id) !== true
  ) {
    throw new Error(
      `Live-run current task ${dashboard.currentTask.id} has no runtime row; refresh dashboard.get and projects.get before rendering.`,
    );
  }
  if (
    dashboard?.currentPhase !== undefined &&
    runtimePhaseById.has(dashboard.currentPhase.id) !== true
  ) {
    throw new Error(
      `Live-run current phase ${dashboard.currentPhase.id} has no runtime row; refresh dashboard.get and projects.get before rendering.`,
    );
  }

  const dashboardTaskRow =
    dashboard?.currentTask === undefined
      ? undefined
      : runtimeTaskById.get(dashboard.currentTask.id);
  const fallbackActiveTask = snapshot.tasks.find((task) =>
    (ACTIVE_TASK_STATES as readonly string[]).includes(task.state),
  );
  const currentRow = dashboardTaskRow ?? fallbackActiveTask;
  const currentPhaseRow =
    currentRow === undefined ? undefined : runtimePhaseById.get(String(currentRow.phaseId));
  const currentTask =
    currentRow === undefined
      ? undefined
      : Object.freeze({
          id: currentRow.id,
          title: currentRow.title,
          phaseId: currentRow.phaseId,
          state: currentRow.state,
          ...(currentPhaseRow?.title === undefined ? {} : { phaseTitle: currentPhaseRow.title }),
          ...(currentPhaseRow?.state === undefined ? {} : { phaseState: currentPhaseRow.state }),
        });

  const projectState = snapshot.summary.project.state;
  if ((LIVE_RUN_CANONICAL_PROJECT_STATES as readonly string[]).includes(projectState) !== true) {
    throw new Error(
      `Live-run project carries an unknown state ${projectState}; refresh projects.get before rendering.`,
    );
  }
  const lifecycle = deriveLifecycle({
    projectState,
    ...(currentTask === undefined
      ? {}
      : {
          taskState: currentTask.state,
          taskId: currentTask.id,
          taskTitle: ` (${currentTask.title})`,
        }),
  });

  const gitChangedPaths =
    gitStatus === undefined ? Object.freeze([]) : Object.freeze([...gitStatus.changedPaths]);
  const gitShowsChanges =
    gitStatus !== undefined &&
    gitStatus.available === true &&
    (gitStatus.dirty === true || gitChangedPaths.length > 0);
  const outcomeChangedPaths =
    lastControl !== undefined &&
    "changedPaths" in lastControl &&
    lastControl.changedPaths !== undefined
      ? Object.freeze([...lastControl.changedPaths])
      : Object.freeze([] as string[]);
  const outcomeRequiresIntervention = lastControl?.status === "INTERVENTION_REQUIRED";
  const detected =
    (projectState === "PAUSED" && gitShowsChanges) ||
    (projectState === "PAUSED" && outcomeRequiresIntervention);
  const changedPaths = Object.freeze([...new Set([...gitChangedPaths, ...outcomeChangedPaths])]);
  const intervention: LiveRunIntervention = Object.freeze({
    detected,
    changedPaths,
    ...(gitStatus?.dirty === undefined ? {} : { dirty: gitStatus.dirty }),
    ...(detected !== true
      ? {}
      : {
          message:
            "Densa ADE detected workspace changes while paused. Resume revalidates recovery and workspace state and recontextualizes the next worker before scheduling more work; manual edits are preserved, never overwritten. " +
            "Resuming without acknowledgement returns INTERVENTION_REQUIRED.",
        }),
    resumeRequiresAck: detected,
    ...(lastControl === undefined ? {} : { outcomeStatus: lastControl.status }),
  });

  const controls = describeControls(projectState);

  const connectionState = input.connectionState ?? "connected";
  const enabled = connectionState === "connected";
  const reason = enabled === true ? undefined : blockedReason(connectionState, input.coreDetail);

  return Object.freeze({
    projectId,
    projectName: snapshot.summary.project.name,
    projectState,
    executionMode: snapshot.summary.project.executionMode,
    workspacePath,
    lifecycle,
    ...(currentTask === undefined ? {} : { currentTask }),
    retryCount: dashboard?.retryCount ?? 0,
    recentFailureCount: dashboard?.recentFailureCount ?? 0,
    controls,
    intervention,
    ...(lastControl === undefined
      ? {}
      : {
          lastControl: Object.freeze({
            status: lastControl.status,
            ...("reason" in lastControl && lastControl.reason !== undefined
              ? { reason: lastControl.reason }
              : {}),
            changedPaths: outcomeChangedPaths,
          }),
        }),
    latestEventSequence: snapshot.latestEventSequence,
    capabilityMethods: LIVE_RUN_CAPABILITY_METHODS,
    optimisticComplete: false as const,
    enabled,
    ...(reason === undefined ? {} : { reason }),
  });
}

export interface LiveRunPauseResolution {
  readonly method: "projects.pause";
  readonly projectId: string;
  readonly workspacePath: string;
  readonly actor: string;
}

function requireActor(actor: unknown): string {
  if (isNonEmptyText(actor) !== true) {
    throw new Error("Live-run control requires an actor.");
  }
  return (actor as string).trim();
}

function requireAddressing(model: LiveRunModel): {
  readonly projectId: string;
  readonly workspacePath: string;
} {
  if (isNonEmptyText(model.projectId) !== true || isNonEmptyText(model.workspacePath) !== true) {
    throw new Error(
      "Live-run control requires the persisted projectId and workspacePath from Core.",
    );
  }
  return { projectId: model.projectId, workspacePath: model.workspacePath };
}

/**
 * Resolve Pause to `projects.pause` through Core. Graceful pause records the
 * durable intent and takes effect at the current safe serial boundary; only
 * the Core outcome (or a later `core.event`) changes what the surface shows.
 */
export function resolveLiveRunPause(
  model: LiveRunModel,
  input: { readonly actor: string },
): LiveRunPauseResolution {
  const actor = requireActor(input.actor);
  const addressing = requireAddressing(model);
  assertKnownMethod("projects.pause");
  return Object.freeze({
    method: "projects.pause" as const,
    projectId: addressing.projectId,
    workspacePath: addressing.workspacePath,
    actor,
  });
}

export interface LiveRunCancelResolution {
  /** Daemon-supported immediate-cancel alias (see `docs/execution-controls.md`). */
  readonly transportMethod: typeof LIVE_RUN_CANCEL_TRANSPORT_METHOD;
  /** Frozen-catalog fallback for strictly-v1 transports. */
  readonly fallbackMethod: typeof LIVE_RUN_CANCEL_FALLBACK_METHOD;
  readonly projectId: string;
  readonly workspacePath: string;
  readonly actor: string;
}

/**
 * Resolve Cancel current run to the daemon-supported `project.cancel`
 * transport alias with `projects.pause` as the frozen-catalog fallback.
 * Cancel records the same durable pause intent as Pause and additionally
 * aborts the active worker through Core: the task lifecycle confirms the
 * terminal stream, rolls back only attempt-owned output, and leaves the
 * task `INTERRUPTED`. Cancel never orphans the worker process and never
 * deletes project work. The payload shape matches `projects.pause`, which
 * is the contract the daemon parses for `project.cancel`.
 */
export function resolveLiveRunCancel(
  model: LiveRunModel,
  input: { readonly actor: string },
): LiveRunCancelResolution {
  const actor = requireActor(input.actor);
  const addressing = requireAddressing(model);
  assertKnownMethod(LIVE_RUN_CANCEL_FALLBACK_METHOD);
  return Object.freeze({
    transportMethod: LIVE_RUN_CANCEL_TRANSPORT_METHOD,
    fallbackMethod: LIVE_RUN_CANCEL_FALLBACK_METHOD,
    projectId: addressing.projectId,
    workspacePath: addressing.workspacePath,
    actor,
  });
}

export interface LiveRunStopResolution {
  readonly method: "projects.stop";
  readonly projectId: string;
  readonly workspacePath: string;
  readonly actor: string;
}

/**
 * Resolve Stop Project to `projects.stop` through Core. Stop is graceful:
 * it records a stopped disposition without deleting work and releases the
 * keep-awake assertion; a stopped project cannot resume without an explicit
 * new start decision.
 */
export function resolveLiveRunStop(
  model: LiveRunModel,
  input: { readonly actor: string },
): LiveRunStopResolution {
  const actor = requireActor(input.actor);
  const addressing = requireAddressing(model);
  assertKnownMethod("projects.stop");
  return Object.freeze({
    method: "projects.stop" as const,
    projectId: addressing.projectId,
    workspacePath: addressing.workspacePath,
    actor,
  });
}

export interface LiveRunResumeResolution {
  readonly method: "projects.resume";
  readonly projectId: string;
  readonly workspacePath: string;
  readonly actor: string;
  readonly acknowledgeIntervention?: boolean;
}

/**
 * Resolve Resume to `projects.resume` through Core. Every resume
 * revalidates recovery and workspace state first. When the model detected
 * paused workspace changes, pass `acknowledgeIntervention: true` to accept
 * the inspected edits for task-packet rebuilding; without it Core returns
 * `INTERVENTION_REQUIRED` and schedules no worker.
 */
export function resolveLiveRunResume(
  model: LiveRunModel,
  input: { readonly actor: string; readonly acknowledgeIntervention?: boolean },
): LiveRunResumeResolution {
  const actor = requireActor(input.actor);
  const addressing = requireAddressing(model);
  assertKnownMethod("projects.resume");
  return Object.freeze({
    method: "projects.resume" as const,
    projectId: addressing.projectId,
    workspacePath: addressing.workspacePath,
    actor,
    ...(input.acknowledgeIntervention === undefined
      ? {}
      : { acknowledgeIntervention: input.acknowledgeIntervention }),
  });
}

export interface LiveRunControlEffect {
  /** Verbatim Core outcome status. */
  readonly status: string;
  /** What the UI should show; never a locally invented state transition. */
  readonly notice: string;
  /** Authoritative snapshot reads to refresh before rebuilding the model. */
  readonly refreshMethods: readonly CoreV1Method[];
  /** True when the request was already applied and no new fact was appended. */
  readonly idempotent: boolean;
  /** Changed paths disclosed by an INTERVENTION_REQUIRED outcome. */
  readonly changedPaths: readonly string[];
}

/**
 * Apply a Core control outcome to the surface without editing the snapshot
 * model. State changes are only shown after Core acknowledgment: the caller
 * refreshes `refreshMethods` and rebuilds via `buildLiveRunModel()`.
 * `UNCHANGED` outcomes are idempotent no-ops; `INTERVENTION_REQUIRED`
 * surfaces Core's changed paths for the intervention panel.
 */
export function applyLiveRunControlOutcome(
  model: LiveRunModel,
  outcome: LiveRunControlOutcome,
): LiveRunControlEffect {
  if (outcome.projectId !== model.projectId) {
    throw new Error("Live-run control outcome crossed the requested project boundary.");
  }
  const changedPaths =
    "changedPaths" in outcome && outcome.changedPaths !== undefined
      ? Object.freeze([...outcome.changedPaths])
      : Object.freeze([] as string[]);
  const reasonSuffix =
    "reason" in outcome && outcome.reason !== undefined ? ` Core reason: ${outcome.reason}` : "";
  switch (outcome.status) {
    case "UNCHANGED":
      return Object.freeze({
        status: outcome.status,
        notice: `Core reports the control request is already durable; no new fact was appended.${reasonSuffix} The surface keeps showing the last refreshed snapshot.`,
        refreshMethods: Object.freeze(["projects.get"] as const),
        idempotent: true,
        changedPaths,
      });
    case "REQUESTED":
      return Object.freeze({
        status: outcome.status,
        notice: `Core recorded the control intent; it takes effect at the current safe boundary.${reasonSuffix} Watch persisted events, then refresh before the next control.`,
        refreshMethods: Object.freeze(["projects.get", "events.replay"] as const),
        idempotent: false,
        changedPaths,
      });
    case "PAUSED":
    case "RESUMED":
    case "STOPPED":
      assertKnownMethod("projects.get");
      assertKnownMethod("dashboard.get");
      return Object.freeze({
        status: outcome.status,
        notice: `Core acknowledged ${outcome.status}.${reasonSuffix} Refreshing authoritative state before rendering.`,
        refreshMethods: LIVE_RUN_OPEN_REFRESH_METHODS,
        idempotent: false,
        changedPaths,
      });
    case "INTERVENTION_REQUIRED":
      return Object.freeze({
        status: outcome.status,
        notice:
          `Core detected workspace changes while paused and scheduled no worker.${reasonSuffix} ` +
          "Review the changed paths, then resume with acknowledgeIntervention to recontextualize the next worker. Manual edits are preserved.",
        refreshMethods: Object.freeze(["projects.get", "git.status"] as const),
        idempotent: false,
        changedPaths,
      });
    case "BLOCKED":
    case "REJECTED":
    case "NOT_FOUND":
      return Object.freeze({
        status: outcome.status,
        notice: `Core did not apply the control request (${outcome.status}).${reasonSuffix} Refresh authoritative state before retrying; never retry blindly.`,
        refreshMethods: Object.freeze(["projects.get"] as const),
        idempotent: false,
        changedPaths,
      });
  }
}

export type LiveRunDrilldown =
  | {
      readonly kind: "project-snapshot";
      readonly method: "projects.get";
      readonly projectId: string;
    }
  | {
      readonly kind: "current-task";
      readonly method: "attempts.list";
      readonly projectId: string;
      readonly taskId: string;
    }
  | {
      readonly kind: "agent-run";
      readonly method: "logs.list";
      readonly projectId: string;
      readonly phaseId?: string;
      readonly taskId?: string;
      readonly attemptId?: string;
    }
  | {
      readonly kind: "changes";
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
      readonly kind: "phase-report";
      readonly method: "phases.report.get";
      readonly projectId: string;
      readonly phaseId: string;
    }
  | {
      readonly kind: "usage";
      readonly method: "usage.get";
      readonly projectId: string;
    }
  | {
      readonly kind: "events";
      readonly method: "events.replay";
      readonly projectId: string;
      readonly afterSequence: number;
    };

/**
 * Resolve a live-run metric to the existing Core v1 operation backing its
 * drill-down. Open current task resolves to `attempts.list` for the
 * persisted current task; View Agent Run resolves to `logs.list` scoped by
 * persisted phase/task/attempt IDs; View Changes resolves to `git.status`
 * (workspace overview) or `git.commit.get` (one persisted SHA). The IDE
 * carries persisted IDs through to Core and never fabricates detail.
 */
export function resolveLiveRunDrilldown(
  model: LiveRunModel,
  selection:
    | { readonly kind: "project-snapshot" }
    | { readonly kind: "current-task" }
    | {
        readonly kind: "agent-run";
        readonly phaseId?: string;
        readonly taskId?: string;
        readonly attemptId?: string;
      }
    | { readonly kind: "changes" }
    | { readonly kind: "git-commit"; readonly sha: string }
    | { readonly kind: "validation-runs"; readonly taskId: string }
    | { readonly kind: "validation-detail"; readonly validationRunId: string }
    | { readonly kind: "phase-report"; readonly phaseId: string }
    | { readonly kind: "usage" }
    | { readonly kind: "events"; readonly afterSequence?: number },
): LiveRunDrilldown {
  switch (selection.kind) {
    case "project-snapshot": {
      assertKnownMethod("projects.get");
      return Object.freeze({
        kind: "project-snapshot" as const,
        method: "projects.get" as const,
        projectId: model.projectId,
      });
    }
    case "current-task": {
      if (model.currentTask === undefined) {
        throw new Error(
          "Live-run current-task drill-down requires a known current task from Core.",
        );
      }
      assertKnownMethod("attempts.list");
      return Object.freeze({
        kind: "current-task" as const,
        method: "attempts.list" as const,
        projectId: model.projectId,
        taskId: model.currentTask.id,
      });
    }
    case "agent-run": {
      const phaseId =
        isNonEmptyText(selection.phaseId) === true
          ? (selection.phaseId as string).trim()
          : undefined;
      const taskId =
        isNonEmptyText(selection.taskId) === true ? (selection.taskId as string).trim() : undefined;
      const attemptId =
        isNonEmptyText(selection.attemptId) === true
          ? (selection.attemptId as string).trim()
          : undefined;
      const fallbackTaskId = model.currentTask?.id;
      const fallbackPhaseId = model.currentTask?.phaseId;
      if (
        phaseId === undefined &&
        taskId === undefined &&
        attemptId === undefined &&
        fallbackTaskId === undefined &&
        fallbackPhaseId === undefined
      ) {
        throw new Error(
          "Live-run agent-run drill-down requires a persisted phase, task, or attempt scope; the surface never fetches unscoped run logs.",
        );
      }
      assertKnownMethod("logs.list");
      const scopedTaskId =
        taskId ?? (phaseId === undefined && attemptId === undefined ? fallbackTaskId : undefined);
      const scopedPhaseId =
        phaseId ?? (taskId === undefined && attemptId === undefined ? fallbackPhaseId : undefined);
      return Object.freeze({
        kind: "agent-run" as const,
        method: "logs.list" as const,
        projectId: model.projectId,
        ...(scopedPhaseId === undefined ? {} : { phaseId: scopedPhaseId }),
        ...(scopedTaskId === undefined ? {} : { taskId: scopedTaskId }),
        ...(attemptId === undefined ? {} : { attemptId }),
      });
    }
    case "changes": {
      if (isNonEmptyText(model.workspacePath) !== true) {
        throw new Error("Live-run changes drill-down requires the persisted workspacePath.");
      }
      assertKnownMethod("git.status");
      return Object.freeze({
        kind: "changes" as const,
        method: "git.status" as const,
        projectId: model.projectId,
        workspacePath: model.workspacePath,
      });
    }
    case "git-commit": {
      if (isNonEmptyText(selection.sha) !== true) {
        throw new Error("Live-run commit drill-down requires a persisted commit SHA.");
      }
      assertKnownMethod("git.commit.get");
      return Object.freeze({
        kind: "git-commit" as const,
        method: "git.commit.get" as const,
        projectId: model.projectId,
        sha: (selection.sha as string).trim(),
      });
    }
    case "validation-runs": {
      if (isNonEmptyText(selection.taskId) !== true) {
        throw new Error("Live-run validation drill-down requires a persisted taskId.");
      }
      assertKnownMethod("validation.list");
      return Object.freeze({
        kind: "validation-runs" as const,
        method: "validation.list" as const,
        projectId: model.projectId,
        taskId: (selection.taskId as string).trim(),
      });
    }
    case "validation-detail": {
      if (isNonEmptyText(selection.validationRunId) !== true) {
        throw new Error("Live-run validation drill-down requires a persisted validationRunId.");
      }
      assertKnownMethod("validation.get");
      return Object.freeze({
        kind: "validation-detail" as const,
        method: "validation.get" as const,
        projectId: model.projectId,
        validationRunId: (selection.validationRunId as string).trim(),
      });
    }
    case "phase-report": {
      if (isNonEmptyText(selection.phaseId) !== true) {
        throw new Error("Live-run phase-report drill-down requires a persisted phaseId.");
      }
      assertKnownMethod("phases.report.get");
      return Object.freeze({
        kind: "phase-report" as const,
        method: "phases.report.get" as const,
        projectId: model.projectId,
        phaseId: (selection.phaseId as string).trim(),
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
    case "events": {
      assertKnownMethod("events.replay");
      const afterSequence =
        selection.afterSequence === undefined ? model.latestEventSequence : selection.afterSequence;
      if (Number.isInteger(afterSequence) !== true || afterSequence < 0) {
        throw new Error("Live-run events drill-down requires a non-negative afterSequence.");
      }
      return Object.freeze({
        kind: "events" as const,
        method: "events.replay" as const,
        projectId: model.projectId,
        afterSequence,
      });
    }
  }
}

export interface LiveRunReopenRefresh {
  readonly action: "refresh-before-render";
  readonly refreshMethods: readonly CoreV1Method[];
  readonly projectId: string;
  readonly reason: string;
}

/**
 * Reconnect/reopen recipe for the live-run surface: refresh `projects.get`
 * and `dashboard.get`, replay `events.replay` from the last applied
 * sequence (then re-subscribe for live hints), and rebuild via
 * `buildLiveRunModel()`. Live `core.event` notifications are hints to
 * refresh, never direct edits.
 */
export function resolveLiveRunReopenRefresh(projectId: string): LiveRunReopenRefresh {
  if (isNonEmptyText(projectId) !== true) {
    throw new Error(
      "Live-run reopen requires a persisted projectId from Core (projects.list); the IDE does not invent one.",
    );
  }
  return Object.freeze({
    action: "refresh-before-render",
    refreshMethods: Object.freeze(["projects.get", "dashboard.get", "events.replay"] as const),
    projectId: projectId.trim(),
    reason:
      "Refresh projects.get and dashboard.get, replay events.replay from the last applied sequence, " +
      "then rebuild the live-run model. Live core.event notifications are hints to refresh, never direct edits.",
  });
}

/**
 * True when a persisted notification is only a refresh hint for the
 * live-run surface. `core.event` notifications re-read Core truth;
 * `run.log.appended` refreshes the `logs.list` cursor behind View Agent
 * Run. Neither notification edits lifecycle state directly: only refreshed
 * snapshots and Core control outcomes change the model.
 */
export function liveRunEventIsRefreshHint(eventType: string): boolean {
  if (typeof eventType !== "string") {
    return false;
  }
  return eventType.trim().length > 0;
}
