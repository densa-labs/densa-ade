// Copyright 2026 Densa Labs
// SPDX-License-Identifier: Apache-2.0

/**
 * Densa ADE recovery and waiting UX (Phase 12 Milestone 3).
 *
 * Crashes, usage waits, and blocked states answer: "Is Densa ADE waiting,
 * broken, or offline — and what was safely kept?" The surface renders every
 * milestone state as an explicit recoverable card instead of a mysterious
 * failure: Core disconnected/reconnecting, interrupted task recovered after
 * restart, workspace divergence requiring review, `WAITING_FOR_USAGE` with a
 * known `resetAt`, `WAITING_FOR_USAGE` with unknown reset, auto-resume
 * enabled/disabled, `BLOCKED` after retries, authentication required, and
 * permission/user decision required.
 *
 * This module is pure and protocol-only:
 *
 * - it imports `@densa-ade/protocol` types only, never `@densa-ade/core`,
 *   `@densa-ade/cli`, SQLite, or `vscode` / `vs/workbench`;
 * - every fact comes from versioned Core v1 operations (`projects.get` for
 *   the authoritative project/task/phase snapshot, `dashboard.get` for the
 *   aggregate current-work pointers, retry counts, and pending approvals,
 *   `usage.get` for the authoritative usage observation, `git.status` for
 *   the observed workspace, `events.replay` for the recent persisted
 *   timeline) plus two explicitly caller-supplied local facts: the IDE
 *   connection state and the reliably observed Codex authentication check.
 *   The IDE never invents project, task, usage, reset, token, cost, Git,
 *   checkpoint, or authentication state;
 * - usage `resetAt` appears only when the persisted `UsageState` actually
 *   carries it. Otherwise the model says unknown and offers no countdown.
 *   No countdown math, no fabricated timer, no guessed reset interval;
 * - the UI never changes lifecycle state optimistically. Resolvers below
 *   return Core request payloads to send or explicit local-only recipes
 *   (reconnect, auto-resume intent); only Core outcomes and `core.event`
 *   notifications (as refresh hints) change what is shown
 *   (`RECOVERY_LIFECYCLE.optimisticComplete` is `false`). Control outcomes
 *   are applied through `applyRecoveryControlOutcome()`, which never edits
 *   the snapshot model: it returns a refresh recipe plus a notice, and the
 *   caller rebuilds via `buildRecoveryModel()` from fresh Core reads;
 * - reconnect/restart never duplicates actions. Reopening replays
 *   `events.replay` from the last applied sequence and re-subscribes;
 *   duplicates are reported as idempotent no-ops (`UNCHANGED`), gaps require
 *   a fresh replay. `resolveRecoveryReopenRefresh()` names that recipe;
 * - each card shows what Densa ADE safely persisted (project/task state,
 *   latest event sequence, Git HEAD when observed, attempt/validation
 *   counts, usage observation) and clear Core-backed next actions. Detailed
 *   diagnostics stay behind drill-downs (`attempts.list`,
 *   `validation.list`/`validation.get`, `logs.list`, `events.replay`,
 *   `git.status`, `usage.get`) and are never dumped inline;
 * - Codex authentication is reported only from the caller-supplied reliable
 *   check (`ready` | `required` | `unknown`). `unknown` is honest and renders
 *   as unknown; presentation text is never scraped to claim readiness.
 *
 * Standard VS Code contribution mechanisms only (AGENTS.md §1.3): the surface
 * renders inside the existing `densa-ade.dashboard` editor-area tab
 * contributed in M3. This milestone adds its content model, not new
 * workbench patches, new activity-bar entries, or new editor viewTypes.
 */

import {
  CORE_V1_METHODS,
  type CoreV1Dashboard,
  type CoreV1Method,
  type CoreV1PersistedEvent,
  type CoreV1ProjectSnapshot,
  type CoreV1Result,
  type ExecutionMode,
  type ProjectState,
  type TaskState,
  type UsageState,
} from "@densa-ade/protocol";

/** Authoritative `git.status` result, when the workspace is observed. */
export type RecoveryGitStatus = CoreV1Result<"git.status">;

/** Authoritative `usage.get` result, when usage is observed. */
export type RecoveryUsageObservation = CoreV1Result<"usage.get">;

/** Authoritative Core control outcome (`projects.pause`/`resume`/`stop`). */
export type RecoveryControlOutcome =
  CoreV1Result<"projects.pause"> | CoreV1Result<"projects.resume"> | CoreV1Result<"projects.stop">;

/** Host tab reused for recovery content (contributed in Phase 10 M3). No new view. */
export const RECOVERY_HOST_COMMAND = "densa-ade.showDashboard" as const;

/** Host editor-area viewType reused for recovery content. No new viewType. */
export const RECOVERY_HOST_VIEW_TYPE = "densa-ade.dashboard" as const;

/** Contract version of this content model. */
export const RECOVERY_VERSION = 1 as const;

/**
 * Snapshot reads backing first render and every reopen, in refresh order.
 * `projects.get` is authoritative; `dashboard.get` supplies the aggregate
 * pointers and counts; `events.replay` restores the persisted timeline from
 * the last applied sequence; `usage.get` supplies the authoritative usage
 * observation behind waiting cards.
 */
export const RECOVERY_OPEN_REFRESH_METHODS: readonly CoreV1Method[] = Object.freeze([
  "projects.get",
  "dashboard.get",
  "events.replay",
  "usage.get",
]);

/** Frozen-catalog Core operations the recovery surface may use once open. */
export const RECOVERY_CAPABILITY_METHODS: readonly CoreV1Method[] = Object.freeze([
  "projects.get",
  "dashboard.get",
  "events.replay",
  "events.subscribe",
  "usage.get",
  "git.status",
  "git.commit.get",
  "attempts.list",
  "validation.list",
  "validation.get",
  "logs.list",
  "projects.pause",
  "projects.resume",
  "projects.stop",
  "permissions.resolve",
  "tasks.approve",
  "phases.approve",
  "phases.report.get",
  "decisions.list",
]);

/**
 * Disposable-view lifecycle contract. The recovery surface renders Core
 * truth; closing it disposes the local handle only, and content never
 * changes lifecycle state without a Core outcome.
 */
export const RECOVERY_LIFECYCLE = Object.freeze({
  /** Closing disposes the local editor tab handle only. */
  closeDisposes: "view-handle-only",
  /** Core keeps running while project policy allows it. */
  coreContinuesAfterClose: true,
  /** Reopening replays from the last applied sequence, then refreshes. */
  reopenRefreshesSnapshot: true,
  /** The UI never completes, resumes, or approves work optimistically. */
  optimisticComplete: false,
  /** Recovery never creates a second authoritative app state. */
  createsNewAuthoritativeState: false,
  /** Opening the surface issues no Core mutation by itself. */
  issuesCoreRequest: false,
});

export type RecoveryConnectionState =
  "disconnected" | "connecting" | "connected" | "version-mismatch" | "auth-failed";

export type RecoveryCodexAuthStatus = "ready" | "required" | "unknown";

/**
 * Reliably observed Codex authentication readiness. `unknown` is the honest
 * default when the installed CLI exposes no stable auth signal: Densa ADE
 * never scrapes presentation text to claim `ready` or `required`.
 */
export interface RecoveryCodexAuthCheck {
  readonly status: RecoveryCodexAuthStatus;
  readonly detail?: string;
}

