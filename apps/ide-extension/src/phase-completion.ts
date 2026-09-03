// Copyright 2026 Densa Labs
// SPDX-License-Identifier: Apache-2.0

/**
 * Densa ADE phase-completion rundown UX (Phase 11 Milestone 3).
 *
 * The Phase-by-phase stopping point answers: "Is this phase really done, and
 * what happens next?" When a phase reaches `AWAITING_APPROVAL` the surface
 * shows the persisted phase report — title and duration where determinable,
 * tasks completed, validator/test summary, commits/files changed, key
 * decisions, roadmap changes, retries/issues, unresolved blockers, and the
 * next-phase summary — with actions for Inspect Changes, Open Roadmap, Ask
 * Master Agent, and Start Next Phase. In Continuous mode the same persisted
 * report remains viewable without blocking unless policy requires it.
 *
 * This module is pure and protocol-only:
 *
 * - it imports `@densa-ade/protocol` types only, never `@densa-ade/core`,
 *   `@densa-ade/cli`, SQLite, or `vscode` / `vs/workbench`;
 * - every fact comes from versioned Core v1 operations (`phases.report.get`
 *   for the authoritative report plus `projects.get` for the runtime phase
 *   row, live execution mode, workspace path, next-phase row, and event
 *   sequence). The IDE never invents phase, task, validation, commit,
 *   decision, revision, retry, blocker, duration, or next-phase state;
 * - the UI never marks work complete optimistically. Resolvers below return
 *   Core request payloads to send; only Core outcomes and `core.event`
 *   notifications (as refresh hints) change the model
 *   (`PHASE_COMPLETION_LIFECYCLE.optimisticComplete` is `false`);
 * - Start Next Phase resolves to `phases.approve` through Core and is gated:
 *   the modeled phase must already be `AWAITING_APPROVAL`, and an `approve`
 *   decision additionally requires the persisted `phaseValidation.status` to
 *   be `passed`. Only the Core outcome advances the phase;
 * - duration appears only when the persisted `phaseStartedAt`/`generatedAt`
 *   timestamps parse and order deterministically, otherwise the model says
 *   unknown and offers no estimate;
 * - closing the rundown disposes the local view handle only. The persisted
 *   report lives in Core (`phases.report.get`) and survives close, reconnect,
 *   and Core restart. Reopening refreshes `phases.report.get` and
 *   `projects.get` before rendering (see
 *   `resolvePhaseCompletionReopenRefresh()`).
 *
 * Standard VS Code contribution mechanisms only (AGENTS.md §1.3): the rundown
 * renders inside the existing `densa-ade.roadmap` / `densa-ade.dashboard`
 * editor-area tabs contributed in M3 (Open Roadmap / Ask Master Agent navigate
 * to `densa-ade.showRoadmap` / `densa-ade.showMasterAgent`). This milestone
 * adds its content model, not new workbench patches or new activity-bar
 * entries.
 */

import {
  CORE_V1_METHODS,
  type CoreV1Method,
  type CoreV1ProjectSnapshot,
  type ExecutionMode,
  type PhaseReport,
  type PhaseState,
} from "@densa-ade/protocol";

/** Snapshot reads backing first render, in reconnect refresh order. */
export const PHASE_COMPLETION_OPEN_REFRESH_METHODS: readonly CoreV1Method[] = Object.freeze([
  "phases.report.get",
  "projects.get",
]);

/** Frozen-catalog Core operations the rundown may use once open. */
export const PHASE_COMPLETION_CAPABILITY_METHODS: readonly CoreV1Method[] = Object.freeze([
  "phases.report.get",
  "projects.get",
  "phases.approve",
  "roadmaps.get",
  "master.send",
  "git.status",
  "git.commit.get",
  "attempts.list",
  "validation.list",
  "validation.get",
  "decisions.list",
  "roadmaps.revisions.list",
  "events.replay",
  "events.subscribe",
  "logs.list",
]);

/**
 * Disposable-view lifecycle contract. The rundown tab renders Core truth;
 * closing it disposes the local handle only, and content never completes
 * work without a Core outcome.
 */
