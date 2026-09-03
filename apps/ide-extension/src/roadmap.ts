// Copyright 2026 Densa Labs
// SPDX-License-Identifier: Apache-2.0

/**
 * Densa ADE Roadmap UI view model (Phase 11 Milestone 0).
 *
 * The Roadmap surface answers: "What is going to happen, and where are we?"
 * It renders the complete phase structure, runtime phase/task states,
 * dependencies, acceptance criteria, the current task, task-history and
 * acceptance-evidence drill-downs, roadmap mutations with reasons, and phase
 * completion criteria.
 *
 * This module is pure and protocol-only:
 *
 * - it imports `@densa-ade/protocol` types only, never `@densa-ade/core`,
 *   `@densa-ade/cli`, SQLite, or `vscode` / `vs/workbench`;
 * - every fact comes from versioned Core v1 operations (`roadmaps.get`,
 *   `projects.get`, `roadmaps.revisions.list`, plus drill-down and mutation
 *   operations from the frozen catalog). The IDE never invents project,
 *   phase, task, revision, or reset state;
 * - the UI never marks work complete optimistically. Resolvers below return
 *   Core request payloads to send; only Core outcomes and events change the
 *   model (`ROADMAP_LIFECYCLE.optimisticComplete` is `false`);
 * - roadmap changes always show audit history (classification, reason,
 *   actor/session, timestamp, affected phases/tasks, before/after binding);
 * - a stale or invalid mutation request reconciles by refreshing the
 *   authoritative snapshots before retrying, never by guessing.
 *
 * Standard VS Code contribution mechanisms only (AGENTS.md §1.3): the surface
 * itself is the `densa-ade.roadmap` editor-area tab contributed in M3. This
 * milestone adds its content model, not new workbench patches.
 */

import {
  CORE_V1_METHODS,
  type CoreV1Method,
  type CoreV1ProjectSnapshot,
  type MasterRoadmapRecord,
  type PhaseState,
  type RoadmapMutationOperation,
  type RoadmapRevision,
  type TaskState,
} from "@densa-ade/protocol";

/** Command that opens the Roadmap editor-area tab (contributed in M3). */
export const ROADMAP_COMMAND = "densa-ade.showRoadmap" as const;

/** Editor-area tab viewType hosting Roadmap content beside source tabs. */
export const ROADMAP_EDITOR_VIEW_TYPE = "densa-ade.roadmap" as const;

/** Canonical phase states from AGENTS.md §2.3. Rendered verbatim, never remapped. */
export const ROADMAP_CANONICAL_PHASE_STATES: readonly PhaseState[] = Object.freeze([
  "PENDING",
  "READY",
  "RUNNING",
  "VALIDATING",
  "AWAITING_APPROVAL",
  "COMPLETED",
  "BLOCKED",
]);

