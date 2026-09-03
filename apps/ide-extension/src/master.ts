// Copyright 2026 Densa Labs
// SPDX-License-Identifier: Apache-2.0

/**
 * Densa ADE Master Agent UI view model (Phase 11 Milestone 2).
 *
 * The Master Agent surface answers: "What should happen next, and why?" It
 * renders as the full `densa-ade.master` editor-area tab beside source tabs
 * (contributed in Phase 10 Milestone 3), never cramped into a narrow chat
 * sidebar. This milestone adds its content model; no visual polish beyond
 * the model by design.
 *
 * This module is pure and protocol-only:
 *
 * - it imports `@densa-ade/protocol` types only, never `@densa-ade/core`,
 *   `@densa-ade/cli`, SQLite, or `vscode` / `vs/workbench`;
 * - every fact comes from versioned Core v1 operations (`projects.get` for
 *   the persisted project/addressing snapshot plus `master.send` turns whose
 *   `proposal`/`commandStatus`/`commandDetails` are Core-owned). The IDE never
 *   invents project, phase, task, decision, revision, reset, token, cost, or
 *   Git state;
 * - the UI never marks work complete optimistically and never applies scope
 *   changes solely from assistant prose. Resolvers below return Core request
 *   payloads to send; only Core outcomes and `core.event` notifications
 *   change the model (`MASTER_LIFECYCLE.optimisticComplete` is `false`);
 * - explanations (`respond`) are rendered distinctly from proposed state
 *   changes (`propose_roadmap_change`, `propose_project_constraint_change`,
 *   `resolve_roadmap_revision`, `request_pause`/`request_resume`/
 *   `request_mode_change`). Proposed roadmap/constraint changes surface
 *   their rationale, affected phase/task/decision links, and required
 *   approval before anything is considered applied;
 * - worker logs are never dumped into Master chat by default.
 *   `MASTER_OPEN_REFRESH_METHODS` excludes `logs.list`,
 *   `MASTER_LIFECYCLE.workerLogsIncludedByDefault` is `false`, and
 *   `run.log.appended` notifications are ignored (see
 *   `masterEventIsRefreshHint()`). Worker detail requires an explicit
 *   opt-in drill-down with persisted task/attempt IDs;
 * - closing the Master tab disposes the local transcript handle only.
 *   Durable decisions (roadmap revisions, constraints, mode/pause state)
 *   live in Core (`decisions.list`, `roadmaps.revisions.list`,
 *   `events.replay`, `projects.get`) and survive the close. Reopening
 *   refreshes those sources before the next send (see
 *   `resolveMasterReopenRefresh()`).
 *
 * Standard VS Code contribution mechanisms only (AGENTS.md §1.3): the surface
 * itself is the `densa-ade.master` editor-area tab contributed in M3. This
 * milestone adds its content model, not new workbench patches.
 */

import {
  CORE_V1_METHODS,
  type CoreV1Method,
  type CoreV1ProjectSnapshot,
  type ExecutionMode,
  type MasterAgentAction,
  type MasterAgentCitation,
  type MasterAgentIntent,
  type MasterAgentProposal,
} from "@densa-ade/protocol";

/** Command that opens the Master Agent editor-area tab (contributed in M3). */
export const MASTER_COMMAND = "densa-ade.showMasterAgent" as const;

/** Editor-area tab viewType hosting Master Agent content beside source tabs. */
export const MASTER_EDITOR_VIEW_TYPE = "densa-ade.master" as const;

/** Canonical Master intents from the protocol contract. Rendered verbatim. */
export const MASTER_INTENTS: readonly MasterAgentIntent[] = Object.freeze([
  "explain_project_status",
  "explain_decision",
  "explain_current_phase",
  "propose_roadmap_change",
  "resolve_roadmap_revision",
  "propose_project_constraint_change",
  "request_project_control",
  "summarize_failures",
]);

/** Canonical Master action kinds from the protocol contract. */
export const MASTER_ACTION_KINDS: readonly MasterAgentAction["kind"][] = Object.freeze([
  "respond",
  "propose_roadmap_change",
  "resolve_roadmap_revision",
  "propose_project_constraint_change",
  "request_pause",
  "request_resume",
  "request_mode_change",
]);

/**
 * Snapshot reads backing first render, in reconnect refresh order.
 * Opening Master Agent never auto-sends: `master.send` is absent here by
 * design. The `projects.get` snapshot supplies the persisted
 * `projectId`/`workspacePath`/state/mode used to address later sends.
 */
export const MASTER_OPEN_REFRESH_METHODS: readonly CoreV1Method[] = Object.freeze(["projects.get"]);

/** Frozen-catalog Core operations the Master Agent surface may use once open. */
export const MASTER_CAPABILITY_METHODS: readonly CoreV1Method[] = Object.freeze([
  "master.send",
  "projects.get",
  "roadmaps.get",
  "roadmaps.revisions.list",
  "roadmaps.revisions.propose",
  "roadmaps.revisions.resolve",
  "decisions.list",
  "projects.pause",
  "projects.resume",
  "settings.update",
  "events.replay",
  "events.subscribe",
  "phases.report.get",
  "attempts.list",
  "validation.list",
  "validation.get",
  "logs.list",
]);

/**
 * Reconnect/reopen refresh set. The local transcript is ephemeral; durable
 * decisions survive in these Core sources and are re-read before the next
 * send.
 */
export const MASTER_REOPEN_REFRESH_METHODS: readonly CoreV1Method[] = Object.freeze([
  "projects.get",
  "events.replay",
  "decisions.list",
  "roadmaps.revisions.list",
]);