export const PHASE_COMPLETION_LIFECYCLE = Object.freeze({
  /** Closing disposes the local editor tab handle only. */
  closeDisposes: "view-handle-only",
  /** Core keeps running while project policy allows it. */
  coreContinuesAfterClose: true,
  /** Reopening re-reads the persisted report and snapshot. */
  reopenRefreshesSnapshot: true,
  /** The UI never marks phases complete optimistically. */
  optimisticComplete: false,
});

/**
 * Rundown actions and the navigation they perform. Inspect Changes stays in
 * the rundown via `git.status` / `git.commit.get` drill-downs; Open Roadmap
 * navigates to the existing Roadmap tab; Ask Master Agent navigates to the
 * existing Master Agent tab and sends via `master.send`; Start Next Phase
 * resolves to `phases.approve` through Core.
 */
export const PHASE_COMPLETION_ACTIONS = Object.freeze({
  inspectChanges: "inspect-changes",
  openRoadmap: "open-roadmap",
  askMasterAgent: "ask-master-agent",
  startNextPhase: "start-next-phase",
} as const);

export type PhaseCompletionActionId =
  (typeof PHASE_COMPLETION_ACTIONS)[keyof typeof PHASE_COMPLETION_ACTIONS];

/** Existing IDE commands the navigation actions open. */
export const PHASE_COMPLETION_NAVIGATION_COMMANDS = Object.freeze({
  openRoadmap: "densa-ade.showRoadmap",
  askMasterAgent: "densa-ade.showMasterAgent",
} as const);

export type PhaseCompletionConnectionState =
  "disconnected" | "connecting" | "connected" | "version-mismatch" | "auth-failed";

export interface PhaseCompletionValidationSummary {
  readonly passed: number;
  readonly failed: number;
  readonly total: number;
}

export interface PhaseCompletionLiveNextPhase {
  readonly id: string;
  readonly title: string;
  readonly state: PhaseState;
  readonly position: number;
}

export interface PhaseCompletionModelInput {
  /** Authoritative `phases.report.get` record. */
  readonly report: PhaseReport;
  /** Authoritative `projects.get` snapshot with runtime phases and mode. */
  readonly snapshot: CoreV1ProjectSnapshot;
  readonly connectionState?: PhaseCompletionConnectionState;
  readonly coreDetail?: string;
}

export interface PhaseCompletionModel {
  readonly projectId: string;
  readonly phaseId: string;
  /** Persisted report title, rendered verbatim. */
  readonly phaseTitle: string;
  /** Authoritative runtime phase state, rendered verbatim. */
  readonly runtimePhaseState: PhaseState;
  readonly outcome: PhaseReport["outcome"];
  /** Execution mode recorded in the persisted report. */
  readonly reportExecutionMode: ExecutionMode;
  /** Live execution mode from the current snapshot. */
  readonly liveExecutionMode: ExecutionMode;
  readonly workspacePath: string;
  readonly reportPath: string;
  readonly roadmapRevisionNumber: number;
  readonly phaseStartedAt: string;
  readonly generatedAt: string;
  /** Deterministic duration from persisted timestamps, when parseable. */
  readonly durationMs?: number;
  readonly durationKnown: boolean;
  readonly tasksCompleted: readonly PhaseReport["tasksCompleted"][number][];
  readonly validations: readonly PhaseReport["validations"][number][];
  readonly validationSummary: PhaseCompletionValidationSummary;
  readonly phaseValidation: PhaseReport["phaseValidation"];
  readonly commits: readonly PhaseReport["commits"][number][];
  readonly filesChanged: readonly {
    readonly taskId: string;
    readonly paths: readonly string[];
  }[];
  readonly importantDecisions: readonly PhaseReport["importantDecisions"][number][];
  readonly roadmapChanges: readonly PhaseReport["roadmapChanges"][number][];
  readonly retriesAndFailures: readonly PhaseReport["retriesAndFailures"][number][];
  readonly unresolvedIssues: readonly string[];
  readonly hasUnresolvedBlockers: boolean;
  readonly reportedNextPhase?: PhaseReport["nextPhase"];
  readonly liveNextPhase?: PhaseCompletionLiveNextPhase;
  /** True while the runtime phase waits at the Phase-mode approval boundary. */
  readonly blocksForApproval: boolean;
  /** True when the live mode is Continuous: the same report is viewable without blocking. */
  readonly continuousStored: boolean;
  /** True only when Start Next Phase may be sent (AWAITING_APPROVAL + validation passed). */
  readonly canStartNextPhase: boolean;
  readonly startNextPhaseBlockedReason?: string;
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
    throw new Error(`Phase-completion surface maps to unknown Core method ${method}.`);
  }
}