/** Canonical task states from AGENTS.md §2.4. Rendered verbatim, never remapped. */
export const ROADMAP_CANONICAL_TASK_STATES: readonly TaskState[] = Object.freeze([
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

/** Snapshot reads backing first render, in reconnect refresh order. */
export const ROADMAP_OPEN_REFRESH_METHODS: readonly CoreV1Method[] = Object.freeze([
  "roadmaps.get",
  "projects.get",
  "roadmaps.revisions.list",
]);

/** Frozen-catalog Core operations the Roadmap surface may use once open. */
export const ROADMAP_CAPABILITY_METHODS: readonly CoreV1Method[] = Object.freeze([
  "roadmaps.get",
  "projects.get",
  "roadmaps.revisions.list",
  "roadmaps.revisions.propose",
  "roadmaps.revisions.resolve",
  "phases.approve",
  "tasks.approve",
  "phases.report.get",
  "attempts.list",
  "validation.list",
  "validation.get",
  "events.subscribe",
  "events.replay",
]);

/**
 * Disposable-view lifecycle contract. The Roadmap tab renders Core truth;
 * closing it disposes the local handle only, and content never completes
 * work without a Core outcome.
 */
export const ROADMAP_LIFECYCLE = Object.freeze({
  /** Closing disposes the local editor tab handle only. */
  closeDisposes: "view-handle-only",
  /** Core keeps running while project policy allows it. */
  coreContinuesAfterClose: true,
  /** Reopening replays from the last applied sequence, then refreshes. */
  reopenRefreshesSnapshot: true,
  /** The UI never marks phases or tasks complete optimistically. */
  optimisticComplete: false,
});

export type RoadmapConnectionState =
  "disconnected" | "connecting" | "connected" | "version-mismatch" | "auth-failed";

export interface RoadmapPhaseView {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  readonly required: boolean;
  /** Authoritative runtime state, rendered verbatim. */
  readonly state: PhaseState;
  readonly position: number;
  /** Explicit completion criteria from the approved roadmap plan. */
  readonly completionCriteria: readonly string[];
  readonly taskIds: readonly string[];
  readonly completedTaskCount: number;
  readonly totalTaskCount: number;
  readonly awaitingApproval: boolean;
}

export interface RoadmapTaskView {
  readonly id: string;
  readonly phaseId: string;
  readonly title: string;
  readonly goal: string;
  readonly executable: boolean;
  /** Authoritative runtime state for executable tasks, rendered verbatim. */
  readonly state: TaskState | undefined;
  readonly position: number;
  /** Planned dependencies from the approved roadmap. */
  readonly dependencyIds: readonly string[];
  /** Incomplete runtime dependencies blocking this task. */
  readonly blockedBy: readonly string[];
  /** Concrete acceptance criteria from persisted runtime state. */
  readonly acceptanceCriteria: readonly string[];
  readonly riskLevel: string;
  readonly expectedValidators: readonly string[];
  readonly supersededByTaskIds: readonly string[];
  readonly isCurrent: boolean;
}

export interface RoadmapRevisionView {
  readonly id: string;
  readonly classification: string;
  readonly reason: string;
  readonly actor: string;
  readonly createdAt: string;
  readonly affectedPhaseIds: readonly string[];
  readonly affectedTaskIds: readonly string[];
  readonly operationKinds: readonly string[];
  readonly hasApproval: boolean;
}

export interface RoadmapPendingPhaseApproval {
  readonly phaseId: string;
  readonly summary: string;
  readonly requestedAt: string;
}

export interface RoadmapSelection {
  readonly phaseId?: string;
  readonly taskId?: string;
}

export interface RoadmapModelInput {
  /** Authoritative `roadmaps.get` record. */
  readonly roadmap: MasterRoadmapRecord;
  /** Authoritative `projects.get` snapshot with runtime phases/tasks. */
  readonly snapshot: CoreV1ProjectSnapshot;
  /** Authoritative `roadmaps.revisions.list` page in Core order. */
  readonly revisions: readonly RoadmapRevision[];
  /** Explicit user selection; unknown IDs throw instead of guessing. */
  readonly selection?: RoadmapSelection;
  readonly connectionState?: RoadmapConnectionState;
  readonly coreDetail?: string;
}

export interface RoadmapModel {
  readonly projectId: string;
  readonly projectState: string;
  readonly executionMode: string;
  readonly projectGoal: string;
  readonly revisionNumber: number;
  readonly phases: readonly RoadmapPhaseView[];
  readonly tasks: readonly RoadmapTaskView[];
  readonly revisions: readonly RoadmapRevisionView[];
  readonly currentPhaseId?: string;
  readonly currentTaskId?: string;
  readonly awaitingApprovalPhaseIds: readonly string[];
  readonly pendingPhaseApprovals: readonly RoadmapPendingPhaseApproval[];
  readonly selectedPhaseId?: string;
  readonly selectedTaskId?: string;
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
    throw new Error(`Roadmap surface maps to unknown Core method ${method}.`);
  }
}

function blockedReason(connectionState: RoadmapConnectionState, coreDetail?: string): string {
  const suffix = isNonEmptyText(coreDetail) === true ? ` (${coreDetail.trim()})` : "";
  switch (connectionState) {
    case "connected":
      return "";
    case "connecting":
      return `Densa ADE Core is connecting. Wait for the connection before using the Roadmap${suffix}.`;
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

function operationKindsOf(revision: RoadmapRevision): readonly string[] {
  const kinds: string[] = [];
  if (revision.operation !== undefined) {
    kinds.push(revision.operation.kind);
  }
  for (const operation of revision.operations ?? []) {
    kinds.push(operation.kind);
  }
  return Object.freeze(kinds);
}

/**
 * Build the Roadmap content model from Core truth only.
 *
 * - `roadmap` provides the complete phase structure, dependencies,
 *   acceptance criteria, risk levels, expected validators, and phase
 *   completion criteria;
 * - `snapshot` provides the authoritative runtime phase/task states, the
 *   pending approvals, and the latest event sequence;
 * - `revisions` provides the audited mutation history with reasons.
 *
 * Runtime rows join to plan rows by stable ID: roadmap materialization uses
 * the same IDs for both. A missing runtime row for a planned phase or an
 * executable task means the snapshots disagree (for example a stale read
 * raced a revision); the builder throws with a refresh hint instead of
 * inventing a state. Non-executable plan tasks may have no runtime row.
 */
export function buildRoadmapModel(input: RoadmapModelInput): RoadmapModel {
  for (const method of [...ROADMAP_OPEN_REFRESH_METHODS, ...ROADMAP_CAPABILITY_METHODS]) {
    assertKnownMethod(method);
  }
  const roadmap = input.roadmap;
  const snapshot = input.snapshot;
  const projectId = snapshot.summary.project.id;
  if (roadmap.projectId !== projectId) {
    throw new Error(
      "Roadmap and project snapshot disagree on projectId; refresh roadmaps.get and projects.get before rendering.",
    );
  }
  for (const revision of input.revisions) {
    if (revision.projectId !== projectId) {
      throw new Error("Roadmap revision crossed the requested project boundary.");
    }
  }

  const runtimePhaseById = new Map(snapshot.phases.map((phase) => [String(phase.id), phase]));
  const runtimeTaskById = new Map(snapshot.tasks.map((task) => [String(task.id), task]));

  const phases: RoadmapPhaseView[] = [];
  const tasks: RoadmapTaskView[] = [];
  for (const [position, planPhase] of roadmap.roadmap.phases.entries()) {
    const runtime = runtimePhaseById.get(planPhase.id);
    if (runtime === undefined) {
      throw new Error(
        `Roadmap phase ${planPhase.id} has no runtime state; refresh roadmaps.get and projects.get before rendering.`,
      );
    }
    if (runtime.position !== position) {
      throw new Error(
        `Roadmap phase ${planPhase.id} moved while the snapshots were read; refresh roadmaps.get and projects.get before rendering.`,
      );
    }
    const phaseTaskIds = planPhase.tasks.map((task) => task.id);
    const completedTaskCount = planPhase.tasks.filter((task) => {
      const entry = runtimeTaskById.get(task.id);
      return entry?.state === "COMPLETED";
    }).length;
    phases.push(
      Object.freeze({
        id: planPhase.id,
        title: planPhase.title,
        goal: planPhase.goal,
        required: planPhase.required,
        state: runtime.state,
        position,
        completionCriteria: Object.freeze([...planPhase.completionCriteria]),
        taskIds: Object.freeze(phaseTaskIds),
        completedTaskCount,
        totalTaskCount: planPhase.tasks.length,
        awaitingApproval: runtime.state === "AWAITING_APPROVAL",
      }),
    );
    for (const [taskPosition, planTask] of planPhase.tasks.entries()) {
      const runtimeTask = runtimeTaskById.get(planTask.id);
      if (planTask.executable === true && runtimeTask === undefined) {
        throw new Error(
          `Roadmap task ${planTask.id} has no runtime state; refresh roadmaps.get and projects.get before rendering.`,
        );
      }
      if (
        runtimeTask !== undefined &&
        (String(runtimeTask.phaseId) !== planPhase.id || runtimeTask.position !== taskPosition)
      ) {
        throw new Error(
          `Roadmap task ${planTask.id} moved while the snapshots were read; refresh roadmaps.get and projects.get before rendering.`,
        );
      }
      const blockedBy = Object.freeze(
        planTask.dependencyIds.filter((dependencyId) => {
          const dependency = runtimeTaskById.get(dependencyId);
          return dependency?.state !== "COMPLETED";
        }),
      );
      tasks.push(
        Object.freeze({
          id: planTask.id,
          phaseId: planPhase.id,
          title: planTask.title,
          goal: planTask.goal,
          executable: planTask.executable,
          state: runtimeTask?.state,
          position: taskPosition,
          dependencyIds: Object.freeze([...planTask.dependencyIds]),
          blockedBy,
          acceptanceCriteria: Object.freeze([
            ...(runtimeTask?.acceptanceCriteria ?? planTask.acceptanceCriteria),
          ]),
          riskLevel: planTask.riskLevel,
          expectedValidators: Object.freeze([...planTask.expectedValidators]),
          supersededByTaskIds: Object.freeze([...(planTask.supersededByTaskIds ?? [])]),
          isCurrent: false,
        }),
      );
    }
  }

  const orderedPhases = [...snapshot.phases].sort((a, b) => a.position - b.position);
  const currentPhase = orderedPhases.find((phase) => phase.state !== "COMPLETED");
  const activeTaskStates: readonly TaskState[] = Object.freeze([
    "RUNNING",
    "VALIDATING",
    "RETRYING",
    "WAITING_FOR_USER",
    "WAITING_FOR_USAGE",
  ]);
  const orderedTasks = [...snapshot.tasks].sort((a, b) => {
    if (a.phaseId !== b.phaseId) {
      const aPhase = runtimePhaseById.get(a.phaseId)?.position ?? 0;
      const bPhase = runtimePhaseById.get(b.phaseId)?.position ?? 0;
      return aPhase - bPhase;
    }
    return a.position - b.position;
  });
  const currentTask = orderedTasks.find((task) =>
    (activeTaskStates as readonly string[]).includes(task.state),
  );
  const currentPhaseId = currentPhase?.id;
  const currentTaskId = currentTask?.id;
  const withCurrent = tasks.map((task) =>
    Object.freeze({ ...task, isCurrent: task.id === currentTaskId }),
  );

  const revisions: RoadmapRevisionView[] = input.revisions.map((revision) =>
    Object.freeze({
      id: revision.id,
      classification: revision.classification,
      reason: revision.reason,
      actor: revision.actor,
      createdAt: revision.createdAt,
      affectedPhaseIds: Object.freeze([...revision.affectedPhaseIds]),
      affectedTaskIds: Object.freeze([...revision.affectedTaskIds]),
      operationKinds: operationKindsOf(revision),
      hasApproval: revision.approval !== undefined,
    }),
  );

  const pendingPhaseApprovals: RoadmapPendingPhaseApproval[] = snapshot.pendingApprovals
    .filter((approval) => approval.kind === "phase")
    .map((approval) => {
      if (approval.kind !== "phase") {
        throw new Error("Roadmap pending-approval filter crossed the approval boundary.");
      }
      return Object.freeze({
        phaseId: approval.phaseId,
        summary: approval.summary,
        requestedAt: approval.requestedAt,
      });
    });
  const awaitingApprovalPhaseIds = Object.freeze(
    orderedPhases.filter((phase) => phase.state === "AWAITING_APPROVAL").map((phase) => phase.id),
  );

  let selectedPhaseId: string | undefined;
  let selectedTaskId: string | undefined;
  if (input.selection?.phaseId !== undefined || input.selection?.taskId !== undefined) {
    const wantedPhase =
      isNonEmptyText(input.selection.phaseId) === true ? input.selection.phaseId.trim() : undefined;
    const wantedTask =
      isNonEmptyText(input.selection.taskId) === true ? input.selection.taskId.trim() : undefined;
    if (wantedTask !== undefined) {
      const task = withCurrent.find((entry) => entry.id === wantedTask);
      if (task === undefined) {
        throw new Error(
          `Roadmap selection task ${wantedTask} is not in the current roadmap; refresh roadmaps.get and projects.get before rendering.`,
        );
      }
      if (wantedPhase !== undefined && wantedPhase !== task.phaseId) {
        throw new Error(
          `Roadmap selection phase ${wantedPhase} does not own task ${wantedTask}; refresh the selection from the current roadmap.`,
        );
      }
      selectedTaskId = task.id;
      selectedPhaseId = task.phaseId;
    } else if (wantedPhase !== undefined) {
      const phase = phases.find((entry) => entry.id === wantedPhase);
      if (phase === undefined) {
        throw new Error(
          `Roadmap selection phase ${wantedPhase} is not in the current roadmap; refresh roadmaps.get and projects.get before rendering.`,
        );
      }
      selectedPhaseId = phase.id;
    }
  }

  const connectionState = input.connectionState ?? "connected";
  const enabled = connectionState === "connected";
  const reason = enabled === true ? undefined : blockedReason(connectionState, input.coreDetail);

  return Object.freeze({
    projectId,
    projectState: snapshot.summary.project.state,
    executionMode: snapshot.summary.project.executionMode,
    projectGoal: roadmap.roadmap.projectGoal,
    revisionNumber: roadmap.revisionNumber,
    phases: Object.freeze(phases),
    tasks: Object.freeze(withCurrent),
    revisions: Object.freeze(revisions),
    ...(currentPhaseId === undefined ? {} : { currentPhaseId }),
    ...(currentTaskId === undefined ? {} : { currentTaskId }),
    awaitingApprovalPhaseIds,
    pendingPhaseApprovals: Object.freeze(pendingPhaseApprovals),
    ...(selectedPhaseId === undefined ? {} : { selectedPhaseId }),
    ...(selectedTaskId === undefined ? {} : { selectedTaskId }),
    latestEventSequence: snapshot.latestEventSequence,
    capabilityMethods: ROADMAP_CAPABILITY_METHODS,
    optimisticComplete: false as const,
    enabled,
    ...(reason === undefined ? {} : { reason }),
  });
}

/** Look up one phase view. Throws on unknown ids instead of guessing. */
export function roadmapPhaseById(model: RoadmapModel, phaseId: string): RoadmapPhaseView {
  const found = model.phases.find((entry) => entry.id === phaseId);
  if (found === undefined) {
    throw new Error(`Unknown roadmap phase: ${phaseId}.`);
  }
  return found;
}

/** Look up one task view. Throws on unknown ids instead of guessing. */
export function roadmapTaskById(model: RoadmapModel, taskId: string): RoadmapTaskView {
  const found = model.tasks.find((entry) => entry.id === taskId);
  if (found === undefined) {
    throw new Error(`Unknown roadmap task: ${taskId}.`);
  }
  return found;
}

/** Look up one revision view. Throws on unknown ids instead of guessing. */
export function roadmapRevisionById(model: RoadmapModel, revisionId: string): RoadmapRevisionView {
  const found = model.revisions.find((entry) => entry.id === revisionId);
  if (found === undefined) {
    throw new Error(`Unknown roadmap revision: ${revisionId}.`);
  }
  return found;
}

export type RoadmapDrilldown =
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
      readonly taskId: string;
      readonly validationRunId: string;
    }
  | {
      readonly kind: "phase-report";
      readonly method: "phases.report.get";
      readonly projectId: string;
      readonly phaseId: string;
    };

/**
 * Resolve a Roadmap drill-down to the existing Core v1 operation it invokes.
 * Attempt history resolves to `attempts.list`; acceptance evidence resolves
 * to `validation.list`/`validation.get`; phase completion evidence resolves
 * to `phases.report.get`. The IDE carries persisted IDs through to Core and
 * never fabricates history locally.
 */
export function resolveRoadmapDrilldown(
  model: RoadmapModel,
  selection:
    | { readonly kind: "attempts"; readonly taskId: string }
    | { readonly kind: "validation-runs"; readonly taskId: string }
    | {
        readonly kind: "validation-detail";
        readonly taskId: string;
        readonly validationRunId: string;
      }
    | { readonly kind: "phase-report"; readonly phaseId: string },
): RoadmapDrilldown {
  switch (selection.kind) {
    case "attempts": {
      const task = roadmapTaskById(model, selection.taskId);
      assertKnownMethod("attempts.list");
      return Object.freeze({
        kind: "attempts" as const,
        method: "attempts.list" as const,
        projectId: model.projectId,
        taskId: task.id,
      });
    }
    case "validation-runs": {
      const task = roadmapTaskById(model, selection.taskId);
      assertKnownMethod("validation.list");
      return Object.freeze({
        kind: "validation-runs" as const,
        method: "validation.list" as const,
        projectId: model.projectId,
        taskId: task.id,
      });
    }
    case "validation-detail": {
      const task = roadmapTaskById(model, selection.taskId);
      if (isNonEmptyText(selection.validationRunId) !== true) {
        throw new Error("Roadmap validation drill-down requires a persisted validationRunId.");
      }
      assertKnownMethod("validation.get");
      return Object.freeze({
        kind: "validation-detail",
        method: "validation.get",
        projectId: model.projectId,
        taskId: task.id,
        validationRunId: selection.validationRunId.trim(),
      });
    }
    case "phase-report": {
      const phase = roadmapPhaseById(model, selection.phaseId);
      assertKnownMethod("phases.report.get");
      return Object.freeze({
        kind: "phase-report",
        method: "phases.report.get",
        projectId: model.projectId,
        phaseId: phase.id,
      });
    }
  }
}

export interface RoadmapProposeResolution {
  readonly method: "roadmaps.revisions.propose";
  readonly projectId: string;
  readonly baseRevisionNumber: number;
  readonly operations: readonly RoadmapMutationOperation[];
  readonly rationale: string;
  readonly actor: string;
  readonly sessionId: string;
}

/**
 * Resolve a Roadmap edit request to `roadmaps.revisions.propose` through the
 * Core revision flow (the same flow the Master Agent uses). The request
 * carries the model's current `revisionNumber` as `baseRevisionNumber` so the
 * proposal binds to the revision the user saw; when resolving an outdated
 * proposal Core reports `STALE`, which reconciles via
 * `reconcileRoadmapStaleOutcome()`: refresh, rebuild, and retry from the new
 * revision instead of overwriting newer work.
 */
export function resolveRoadmapPropose(
  model: RoadmapModel,
  input: {
    readonly operations: readonly RoadmapMutationOperation[];
    readonly rationale: string;
    readonly actor: string;
    readonly sessionId: string;
  },
): RoadmapProposeResolution {
  if (input.operations.length === 0 || input.operations.length > 32) {
    throw new Error("Roadmap proposal requires 1 to 32 mutation operations.");
  }
  if (isNonEmptyText(input.rationale) !== true) {
    throw new Error("Roadmap proposal requires a rationale.");
  }
  if (isNonEmptyText(input.actor) !== true) {
    throw new Error("Roadmap proposal requires an actor.");
  }
  if (isNonEmptyText(input.sessionId) !== true) {
    throw new Error("Roadmap proposal requires a sessionId.");
  }
  assertKnownMethod("roadmaps.revisions.propose");
  return Object.freeze({
    method: "roadmaps.revisions.propose",
    projectId: model.projectId,
    baseRevisionNumber: model.revisionNumber,
    operations: Object.freeze([...input.operations]),
    rationale: input.rationale.trim(),
    actor: input.actor.trim(),
    sessionId: input.sessionId.trim(),
  });
}

export interface RoadmapResolveResolution {
  readonly method: "roadmaps.revisions.resolve";
  readonly projectId: string;
  readonly proposalEventId: string;
  readonly resolution: "approve" | "reject";
  readonly rationale: string;
  readonly actor: string;
  readonly sessionId: string;
}

/** Resolve a pending revision proposal approval/rejection through Core. */
export function resolveRoadmapResolve(
  model: RoadmapModel,
  input: {
    readonly proposalEventId: string;
    readonly resolution: "approve" | "reject";
    readonly rationale: string;
    readonly actor: string;
    readonly sessionId: string;
  },
): RoadmapResolveResolution {
  if (isNonEmptyText(input.proposalEventId) !== true) {
    throw new Error("Roadmap resolution requires a persisted proposalEventId.");
  }
  if (input.resolution !== "approve" && input.resolution !== "reject") {
    throw new Error("Roadmap resolution must be approve or reject.");
  }
  if (isNonEmptyText(input.rationale) !== true) {
    throw new Error("Roadmap resolution requires a rationale.");
  }
  if (isNonEmptyText(input.actor) !== true) {
    throw new Error("Roadmap resolution requires an actor.");
  }
  if (isNonEmptyText(input.sessionId) !== true) {
    throw new Error("Roadmap resolution requires a sessionId.");
  }
  assertKnownMethod("roadmaps.revisions.resolve");
  return Object.freeze({
    method: "roadmaps.revisions.resolve",
    projectId: model.projectId,
    proposalEventId: input.proposalEventId.trim(),
    resolution: input.resolution,
    rationale: input.rationale.trim(),
    actor: input.actor.trim(),
    sessionId: input.sessionId.trim(),
  });
}

export interface RoadmapPhaseApprovalResolution {
  readonly method: "phases.approve";
  readonly projectId: string;
  readonly phaseId: string;
  readonly decision: "approve" | "reject";
  readonly actor: string;
  readonly reason: string;
}

/**
 * Resolve the "Start Next Phase" approval to `phases.approve` through Core.
 * The phase must already be `AWAITING_APPROVAL` in the model; the UI enables
 * approval only then, and this resolver refuses any other state instead of
 * completing work optimistically. Only the Core outcome changes the phase.
 */
export function resolveRoadmapPhaseApproval(
  model: RoadmapModel,
  input: {
    readonly phaseId: string;
    readonly decision: "approve" | "reject";
    readonly actor: string;
    readonly reason: string;
  },
): RoadmapPhaseApprovalResolution {
  const phase = roadmapPhaseById(model, input.phaseId);
  if (phase.state !== "AWAITING_APPROVAL") {
    throw new Error(
      `Roadmap phase ${phase.id} is ${phase.state}, not AWAITING_APPROVAL; refresh projects.get before approving.`,
    );
  }
  if (input.decision !== "approve" && input.decision !== "reject") {
    throw new Error("Roadmap phase approval must be approve or reject.");
  }
  if (isNonEmptyText(input.actor) !== true) {
    throw new Error("Roadmap phase approval requires an actor.");
  }
  if (isNonEmptyText(input.reason) !== true) {
    throw new Error("Roadmap phase approval requires a reason.");
  }
  assertKnownMethod("phases.approve");
  return Object.freeze({
    method: "phases.approve",
    projectId: model.projectId,
    phaseId: phase.id,
    decision: input.decision,
    actor: input.actor.trim(),
    reason: input.reason.trim(),
  });
}

export interface RoadmapTaskApprovalResolution {
  readonly method: "tasks.approve";
  readonly projectId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly decision: "approve" | "reject";
  readonly actor: string;
  readonly reason: string;
}

/** Resolve a Guided-mode task approval to `tasks.approve` through Core. */
export function resolveRoadmapTaskApproval(
  model: RoadmapModel,
  input: {
    readonly taskId: string;
    readonly decision: "approve" | "reject";
    readonly actor: string;
    readonly reason: string;
  },
): RoadmapTaskApprovalResolution {
  const task = roadmapTaskById(model, input.taskId);
  if (input.decision !== "approve" && input.decision !== "reject") {
    throw new Error("Roadmap task approval must be approve or reject.");
  }
  if (isNonEmptyText(input.actor) !== true) {
    throw new Error("Roadmap task approval requires an actor.");
  }
  if (isNonEmptyText(input.reason) !== true) {
    throw new Error("Roadmap task approval requires a reason.");
  }
  assertKnownMethod("tasks.approve");
  return Object.freeze({
    method: "tasks.approve",
    projectId: model.projectId,
    phaseId: task.phaseId,
    taskId: task.id,
    decision: input.decision,
    actor: input.actor.trim(),
    reason: input.reason.trim(),
  });
}

export interface RoadmapStaleReconciliation {
  readonly action: "refresh-before-retry";
  readonly refreshMethods: readonly CoreV1Method[];
  readonly baseRevisionNumber: number;
  readonly reason: string;
}

/**
 * Reconcile a `STALE` proposal outcome (or a snapshot-disagreement throw)
 * cleanly: refresh the authoritative snapshots, rebuild the model, and retry
 * the proposal from the new `revisionNumber`. Never retry blindly against
 * the old base revision.
 */
export function reconcileRoadmapStaleOutcome(input: {
  readonly baseRevisionNumber: number;
  readonly latestRevisionNumber?: number;
}): RoadmapStaleReconciliation {
  const suffix =
    input.latestRevisionNumber === undefined
      ? "another writer advanced the roadmap"
      : `the roadmap is now at revision ${String(input.latestRevisionNumber)}`;
  return Object.freeze({
    action: "refresh-before-retry",
    refreshMethods: ROADMAP_OPEN_REFRESH_METHODS,
    baseRevisionNumber: input.baseRevisionNumber,
    reason:
      `Roadmap proposal base revision ${String(input.baseRevisionNumber)} is stale (${suffix}). ` +
      "Refresh roadmaps.get, projects.get, and roadmaps.revisions.list, rebuild the Roadmap model, and retry from the new revision.",
  });
}

/** True for the `STALE` proposal outcome returned by Core. */
export function isRoadmapStaleOutcome(outcome: string): boolean {
  return outcome === "STALE";
}
