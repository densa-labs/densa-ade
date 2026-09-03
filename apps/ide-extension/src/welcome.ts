// Copyright 2026 Densa Labs
// SPDX-License-Identifier: Apache-2.0

/**
 * Densa ADE Home/Welcome actions (Phase 10 Milestone 2).
 *
 * The welcome experience keeps familiar Code-OSS behavior usable while adding
 * Densa ADE project entry points. Editor-native actions (`Open Folder`,
 * `Open File`, `New Window`) are built-in workbench commands and are never
 * gated on Densa ADE Core: standard editor use is not blocked by Densa ADE
 * setup.
 *
 * Densa ADE actions (`Start Project`, `Open Dashboard`, `Open Roadmap`,
 * `Open Master Agent`, `Resume Project`, recent projects) are thin views over
 * the versioned Core v1 protocol. This module is pure and protocol-only:
 *
 * - it imports `@densa-ade/protocol` types only, never `@densa-ade/core`,
 *   `@densa-ade/cli`, SQLite, or `vscode` / `vs/workbench`;
 * - it never invents project state. Recent projects are direct projections of
 *   `projects.list` summaries; availability reasons quote the connection state
 *   and selection instead of fabricating IDs;
 * - every Densa ADE action resolves to an existing `CORE_V1_METHODS` entry
 *   (`projects.create`, `dashboard.get`, `roadmaps.get`, `master.send`,
 *   `projects.get` / `projects.resume`, `projects.list`). `Start Project`
 *   reaches the existing Core project-creation flow; `Resume` re-opens the
 *   persisted project snapshot.
 *
 * Unavailable actions always explain what is needed (Core stopped,
 * version mismatch, authentication, no projects yet, no selection) instead of
 * failing silently.
 */

import { CORE_V1_METHODS, type CoreV1Method, type CoreV1ProjectSummary } from "@densa-ade/protocol";

/** Built-in Code-OSS workbench commands preserved on the welcome surface. */
export const WELCOME_EDITOR_COMMANDS = {
  openFolder: "workbench.action.files.openFolder",
  openFile: "workbench.action.files.openFile",
  newWindow: "workbench.action.newWindow",
} as const;

export type WelcomeEditorCommand =
  (typeof WELCOME_EDITOR_COMMANDS)[keyof typeof WELCOME_EDITOR_COMMANDS];

/** Densa ADE commands contributed by the built-in extension. */
export const WELCOME_DENSA_COMMANDS = {
  startProject: "densa-ade.startProject",
  openDashboard: "densa-ade.showDashboard",
  openRoadmap: "densa-ade.showRoadmap",
  openMasterAgent: "densa-ade.showMasterAgent",
  resumeProject: "densa-ade.resumeProject",
} as const;

export type WelcomeDensaCommand =
  (typeof WELCOME_DENSA_COMMANDS)[keyof typeof WELCOME_DENSA_COMMANDS];

export type WelcomeActionKind = "editor-native" | "densa-core" | "densa-recent";

export type WelcomeConnectionState =
  "disconnected" | "connecting" | "connected" | "version-mismatch" | "auth-failed";

export interface WelcomeActionDefinition {
  readonly id: string;
  readonly title: string;
  /** Concrete command invoked by the workbench welcome surface. */
  readonly command: string;
  readonly kind: WelcomeActionKind;
  /** True when the action needs a live Core connection. */
  readonly requiresCore: boolean;
  /** True when the action needs an explicitly selected persisted project. */
  readonly requiresProjectSelection: boolean;
  /** Existing Core v1 operation backing the action, when applicable. */
  readonly coreMethod?: CoreV1Method;
}

/**
 * Canonical welcome catalog: 3 familiar editor actions + 5 Densa ADE project
 * actions + the recent-projects section. The editor-native entries reference
 * built-in workbench commands that this extension does not contribute and must
 * not block.
 */
