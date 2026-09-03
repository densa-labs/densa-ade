// Copyright 2026 Densa Labs
// SPDX-License-Identifier: Apache-2.0

/**
 * Built-in Densa ADE extension (Phase 10 Milestone 3).
 *
 * Protocol-only IDE client boundary: this package may import
 * `@densa-ade/protocol` and nothing else from Densa ADE Core. It never imports
 * `@densa-ade/core`, SQLite repositories, daemon internals, or Code-OSS workbench
 * APIs. All project truth comes from Densa ADE Core over the versioned local
 * protocol; the IDE renders snapshots and sends validated requests.
 *
 * The IDE socket is disposable; Core is durable. `disconnect()` closes the
 * IDE window's connection only and never stops Core.
 *
 * Welcome/Home actions (M2) keep familiar Code-OSS `Open Folder` / `Open File`
 * / `New Window` flows usable without Core and resolve every Densa ADE action
 * to an existing Core v1 operation (see `./welcome.js`).
 *
 * Navigation shells (M3) open Dashboard, Roadmap, and Master Agent as full
 * editor-area tabs beside source tabs via standard contribution mechanisms
 * (commands, Activity Bar launchers, custom-editor viewTypes). Activity Bar
 * entries navigate; they do not host surface content. Surfaces are
 * disposable: closing or reopening a tab never changes Core execution
 * (see `./surfaces.js`).
 *
 * Dashboard command center (Phase 11 M1) renders the project command center
 * over the same protocol boundary: PROJECT/CURRENT/HEALTH/CHANGES/
 * AGENTS-USAGE/EVENTS sections plus drill-downs and WAITING/BLOCKED banners
 * (see `./dashboard.js`). Roadmap content (M0) lives in `./roadmap.js`.
 * Master Agent conversation/control surface (M2) distinguishes explanations
 * from proposed state changes over `master.send` with explicit approval,
 * stale revalidation, durable decisions, and no worker-log dumping by
 * default (see `./master.js`). Phase-completion rundown UX (Phase 11 M3)
 * renders the persisted `phases.report.get` stopping point with gated
 * Start Next Phase approval (see `./phase-completion.js`).
 */