/**
 * Disposable-view lifecycle contract. The Master tab hosts a conversation;
 * closing it disposes the local transcript handle only, and content never
 * completes work or applies scope from prose without a Core outcome.
 */
export const MASTER_LIFECYCLE = Object.freeze({
  /** Closing disposes the local editor tab + transcript handle only. */
  closeDisposes: "view-handle-only",
  /** Core keeps running while project policy allows it. */
  coreContinuesAfterClose: true,
  /** Reopening replays from the last applied sequence, then refreshes. */
  reopenRefreshesSnapshot: true,
  /** The UI never marks phases/tasks complete or applies scope optimistically. */
  optimisticComplete: false,
  /** Worker logs are never included in Master chat unless explicitly requested. */
  workerLogsIncludedByDefault: false,
});

/** Guided example prompts the Master surface supports, with expected intent. */
export interface MasterExamplePrompt {
  readonly example: string;
  readonly intent: MasterAgentIntent;
  readonly note: string;
}

export const MASTER_EXAMPLE_PROMPTS: readonly MasterExamplePrompt[] = Object.freeze([
  Object.freeze({
    example: "Why did you change the roadmap?",
    intent: "explain_decision",
    note: "Explanation with cited roadmap revision/decision IDs; no state change.",
  }),
  Object.freeze({
    example: "Don't use Firebase anywhere.",
    intent: "propose_project_constraint_change",
    note: "Durable project constraint proposal; shown before it is considered applied.",
  }),
  Object.freeze({
    example: "Add mobile support before QA.",
    intent: "propose_roadmap_change",
    note: "Structured roadmap operations; significant/scope changes require explicit approval.",
  }),
  Object.freeze({
    example: "Pause after authentication.",
    intent: "request_project_control",
    note: "Control request; only a Core pause outcome changes lifecycle state.",
  }),
  Object.freeze({
    example: "What is blocking us?",
    intent: "summarize_failures",
    note: "Core-rendered failure summary with drill-down IDs; never worker prose alone.",
  }),
  Object.freeze({
    example: "Switch to Continuous after this phase.",
    intent: "request_project_control",
    note: "Mode-change request; only a Core settings outcome changes the mode.",
  }),
]);

export type MasterConnectionState =
  "disconnected" | "connecting" | "connected" | "version-mismatch" | "auth-failed";

/** Presentation classification derived from the structured action kind. */
export type MasterTurnKind =
  | "explanation"
  | "roadmap_proposal"
  | "constraint_proposal"
  | "revision_resolution"
  | "control_request";

export interface MasterTurnInput {
  /** Client-local turn id. Non-empty; carried through for rendering only. */
  readonly id: string;
  /** Verbatim user message sent (or to be sent) via `master.send`. */
  readonly userMessage: string;
  /** Core-owned structured proposal returned for this turn. */
  readonly proposal: MasterAgentProposal;
  /** Verbatim Core command outcome when `master.send` returned one. */
  readonly commandStatus?: string;
  /** Opaque Core command detail when `master.send` returned one. */
  readonly commandDetails?: Readonly<Record<string, unknown>>;
}

export interface MasterTurnView {
  readonly id: string;
  readonly userMessage: string;
  /** Authoritative intent returned by Core, rendered verbatim. */
  readonly intent: MasterAgentIntent;
  /** Core-rendered response text. Never edited locally. */
  readonly response: string;
  /** Verbatim citations returned by Core, rendered as drill-down links. */
  readonly citations: readonly MasterAgentCitation[];
  /** Authoritative action kind returned by Core. */
  readonly actionKind: MasterAgentAction["kind"];
  /** Explanation vs proposed state change. Drives distinct rendering. */
  readonly kind: MasterTurnKind;
  /** True for explanations; false when the turn proposes a state change. */
  readonly isExplanation: boolean;
  /**
   * True when the UI must show an approval/review step before treating the
   * turn as applied. Scope changes are never considered applied from prose
   * alone; only a Core `APPLIED`/`CHANGED`/`RESUMED` outcome clears this.
   */
  readonly requiresApproval: boolean;
  /**
   * Core method backing the approval/review step when one exists. Undefined
   * when the next step is a fresh `master.send` message rather than a direct
   * approve call.
   */
  readonly approvalMethod?: CoreV1Method;
  readonly affectedPhaseIds: readonly string[];
  readonly affectedTaskIds: readonly string[];
  readonly affectedDecisionIds: readonly string[];
  readonly affectedEventIds: readonly string[];
  /** Pending proposal event to resolve, when Core disclosed one. */
  readonly proposalEventId?: string;
  /** Verbatim Core command outcome, when Core returned one. */
  readonly commandStatus?: string;
  /** True only when `commandStatus` is exactly `STALE`. */
  readonly stale: boolean;
  /** False when `master.send` returned prose without a command outcome. */
  readonly outcomeKnown: boolean;
}

export interface MasterModelInput {
  /** Authoritative `projects.get` snapshot for addressing sends. */
  readonly snapshot: CoreV1ProjectSnapshot;
  /** Local transcript turns in display order. Empty when just opened. */
  readonly turns?: readonly MasterTurnInput[];
  /** Client-local conversation session carried into `master.send`. */
  readonly sessionId?: string;
  readonly connectionState?: MasterConnectionState;
  readonly coreDetail?: string;
}