export const WELCOME_ACTIONS: readonly WelcomeActionDefinition[] = Object.freeze([
  Object.freeze({
    id: "open-folder",
    title: "Open Folder",
    command: WELCOME_EDITOR_COMMANDS.openFolder,
    kind: "editor-native",
    requiresCore: false,
    requiresProjectSelection: false,
  }),
  Object.freeze({
    id: "open-file",
    title: "Open File",
    command: WELCOME_EDITOR_COMMANDS.openFile,
    kind: "editor-native",
    requiresCore: false,
    requiresProjectSelection: false,
  }),
  Object.freeze({
    id: "new-window",
    title: "New Window",
    command: WELCOME_EDITOR_COMMANDS.newWindow,
    kind: "editor-native",
    requiresCore: false,
    requiresProjectSelection: false,
  }),
  Object.freeze({
    id: "start-project",
    title: "Start Project",
    command: WELCOME_DENSA_COMMANDS.startProject,
    kind: "densa-core",
    requiresCore: true,
    requiresProjectSelection: false,
    coreMethod: "projects.create",
  }),
  Object.freeze({
    id: "open-dashboard",
    title: "Open Dashboard",
    command: WELCOME_DENSA_COMMANDS.openDashboard,
    kind: "densa-core",
    requiresCore: true,
    requiresProjectSelection: true,
    coreMethod: "dashboard.get",
  }),
  Object.freeze({
    id: "open-roadmap",
    title: "Open Roadmap",
    command: WELCOME_DENSA_COMMANDS.openRoadmap,
    kind: "densa-core",
    requiresCore: true,
    requiresProjectSelection: true,
    coreMethod: "roadmaps.get",
  }),
  Object.freeze({
    id: "open-master-agent",
    title: "Open Master Agent",
    command: WELCOME_DENSA_COMMANDS.openMasterAgent,
    kind: "densa-core",
    requiresCore: true,
    requiresProjectSelection: true,
    coreMethod: "master.send",
  }),
  Object.freeze({
    id: "resume-project",
    title: "Resume Project",
    command: WELCOME_DENSA_COMMANDS.resumeProject,
    kind: "densa-core",
    requiresCore: true,
    requiresProjectSelection: true,
    coreMethod: "projects.resume",
  }),
  Object.freeze({
    id: "recent-projects",
    title: "Recent Densa ADE projects",
    command: WELCOME_DENSA_COMMANDS.resumeProject,
    kind: "densa-recent",
    requiresCore: true,
    requiresProjectSelection: false,
    coreMethod: "projects.list",
  }),
]);

/** Minimal Core-truth projection for the welcome recent-projects section. */
export interface WelcomeRecentProject {
  readonly projectId: string;
  readonly name: string;
  readonly state: string;
  readonly executionMode: string;
  readonly workspacePath: string;
  readonly completedTaskCount: number;
  readonly totalTaskCount: number;
  readonly attentionRequired: boolean;
  readonly currentPhaseId?: string;
}

export interface WelcomeModelInput {
  readonly connectionState: WelcomeConnectionState;
  /** Authoritative `projects.list` page in Core order. Never fabricated. */
  readonly projects: readonly CoreV1ProjectSummary[];
  /** Explicitly selected persisted project, when the window has one. */
  readonly selectedProjectId?: string;
  /** Optional Core/transport detail surfaced verbatim in reasons. */
  readonly coreDetail?: string;
}

export interface WelcomeActionAvailability {
  readonly id: string;
  readonly title: string;
  readonly command: string;
  readonly kind: WelcomeActionKind;
  readonly enabled: boolean;
  /** Human-readable explanation when `enabled` is false. Always present then. */
  readonly reason?: string;
  readonly coreMethod?: CoreV1Method;
}

export interface WelcomeModel {
  readonly connectionState: WelcomeConnectionState;
  readonly actions: readonly WelcomeActionAvailability[];
  /** Direct projection of Core `projects.list` order, bounded for display. */
  readonly recentProjects: readonly WelcomeRecentProject[];
  readonly hasProjects: boolean;
  readonly selectedProjectId?: string;
}