export {
  IDE_PROTOCOL_VERSION,
  assertCompatibleProtocol,
  createIdeConnectionOptions,
  type IdeCoreConnectionOptions,
} from "./connection.js";
export {
  defaultIdeCoreRuntimeDirectory,
  ideCoreRuntimePaths,
  parseIdeCoreProcessState,
  ideCoreProcessExists,
  type IdeCoreRuntimePaths,
  type IdeCoreProcessState,
} from "./runtime-paths.js";
export {
  IDE_IPC_MAX_FRAME_BYTES,
  IdeCoreIpcError,
  IdeCoreIpcTransport,
  type IdeIpcTransportOptions,
  type IdeNotificationListener,
} from "./ide-transport.js";
export {
  IdeProjectEventCache,
  IdeEventCache,
  type IdeEventApplication,
  type IdeReplayOutcome,
} from "./event-cache.js";
export {
  IdeCoreConnection,
  discoverIdeCoreStatus,
  isIdeCoreIpcError,
  type IdeConnectionState,
  type IdeConnectionStatus,
  type IdeCoreStarter,
  type IdeCoreSessionOptions,
} from "./ide-connection.js";
export {
  WELCOME_ACTIONS,
  WELCOME_DENSA_COMMANDS,
  WELCOME_EDITOR_COMMANDS,
  WELCOME_MAX_RECENT_PROJECTS,
  buildWelcomeModel,
  resolveWelcomeCoreAction,
  toWelcomeRecentProject,
  toWelcomeRecentProjects,
  welcomeActionById,
  type WelcomeActionAvailability,
  type WelcomeActionDefinition,
  type WelcomeActionKind,
  type WelcomeConnectionState,
  type WelcomeCoreResolution,
  type WelcomeDensaCommand,
  type WelcomeEditorCommand,
  type WelcomeModel,
  type WelcomeModelInput,
  type WelcomeRecentProject,
} from "./welcome.js";
export {
  ACTIVITY_BAR_CONTAINER_ID,
  SURFACE_ACTIVITY_BAR_VIEWS,
  SURFACE_COMMANDS,
  SURFACE_COMMAND_CATEGORY,
  SURFACE_DEFINITIONS,
  SURFACE_EDITOR_VIEW_TYPES,
  SURFACE_LIFECYCLE,
  buildSurfaceAvailability,
  resolveSurfaceOpenRefresh,
  surfaceById,
  surfaceForActivityBarView,
  surfaceForCommand,
  surfaceForEditorViewType,
  type SurfaceAvailability,
  type SurfaceAvailabilityInput,
  type SurfaceArea,
  type SurfaceConnectionState,
  type SurfaceDefinition,
  type SurfaceId,
  type SurfaceOpenRefresh,
} from "./surfaces.js";
export {
  ROADMAP_CANONICAL_PHASE_STATES,
  ROADMAP_CANONICAL_TASK_STATES,
  ROADMAP_CAPABILITY_METHODS,
  ROADMAP_COMMAND,
  ROADMAP_EDITOR_VIEW_TYPE,
  ROADMAP_LIFECYCLE,
  ROADMAP_OPEN_REFRESH_METHODS,
  buildRoadmapModel,
  isRoadmapStaleOutcome,
  reconcileRoadmapStaleOutcome,
  resolveRoadmapDrilldown,
  resolveRoadmapPhaseApproval,
  resolveRoadmapPropose,
  resolveRoadmapResolve,
  resolveRoadmapTaskApproval,
  roadmapPhaseById,
  roadmapRevisionById,
  roadmapTaskById,
  type RoadmapConnectionState,
  type RoadmapDrilldown,
  type RoadmapModel,
  type RoadmapModelInput,
  type RoadmapPendingPhaseApproval,
  type RoadmapPhaseApprovalResolution,
  type RoadmapPhaseView,
  type RoadmapProposeResolution,
  type RoadmapResolveResolution,
  type RoadmapRevisionView,
  type RoadmapSelection,
  type RoadmapStaleReconciliation,
  type RoadmapTaskApprovalResolution,
  type RoadmapTaskView,
} from "./roadmap.js";
export {
  DASHBOARD_CANONICAL_PHASE_STATES,
  DASHBOARD_CANONICAL_PROJECT_STATES,
  DASHBOARD_CANONICAL_TASK_STATES,
  DASHBOARD_CAPABILITY_METHODS,
  DASHBOARD_COMMAND,
  DASHBOARD_EDITOR_VIEW_TYPE,
  DASHBOARD_LIFECYCLE,
  DASHBOARD_OPEN_REFRESH_METHODS,
  buildDashboardModel,
  dashboardEventIsRefreshHint,
  dashboardPhaseProgressById,
  resolveDashboardDrilldown,
  resolveDashboardReopenRefresh,
  type DashboardAgentsUsageSection,
  type DashboardBannerKind,
  type DashboardChangesSection,
  type DashboardConnectionState,
  type DashboardCurrentSection,
  type DashboardDrilldown,
  type DashboardEventsSection,
  type DashboardHealthSection,
  type DashboardModel,
  type DashboardModelInput,
  type DashboardPendingApproval,
  type DashboardPhaseProgress,
  type DashboardProjectSection,
  type DashboardRecentEvent,
  type DashboardReopenRefresh,
  type DashboardStateCount,
  type DashboardStatusBanner,
} from "./dashboard.js";
export {
  MASTER_ACTION_KINDS,
  MASTER_CAPABILITY_METHODS,
  MASTER_COMMAND,
  MASTER_EDITOR_VIEW_TYPE,
  MASTER_EXAMPLE_PROMPTS,
  MASTER_INTENTS,
  MASTER_LIFECYCLE,
  MASTER_OPEN_REFRESH_METHODS,
  MASTER_REOPEN_REFRESH_METHODS,
  buildMasterModel,
  classifyMasterAction,
  isMasterStaleOutcome,
  masterEventIsRefreshHint,
  masterTurnById,
  masterWorkerLogsIncludedByDefault,
  reconcileMasterStaleOutcome,
  resolveMasterCitationDrilldown,
  resolveMasterDrilldown,
  resolveMasterModeChange,
  resolveMasterPause,
  resolveMasterReopenRefresh,
  resolveMasterResume,
  resolveMasterRoadmapResolve,
  resolveMasterSend,
  type MasterConnectionState,
  type MasterDrilldown,
  type MasterExamplePrompt,
  type MasterModel,
  type MasterModelInput,
  type MasterReopenRefresh,
  type MasterSendResolution,
  type MasterStaleReconciliation,
  type MasterTurnInput,
  type MasterTurnKind,
  type MasterTurnView,
} from "./master.js";
export {
  PHASE_COMPLETION_ACTIONS,
  PHASE_COMPLETION_CAPABILITY_METHODS,
  PHASE_COMPLETION_LIFECYCLE,
  PHASE_COMPLETION_NAVIGATION_COMMANDS,
  PHASE_COMPLETION_OPEN_REFRESH_METHODS,
  buildPhaseCompletionModel,
  phaseCompletionEventIsRefreshHint,
  resolvePhaseCompletionDrilldown,
  resolvePhaseCompletionInspectChanges,
  resolvePhaseCompletionMasterAsk,
  resolvePhaseCompletionOpenRoadmap,
  resolvePhaseCompletionPhaseApproval,
  resolvePhaseCompletionReopenRefresh,
  type PhaseCompletionActionId,
  type PhaseCompletionConnectionState,
  type PhaseCompletionDrilldown,
  type PhaseCompletionInspectChangesResolution,
  type PhaseCompletionLiveNextPhase,
  type PhaseCompletionMasterAskResolution,
  type PhaseCompletionModel,
  type PhaseCompletionModelInput,
  type PhaseCompletionOpenRoadmapResolution,
  type PhaseCompletionPhaseApprovalResolution,
  type PhaseCompletionReopenRefresh,
  type PhaseCompletionValidationSummary,
} from "./phase-completion.js";