function blockedReason(
  connectionState: PhaseCompletionConnectionState,
  coreDetail?: string,
): string {
  const suffix = isNonEmptyText(coreDetail) === true ? ` (${coreDetail.trim()})` : "";
  switch (connectionState) {
    case "connected":
      return "";
    case "connecting":
      return `Densa ADE Core is connecting. Wait for the connection before using the phase report${suffix}.`;
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

function elapsedMsBetween(startedAt: string, generatedAt: string): number | undefined {
  const started = Date.parse(startedAt);
  const generated = Date.parse(generatedAt);
  if (Number.isFinite(started) !== true || Number.isFinite(generated) !== true) {
    return undefined;
  }
  if (generated < started) {
    return undefined;
  }
  return generated - started;
}

/**
 * Build the phase-completion rundown model from Core truth only.
 *
 * - `report` (`phases.report.get`) provides the persisted title, outcome,
 *   tasks completed, task/phase validator checks, commits, changed files,
 *   decisions, roadmap changes, retries/failures, unresolved issues, phase
 *   validation status, and reported next-phase summary;
 * - `snapshot` (`projects.get`) provides the authoritative runtime phase
 *   state, live execution mode, workspace path, live next-phase row, and
 *   latest event sequence.
 *
 * Any project/phase-boundary disagreement throws with a refresh hint instead
 * of inventing a fact. Duration appears only when the persisted timestamps
 * order deterministically. Start Next Phase availability is derived, never
 * assumed: the runtime phase must be `AWAITING_APPROVAL` and the persisted
 * phase validation must have `passed`.
 */
export function buildPhaseCompletionModel(input: PhaseCompletionModelInput): PhaseCompletionModel {
  for (const method of [
    ...PHASE_COMPLETION_OPEN_REFRESH_METHODS,
    ...PHASE_COMPLETION_CAPABILITY_METHODS,
  ]) {
    assertKnownMethod(method);
  }
  const report = input.report;
  const snapshot = input.snapshot;
  const projectId = snapshot.summary.project.id;
  if (report.projectId !== projectId) {
    throw new Error(
      "Phase report and project snapshot disagree on projectId; refresh phases.report.get and projects.get before rendering.",
    );
  }
  const runtimePhase = snapshot.phases.find((phase) => String(phase.id) === String(report.phaseId));
  if (runtimePhase === undefined) {
    throw new Error(
      `Phase report phase ${report.phaseId} has no runtime state; refresh phases.report.get and projects.get before rendering.`,
    );
  }
  if (String(runtimePhase.projectId) !== String(projectId)) {
    throw new Error("Phase report runtime row crossed the requested project boundary.");
  }
  if (isNonEmptyText(snapshot.summary.workspacePath) !== true) {
    throw new Error("Phase-completion snapshot is missing the persisted workspacePath.");
  }

  const durationMs = elapsedMsBetween(report.phaseStartedAt, report.generatedAt);
  const passed = report.validations.filter((check) => check.passed === true).length;
  const failed = report.validations.length - passed;

  const orderedPhases = [...snapshot.phases].sort((a, b) => a.position - b.position);
  const currentIndex = orderedPhases.findIndex(
    (phase) => String(phase.id) === String(report.phaseId),
  );
  const liveNextRow = currentIndex >= 0 ? orderedPhases[currentIndex + 1] : undefined;
  const liveNextPhase =
    liveNextRow === undefined
      ? undefined
      : Object.freeze({
          id: liveNextRow.id,
          title: liveNextRow.title,
          state: liveNextRow.state,
          position: liveNextRow.position,
        });

  const hasUnresolvedBlockers =
    report.unresolvedIssues.length > 0 ||
    report.outcome === "blocked" ||
    report.phaseValidation.status === "failed";

  const blocksForApproval = runtimePhase.state === "AWAITING_APPROVAL";
  const liveExecutionMode = snapshot.summary.project.executionMode;
  const continuousStored = liveExecutionMode === "continuous";

  const validationPassed = report.phaseValidation.status === "passed";
  const canStartNextPhase = blocksForApproval && validationPassed;
  let startNextPhaseBlockedReason: string | undefined;
  if (canStartNextPhase !== true) {
    if (blocksForApproval !== true) {
      startNextPhaseBlockedReason =
        `Phase ${report.phaseId} is ${runtimePhase.state}, not AWAITING_APPROVAL; ` +
        "Start Next Phase is available only at the phase approval boundary. Refresh phases.report.get and projects.get before approving.";
    } else {
      startNextPhaseBlockedReason =
        `Phase ${report.phaseId} validation is ${report.phaseValidation.status}, not passed; ` +
        "Start Next Phase is unavailable until phase validation passed. Inspect the validator summary and retries before approving.";
    }
  }

  const connectionState = input.connectionState ?? "connected";
  const enabled = connectionState === "connected";
  const reason = enabled === true ? undefined : blockedReason(connectionState, input.coreDetail);

  return Object.freeze({
    projectId,
    phaseId: report.phaseId,
    phaseTitle: report.phaseTitle,
    runtimePhaseState: runtimePhase.state,
    outcome: report.outcome,
    reportExecutionMode: report.executionMode,
    liveExecutionMode,
    workspacePath: snapshot.summary.workspacePath,
    reportPath: report.reportPath,
    roadmapRevisionNumber: report.roadmapRevisionNumber,
    phaseStartedAt: report.phaseStartedAt,
    generatedAt: report.generatedAt,
    ...(durationMs === undefined ? {} : { durationMs }),
    durationKnown: durationMs !== undefined,
    tasksCompleted: Object.freeze(
      report.tasksCompleted.map((entry) => Object.freeze({ ...entry })),
    ),
    validations: Object.freeze(report.validations.map((entry) => Object.freeze({ ...entry }))),
    validationSummary: Object.freeze({ passed, failed, total: report.validations.length }),
    phaseValidation: Object.freeze({ ...report.phaseValidation }),
    commits: Object.freeze(report.commits.map((entry) => Object.freeze({ ...entry }))),
    filesChanged: Object.freeze(
      report.filesChanged.map((entry) =>
        Object.freeze({ taskId: entry.taskId, paths: Object.freeze([...entry.paths]) }),
      ),
    ),
    importantDecisions: Object.freeze(
      report.importantDecisions.map((entry) => Object.freeze({ ...entry })),
    ),
    roadmapChanges: Object.freeze(
      report.roadmapChanges.map((entry) => Object.freeze({ ...entry })),
    ),
    retriesAndFailures: Object.freeze(
      report.retriesAndFailures.map((entry) => Object.freeze({ ...entry })),
    ),
    unresolvedIssues: Object.freeze([...report.unresolvedIssues]),
    hasUnresolvedBlockers,
    ...(report.nextPhase === undefined
      ? {}
      : { reportedNextPhase: Object.freeze({ ...report.nextPhase }) }),
    ...(liveNextPhase === undefined ? {} : { liveNextPhase }),
    blocksForApproval,
    continuousStored,
    canStartNextPhase,
    ...(startNextPhaseBlockedReason === undefined ? {} : { startNextPhaseBlockedReason }),
    latestEventSequence: snapshot.latestEventSequence,
    capabilityMethods: PHASE_COMPLETION_CAPABILITY_METHODS,
    optimisticComplete: false as const,
    enabled,
    ...(reason === undefined ? {} : { reason }),
  });
}

export type PhaseCompletionDrilldown =
  | {
      readonly kind: "report-refresh";
      readonly method: "phases.report.get";
      readonly projectId: string;
      readonly phaseId: string;
    }
  | {
      readonly kind: "project-snapshot";
      readonly method: "projects.get";
      readonly projectId: string;
    }
  | {
      readonly kind: "open-roadmap";
      readonly method: "roadmaps.get";
      readonly projectId: string;
    }
  | {
      readonly kind: "inspect-changes";
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
      readonly kind: "decisions";
      readonly method: "decisions.list";
      readonly projectId: string;
    }
  | {
      readonly kind: "revisions";
      readonly method: "roadmaps.revisions.list";
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
      readonly phaseId: string;
    };

/**
 * Resolve a rundown metric to the existing Core v1 operation that backs its
 * drill-down. Tasks completed resolve to `attempts.list`; validator checks
 * to `validation.list`/`validation.get`; commits to `git.commit.get` (with
 * the workspace overview via `git.status`); decisions to `decisions.list`;
 * roadmap changes to `roadmaps.revisions.list`; the next-phase summary to
 * `roadmaps.get`; run detail to `logs.list`. The IDE carries persisted IDs
 * through to Core and never fabricates detail locally.
 */
export function resolvePhaseCompletionDrilldown(
  model: PhaseCompletionModel,
  selection:
    | { readonly kind: "report-refresh" }
    | { readonly kind: "project-snapshot" }
    | { readonly kind: "open-roadmap" }
    | { readonly kind: "inspect-changes" }
    | { readonly kind: "git-commit"; readonly sha: string }
    | { readonly kind: "attempts"; readonly taskId: string }
    | { readonly kind: "validation-runs"; readonly taskId: string }
    | { readonly kind: "validation-detail"; readonly validationRunId: string }
    | { readonly kind: "decisions" }
    | { readonly kind: "revisions" }
    | { readonly kind: "events"; readonly afterSequence?: number }
    | { readonly kind: "run-logs" },
): PhaseCompletionDrilldown {
  switch (selection.kind) {
    case "report-refresh": {
      assertKnownMethod("phases.report.get");
      return Object.freeze({
        kind: "report-refresh" as const,
        method: "phases.report.get" as const,
        projectId: model.projectId,
        phaseId: model.phaseId,
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
    case "open-roadmap": {
      assertKnownMethod("roadmaps.get");
      return Object.freeze({
        kind: "open-roadmap" as const,
        method: "roadmaps.get" as const,
        projectId: model.projectId,
      });
    }
    case "inspect-changes": {
      if (isNonEmptyText(model.workspacePath) !== true) {
        throw new Error(
          "Phase-completion changes drill-down requires the persisted workspacePath.",
        );
      }
      assertKnownMethod("git.status");
      return Object.freeze({
        kind: "inspect-changes" as const,
        method: "git.status" as const,
        projectId: model.projectId,
        workspacePath: model.workspacePath,
      });
    }
    case "git-commit": {
      if (isNonEmptyText(selection.sha) !== true) {
        throw new Error("Phase-completion commit drill-down requires a persisted commit SHA.");
      }
      const wanted = (selection.sha as string).trim();
      const known = model.commits.some(
        (entry) => entry.sha.startsWith(wanted) || wanted.startsWith(entry.sha),
      );
      if (known !== true) {
        throw new Error(
          `Unknown phase-report commit ${wanted}; refresh phases.report.get before rendering.`,
        );
      }
      assertKnownMethod("git.commit.get");
      return Object.freeze({
        kind: "git-commit" as const,
        method: "git.commit.get" as const,
        projectId: model.projectId,
        sha: wanted,
      });
    }
    case "attempts": {
      if (isNonEmptyText(selection.taskId) !== true) {
        throw new Error("Phase-completion attempts drill-down requires a persisted taskId.");
      }
      const taskId = (selection.taskId as string).trim();
      const known =
        model.tasksCompleted.some((entry) => entry.taskId === taskId) ||
        model.retriesAndFailures.some((entry) => entry.taskId === taskId) ||
        model.commits.some((entry) => entry.taskId === taskId);
      if (known !== true) {
        throw new Error(
          `Unknown phase-report task ${taskId}; refresh phases.report.get before rendering.`,
        );
      }
      assertKnownMethod("attempts.list");
      return Object.freeze({
        kind: "attempts" as const,
        method: "attempts.list" as const,
        projectId: model.projectId,
        taskId,
      });
    }
    case "validation-runs": {
      if (isNonEmptyText(selection.taskId) !== true) {
        throw new Error("Phase-completion validation drill-down requires a persisted taskId.");
      }
      const taskId = (selection.taskId as string).trim();
      assertKnownMethod("validation.list");
      return Object.freeze({
        kind: "validation-runs" as const,
        method: "validation.list" as const,
        projectId: model.projectId,
        taskId,
      });
    }
    case "validation-detail": {
      if (isNonEmptyText(selection.validationRunId) !== true) {
        throw new Error(
          "Phase-completion validation drill-down requires a persisted validationRunId.",
        );
      }
      assertKnownMethod("validation.get");
      return Object.freeze({
        kind: "validation-detail" as const,
        method: "validation.get" as const,
        projectId: model.projectId,
        validationRunId: (selection.validationRunId as string).trim(),
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
    case "revisions": {
      assertKnownMethod("roadmaps.revisions.list");
      return Object.freeze({
        kind: "revisions" as const,
        method: "roadmaps.revisions.list" as const,
        projectId: model.projectId,
      });
    }
    case "events": {
      assertKnownMethod("events.replay");
      const afterSequence =
        selection.afterSequence === undefined ? model.latestEventSequence : selection.afterSequence;
      if (Number.isInteger(afterSequence) !== true || afterSequence < 0) {
        throw new Error(
          "Phase-completion events drill-down requires a non-negative afterSequence.",
        );
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
      return Object.freeze({
        kind: "run-logs" as const,
        method: "logs.list" as const,
        projectId: model.projectId,
        phaseId: model.phaseId,
      });
    }
  }
}

export interface PhaseCompletionInspectChangesResolution {
  readonly method: "git.status";
  readonly projectId: string;
  readonly workspacePath: string;
}

/** Resolve the Inspect Changes action to `git.status` through Core. */
export function resolvePhaseCompletionInspectChanges(
  model: PhaseCompletionModel,
): PhaseCompletionInspectChangesResolution {
  const drilldown = resolvePhaseCompletionDrilldown(model, { kind: "inspect-changes" });
  if (drilldown.kind !== "inspect-changes") {
    throw new Error("Phase-completion changes drill-down crossed its kind boundary.");
  }
  return Object.freeze({
    method: drilldown.method,
    projectId: drilldown.projectId,
    workspacePath: drilldown.workspacePath,
  });
}

export interface PhaseCompletionOpenRoadmapResolution {
  readonly method: "roadmaps.get";
  readonly projectId: string;
  /** Existing Roadmap editor-area tab this action opens. */
  readonly command: "densa-ade.showRoadmap";
}

/** Resolve the Open Roadmap action to `roadmaps.get` plus its IDE tab. */
export function resolvePhaseCompletionOpenRoadmap(
  model: PhaseCompletionModel,
): PhaseCompletionOpenRoadmapResolution {
  const drilldown = resolvePhaseCompletionDrilldown(model, { kind: "open-roadmap" });
  if (drilldown.kind !== "open-roadmap") {
    throw new Error("Phase-completion roadmap drill-down crossed its kind boundary.");
  }
  return Object.freeze({
    method: drilldown.method,
    projectId: drilldown.projectId,
    command: PHASE_COMPLETION_NAVIGATION_COMMANDS.openRoadmap,
  });
}

export interface PhaseCompletionMasterAskResolution {
  readonly method: "master.send";
  readonly projectId: string;
  readonly workspacePath: string;
  readonly sessionId: string;
  readonly message: string;
  /** Existing Master Agent editor-area tab this action opens. */
  readonly command: "densa-ade.showMasterAgent";
}

/**
 * Resolve the Ask Master Agent action to `master.send` through Core. Sending
 * asks through the Master role — it never applies roadmap, constraint, or
 * control mutations directly. Only the Core `proposal`/`commandStatus` in the
 * response determines what changed.
 */
export function resolvePhaseCompletionMasterAsk(
  model: PhaseCompletionModel,
  input: { readonly message: string; readonly sessionId: string },
): PhaseCompletionMasterAskResolution {
  if (isNonEmptyText(input.message) !== true) {
    throw new Error("Phase-completion Master ask requires a non-empty message.");
  }
  if (isNonEmptyText(input.sessionId) !== true) {
    throw new Error("Phase-completion Master ask requires a sessionId.");
  }
  const sessionId = (input.sessionId as string).trim();
  if (sessionId.length > 256) {
    throw new Error("Master sessionId exceeds the 256 character Core limit.");
  }
  if (Buffer.byteLength(input.message) > 64 * 1_024) {
    throw new Error("Master message exceeds the 64 KiB Core limit.");
  }
  if (isNonEmptyText(model.projectId) !== true || isNonEmptyText(model.workspacePath) !== true) {
    throw new Error("Phase-completion Master ask requires the persisted project and workspace.");
  }
  assertKnownMethod("master.send");
  return Object.freeze({
    method: "master.send" as const,
    projectId: model.projectId,
    workspacePath: model.workspacePath,
    sessionId,
    message: (input.message as string).trim(),
    command: PHASE_COMPLETION_NAVIGATION_COMMANDS.askMasterAgent,
  });
}

export interface PhaseCompletionPhaseApprovalResolution {
  readonly method: "phases.approve";
  readonly projectId: string;
  readonly phaseId: string;
  readonly decision: "approve" | "reject";
  readonly actor: string;
  readonly reason: string;
}

/**
 * Resolve the Start Next Phase action to `phases.approve` through Core. The
 * phase must already be `AWAITING_APPROVAL` in the model; an `approve`
 * decision additionally requires the persisted `phaseValidation.status` to
 * be `passed`. Only the Core outcome advances the phase — the UI never
 * completes it optimistically.
 */
export function resolvePhaseCompletionPhaseApproval(
  model: PhaseCompletionModel,
  input: {
    readonly decision: "approve" | "reject";
    readonly actor: string;
    readonly reason: string;
  },
): PhaseCompletionPhaseApprovalResolution {
  if (input.decision !== "approve" && input.decision !== "reject") {
    throw new Error("Phase-completion approval must be approve or reject.");
  }
  if (model.runtimePhaseState !== "AWAITING_APPROVAL") {
    throw new Error(
      `Phase ${model.phaseId} is ${model.runtimePhaseState}, not AWAITING_APPROVAL; refresh phases.report.get and projects.get before approving.`,
    );
  }
  if (input.decision === "approve" && model.phaseValidation.status !== "passed") {
    throw new Error(
      `Phase ${model.phaseId} validation is ${model.phaseValidation.status}, not passed; Start Next Phase is unavailable until phase validation passed.`,
    );
  }
  if (isNonEmptyText(input.actor) !== true) {
    throw new Error("Phase-completion approval requires an actor.");
  }
  if (isNonEmptyText(input.reason) !== true) {
    throw new Error("Phase-completion approval requires a reason.");
  }
  assertKnownMethod("phases.approve");
  return Object.freeze({
    method: "phases.approve" as const,
    projectId: model.projectId,
    phaseId: model.phaseId,
    decision: input.decision,
    actor: (input.actor as string).trim(),
    reason: (input.reason as string).trim(),
  });
}

export interface PhaseCompletionReopenRefresh {
  readonly action: "refresh-before-render";
  readonly refreshMethods: readonly CoreV1Method[];
  readonly projectId: string;
  readonly phaseId: string;
  readonly reason: string;
}

/**
 * Reconnect/reopen recipe for the rundown: refresh `phases.report.get` and
 * `projects.get`, then rebuild via `buildPhaseCompletionModel()`. The
 * persisted report survives close, reconnect, and Core restart; live
 * `core.event` notifications are hints to refresh, never direct edits.
 */
export function resolvePhaseCompletionReopenRefresh(
  projectId: string,
  phaseId: string,
): PhaseCompletionReopenRefresh {
  if (isNonEmptyText(projectId) !== true) {
    throw new Error(
      "Phase-completion reopen requires a persisted projectId from Core (projects.list); the IDE does not invent one.",
    );
  }
  if (isNonEmptyText(phaseId) !== true) {
    throw new Error(
      "Phase-completion reopen requires a persisted phaseId from Core (phases.report.get); the IDE does not invent one.",
    );
  }
  return Object.freeze({
    action: "refresh-before-render",
    refreshMethods: PHASE_COMPLETION_OPEN_REFRESH_METHODS,
    projectId: projectId.trim(),
    phaseId: phaseId.trim(),
    reason:
      "Refresh phases.report.get and projects.get, then rebuild the phase-completion model. " +
      "The persisted report survives close, reconnect, and Core restart. Live core.event notifications are hints to refresh, never direct edits.",
  });
}

/**
 * True when a persisted notification is only a refresh hint for the rundown.
 * `core.event` notifications are hints to re-read Core truth; empty event
 * names are ignored; `run.log.appended` worker-log notifications are ignored
 * so worker transcripts never spill into the rundown without an explicit
 * opt-in drill-down.
 */
export function phaseCompletionEventIsRefreshHint(eventType: string): boolean {
  if (typeof eventType !== "string") {
    return false;
  }
  const trimmed = eventType.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (trimmed === "run.log.appended") {
    return false;
  }
  return true;
}