export interface MasterModel {
  readonly projectId: string;
  readonly workspacePath: string;
  readonly sessionId: string;
  readonly projectState: string;
  readonly executionMode: string;
  readonly turns: readonly MasterTurnView[];
  /** Persisted runtime phase ids from the addressing snapshot, for stale-link checks. */
  readonly phaseIds: readonly string[];
  /** Persisted runtime task ids from the addressing snapshot, for stale-link checks. */
  readonly taskIds: readonly string[];
  readonly latestEventSequence: number;
  readonly capabilityMethods: readonly CoreV1Method[];
  readonly optimisticComplete: false;
  readonly workerLogsIncludedByDefault: false;
  readonly enabled: boolean;
  readonly reason?: string;
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function assertKnownMethod(method: string): asserts method is CoreV1Method {
  if ((CORE_V1_METHODS as readonly string[]).includes(method) !== true) {
    throw new Error(`Master Agent surface maps to unknown Core method ${method}.`);
  }
}

function blockedReason(connectionState: MasterConnectionState, coreDetail?: string): string {
  const suffix = isNonEmptyText(coreDetail) === true ? ` (${coreDetail.trim()})` : "";
  switch (connectionState) {
    case "connected":
      return "";
    case "connecting":
      return `Densa ADE Core is connecting. Wait for the connection before using the Master Agent${suffix}.`;
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

function isValidIntent(value: unknown): value is MasterAgentIntent {
  return typeof value === "string" && (MASTER_INTENTS as readonly string[]).includes(value);
}

function isValidActionKind(value: unknown): value is MasterAgentAction["kind"] {
  return typeof value === "string" && (MASTER_ACTION_KINDS as readonly string[]).includes(value);
}

function isValidCitationKind(value: unknown): value is MasterAgentCitation["kind"] {
  return (
    typeof value === "string" &&
    [
      "project",
      "phase",
      "task",
      "decision",
      "event",
      "roadmap_revision",
      "roadmap_revision_proposal",
    ].includes(value)
  );
}

function validateProposalShape(proposal: MasterAgentProposal): void {
  if (typeof proposal !== "object" || proposal === null) {
    throw new Error("Master turn proposal must be an object from Core; refresh before rendering.");
  }
  const candidate = proposal as Record<string, unknown>;
  if (candidate["formatVersion"] !== 1) {
    throw new Error(
      "Master turn proposal has an unsupported formatVersion; refresh before rendering.",
    );
  }
  if (isValidIntent(candidate["intent"]) !== true) {
    throw new Error("Master turn proposal carries an unknown intent; refresh before rendering.");
  }
  if (isNonEmptyText(candidate["response"]) !== true) {
    throw new Error("Master turn proposal is missing Core-rendered response text.");
  }
  if (Array.isArray(candidate["citations"]) !== true) {
    throw new Error("Master turn proposal is missing citations.");
  }
  const citations = candidate["citations"] as unknown[];
  if (citations.length > 32) {
    throw new Error("Master turn proposal carries too many citations; refresh before rendering.");
  }
  for (const citation of citations) {
    if (typeof citation !== "object" || citation === null) {
      throw new Error("Master turn citation must be an object from Core.");
    }
    const entry = citation as Record<string, unknown>;
    if (isValidCitationKind(entry["kind"]) !== true) {
      throw new Error("Master turn citation carries an unknown kind; refresh before rendering.");
    }
    if (isNonEmptyText(entry["id"]) !== true) {
      throw new Error("Master turn citation is missing its persisted id.");
    }
  }
  const action = candidate["action"] as Record<string, unknown> | undefined;
  if (typeof action !== "object" || action === null) {
    throw new Error("Master turn proposal is missing its structured action.");
  }
  if (isValidActionKind(action["kind"]) !== true) {
    throw new Error("Master turn proposal carries an unknown action kind.");
  }
}

/** Classify a structured action for distinct explanation vs proposal rendering. */
export function classifyMasterAction(action: MasterAgentAction["kind"]): MasterTurnKind {
  switch (action) {
    case "respond":
      return "explanation";
    case "propose_roadmap_change":
      return "roadmap_proposal";
    case "propose_project_constraint_change":
      return "constraint_proposal";
    case "resolve_roadmap_revision":
      return "revision_resolution";
    case "request_pause":
    case "request_resume":
    case "request_mode_change":
      return "control_request";
  }
}

function stringArrayOf(value: unknown): readonly string[] {
  if (Array.isArray(value) !== true) {
    return Object.freeze([]);
  }
  const output: string[] = [];
  for (const entry of value as unknown[]) {
    if (isNonEmptyText(entry) === true) {
      output.push((entry as string).trim());
    }
  }
  return Object.freeze(output);
}

function commandStringArray(
  details: Readonly<Record<string, unknown>> | undefined,
  key: string,
): readonly string[] {
  if (details === undefined) {
    return Object.freeze([]);
  }
  return stringArrayOf(details[key]);
}

function commandString(
  details: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  if (details === undefined) {
    return undefined;
  }
  const value = details[key];
  return isNonEmptyText(value) === true ? (value as string).trim() : undefined;
}

function actionProposalEventId(proposal: MasterAgentProposal): string | undefined {
  if (proposal.action.kind === "resolve_roadmap_revision") {
    return proposal.action.proposalEventId.trim();
  }
  return undefined;
}

function approvalForTurn(input: {
  readonly kind: MasterTurnKind;
  readonly commandStatus: string | undefined;
  readonly outcomeKnown: boolean;
}): { readonly requiresApproval: boolean; readonly approvalMethod?: CoreV1Method } {
  const status = input.commandStatus;
  if (input.kind === "explanation") {
    return { requiresApproval: false };
  }
  if (status === "STALE") {
    return { requiresApproval: false };
  }
  if (status === "AWAITING_USER_APPROVAL") {
    assertKnownMethod("roadmaps.revisions.resolve");
    return { requiresApproval: true, approvalMethod: "roadmaps.revisions.resolve" };
  }
  if (status === "WAITING_FOR_SAFE_BOUNDARY") {
    assertKnownMethod("projects.get");
    return { requiresApproval: true, approvalMethod: "projects.get" };
  }
  if (status === "BLOCKED") {
    if (input.kind === "constraint_proposal") {
      assertKnownMethod("decisions.list");
      return { requiresApproval: true, approvalMethod: "decisions.list" };
    }
    assertKnownMethod("projects.get");
    return { requiresApproval: true, approvalMethod: "projects.get" };
  }
  if (status === "NOT_FOUND") {
    assertKnownMethod("projects.get");
    return { requiresApproval: true, approvalMethod: "projects.get" };
  }
  if (
    status === "APPLIED" ||
    status === "CHANGED" ||
    status === "RESUMED" ||
    status === "REQUESTED" ||
    status === "UNCHANGED" ||
    status === "REJECTED" ||
    status === "STOPPED" ||
    status === "PROPOSED"
  ) {
    return { requiresApproval: false };
  }
  if (input.outcomeKnown !== true) {
    if (input.kind === "roadmap_proposal" || input.kind === "revision_resolution") {
      assertKnownMethod("roadmaps.revisions.list");
      return { requiresApproval: true, approvalMethod: "roadmaps.revisions.list" };
    }
    if (input.kind === "constraint_proposal") {
      assertKnownMethod("decisions.list");
      return { requiresApproval: true, approvalMethod: "decisions.list" };
    }
    assertKnownMethod("projects.get");
    return { requiresApproval: true, approvalMethod: "projects.get" };
  }
  return { requiresApproval: false };
}

function buildTurnView(
  turn: MasterTurnInput,
  snapshot: CoreV1ProjectSnapshot,
  projectId: string,
): MasterTurnView {
  if (isNonEmptyText(turn.id) !== true) {
    throw new Error("Master turn requires a non-empty local id.");
  }
  if (isNonEmptyText(turn.userMessage) !== true) {
    throw new Error("Master turn requires a non-empty user message.");
  }
  if (Buffer.byteLength(turn.userMessage) > 64 * 1_024) {
    throw new Error("Master turn message exceeds the 64 KiB Core limit.");
  }
  validateProposalShape(turn.proposal);
  const proposal = turn.proposal;
  const actionKind = proposal.action.kind;
  const kind = classifyMasterAction(actionKind);
  const isExplanation = kind === "explanation";
  const commandStatus = turn.commandStatus === undefined ? undefined : turn.commandStatus.trim();
  if (commandStatus !== undefined && commandStatus.length === 0) {
    throw new Error("Master turn commandStatus must be non-empty when present.");
  }
  const outcomeKnown = commandStatus !== undefined;
  const stale = commandStatus === "STALE";
  const approval = approvalForTurn({ kind, commandStatus, outcomeKnown });

  const phaseIds = new Set(snapshot.phases.map((phase) => String(phase.id)));
  const taskIds = new Set(snapshot.tasks.map((task) => String(task.id)));
  for (const citation of proposal.citations) {
    if (citation.kind === "project" && citation.id !== projectId) {
      throw new Error(
        "Master citation crossed the requested project boundary; refresh projects.get before rendering.",
      );
    }
    if (citation.kind === "phase" && phaseIds.has(citation.id) !== true) {
      throw new Error(
        `Master cited unknown phase ${citation.id}; refresh projects.get and roadmaps.get before rendering.`,
      );
    }
    if (citation.kind === "task" && taskIds.has(citation.id) !== true) {
      throw new Error(
        `Master cited unknown task ${citation.id}; refresh projects.get and roadmaps.get before rendering.`,
      );
    }
  }

  const details = turn.commandDetails;
  if (
    details !== undefined &&
    (typeof details !== "object" || details === null || Array.isArray(details))
  ) {
    throw new Error("Master turn commandDetails must be an object when present.");
  }

  const citationPhaseIds = proposal.citations
    .filter((citation) => citation.kind === "phase")
    .map((citation) => citation.id);
  const citationTaskIds = proposal.citations
    .filter((citation) => citation.kind === "task")
    .map((citation) => citation.id);
  const citationDecisionIds = proposal.citations
    .filter((citation) => citation.kind === "decision")
    .map((citation) => citation.id);
  const citationEventIds = proposal.citations
    .filter(
      (citation) =>
        citation.kind === "event" ||
        citation.kind === "roadmap_revision" ||
        citation.kind === "roadmap_revision_proposal",
    )
    .map((citation) => citation.id);

  const detailPhaseIds = commandStringArray(details, "affectedPhaseIds");
  const detailTaskIds = commandStringArray(details, "affectedTaskIds");
  const detailDecisionIds = Object.freeze([
    ...commandStringArray(details, "conflictDecisionIds"),
    ...commandStringArray(details, "affectedDecisionIds"),
  ]);
  const affectedPhaseIds = Object.freeze([...new Set([...citationPhaseIds, ...detailPhaseIds])]);
  const affectedTaskIds = Object.freeze([...new Set([...citationTaskIds, ...detailTaskIds])]);
  const affectedDecisionIds = Object.freeze([
    ...new Set([...citationDecisionIds, ...detailDecisionIds]),
  ]);
  const affectedEventIds = Object.freeze([...new Set(citationEventIds)]);

  const proposalEventId =
    commandString(details, "proposalEventId") ?? actionProposalEventId(proposal);

  return Object.freeze({
    id: turn.id.trim(),
    userMessage: turn.userMessage,
    intent: proposal.intent,
    response: proposal.response,
    citations: Object.freeze(proposal.citations.map((citation) => Object.freeze({ ...citation }))),
    actionKind,
    kind,
    isExplanation,
    requiresApproval: approval.requiresApproval,
    ...(approval.approvalMethod === undefined ? {} : { approvalMethod: approval.approvalMethod }),
    affectedPhaseIds,
    affectedTaskIds,
    affectedDecisionIds,
    affectedEventIds,
    ...(proposalEventId === undefined ? {} : { proposalEventId }),
    ...(commandStatus === undefined ? {} : { commandStatus }),
    stale,
    outcomeKnown,
  });
}

/**
 * Build the Master Agent content model from Core truth only.
 *
 * - `snapshot` (`projects.get`) supplies the persisted `projectId`,
 *   `workspacePath`, lifecycle state, execution mode, runtime phase/task
 *   rows used to validate citations, and the latest event sequence;
 * - `turns` are Core-owned `master.send` results already received. The model
 *   never invents a response, citation, or command outcome;
 * - `sessionId` is the client-local conversation session carried into
 *   `master.send`. It defaults to a stable placeholder only when the caller
 *   has not started a conversation yet; every send resolver requires an
 *   explicit non-empty session.
 *
 * Phase/task citations that name IDs absent from the snapshot throw with a
 * refresh hint instead of rendering a stale link. Scope outcomes without a
 * Core `commandStatus` stay `requiresApproval` so prose alone never reads
 * as applied.
 */
export function buildMasterModel(input: MasterModelInput): MasterModel {
  for (const method of [
    ...MASTER_OPEN_REFRESH_METHODS,
    ...MASTER_CAPABILITY_METHODS,
    ...MASTER_REOPEN_REFRESH_METHODS,
  ]) {
    assertKnownMethod(method);
  }
  if ((MASTER_OPEN_REFRESH_METHODS as readonly string[]).includes("master.send") === true) {
    throw new Error("Master Agent opening must never auto-send; refresh projects.get first.");
  }
  if ((MASTER_OPEN_REFRESH_METHODS as readonly string[]).includes("logs.list") === true) {
    throw new Error("Master Agent opening must never fetch worker logs by default.");
  }
  const snapshot = input.snapshot;
  const projectId = snapshot.summary.project.id;
  const workspacePath = snapshot.summary.workspacePath;
  if (isNonEmptyText(projectId) !== true) {
    throw new Error("Master model requires a persisted projectId from Core.");
  }
  if (isNonEmptyText(workspacePath) !== true) {
    throw new Error("Master model requires the persisted workspacePath from Core.");
  }
  const sessionId =
    isNonEmptyText(input.sessionId) === true
      ? (input.sessionId as string).trim()
      : "master-session-pending";
  if (sessionId.length > 256) {
    throw new Error("Master sessionId exceeds the 256 character Core limit.");
  }
  const turnsInput = input.turns ?? [];
  if (turnsInput.length > 200) {
    throw new Error("Master transcript exceeds the 200-turn local bound; reopen and refresh.");
  }
  const seen = new Set<string>();
  const turns: MasterTurnView[] = [];
  for (const turn of turnsInput) {
    const view = buildTurnView(turn, snapshot, projectId);
    if (seen.has(view.id) === true) {
      throw new Error(`Duplicate Master turn id ${view.id}.`);
    }
    seen.add(view.id);
    turns.push(view);
  }

  const connectionState = input.connectionState ?? "connected";
  const enabled = connectionState === "connected";
  const reason = enabled === true ? undefined : blockedReason(connectionState, input.coreDetail);

  const phaseIds = Object.freeze(snapshot.phases.map((phase) => String(phase.id)));
  const taskIds = Object.freeze(snapshot.tasks.map((task) => String(task.id)));

  return Object.freeze({
    projectId,
    workspacePath,
    sessionId,
    projectState: snapshot.summary.project.state,
    executionMode: snapshot.summary.project.executionMode,
    turns: Object.freeze(turns),
    phaseIds,
    taskIds,
    latestEventSequence: snapshot.latestEventSequence,
    capabilityMethods: MASTER_CAPABILITY_METHODS,
    optimisticComplete: false as const,
    workerLogsIncludedByDefault: false as const,
    enabled,
    ...(reason === undefined ? {} : { reason }),
  });
}

/** Look up one transcript turn. Throws on unknown ids instead of guessing. */
export function masterTurnById(model: MasterModel, turnId: string): MasterTurnView {
  const found = model.turns.find((entry) => entry.id === turnId);
  if (found === undefined) {
    throw new Error(`Unknown Master turn: ${turnId}.`);
  }
  return found;
}

export interface MasterSendResolution {
  readonly method: "master.send";
  readonly projectId: string;
  readonly workspacePath: string;
  readonly sessionId: string;
  readonly message: string;
}

/**
 * Resolve a Master message to `master.send` through Core. The request
 * carries the model's persisted `projectId`/`workspacePath`; the IDE never
 * fabricates addressing. Sending proposes through the Master role — it does
 * not directly apply roadmap, constraint, or control mutations. Only the
 * Core `proposal`/`commandStatus` in the response determines what changed.
 */
export function resolveMasterSend(
  model: MasterModel,
  input: { readonly message: string; readonly sessionId?: string },
): MasterSendResolution {
  if (isNonEmptyText(input.message) !== true) {
    throw new Error("Master send requires a non-empty message.");
  }
  const message = (input.message as string).trim();
  if (Buffer.byteLength(input.message) > 64 * 1_024) {
    throw new Error("Master message exceeds the 64 KiB Core limit.");
  }
  const sessionId =
    isNonEmptyText(input.sessionId) === true ? (input.sessionId as string).trim() : model.sessionId;
  if (isNonEmptyText(sessionId) !== true) {
    throw new Error(
      "Master send requires a persisted sessionId; the IDE does not invent one per keystroke.",
    );
  }
  if (sessionId.length > 256) {
    throw new Error("Master sessionId exceeds the 256 character Core limit.");
  }
  if (isNonEmptyText(model.projectId) !== true || isNonEmptyText(model.workspacePath) !== true) {
    throw new Error("Master send requires the persisted projectId and workspacePath from Core.");
  }
  assertKnownMethod("master.send");
  return Object.freeze({
    method: "master.send" as const,
    projectId: model.projectId,
    workspacePath: model.workspacePath,
    sessionId,
    message,
  });
}

export interface MasterRoadmapResolveResolution {
  readonly method: "roadmaps.revisions.resolve";
  readonly projectId: string;
  readonly proposalEventId: string;
  readonly resolution: "approve" | "reject";
  readonly rationale: string;
  readonly actor: string;
  readonly sessionId: string;
}

/**
 * Resolve an explicit roadmap-proposal approval to
 * `roadmaps.revisions.resolve` through Core. The `proposalEventId` must be
 * the persisted Core value disclosed in the turn's `commandDetails` (or the
 * turn's `resolve_roadmap_revision` action). The UI enables this only after
 * showing the proposed operations, rationale, and affected links; prose
 * alone never resolves. Stale outcomes reconcile via
 * `reconcileMasterStaleOutcome()`.
 */
export function resolveMasterRoadmapResolve(
  model: MasterModel,
  input: {
    readonly proposalEventId: string;
    readonly resolution: "approve" | "reject";
    readonly rationale: string;
    readonly actor: string;
    readonly sessionId?: string;
  },
): MasterRoadmapResolveResolution {
  if (isNonEmptyText(input.proposalEventId) !== true) {
    throw new Error("Master roadmap resolution requires a persisted proposalEventId from Core.");
  }
  if (input.resolution !== "approve" && input.resolution !== "reject") {
    throw new Error("Master roadmap resolution must be approve or reject.");
  }
  if (isNonEmptyText(input.rationale) !== true) {
    throw new Error("Master roadmap resolution requires a rationale.");
  }
  if (isNonEmptyText(input.actor) !== true) {
    throw new Error("Master roadmap resolution requires an actor.");
  }
  const sessionId =
    isNonEmptyText(input.sessionId) === true ? (input.sessionId as string).trim() : model.sessionId;
  if (isNonEmptyText(sessionId) !== true) {
    throw new Error("Master roadmap resolution requires a sessionId.");
  }
  assertKnownMethod("roadmaps.revisions.resolve");
  return Object.freeze({
    method: "roadmaps.revisions.resolve" as const,
    projectId: model.projectId,
    proposalEventId: (input.proposalEventId as string).trim(),
    resolution: input.resolution,
    rationale: (input.rationale as string).trim(),
    actor: (input.actor as string).trim(),
    sessionId,
  });
}

export interface MasterPauseResolution {
  readonly method: "projects.pause";
  readonly projectId: string;
  readonly workspacePath: string;
  readonly actor: string;
}

/** Resolve an explicit pause control to `projects.pause` through Core. */
export function resolveMasterPause(
  model: MasterModel,
  input: { readonly actor: string },
): MasterPauseResolution {
  if (isNonEmptyText(input.actor) !== true) {
    throw new Error("Master pause requires an actor.");
  }
  assertKnownMethod("projects.pause");
  return Object.freeze({
    method: "projects.pause" as const,
    projectId: model.projectId,
    workspacePath: model.workspacePath,
    actor: (input.actor as string).trim(),
  });
}

export interface MasterResumeResolution {
  readonly method: "projects.resume";
  readonly projectId: string;
  readonly workspacePath: string;
  readonly actor: string;
  readonly acknowledgeIntervention?: boolean;
}

/** Resolve an explicit resume control to `projects.resume` through Core. */
export function resolveMasterResume(
  model: MasterModel,
  input: { readonly actor: string; readonly acknowledgeIntervention?: boolean },
): MasterResumeResolution {
  if (isNonEmptyText(input.actor) !== true) {
    throw new Error("Master resume requires an actor.");
  }
  assertKnownMethod("projects.resume");
  return Object.freeze({
    method: "projects.resume" as const,
    projectId: model.projectId,
    workspacePath: model.workspacePath,
    actor: (input.actor as string).trim(),
    ...(input.acknowledgeIntervention === undefined
      ? {}
      : { acknowledgeIntervention: input.acknowledgeIntervention }),
  });
}

export interface MasterModeChangeResolution {
  readonly method: "settings.update";
  readonly projectId: string;
  readonly executionMode: ExecutionMode;
  readonly actor: string;
  readonly reason: string;
}

/**
 * Resolve an explicit execution-mode change to `settings.update` through
 * Core. Mode changes apply only at a safe Core boundary; the resolver
 * carries the persisted project and an explicit reason, never a guessed
 * mode.
 */
export function resolveMasterModeChange(
  model: MasterModel,
  input: { readonly mode: ExecutionMode; readonly actor: string; readonly reason: string },
): MasterModeChangeResolution {
  if (input.mode !== "guided" && input.mode !== "phase" && input.mode !== "continuous") {
    throw new Error("Master mode change must be guided, phase, or continuous.");
  }
  if (isNonEmptyText(input.actor) !== true) {
    throw new Error("Master mode change requires an actor.");
  }
  if (isNonEmptyText(input.reason) !== true) {
    throw new Error("Master mode change requires a reason.");
  }
  assertKnownMethod("settings.update");
  return Object.freeze({
    method: "settings.update" as const,
    projectId: model.projectId,
    executionMode: input.mode,
    actor: (input.actor as string).trim(),
    reason: (input.reason as string).trim(),
  });
}

export type MasterDrilldown =
  | {
      readonly kind: "project-snapshot";
      readonly method: "projects.get";
      readonly projectId: string;
    }
  | {
      readonly kind: "roadmap";
      readonly method: "roadmaps.get";
      readonly projectId: string;
    }
  | {
      readonly kind: "revisions";
      readonly method: "roadmaps.revisions.list";
      readonly projectId: string;
    }
  | {
      readonly kind: "decisions";
      readonly method: "decisions.list";
      readonly projectId: string;
    }
  | {
      readonly kind: "events";
      readonly method: "events.replay";
      readonly projectId: string;
      readonly afterSequence: number;
    }
  | {
      readonly kind: "phase-report";
      readonly method: "phases.report.get";
      readonly projectId: string;
      readonly phaseId: string;
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
      readonly kind: "worker-logs";
      readonly method: "logs.list";
      readonly projectId: string;
      readonly phaseId?: string;
      readonly taskId?: string;
      readonly attemptId?: string;
    };

/**
 * Resolve a Master metric or citation to the existing Core v1 operation that
 * backs its drill-down. Affected phases resolve to `phases.report.get`,
 * affected tasks to `attempts.list`/`validation.list`, decisions and
 * revision history to `decisions.list`/`roadmaps.revisions.list`, and events
 * to `events.replay`. The IDE carries persisted IDs through to Core and
 * never fabricates detail locally.
 */
export function resolveMasterDrilldown(
  model: MasterModel,
  selection:
    | { readonly kind: "project-snapshot" }
    | { readonly kind: "roadmap" }
    | { readonly kind: "revisions" }
    | { readonly kind: "decisions" }
    | { readonly kind: "events"; readonly afterSequence?: number }
    | { readonly kind: "phase-report"; readonly phaseId: string }
    | { readonly kind: "attempts"; readonly taskId: string }
    | { readonly kind: "validation-runs"; readonly taskId: string }
    | { readonly kind: "validation-detail"; readonly validationRunId: string }
    | {
        readonly kind: "worker-logs";
        readonly phaseId?: string;
        readonly taskId?: string;
        readonly attemptId?: string;
        readonly confirmed: true;
      },
): MasterDrilldown {
  switch (selection.kind) {
    case "project-snapshot": {
      assertKnownMethod("projects.get");
      return Object.freeze({
        kind: "project-snapshot" as const,
        method: "projects.get" as const,
        projectId: model.projectId,
      });
    }
    case "roadmap": {
      assertKnownMethod("roadmaps.get");
      return Object.freeze({
        kind: "roadmap" as const,
        method: "roadmaps.get" as const,
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
    case "decisions": {
      assertKnownMethod("decisions.list");
      return Object.freeze({
        kind: "decisions" as const,
        method: "decisions.list" as const,
        projectId: model.projectId,
      });
    }
    case "events": {
      assertKnownMethod("events.replay");
      const afterSequence =
        selection.afterSequence === undefined ? model.latestEventSequence : selection.afterSequence;
      if (Number.isInteger(afterSequence) !== true || afterSequence < 0) {
        throw new Error("Master events drill-down requires a non-negative afterSequence.");
      }
      return Object.freeze({
        kind: "events" as const,
        method: "events.replay" as const,
        projectId: model.projectId,
        afterSequence,
      });
    }
    case "phase-report": {
      if (isNonEmptyText(selection.phaseId) !== true) {
        throw new Error("Master phase drill-down requires a persisted phaseId.");
      }
      const phaseId = (selection.phaseId as string).trim();
      if ((model.phaseIds as readonly string[]).includes(phaseId) !== true) {
        throw new Error(
          `Unknown Master phase ${phaseId}; refresh projects.get and roadmaps.get before rendering.`,
        );
      }
      assertKnownMethod("phases.report.get");
      return Object.freeze({
        kind: "phase-report" as const,
        method: "phases.report.get" as const,
        projectId: model.projectId,
        phaseId,
      });
    }
    case "attempts": {
      if (isNonEmptyText(selection.taskId) !== true) {
        throw new Error("Master attempts drill-down requires a persisted taskId.");
      }
      const taskId = (selection.taskId as string).trim();
      if ((model.taskIds as readonly string[]).includes(taskId) !== true) {
        throw new Error(
          `Unknown Master task ${taskId}; refresh projects.get and roadmaps.get before rendering.`,
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
        throw new Error("Master validation drill-down requires a persisted taskId.");
      }
      const taskId = (selection.taskId as string).trim();
      if ((model.taskIds as readonly string[]).includes(taskId) !== true) {
        throw new Error(
          `Unknown Master task ${taskId}; refresh projects.get and roadmaps.get before rendering.`,
        );
      }
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
        throw new Error("Master validation drill-down requires a persisted validationRunId.");
      }
      assertKnownMethod("validation.get");
      return Object.freeze({
        kind: "validation-detail" as const,
        method: "validation.get" as const,
        projectId: model.projectId,
        validationRunId: (selection.validationRunId as string).trim(),
      });
    }
    case "worker-logs": {
      if (selection.confirmed !== true) {
        throw new Error("Master worker-log drill-down requires explicit user confirmation.");
      }
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
          "Master worker-log drill-down requires a persisted phaseId, taskId, or attemptId; the surface never fetches unscoped worker logs by default.",
        );
      }
      assertKnownMethod("logs.list");
      return Object.freeze({
        kind: "worker-logs" as const,
        method: "logs.list" as const,
        projectId: model.projectId,
        ...(phaseId === undefined ? {} : { phaseId }),
        ...(taskId === undefined ? {} : { taskId }),
        ...(attemptId === undefined ? {} : { attemptId }),
      });
    }
  }
}

/**
 * Resolve a single Master citation to its Core drill-down. Project citations
 * resolve to `projects.get`; phase citations to `phases.report.get`; task
 * citations to `attempts.list`; decision citations to `decisions.list`;
 * event and roadmap-revision citations to `events.replay` /
 * `roadmaps.revisions.list`. Unknown citation ids throw instead of
 * guessing; the caller refreshes and rebuilds first.
 */
export function resolveMasterCitationDrilldown(
  model: MasterModel,
  citation: MasterAgentCitation,
): MasterDrilldown {
  if (isValidCitationKind(citation.kind) !== true || isNonEmptyText(citation.id) !== true) {
    throw new Error("Master citation drill-down requires a persisted citation kind and id.");
  }
  switch (citation.kind) {
    case "project": {
      if (citation.id !== model.projectId) {
        throw new Error("Master project citation crossed the requested project boundary.");
      }
      return resolveMasterDrilldown(model, { kind: "project-snapshot" });
    }
    case "phase": {
      return resolveMasterDrilldown(model, { kind: "phase-report", phaseId: citation.id });
    }
    case "task": {
      return resolveMasterDrilldown(model, { kind: "attempts", taskId: citation.id });
    }
    case "decision": {
      return resolveMasterDrilldown(model, { kind: "decisions" });
    }
    case "event": {
      return resolveMasterDrilldown(model, { kind: "events" });
    }
    case "roadmap_revision":
    case "roadmap_revision_proposal": {
      return resolveMasterDrilldown(model, { kind: "revisions" });
    }
  }
}

export interface MasterStaleReconciliation {
  readonly action: "refresh-before-retry";
  readonly refreshMethods: readonly CoreV1Method[];
  readonly reason: string;
}

/**
 * Reconcile a `STALE` Master command outcome cleanly: refresh the
 * authoritative snapshots, rebuild the model, and retry from the new
 * revision/sequence instead of overwriting newer work. Never retry blindly
 * against the old proposal or revision.
 */
export function reconcileMasterStaleOutcome(input: {
  readonly proposalEventId?: string;
  readonly baseRevisionNumber?: number;
  readonly latestRevisionNumber?: number;
}): MasterStaleReconciliation {
  const suffix =
    input.latestRevisionNumber === undefined
      ? "another writer advanced the roadmap"
      : `the roadmap is now at revision ${String(input.latestRevisionNumber)}`;
  const proposal =
    input.proposalEventId === undefined
      ? "Master proposal"
      : `Master proposal ${input.proposalEventId}`;
  const base =
    input.baseRevisionNumber === undefined
      ? "its base"
      : `base revision ${String(input.baseRevisionNumber)}`;
  return Object.freeze({
    action: "refresh-before-retry",
    refreshMethods: MASTER_REOPEN_REFRESH_METHODS,
    reason:
      `${proposal} is stale against ${base} (${suffix}). ` +
      "Refresh projects.get, events.replay, decisions.list, and roadmaps.revisions.list, rebuild the Master model, and retry from the new state.",
  });
}

/** True for the `STALE` command outcome returned by Core. */
export function isMasterStaleOutcome(outcome: string): boolean {
  return outcome === "STALE";
}

export interface MasterReopenRefresh {
  readonly action: "refresh-before-render";
  readonly refreshMethods: readonly CoreV1Method[];
  readonly projectId: string;
  readonly reason: string;
}

/**
 * Reconnect/reopen recipe for the Master Agent: the local transcript handle
 * is disposable, durable decisions are not. Refresh `projects.get` for
 * addressing, replay `events.replay` from the last applied sequence (then
 * re-subscribe for live hints), and re-read `decisions.list` plus
 * `roadmaps.revisions.list` so roadmap/constraint approvals survive the
 * close. Live `core.event` notifications are hints to refresh, never direct
 * edits; `run.log.appended` is ignored by Master chat by default.
 */
export function resolveMasterReopenRefresh(projectId: string): MasterReopenRefresh {
  if (isNonEmptyText(projectId) !== true) {
    throw new Error(
      "Master reopen requires a persisted projectId from Core (projects.list); the IDE does not invent one.",
    );
  }
  return Object.freeze({
    action: "refresh-before-render",
    refreshMethods: MASTER_REOPEN_REFRESH_METHODS,
    projectId: projectId.trim(),
    reason:
      "Refresh projects.get and re-read events.replay, decisions.list, and roadmaps.revisions.list, then rebuild the Master model. " +
      "Closing the Master tab disposes the local transcript handle only; durable roadmap and constraint decisions persist in Core. " +
      "Live core.event notifications are hints to refresh, never direct edits.",
  });
}

/**
 * True when a persisted notification is only a refresh hint for Master chat.
 * `core.event` notifications are hints to re-read Core truth; empty event
 * names are ignored; `run.log.appended` worker-log notifications are ignored
 * by default so worker transcripts never spill into Master chat without an
 * explicit opt-in drill-down.
 */
export function masterEventIsRefreshHint(eventType: string): boolean {
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

/** Always false: Master chat never includes worker logs unless explicitly requested. */
export function masterWorkerLogsIncludedByDefault(): boolean {
  return false;
}