export type RecoveryKind =
  | "core-disconnected"
  | "core-reconnecting"
  | "core-version-mismatch"
  | "core-auth-failed"
  | "codex-auth-required"
  | "interrupted-recovered"
  | "workspace-divergence"
  | "waiting-for-usage-known-reset"
  | "waiting-for-usage-unknown"
  | "blocked-after-retries"
  | "permission-required"
  | "user-decision-required"
  | "steady";

/**
 * How the user should read a card:
 * - `waiting` is a normal recoverable wait (not broken);
 * - `attention` needs user review/action but is recoverable (not broken);
 * - `broken` needs intervention with new evidence before progress resumes;
 * - `offline` means Core is unreachable and shown facts are the last known
 *   truth, not fresh truth (not lost);
 * - `ok` means no recovery is needed.
 */
export type RecoveryTone = "waiting" | "attention" | "broken" | "offline" | "ok";

export type RecoveryDrilldown =
  | {
      readonly kind: "project-snapshot";
      readonly method: "projects.get";
      readonly projectId: string;
    }
  | {
      readonly kind: "dashboard-refresh";
      readonly method: "dashboard.get";
      readonly projectId: string;
    }
  | {
      readonly kind: "events";
      readonly method: "events.replay";
      readonly projectId: string;
      readonly afterSequence: number;
    }
  | {
      readonly kind: "usage";
      readonly method: "usage.get";
      readonly projectId: string;
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
      readonly kind: "run-logs";
      readonly method: "logs.list";
      readonly projectId: string;
      readonly phaseId?: string;
      readonly taskId?: string;
      readonly attemptId?: string;
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

export interface RecoveryCard {
  readonly kind: RecoveryKind;
  readonly tone: RecoveryTone;
  readonly title: string;
  readonly detail: string;
  /** Facts Densa ADE safely persisted behind this card. Never invented. */
  readonly persisted: readonly string[];
  /** Clear Core-backed next actions. Never a fabricated countdown. */
  readonly nextActions: readonly string[];
  /** Read-only drill-downs to persisted detail. Full logs are never inlined. */
  readonly drilldowns: readonly RecoveryDrilldown[];
  /** Where detailed diagnostics live without being dumped inline. */
  readonly diagnosticsHint: string;
  /** Local-only auto-resume intent, present only on waiting cards. */
  readonly autoResumeEnabled?: boolean;
  /** Verbatim `resetAt` only when the persisted usage observation carries it. */
  readonly resetAt?: string;
  readonly resetKnown?: boolean;
}

export interface RecoverySummary {
  readonly tone: RecoveryTone;
  readonly title: string;
  readonly detail: string;
}

export interface RecoveryModelInput {
  /** Authoritative `projects.get` snapshot (last known truth when offline). */
  readonly snapshot: CoreV1ProjectSnapshot;
  /** Authoritative `dashboard.get` aggregate, when shown. */
  readonly dashboard?: CoreV1Dashboard;
  /** Authoritative `git.status` result, when the workspace is observed. */
  readonly gitStatus?: RecoveryGitStatus;
  /** Authoritative `usage.get` result, when usage is observed. */
  readonly usageObservation?: RecoveryUsageObservation;
  /** Authoritative `events.replay` page in Core order, when shown. */
  readonly recentEvents?: readonly CoreV1PersistedEvent[];
  readonly connectionState?: RecoveryConnectionState;
  readonly coreDetail?: string;
  /** Reliably observed Codex auth check. `unknown` when not observed. */
  readonly codexAuth?: RecoveryCodexAuthCheck;
  /** Local-only auto-resume intent (settings). Off unless explicitly enabled. */
  readonly autoResumeEnabled?: boolean;
  /** True when the caller observed a Core/IDE restart before this render. */
  readonly restartObserved?: boolean;
}

export interface RecoveryModel {
  readonly version: typeof RECOVERY_VERSION;
  readonly projectId: string;
  readonly projectName: string;
  /** Authoritative project state, rendered verbatim. */
  readonly projectState: ProjectState;
  readonly executionMode: ExecutionMode;
  readonly workspacePath: string;
  readonly latestEventSequence: number;
  readonly connectionState: RecoveryConnectionState;
  readonly autoResumeEnabled: boolean;
  readonly usageResetKnown: boolean;
  readonly usageResetAt?: string;
  readonly cards: readonly RecoveryCard[];
  readonly summary: RecoverySummary;
  readonly capabilityMethods: readonly CoreV1Method[];
  readonly optimisticComplete: false;
  readonly enabled: boolean;
  readonly reason?: string;
}

/** Canonical project states from AGENTS.md §2.2. Rendered verbatim. */
export const RECOVERY_CANONICAL_PROJECT_STATES: readonly ProjectState[] = Object.freeze([
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
export const RECOVERY_CANONICAL_TASK_STATES: readonly TaskState[] = Object.freeze([
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

/** Every recovery card kind the surface can render. */
export const RECOVERY_KINDS: readonly RecoveryKind[] = Object.freeze([
  "core-disconnected",
  "core-reconnecting",
  "core-version-mismatch",
  "core-auth-failed",
  "codex-auth-required",
  "interrupted-recovered",
  "workspace-divergence",
  "waiting-for-usage-known-reset",
  "waiting-for-usage-unknown",
  "blocked-after-retries",
  "permission-required",
  "user-decision-required",
  "steady",
]);

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKnownMethod(method: string): asserts method is CoreV1Method {
  if ((CORE_V1_METHODS as readonly string[]).includes(method) !== true) {
    throw new Error(`Recovery surface maps to unknown Core method ${method}.`);
  }
}

function blockedReason(connectionState: RecoveryConnectionState, coreDetail?: string): string {
  const suffix = isNonEmptyText(coreDetail) === true ? ` (${coreDetail.trim()})` : "";
  switch (connectionState) {
    case "connected":
      return "";
    case "connecting":
      return `Densa ADE Core is connecting. Wait for the connection before using recovery controls${suffix}.`;
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

function parseCodexAuth(value: unknown): RecoveryCodexAuthCheck {
  if (value === undefined) {
    return Object.freeze({ status: "unknown" as const });
  }
  if (isRecord(value) !== true) {
    throw new Error("Recovery codexAuth must be an object.");
  }
  const status = value["status"];
  if (status !== "ready" && status !== "required" && status !== "unknown") {
    throw new Error("Recovery codexAuth status must be ready, required, or unknown.");
  }
  const detail = value["detail"];
  if (detail !== undefined && typeof detail !== "string") {
    throw new Error("Recovery codexAuth detail must be text when present.");
  }
  return Object.freeze({
    status,
    ...(detail === undefined ? {} : { detail: detail as string }),
  });
}

function usageResetOf(usage: UsageState): { readonly resetAt?: string; readonly known: boolean } {
  if (usage.status === "limited" && usage.resetAt !== undefined) {
    return { resetAt: usage.resetAt, known: true };
  }
  return { known: false };
}

function describeUsage(usage: UsageState): string {
  if (usage.status === "available") {
    return "Agent usage is available.";
  }
  if (usage.status === "limited") {
    return "Agent usage is limited.";
  }
  const reasonSuffix =
    usage.status === "unknown" && isNonEmptyText(usage.reason) === true
      ? `: ${usage.reason.trim()}`
      : "";
  return `Agent usage is unknown${reasonSuffix}.`;
}

const DIAGNOSTICS_HINT =
  "Detailed diagnostics stay behind the drill-downs below (attempts, validation runs, run logs, event replay, Git status, usage observation). Full transcripts and raw log bodies are never dumped inline; open a drill-down to inspect persisted detail.";

function drilldownProjectSnapshot(projectId: string): RecoveryDrilldown {
  assertKnownMethod("projects.get");
  return Object.freeze({
    kind: "project-snapshot" as const,
    method: "projects.get" as const,
    projectId,
  });
}

function drilldownDashboard(projectId: string): RecoveryDrilldown {
  assertKnownMethod("dashboard.get");
  return Object.freeze({
    kind: "dashboard-refresh" as const,
    method: "dashboard.get" as const,
    projectId,
  });
}

function drilldownEvents(projectId: string, afterSequence: number): RecoveryDrilldown {
  assertKnownMethod("events.replay");
  if (Number.isInteger(afterSequence) !== true || afterSequence < 0) {
    throw new Error("Recovery events drill-down requires a non-negative afterSequence.");
  }
  return Object.freeze({
    kind: "events" as const,
    method: "events.replay" as const,
    projectId,
    afterSequence,
  });
}

function drilldownUsage(projectId: string): RecoveryDrilldown {
  assertKnownMethod("usage.get");
  return Object.freeze({ kind: "usage" as const, method: "usage.get" as const, projectId });
}

function drilldownChanges(projectId: string, workspacePath: string): RecoveryDrilldown {
  assertKnownMethod("git.status");
  if (isNonEmptyText(workspacePath) !== true) {
    throw new Error("Recovery changes drill-down requires the persisted workspacePath.");
  }
  return Object.freeze({
    kind: "changes" as const,
    method: "git.status" as const,
    projectId,
    workspacePath: workspacePath.trim(),
  });
}

function drilldownAttempts(projectId: string, taskId: string): RecoveryDrilldown {
  assertKnownMethod("attempts.list");
  if (isNonEmptyText(taskId) !== true) {
    throw new Error("Recovery attempts drill-down requires a persisted taskId.");
  }
  return Object.freeze({
    kind: "attempts" as const,
    method: "attempts.list" as const,
    projectId,
    taskId: taskId.trim(),
  });
}

function drilldownValidationRuns(projectId: string, taskId: string): RecoveryDrilldown {
  assertKnownMethod("validation.list");
  if (isNonEmptyText(taskId) !== true) {
    throw new Error("Recovery validation drill-down requires a persisted taskId.");
  }
  return Object.freeze({
    kind: "validation-runs" as const,
    method: "validation.list" as const,
    projectId,
    taskId: taskId.trim(),
  });
}

function drilldownRunLogs(
  projectId: string,
  scope: { readonly phaseId?: string; readonly taskId?: string; readonly attemptId?: string },
): RecoveryDrilldown {
  assertKnownMethod("logs.list");
  return Object.freeze({
    kind: "run-logs" as const,
    method: "logs.list" as const,
    projectId,
    ...(scope.phaseId === undefined ? {} : { phaseId: scope.phaseId }),
    ...(scope.taskId === undefined ? {} : { taskId: scope.taskId }),
    ...(scope.attemptId === undefined ? {} : { attemptId: scope.attemptId }),
  });
}

function drilldownDecisions(projectId: string): RecoveryDrilldown {
  assertKnownMethod("decisions.list");
  return Object.freeze({
    kind: "decisions" as const,
    method: "decisions.list" as const,
    projectId,
  });
}

/**
 * Build the recovery/waiting content model from Core truth only.
 *
 * - `snapshot` (`projects.get`) provides the authoritative project state,
 *   workspace path, runtime phase/task rows, pending approvals, usage, and
 *   latest event sequence (last known truth when offline);
 * - `dashboard` (`dashboard.get`, when shown) provides the aggregate retry,
 *   failure, and pending-approval counts plus current-work pointers;
 * - `usageObservation` (`usage.get`, when observed) is authoritative for
 *   waiting cards and wins over the snapshot/dashboard copies;
 * - `gitStatus` (`git.status`, when observed) provides the workspace
 *   observation behind divergence cards;
 * - `recentEvents` (when shown) proves the persisted timeline behind
 *   "what was safely persisted";
 * - `connectionState`/`coreDetail` are the IDE's observed Core transport
 *   state; `codexAuth` is the reliably observed worker-auth check;
 *   `autoResumeEnabled` is local-only intent and never claims Core
 *   persistence; `restartObserved` records a caller-observed restart.
 *
 * Any project-boundary disagreement throws with a refresh hint instead of
 * inventing a fact. Usage reset appears only when observed. No countdown is
 * ever synthesized.
 */
export function buildRecoveryModel(input: RecoveryModelInput): RecoveryModel {
  for (const method of [...RECOVERY_OPEN_REFRESH_METHODS, ...RECOVERY_CAPABILITY_METHODS]) {
    assertKnownMethod(method);
  }
  const snapshot = input.snapshot;
  if (isRecord(snapshot) !== true) {
    throw new Error("Recovery model requires a projects.get snapshot from Core.");
  }
  const projectId = snapshot.summary.project.id;
  if (isNonEmptyText(projectId) !== true) {
    throw new Error("Recovery model requires a persisted projectId from Core.");
  }
  const workspacePath = snapshot.summary.workspacePath;
  if (isNonEmptyText(workspacePath) !== true) {
    throw new Error("Recovery model requires the persisted workspacePath from Core.");
  }
  const projectState = snapshot.summary.project.state;
  if ((RECOVERY_CANONICAL_PROJECT_STATES as readonly string[]).includes(projectState) !== true) {
    throw new Error(
      `Recovery project carries an unknown state ${String(projectState)}; refresh projects.get before rendering.`,
    );
  }
  for (const task of snapshot.tasks) {
    if ((RECOVERY_CANONICAL_TASK_STATES as readonly string[]).includes(task.state) !== true) {
      throw new Error(
        `Recovery task ${String(task.id)} carries an unknown state ${String(task.state)}; refresh projects.get before rendering.`,
      );
    }
    if (String(task.projectId) !== projectId) {
      throw new Error("Recovery task crossed the requested project boundary.");
    }
  }
  for (const phase of snapshot.phases) {
    if (String(phase.projectId) !== projectId) {
      throw new Error("Recovery phase crossed the requested project boundary.");
    }
  }

  const dashboard = input.dashboard;
  if (dashboard !== undefined) {
    if (dashboard.project.project.id !== projectId) {
      throw new Error(
        "Recovery dashboard and project snapshot disagree on projectId; refresh dashboard.get and projects.get before rendering.",
      );
    }
    if (dashboard.project.workspacePath !== workspacePath) {
      throw new Error(
        "Recovery dashboard and project snapshot disagree on workspacePath; refresh dashboard.get and projects.get before rendering.",
      );
    }
    if (dashboard.latestEventSequence !== snapshot.latestEventSequence) {
      throw new Error(
        "Recovery dashboard and project snapshot disagree on latestEventSequence; refresh dashboard.get and projects.get before rendering.",
      );
    }
  }

  const gitStatus = input.gitStatus;
  if (gitStatus !== undefined && gitStatus.projectId !== projectId) {
    throw new Error("Recovery Git status crossed the requested project boundary.");
  }

  const usageObservation = input.usageObservation;
  if (usageObservation !== undefined && usageObservation.projectId !== projectId) {
    throw new Error("Recovery usage observation crossed the requested project boundary.");
  }

  const recentEvents = input.recentEvents ?? [];
  for (const event of recentEvents) {
    if (event.projectId !== projectId) {
      throw new Error("Recovery event crossed the requested project boundary.");
    }
  }

  const connectionState = input.connectionState ?? "connected";
  const knownConnection: readonly string[] = Object.freeze([
    "disconnected",
    "connecting",
    "connected",
    "version-mismatch",
    "auth-failed",
  ]);
  if (knownConnection.includes(connectionState) !== true) {
    throw new Error("Recovery connectionState must be a known connection state.");
  }

  const codexAuth = parseCodexAuth(input.codexAuth);
  const autoResumeEnabled = input.autoResumeEnabled ?? false;
  if (typeof autoResumeEnabled !== "boolean") {
    throw new Error("Recovery autoResumeEnabled must be a boolean.");
  }
  const restartObserved = input.restartObserved ?? false;

  const effectiveUsage: UsageState = usageObservation?.usage ?? dashboard?.usage ?? snapshot.usage;
  const reset = usageResetOf(effectiveUsage);
  const latestEventSequence = snapshot.latestEventSequence;

  const cards: RecoveryCard[] = [];

  const basePersistedSequence = `Project state ${projectState} persisted (sequence ${String(latestEventSequence)}).`;
  const eventsPersisted =
    recentEvents.length > 0
      ? `Recent event timeline persisted (${String(recentEvents.length)} event(s) shown, latest sequence ${String(latestEventSequence)}).`
      : `Event journal persisted through sequence ${String(latestEventSequence)}; replay events.replay from the last applied sequence to catch up.`;
  const gitPersisted =
    gitStatus === undefined
      ? "Workspace not yet observed for this render; open the git.status drill-down before acting on workspace state."
      : gitStatus.available === true
        ? `Workspace observed at ${gitStatus.observedAt} (HEAD ${gitStatus.headSha ?? "unknown"}, ${String(gitStatus.changedPaths.length)} changed path(s)).`
        : `Workspace observation unavailable: ${gitStatus.reason ?? "unknown reason"} (observed at ${gitStatus.observedAt}).`;

  if (connectionState !== "connected") {
    const offlineKind: RecoveryKind =
      connectionState === "connecting"
        ? "core-reconnecting"
        : connectionState === "version-mismatch"
          ? "core-version-mismatch"
          : connectionState === "auth-failed"
            ? "core-auth-failed"
            : "core-disconnected";
    const offlineTitle =
      offlineKind === "core-reconnecting"
        ? "Core reconnecting"
        : offlineKind === "core-version-mismatch"
          ? "Core protocol mismatch"
          : offlineKind === "core-auth-failed"
            ? "Core session rejected"
            : "Core disconnected";
    const offlineDetail =
      offlineKind === "core-reconnecting"
        ? `The IDE is reconnecting to Densa ADE Core. Shown facts are the last known truth at sequence ${String(latestEventSequence)}; they are stale, not lost. Live core.event notifications are hints to refresh, never direct edits.`
        : offlineKind === "core-version-mismatch"
          ? `The IDE and Core disagree on the protocol version${isNonEmptyText(input.coreDetail) === true ? ` (${(input.coreDetail as string).trim()})` : ""}. Shown facts are the last known truth at sequence ${String(latestEventSequence)}; no mutation is attempted until the versions agree. Standard editor actions remain available.`
          : offlineKind === "core-auth-failed"
            ? `Core rejected the IDE session${isNonEmptyText(input.coreDetail) === true ? ` (${(input.coreDetail as string).trim()})` : ""}. Shown facts are the last known truth at sequence ${String(latestEventSequence)}; refresh local trust before retrying. Standard editor actions remain available.`
            : `Core is not connected${isNonEmptyText(input.coreDetail) === true ? ` (${(input.coreDetail as string).trim()})` : ""}. Shown facts are the last known truth at sequence ${String(latestEventSequence)}; nothing was appended while disconnected. Standard editor actions remain available.`;
    cards.push(
      Object.freeze({
        kind: offlineKind,
        tone: "offline" as const,
        title: offlineTitle,
        detail: `${offlineDetail} This is offline, not broken: the project waits untouched until reconnect replays the journal.`,
        persisted: Object.freeze([basePersistedSequence, eventsPersisted]),
        nextActions: Object.freeze(
          offlineKind === "core-reconnecting"
            ? [
                "Wait for reconnect, then replay events.replay from the last applied sequence before acting.",
                "Re-subscribe to events.subscribe from the newest applied sequence; duplicates are ignored.",
                "Refresh projects.get and dashboard.get before any control whose preconditions may have changed.",
              ]
            : offlineKind === "core-version-mismatch"
              ? [
                  "Update Densa ADE so the IDE and Core agree on the protocol version.",
                  "Do not retry mutations until the handshake succeeds; version mismatches fail closed.",
                  "Standard editing stays available while versions disagree.",
                ]
              : offlineKind === "core-auth-failed"
                ? [
                    "Restart the IDE or run `densa-ade core start` to refresh local trust, then reconnect.",
                    "Replay events.replay from the last applied sequence after reconnect; duplicates are ignored.",
                    "Standard editing stays available while the session is rejected.",
                  ]
                : [
                    "Start Core with `densa-ade core start` and reconnect.",
                    "Replay events.replay from the last applied sequence, then re-subscribe; duplicates are ignored and gaps require a fresh replay.",
                    "Refresh projects.get and dashboard.get before any control whose preconditions may have changed.",
                  ],
        ),
        drilldowns: Object.freeze([
          drilldownProjectSnapshot(projectId),
          drilldownDashboard(projectId),
          drilldownEvents(projectId, latestEventSequence),
        ]),
        diagnosticsHint: DIAGNOSTICS_HINT,
      }),
    );
  }

  if (codexAuth.status === "required") {
    cards.push(
      Object.freeze({
        kind: "codex-auth-required" as const,
        tone: "attention" as const,
        title: "Codex authentication required",
        detail: `Worker execution needs authentication with the official Codex client/CLI${isNonEmptyText(codexAuth.detail) === true ? `: ${(codexAuth.detail as string).trim()}` : ""}. The project waits with its checkpoint intact; nothing is retried blindly. This needs your action, but the run is not broken.`,
        persisted: Object.freeze([basePersistedSequence, eventsPersisted, gitPersisted]),
        nextActions: Object.freeze([
          "Authenticate with the official Codex client/CLI; Densa ADE never scrapes browser cookies or stores ChatGPT passwords.",
          "Re-run the readiness check, then resume through projects.resume so Core revalidates workspace and project state first.",
          "Inspect usage.get for the persisted provider observation before expecting execution to proceed.",
        ]),
        drilldowns: Object.freeze([
          drilldownProjectSnapshot(projectId),
          drilldownUsage(projectId),
          drilldownEvents(projectId, latestEventSequence),
        ]),
        diagnosticsHint: DIAGNOSTICS_HINT,
      }),
    );
  }

  const interruptedTasks = snapshot.tasks.filter((task) => task.state === "INTERRUPTED");
  if (interruptedTasks.length > 0) {
    const ids = interruptedTasks.map((task) => task.id);
    const restartSuffix =
      restartObserved === true
        ? " Core observed a restart and classified the dead worker as INTERRUPTED instead of guessing an outcome."
        : " The worker stopped without a terminal outcome, so Core holds the task INTERRUPTED instead of guessing.";
    cards.push(
      Object.freeze({
        kind: "interrupted-recovered" as const,
        tone: "attention" as const,
        title:
          interruptedTasks.length === 1
            ? `Interrupted task recovered (${ids[0]})`
            : `${String(interruptedTasks.length)} interrupted tasks recovered`,
        detail: `Task ${ids.join(", ")} ${interruptedTasks.length === 1 ? "was" : "were"} interrupted and safely recovered to a durable boundary.${restartSuffix} Attempt diagnostics are preserved; the next attempt starts from a known checkpoint. This needs review, not a fresh start.`,
        persisted: Object.freeze([
          basePersistedSequence,
          `Interrupted task(s) persisted: ${ids.join(", ")}.`,
          eventsPersisted,
          gitPersisted,
        ]),
        nextActions: Object.freeze([
          "Open attempts.list for the interrupted task to read preserved attempt diagnostics.",
          "Verify the workspace checkpoint with git.status before resuming.",
          "Resume through projects.resume; Core revalidates recovery and workspace state before scheduling the next attempt.",
        ]),
        drilldowns: Object.freeze([
          drilldownAttempts(projectId, ids[0] as string),
          drilldownRunLogs(projectId, { taskId: ids[0] as string }),
          drilldownProjectSnapshot(projectId),
          drilldownEvents(projectId, latestEventSequence),
        ]),
        diagnosticsHint: DIAGNOSTICS_HINT,
      }),
    );
  }

  const gitChangedPaths = gitStatus === undefined ? [] : [...gitStatus.changedPaths];
  const gitShowsChanges =
    gitStatus !== undefined &&
    gitStatus.available === true &&
    (gitStatus.dirty === true || gitChangedPaths.length > 0);
  const divergenceStates: readonly string[] = Object.freeze([
    "PAUSED",
    "WAITING_FOR_USER",
    "WAITING_FOR_USAGE",
    "BLOCKED",
  ]);
  if (gitShowsChanges && divergenceStates.includes(projectState)) {
    cards.push(
      Object.freeze({
        kind: "workspace-divergence" as const,
        tone: "attention" as const,
        title: "Workspace changes need review",
        detail: `Densa ADE detected workspace changes while ${projectState} (${String(gitChangedPaths.length)} changed path(s)). Manual edits are preserved, never overwritten. Resume revalidates recovery and workspace state and recontextualizes the next worker; resuming without acknowledgement returns INTERVENTION_REQUIRED.`,
        persisted: Object.freeze([
          basePersistedSequence,
          gitPersisted,
          "Manual edits detected after the durable pause boundary; Core scheduled no worker over them.",
          eventsPersisted,
        ]),
        nextActions: Object.freeze([
          "Review the changed paths with the git.status drill-down.",
          "Resume with acknowledgeIntervention only after inspecting the edits; without it Core returns INTERVENTION_REQUIRED.",
          "Never expect Densa ADE to overwrite manual work to force a resume.",
        ]),
        drilldowns: Object.freeze([
          drilldownChanges(projectId, workspacePath),
          drilldownProjectSnapshot(projectId),
          drilldownEvents(projectId, latestEventSequence),
        ]),
        diagnosticsHint: DIAGNOSTICS_HINT,
      }),
    );
  }

  if (projectState === "WAITING_FOR_USAGE") {
    const autoResumeSuffix =
      autoResumeEnabled === true
        ? " Auto-resume is enabled (local opt-in): Core probes conservatively with backoff and resumes only after revalidating workspace, project state, pending decisions, and backend availability."
        : " Auto-resume is disabled: the project waits without probing aggressively. Enable it in settings only if you want Core to resume automatically when usage returns.";
    if (reset.known === true && reset.resetAt !== undefined) {
      cards.push(
        Object.freeze({
          kind: "waiting-for-usage-known-reset" as const,
          tone: "waiting" as const,
          title: "Waiting for agent usage",
          detail: `${describeUsage(effectiveUsage)} Core observed a usage reset at ${reset.resetAt}.${autoResumeSuffix} The run checkpoint and attempt diagnostics are persisted; nothing is retried blindly while waiting. Waiting is normal here, not broken.`,
          persisted: Object.freeze([
            basePersistedSequence,
            `Usage observation persisted (${describeUsage(effectiveUsage)} reset at ${reset.resetAt}).`,
            eventsPersisted,
            gitPersisted,
          ]),
          nextActions: Object.freeze([
            "Inspect usage.get for the persisted provider observation before expecting a resume.",
            "Verify the workspace checkpoint with git.status before resuming.",
            autoResumeEnabled === true
              ? "Leave auto-resume on to let Core resume after revalidation, or resume manually through projects.resume."
              : "Wait for the observed reset, or enable auto-resume in settings for an opted-in automatic resume after revalidation.",
          ]),
          drilldowns: Object.freeze([
            drilldownUsage(projectId),
            drilldownProjectSnapshot(projectId),
            drilldownEvents(projectId, latestEventSequence),
          ]),
          diagnosticsHint: DIAGNOSTICS_HINT,
          autoResumeEnabled,
          resetAt: reset.resetAt,
          resetKnown: true as const,
        }),
      );
    } else {
      cards.push(
        Object.freeze({
          kind: "waiting-for-usage-unknown" as const,
          tone: "waiting" as const,
          title: "Waiting for agent usage",
          detail: `${describeUsage(effectiveUsage)} Core has no observed usage reset time, so this surface shows no countdown.${autoResumeSuffix} The wait is preserved and availability is probed conservatively. Waiting is normal here, not broken.`,
          persisted: Object.freeze([
            basePersistedSequence,
            `Usage observation persisted (${describeUsage(effectiveUsage)} no observed reset time).`,
            eventsPersisted,
            gitPersisted,
          ]),
          nextActions: Object.freeze([
            "Inspect usage.get for the persisted provider observation; do not expect a reset time that was not observed.",
            "Verify the workspace checkpoint with git.status before resuming.",
            autoResumeEnabled === true
              ? "Leave auto-resume on for conservative backoff probing, or resume manually through projects.resume once usage.get shows available."
              : "Wait without aggressive probing, or enable auto-resume in settings for an opted-in conservative probe schedule.",
          ]),
          drilldowns: Object.freeze([
            drilldownUsage(projectId),
            drilldownProjectSnapshot(projectId),
            drilldownEvents(projectId, latestEventSequence),
          ]),
          diagnosticsHint: DIAGNOSTICS_HINT,
          autoResumeEnabled,
          resetKnown: false as const,
        }),
      );
    }
  }

  const blockedTasks = snapshot.tasks.filter((task) => task.state === "BLOCKED");
  const dashboardBlockedTasks =
    dashboard?.taskCounts.find((entry) => entry.state === "BLOCKED")?.count ?? 0;
  const dashboardBlockedPhases =
    dashboard?.phaseCounts.find((entry) => entry.state === "BLOCKED")?.count ?? 0;
  const retryCount = dashboard?.retryCount ?? 0;
  const recentFailureCount = dashboard?.recentFailureCount ?? 0;
  if (projectState === "BLOCKED" || blockedTasks.length > 0) {
    const blockedIds = blockedTasks.map((task) => task.id);
    const firstBlocked = blockedIds[0];
    const drilldowns: RecoveryDrilldown[] = [
      drilldownProjectSnapshot(projectId),
      drilldownEvents(projectId, latestEventSequence),
    ];
    if (firstBlocked !== undefined) {
      drilldowns.unshift(drilldownAttempts(projectId, firstBlocked));
      drilldowns.unshift(drilldownValidationRuns(projectId, firstBlocked));
    }
    drilldowns.push(drilldownDecisions(projectId));
    cards.push(
      Object.freeze({
        kind: "blocked-after-retries" as const,
        tone: "broken" as const,
        title: "Blocked after retries",
        detail: `Core stopped scheduling after repeated failures or a workspace conflict${blockedIds.length > 0 ? ` (blocked task(s): ${blockedIds.join(", ")})` : ""}${dashboardBlockedPhases > 0 ? ` with ${String(dashboardBlockedPhases)} blocked phase(s)` : ""}. Retries so far: ${String(retryCount)}, recent failures: ${String(recentFailureCount)}. Attempt history and diagnostics are preserved; nothing was skipped silently. This is blocked, not waiting: retries need new evidence.`,
        persisted: Object.freeze([
          basePersistedSequence,
          blockedIds.length > 0
            ? `Blocked task(s) persisted: ${blockedIds.join(", ")}.`
            : "Blocked project disposition persisted.",
          `Retry/failure counts persisted (retries ${String(retryCount)}, recent failures ${String(recentFailureCount)}).`,
          eventsPersisted,
          gitPersisted,
        ]),
        nextActions: Object.freeze([
          "Open attempts.list for the blocked task to read attempt diagnostics.",
          "Open validation.list and validation.get for the failing acceptance evidence.",
          "Steer the roadmap through the Roadmap or Master Agent revision flow; retries need new evidence or a revised strategy.",
        ]),
        drilldowns: Object.freeze(drilldowns),
        diagnosticsHint: DIAGNOSTICS_HINT,
      }),
    );
    void dashboardBlockedTasks;
  }

  const pendingApprovals = [
    ...snapshot.pendingApprovals,
    ...(dashboard === undefined ? [] : dashboard.pendingApprovals),
  ];
  const seenApprovalKeys = new Set<string>();
  const dedupedApprovals = pendingApprovals.filter((approval) => {
    const key = `${approval.kind}:${approval.summary}:${approval.requestedAt}`;
    if (seenApprovalKeys.has(key)) {
      return false;
    }
    seenApprovalKeys.add(key);
    return true;
  });
  for (const approval of dedupedApprovals) {
    if (approval.projectId !== projectId) {
      throw new Error("Recovery approval crossed the requested project boundary.");
    }
  }
  const permissionApprovals = dedupedApprovals.filter((approval) => approval.kind === "permission");
  const userApprovals = dedupedApprovals.filter((approval) => approval.kind !== "permission");
  if (permissionApprovals.length > 0) {
    const first = permissionApprovals[0];
    cards.push(
      Object.freeze({
        kind: "permission-required" as const,
        tone: "attention" as const,
        title:
          permissionApprovals.length === 1
            ? "Permission decision required"
            : `${String(permissionApprovals.length)} permission decisions required`,
        detail: `Core needs an explicit permission decision before continuing: ${first?.summary ?? "A permission decision is pending."} Nothing advances until the decision is recorded through Core. This needs your decision, not a retry.`,
        persisted: Object.freeze([
          basePersistedSequence,
          `Permission approval(s) persisted (${String(permissionApprovals.length)} pending).`,
          eventsPersisted,
        ]),
        nextActions: Object.freeze([
          "Review the pending permission, then resolve it through permissions.resolve with an explicit rationale.",
          "Inspect decisions.list for the durable permission record before approving.",
          "Permission denials stay auditable; nothing proceeds on prose alone.",
        ]),
        drilldowns: Object.freeze([
          drilldownDecisions(projectId),
          drilldownProjectSnapshot(projectId),
          drilldownEvents(projectId, latestEventSequence),
        ]),
        diagnosticsHint: DIAGNOSTICS_HINT,
      }),
    );
  }
  if (userApprovals.length > 0 || projectState === "WAITING_FOR_USER") {
    const firstSummary =
      userApprovals[0]?.summary ?? "Core needs an explicit user decision before continuing.";
    const phaseScope =
      userApprovals.find((approval) => approval.kind === "phase" || approval.kind === "task") ??
      undefined;
    const drilldowns: RecoveryDrilldown[] = [
      drilldownProjectSnapshot(projectId),
      drilldownEvents(projectId, latestEventSequence),
    ];
    if (phaseScope !== undefined && isNonEmptyText(phaseScope.phaseId)) {
      assertKnownMethod("phases.report.get");
      drilldowns.unshift(
        Object.freeze({
          kind: "phase-report" as const,
          method: "phases.report.get" as const,
          projectId,
          phaseId: phaseScope.phaseId.trim(),
        }),
      );
    }
    cards.push(
      Object.freeze({
        kind: "user-decision-required" as const,
        tone: "attention" as const,
        title:
          userApprovals.length > 1
            ? `${String(userApprovals.length)} user decisions required`
            : "User decision required",
        detail: `${firstSummary} Nothing advances until the decision is recorded through Core. This is waiting on you, not broken execution.`,
        persisted: Object.freeze([
          basePersistedSequence,
          userApprovals.length > 0
            ? `User approval(s) persisted (${String(userApprovals.length)} pending).`
            : "Waiting-for-user project disposition persisted with no additional queued approvals.",
          eventsPersisted,
        ]),
        nextActions: Object.freeze([
          "Review pending approvals, then approve or reject through the Roadmap surface (tasks.approve, phases.approve, roadmaps.revisions.resolve).",
          "Scope changes always need explicit approval, even in Continuous mode.",
          "Revalidate the snapshot before approving; stale proposals are rechecked by Core.",
        ]),
        drilldowns: Object.freeze(drilldowns),
        diagnosticsHint: DIAGNOSTICS_HINT,
      }),
    );
  }

  if (cards.length === 0) {
    cards.push(
      Object.freeze({
        kind: "steady" as const,
        tone: "ok" as const,
        title: "No recovery needed",
        detail: `The project is ${projectState} with no interrupted tasks, no workspace divergence, no usage wait, no blocked work, and no pending decisions in this render. Progress below reflects persisted facts at sequence ${String(latestEventSequence)}.`,
        persisted: Object.freeze([basePersistedSequence, eventsPersisted, gitPersisted]),
        nextActions: Object.freeze(["Open the Roadmap for the full phase plan."]),
        drilldowns: Object.freeze([
          drilldownProjectSnapshot(projectId),
          drilldownDashboard(projectId),
          drilldownEvents(projectId, latestEventSequence),
        ]),
        diagnosticsHint: DIAGNOSTICS_HINT,
      }),
    );
  }

  const frozenCards = Object.freeze([...cards]);

  const overallTone: RecoveryTone = frozenCards.some((card) => card.tone === "broken")
    ? "broken"
    : frozenCards.some((card) => card.tone === "offline")
      ? "offline"
      : frozenCards.some((card) => card.tone === "attention")
        ? "attention"
        : frozenCards.some((card) => card.tone === "waiting")
          ? "waiting"
          : "ok";

  const summary: RecoverySummary =
    overallTone === "broken"
      ? Object.freeze({
          tone: overallTone,
          title: "Needs intervention",
          detail:
            "At least one card is blocked. This is blocked, not waiting: inspect attempt and validation evidence, then steer with new evidence. Waiting will not resolve it.",
        })
      : overallTone === "offline"
        ? Object.freeze({
            tone: overallTone,
            title: "Core unreachable",
            detail:
              "Core is unreachable, so shown facts are the last known truth, not fresh truth. This is offline, not broken: reconnect and replay the journal before acting; nothing was lost.",
          })
        : overallTone === "attention"
          ? Object.freeze({
              tone: overallTone,
              title: "Needs review",
              detail:
                "At least one card needs your review (interruption, divergence, authentication, or a pending decision). This is recoverable and attention-gated, not broken execution.",
            })
          : overallTone === "waiting"
            ? Object.freeze({
                tone: overallTone,
                title: "Waiting, not broken",
                detail:
                  "The project is waiting for agent usage with its checkpoint intact. Waiting, not broken: availability is probed conservatively and no countdown is shown unless Core observed a reset time.",
              })
            : Object.freeze({
                tone: overallTone,
                title: "Steady",
                detail: "No recovery is needed. Shown facts reflect persisted Core truth.",
              });

  const connectionEnabled = connectionState === "connected";
  const reason =
    connectionEnabled === true ? undefined : blockedReason(connectionState, input.coreDetail);

  return Object.freeze({
    version: RECOVERY_VERSION,
    projectId,
    projectName: snapshot.summary.project.name,
    projectState,
    executionMode: snapshot.summary.project.executionMode,
    workspacePath,
    latestEventSequence,
    connectionState,
    autoResumeEnabled,
    usageResetKnown: reset.known,
    ...(reset.resetAt === undefined ? {} : { usageResetAt: reset.resetAt }),
    cards: frozenCards,
    summary,
    capabilityMethods: RECOVERY_CAPABILITY_METHODS,
    optimisticComplete: false as const,
    enabled: connectionEnabled,
    ...(reason === undefined ? {} : { reason }),
  });
}

export interface RecoveryResumeResolution {
  readonly method: "projects.resume";
  readonly projectId: string;
  readonly workspacePath: string;
  readonly actor: string;
  readonly acknowledgeIntervention?: boolean;
}

function requireActor(actor: unknown): string {
  if (isNonEmptyText(actor) !== true) {
    throw new Error("Recovery control requires an actor.");
  }
  return (actor as string).trim();
}

function requireAddressing(model: RecoveryModel): {
  readonly projectId: string;
  readonly workspacePath: string;
} {
  if (isNonEmptyText(model.projectId) !== true || isNonEmptyText(model.workspacePath) !== true) {
    throw new Error(
      "Recovery control requires the persisted projectId and workspacePath from Core.",
    );
  }
  return { projectId: model.projectId, workspacePath: model.workspacePath };
}

/**
 * Resolve a manual resume to `projects.resume` through Core. Every resume
 * revalidates recovery and workspace state first. When the model shows
 * workspace divergence, pass `acknowledgeIntervention: true` after reviewing
 * the changed paths; without it Core returns `INTERVENTION_REQUIRED` and
 * schedules no worker.
 */
export function resolveRecoveryResume(
  model: RecoveryModel,
  input: { readonly actor: string; readonly acknowledgeIntervention?: boolean },
): RecoveryResumeResolution {
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

export interface RecoveryPermissionResolution {
  readonly method: "permissions.resolve";
  readonly projectId: string;
  readonly decisionId: string;
  readonly resolution: "approve" | "reject";
  readonly actor: string;
  readonly reason: string;
}

/**
 * Resolve a permission card action to `permissions.resolve` through Core.
 * The caller carries the persisted `decisionId` from the pending approval;
 * the IDE never fabricates it. Actor and reason keep the decision auditable.
 */
export function resolveRecoveryPermissionResolve(
  model: RecoveryModel,
  input: {
    readonly decisionId: string;
    readonly resolution: "approve" | "reject";
    readonly actor: string;
    readonly reason: string;
  },
): RecoveryPermissionResolution {
  const addressing = requireAddressing(model);
  const actor = requireActor(input.actor);
  if (isNonEmptyText(input.decisionId) !== true) {
    throw new Error("Recovery permission resolution requires a persisted decisionId.");
  }
  if (input.resolution !== "approve" && input.resolution !== "reject") {
    throw new Error("Recovery permission resolution must be approve or reject.");
  }
  if (isNonEmptyText(input.reason) !== true) {
    throw new Error("Recovery permission resolution requires a non-empty reason for audit.");
  }
  assertKnownMethod("permissions.resolve");
  return Object.freeze({
    method: "permissions.resolve" as const,
    projectId: addressing.projectId,
    decisionId: (input.decisionId as string).trim(),
    resolution: input.resolution,
    actor,
    reason: (input.reason as string).trim(),
  });
}

export interface RecoveryTaskApprovalResolution {
  readonly method: "tasks.approve";
  readonly projectId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly decision: "approve" | "reject";
  readonly actor: string;
  readonly reason: string;
}

/**
 * Resolve a user-decision card action to `tasks.approve` through Core.
 * IDs come from the persisted pending approval; the IDE never invents them.
 */
export function resolveRecoveryTaskApproval(
  model: RecoveryModel,
  input: {
    readonly phaseId: string;
    readonly taskId: string;
    readonly decision: "approve" | "reject";
    readonly actor: string;
    readonly reason: string;
  },
): RecoveryTaskApprovalResolution {
  const addressing = requireAddressing(model);
  const actor = requireActor(input.actor);
  if (isNonEmptyText(input.phaseId) !== true || isNonEmptyText(input.taskId) !== true) {
    throw new Error("Recovery task approval requires persisted phaseId and taskId.");
  }
  if (input.decision !== "approve" && input.decision !== "reject") {
    throw new Error("Recovery task approval decision must be approve or reject.");
  }
  if (isNonEmptyText(input.reason) !== true) {
    throw new Error("Recovery task approval requires a non-empty reason for audit.");
  }
  assertKnownMethod("tasks.approve");
  return Object.freeze({
    method: "tasks.approve" as const,
    projectId: addressing.projectId,
    phaseId: (input.phaseId as string).trim(),
    taskId: (input.taskId as string).trim(),
    decision: input.decision,
    actor,
    reason: (input.reason as string).trim(),
  });
}

export interface RecoveryPhaseApprovalResolution {
  readonly method: "phases.approve";
  readonly projectId: string;
  readonly phaseId: string;
  readonly decision: "approve" | "reject";
  readonly actor: string;
  readonly reason: string;
}

/**
 * Resolve a user-decision card action to `phases.approve` through Core.
 * Only the Core outcome advances the phase; stale proposals are rechecked.
 */
export function resolveRecoveryPhaseApproval(
  model: RecoveryModel,
  input: {
    readonly phaseId: string;
    readonly decision: "approve" | "reject";
    readonly actor: string;
    readonly reason: string;
  },
): RecoveryPhaseApprovalResolution {
  const addressing = requireAddressing(model);
  const actor = requireActor(input.actor);
  if (isNonEmptyText(input.phaseId) !== true) {
    throw new Error("Recovery phase approval requires a persisted phaseId.");
  }
  if (input.decision !== "approve" && input.decision !== "reject") {
    throw new Error("Recovery phase approval decision must be approve or reject.");
  }
  if (isNonEmptyText(input.reason) !== true) {
    throw new Error("Recovery phase approval requires a non-empty reason for audit.");
  }
  assertKnownMethod("phases.approve");
  return Object.freeze({
    method: "phases.approve" as const,
    projectId: addressing.projectId,
    phaseId: (input.phaseId as string).trim(),
    decision: input.decision,
    actor,
    reason: (input.reason as string).trim(),
  });
}

export interface RecoveryReconnectRecipe {
  readonly action: "reconnect-and-replay";
  readonly reason: string;
}

/**
 * Reconnect recipe for the recovery surface (IDE transport, not a Core v1
 * mutation): reconnect, replay `events.replay` from the last applied
 * sequence, re-subscribe, then refresh before any control. No new fact is
 * appended by reconnecting, so repeating it never duplicates actions.
 */
export function resolveRecoveryReconnect(): RecoveryReconnectRecipe {
  return Object.freeze({
    action: "reconnect-and-replay" as const,
    reason:
      "Reconnect the IDE transport, replay events.replay from the last applied sequence (repeating while hasMore is true), re-subscribe from the newest applied sequence, then refresh projects.get and dashboard.get before acting. Duplicates are ignored; gaps require a fresh replay.",
  });
}

export interface RecoveryAutoResumeIntent {
  readonly storage: "local-only";
  readonly enabled: boolean;
  readonly reason: string;
}

/**
 * Describe the local-only auto-resume intent behind waiting cards. Core v1
 * exposes no frozen `settings.update` field for this toggle, so enabling it
 * records local intent and never fabricates a Core setting or reset time.
 */
export function resolveRecoveryAutoResumeIntent(enabled: boolean): RecoveryAutoResumeIntent {
  if (typeof enabled !== "boolean") {
    throw new Error("Recovery auto-resume intent must be a boolean.");
  }
  return Object.freeze({
    storage: "local-only" as const,
    enabled,
    reason:
      enabled === true
        ? "Auto-resume intent recorded locally: Core probes conservatively with backoff and resumes only after revalidating workspace, project state, pending decisions, and backend availability."
        : "Auto-resume stays disabled locally: the project waits without aggressive probing until usage.get shows available or the user resumes explicitly.",
  });
}

export interface RecoveryControlEffect {
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
 * refreshes `refreshMethods` and rebuilds via `buildRecoveryModel()`.
 * `UNCHANGED` outcomes are idempotent no-ops; `INTERVENTION_REQUIRED`
 * surfaces Core's changed paths for the divergence card.
 */
export function applyRecoveryControlOutcome(
  model: RecoveryModel,
  outcome: RecoveryControlOutcome,
): RecoveryControlEffect {
  if (outcome.projectId !== model.projectId) {
    throw new Error("Recovery control outcome crossed the requested project boundary.");
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
        refreshMethods: RECOVERY_OPEN_REFRESH_METHODS,
        idempotent: false,
        changedPaths,
      });
    case "INTERVENTION_REQUIRED":
      return Object.freeze({
        status: outcome.status,
        notice:
          `Core detected workspace changes and scheduled no worker.${reasonSuffix} ` +
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

/**
 * Resolve a recovery metric to the existing Core v1 operation backing its
 * drill-down. The IDE carries persisted IDs through to Core and never
 * fabricates detail locally. Full transcripts stay behind `logs.list`;
 * arbitrary unscoped log fetches throw.
 */
export function resolveRecoveryDrilldown(
  model: RecoveryModel,
  selection:
    | { readonly kind: "project-snapshot" }
    | { readonly kind: "dashboard-refresh" }
    | { readonly kind: "events"; readonly afterSequence?: number }
    | { readonly kind: "usage" }
    | { readonly kind: "changes" }
    | { readonly kind: "git-commit"; readonly sha: string }
    | { readonly kind: "attempts"; readonly taskId: string }
    | { readonly kind: "validation-runs"; readonly taskId: string }
    | { readonly kind: "validation-detail"; readonly validationRunId: string }
    | {
        readonly kind: "run-logs";
        readonly phaseId?: string;
        readonly taskId?: string;
        readonly attemptId?: string;
      }
    | { readonly kind: "phase-report"; readonly phaseId: string }
    | { readonly kind: "decisions" },
): RecoveryDrilldown {
  switch (selection.kind) {
    case "project-snapshot": {
      return drilldownProjectSnapshot(model.projectId);
    }
    case "dashboard-refresh": {
      return drilldownDashboard(model.projectId);
    }
    case "events": {
      const afterSequence =
        selection.afterSequence === undefined ? model.latestEventSequence : selection.afterSequence;
      return drilldownEvents(model.projectId, afterSequence);
    }
    case "usage": {
      return drilldownUsage(model.projectId);
    }
    case "changes": {
      return drilldownChanges(model.projectId, model.workspacePath);
    }
    case "git-commit": {
      if (isNonEmptyText(selection.sha) !== true) {
        throw new Error("Recovery commit drill-down requires a persisted commit SHA.");
      }
      assertKnownMethod("git.commit.get");
      return Object.freeze({
        kind: "git-commit" as const,
        method: "git.commit.get" as const,
        projectId: model.projectId,
        sha: (selection.sha as string).trim(),
      });
    }
    case "attempts": {
      return drilldownAttempts(model.projectId, selection.taskId);
    }
    case "validation-runs": {
      return drilldownValidationRuns(model.projectId, selection.taskId);
    }
    case "validation-detail": {
      if (isNonEmptyText(selection.validationRunId) !== true) {
        throw new Error("Recovery validation drill-down requires a persisted validationRunId.");
      }
      assertKnownMethod("validation.get");
      return Object.freeze({
        kind: "validation-detail" as const,
        method: "validation.get" as const,
        projectId: model.projectId,
        validationRunId: (selection.validationRunId as string).trim(),
      });
    }
    case "run-logs": {
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
      if (phaseId === undefined && taskId === undefined && attemptId === undefined) {
        throw new Error(
          "Recovery run-log drill-down requires a persisted phase, task, or attempt scope; the surface never fetches unscoped run logs.",
        );
      }
      return drilldownRunLogs(model.projectId, {
        ...(phaseId === undefined ? {} : { phaseId }),
        ...(taskId === undefined ? {} : { taskId }),
        ...(attemptId === undefined ? {} : { attemptId }),
      });
    }
    case "phase-report": {
      if (isNonEmptyText(selection.phaseId) !== true) {
        throw new Error("Recovery phase-report drill-down requires a persisted phaseId.");
      }
      assertKnownMethod("phases.report.get");
      return Object.freeze({
        kind: "phase-report" as const,
        method: "phases.report.get" as const,
        projectId: model.projectId,
        phaseId: (selection.phaseId as string).trim(),
      });
    }
    case "decisions": {
      return drilldownDecisions(model.projectId);
    }
  }
}

export interface RecoveryReopenRefresh {
  readonly action: "refresh-before-render";
  readonly refreshMethods: readonly CoreV1Method[];
  readonly projectId: string;
  readonly reason: string;
}

/**
 * Reconnect/reopen recipe for the recovery surface: refresh `projects.get`
 * and `dashboard.get`, replay `events.replay` from the last applied sequence
 * (then re-subscribe for live hints), re-read `usage.get` and `git.status`
 * where the cards need them, and rebuild via `buildRecoveryModel()`. Live
 * `core.event` notifications are hints to refresh, never direct edits, so
 * reconnecting never duplicates actions.
 */
export function resolveRecoveryReopenRefresh(projectId: string): RecoveryReopenRefresh {
  if (isNonEmptyText(projectId) !== true) {
    throw new Error(
      "Recovery reopen requires a persisted projectId from Core (projects.list); the IDE does not invent one.",
    );
  }
  return Object.freeze({
    action: "refresh-before-render",
    refreshMethods: RECOVERY_OPEN_REFRESH_METHODS,
    projectId: projectId.trim(),
    reason:
      "Refresh projects.get and dashboard.get, replay events.replay from the last applied sequence, re-read usage.get and git.status where the cards need them, then rebuild the recovery model. Live core.event notifications are hints to refresh, never direct edits.",
  });
}

/**
 * True when a persisted notification is only a refresh hint for the
 * recovery surface. `core.event` notifications re-read Core truth;
 * `run.log.appended` refreshes the `logs.list` cursor behind run-log
 * drill-downs. Neither notification edits recovery state directly: only
 * refreshed snapshots and Core control outcomes change the model.
 */
export function recoveryEventIsRefreshHint(eventType: string): boolean {
  if (typeof eventType !== "string") {
    return false;
  }
  return eventType.trim().length > 0;
}