export const EXTENSION_ID = "densa-labs.densa-ade" as const;

export const PRODUCT_BINDING = {
  applicationName: "densa-ade",
  nameShort: "Densa ADE",
  dataFolderName: "densa-ade",
  darwinBundleIdentifier: "labs.densa.ade",
} as const;

export const IDE_COMMAND_PALETTE_GROUP = "densa-ade" as const;

export const IDE_COMMANDS = [
  "densa-ade.showDashboard",
  "densa-ade.showRoadmap",
  "densa-ade.showMasterAgent",
  "densa-ade.startProject",
  "densa-ade.resumeProject",
] as const;

export type IdeCommand = (typeof IDE_COMMANDS)[number];

export const IDE_VIEWS = ["densa-ade.dashboard", "densa-ade.roadmap", "densa-ade.master"] as const;

export type IdeView = (typeof IDE_VIEWS)[number];

export interface IdeExtensionSummary {
  readonly extensionId: typeof EXTENSION_ID;
  readonly productBinding: typeof PRODUCT_BINDING;
  readonly commands: readonly IdeCommand[];
  readonly views: readonly IdeView[];
  readonly coreBoundary: "protocol-only";
}

export function describeExtension(): IdeExtensionSummary {
  return {
    extensionId: EXTENSION_ID,
    productBinding: PRODUCT_BINDING,
    commands: IDE_COMMANDS,
    views: IDE_VIEWS,
    coreBoundary: "protocol-only",
  };
}