export const WELCOME_MAX_RECENT_PROJECTS = 10 as const;

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Project a Core summary without inventing fields or reordering. */
export function toWelcomeRecentProject(summary: CoreV1ProjectSummary): WelcomeRecentProject {
  const entry: WelcomeRecentProject = {
    projectId: summary.project.id,
    name: summary.project.name,
    state: summary.project.state,
    executionMode: summary.project.executionMode,
    workspacePath: summary.workspacePath,
    completedTaskCount: summary.completedTaskCount,
    totalTaskCount: summary.totalTaskCount,
    attentionRequired: summary.attentionRequired,
    ...(summary.currentPhaseId === undefined ? {} : { currentPhaseId: summary.currentPhaseId }),
  };
  return Object.freeze(entry);
}

export function toWelcomeRecentProjects(
  projects: readonly CoreV1ProjectSummary[],
): readonly WelcomeRecentProject[] {
  return Object.freeze(
    projects
      .slice(0, WELCOME_MAX_RECENT_PROJECTS)
      .map((summary) => toWelcomeRecentProject(summary)),
  );
}

function coreBlockedReason(connectionState: WelcomeConnectionState, coreDetail?: string): string {
  const suffix = isNonEmptyText(coreDetail) === true ? ` (${coreDetail.trim()})` : "";
  switch (connectionState) {
    case "connected":
      return "";
    case "connecting":
      return `Densa ADE Core is connecting. Wait for the connection before using this action${suffix}.`;
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

function selectedProject(
  projects: readonly CoreV1ProjectSummary[],
  selectedProjectId?: string,
): CoreV1ProjectSummary | undefined {
  if (isNonEmptyText(selectedProjectId) !== true) {
    return undefined;
  }
  const wanted = selectedProjectId.trim();
  return projects.find((summary) => summary.project.id === wanted);
}

/**
 * Build the welcome surface from Core truth only. Editor-native actions are
 * always enabled; Densa ADE actions are enabled only when Core is connected
 * (and, where marked, when a persisted project is explicitly selected).
 */
export function buildWelcomeModel(input: WelcomeModelInput): WelcomeModel {
  const projects = Object.freeze([...input.projects]);
  const selected =
    isNonEmptyText(input.selectedProjectId) === true ? input.selectedProjectId.trim() : undefined;
  const hasProjects = projects.length > 0;
  const selectedSnapshot = selected === undefined ? undefined : selectedProject(projects, selected);
  const recentProjects = toWelcomeRecentProjects(projects);

  const actions: WelcomeActionAvailability[] = WELCOME_ACTIONS.map((definition) => {
    if (definition.requiresCore !== true) {
      return Object.freeze({
        id: definition.id,
        title: definition.title,
        command: definition.command,
        kind: definition.kind,
        enabled: true,
        ...(definition.coreMethod === undefined ? {} : { coreMethod: definition.coreMethod }),
      });
    }
    if (input.connectionState !== "connected") {
      return Object.freeze({
        id: definition.id,
        title: definition.title,
        command: definition.command,
        kind: definition.kind,
        enabled: false,
        reason: coreBlockedReason(input.connectionState, input.coreDetail),
        ...(definition.coreMethod === undefined ? {} : { coreMethod: definition.coreMethod }),
      });
    }
    if (definition.kind === "densa-recent") {
      if (hasProjects !== true) {
        return Object.freeze({
          id: definition.id,
          title: definition.title,
          command: definition.command,
          kind: definition.kind,
          enabled: false,
          reason:
            "No Densa ADE projects yet. Use Start Project to create one through Core; standard editor actions remain available.",
          ...(definition.coreMethod === undefined ? {} : { coreMethod: definition.coreMethod }),
        });
      }
      return Object.freeze({
        id: definition.id,
        title: definition.title,
        command: definition.command,
        kind: definition.kind,
        enabled: true,
        ...(definition.coreMethod === undefined ? {} : { coreMethod: definition.coreMethod }),
      });
    }
    if (definition.requiresProjectSelection === true) {
      if (selected === undefined) {
        return Object.freeze({
          id: definition.id,
          title: definition.title,
          command: definition.command,
          kind: definition.kind,
          enabled: false,
          reason:
            hasProjects === true
              ? `Select a Densa ADE project to ${definition.title.toLowerCase()}. Recent projects are listed from Core; nothing is stored locally.`
              : `No Densa ADE project is open. Use Start Project to create one through Core, or open a folder for standard editing.`,
          ...(definition.coreMethod === undefined ? {} : { coreMethod: definition.coreMethod }),
        });
      }
      if (selectedSnapshot === undefined) {
        return Object.freeze({
          id: definition.id,
          title: definition.title,
          command: definition.command,
          kind: definition.kind,
          enabled: false,
          reason: `The selected project is not in the Core project list. Refresh recent projects from Core (projects.list) and select a persisted project.`,
          ...(definition.coreMethod === undefined ? {} : { coreMethod: definition.coreMethod }),
        });
      }
    }
    return Object.freeze({
      id: definition.id,
      title: definition.title,
      command: definition.command,
      kind: definition.kind,
      enabled: true,
      ...(definition.coreMethod === undefined ? {} : { coreMethod: definition.coreMethod }),
    });
  });

  return Object.freeze({
    connectionState: input.connectionState,
    actions: Object.freeze(actions),
    recentProjects,
    hasProjects,
    ...(selected === undefined ? {} : { selectedProjectId: selected }),
  });
}

/** Look up one action's availability inside a built model. */
export function welcomeActionById(
  model: WelcomeModel,
  actionId: string,
): WelcomeActionAvailability {
  const found = model.actions.find((action) => action.id === actionId);
  if (found === undefined) {
    throw new Error(`Unknown Densa ADE welcome action: ${actionId}.`);
  }
  return found;
}

export interface WelcomeCoreResolution {
  /** Existing Core v1 operation backing the welcome action. */
  readonly method: CoreV1Method;
  /** IDE command that triggers it. */
  readonly command: string;
  /** Whether a persisted projectId argument is required. */
  readonly requiresProjectId: boolean;
  /** ProjectId carried through to Core; never invented by the IDE. */
  readonly projectId?: string;
}

/**
 * Resolve a welcome action to the existing Core v1 operation it invokes.
 * Editor-native actions have no Core method and throw; Densa ADE actions
 * return the frozen `CORE_V1_METHODS` entry plus the persisted projectId the
 * caller selected. The IDE never fabricates a projectId.
 */
export function resolveWelcomeCoreAction(
  actionId: string,
  options: { readonly projectId?: string } = {},
): WelcomeCoreResolution {
  const definition = WELCOME_ACTIONS.find((entry) => entry.id === actionId);
  if (definition === undefined) {
    throw new Error(`Unknown Densa ADE welcome action: ${actionId}.`);
  }
  if (definition.coreMethod === undefined) {
    throw new Error(
      `Welcome action ${actionId} is editor-native (${definition.command}) and has no Core operation.`,
    );
  }
  if ((CORE_V1_METHODS as readonly string[]).includes(definition.coreMethod) !== true) {
    throw new Error(
      `Welcome action ${actionId} maps to unknown Core method ${definition.coreMethod}.`,
    );
  }
  if (definition.requiresProjectSelection === true) {
    if (isNonEmptyText(options.projectId) !== true) {
      throw new Error(
        `Welcome action ${actionId} requires a persisted projectId from Core (projects.list); the IDE does not invent one.`,
      );
    }
    return Object.freeze({
      method: definition.coreMethod,
      command: definition.command,
      requiresProjectId: true,
      projectId: options.projectId.trim(),
    });
  }
  const trimmed = isNonEmptyText(options.projectId) === true ? options.projectId.trim() : undefined;
  return Object.freeze({
    method: definition.coreMethod,
    command: definition.command,
    requiresProjectId: false,
    ...(trimmed === undefined ? {} : { projectId: trimmed }),
  });
}
