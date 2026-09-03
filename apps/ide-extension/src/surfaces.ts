// Copyright 2026 Densa Labs
// SPDX-License-Identifier: Apache-2.0

/**
 * Densa ADE navigation shells (Phase 10 Milestone 3).
 *
 * Primary navigation for Dashboard, Roadmap, and Master Agent. Each surface is
 * a full editor-area tab opened alongside source tabs — never content cramped
 * into a narrow sidebar. The Activity Bar entries are launchers: they reveal
 * the surface and its open-as-editor-tab command, they do not host the
 * surface content.
 *
 * This module is pure and protocol-only:
 *
 * - it imports `@densa-ade/protocol` types (via `./welcome.js` command
 *   constants) only, never `@densa-ade/core`, `@densa-ade/cli`, SQLite, or
 *   `vscode` / `vs/workbench`;
 * - it never invents project state. Opening a surface resolves to existing
 *   `CORE_V1_METHODS` snapshot reads (`dashboard.get`, `roadmaps.get`) for a
 *   persisted projectId selected from Core truth (`projects.list`). Opening
 *   Master Agent never auto-sends: the `master.send` capability is required
 *   to interact, but opening itself issues no Core mutation;
 * - surfaces are disposable, Core is durable. Closing (or reopening) a
 *   surface disposes the local view handle only and never changes project
 *   truth. Reopening replays from the last applied sequence and refreshes
 *   the authoritative snapshot before the next mutation whose preconditions
 *   may have changed (see `docs/core-v1-protocol.md` reconnect recipe).
 *
 * Standard VS Code contribution mechanisms only (AGENTS.md §1.3): commands
 * with the `Densa ADE` palette category, an `activitybar` container with
 * three views, and three `customEditors` viewTypes so the surfaces are
 * first-class editor tabs. Zero workbench patches.
 */

import { CORE_V1_METHODS, type CoreV1Method } from "@densa-ade/protocol";

import { WELCOME_DENSA_COMMANDS } from "./welcome.js";

/** Human-readable Command Palette group shared by every Densa ADE command. */
export const SURFACE_COMMAND_CATEGORY = "Densa ADE" as const;

/** Activity Bar container contributed by the built-in extension. */
export const ACTIVITY_BAR_CONTAINER_ID = "densa-ade" as const;

export type SurfaceId = "dashboard" | "roadmap" | "master";

/** Primary render area. Every M3 surface renders as an editor-area tab. */
export type SurfaceArea = "editor-tab";

export type SurfaceConnectionState =
  "disconnected" | "connecting" | "connected" | "version-mismatch" | "auth-failed";

export interface SurfaceDefinition {
  readonly id: SurfaceId;
  readonly title: string;
  /** Command that opens the surface (also the Command Palette entry). */
  readonly command: string;
  /** Activity Bar launcher view. Navigation entry only, not the content host. */
  readonly activityBarViewId: string;
  /** Editor-area tab viewType. Content renders here, beside source tabs. */
  readonly editorViewType: string;
  readonly area: SurfaceArea;
  /** True when opening requires an explicitly selected persisted project. */
  readonly requiresProjectSelection: boolean;
  /**
   * Snapshot reads issued immediately after opening, before first render.
   * Empty for Master Agent: opening never auto-sends.
   */
  readonly openRefreshMethods: readonly CoreV1Method[];
  /** Frozen-catalog Core operations the surface may use once open. */
  readonly capabilityMethods: readonly CoreV1Method[];
}

/**
 * Canonical navigation shells: Dashboard, Roadmap, Master Agent. Dashboard
 * and Roadmap render full editor-area tabs; Master Agent does the same so it
 * can sit alongside source tabs rather than in a cramped chat sidebar.
 */
export const SURFACE_DEFINITIONS: readonly SurfaceDefinition[] = Object.freeze([
  Object.freeze({
    id: "dashboard",
    title: "Dashboard",
    command: WELCOME_DENSA_COMMANDS.openDashboard,
    activityBarViewId: "densa-ade.dashboard",
    editorViewType: "densa-ade.dashboard",
    area: "editor-tab",
    requiresProjectSelection: true,
    openRefreshMethods: Object.freeze(["dashboard.get"] as const),
    capabilityMethods: Object.freeze([
      "dashboard.get",
      "projects.get",
      "events.subscribe",
    ] as const),
  }),
  Object.freeze({
    id: "roadmap",
    title: "Roadmap",
    command: WELCOME_DENSA_COMMANDS.openRoadmap,
    activityBarViewId: "densa-ade.roadmap",
    editorViewType: "densa-ade.roadmap",
    area: "editor-tab",
    requiresProjectSelection: true,
    openRefreshMethods: Object.freeze(["roadmaps.get"] as const),
    capabilityMethods: Object.freeze([
      "roadmaps.get",
      "roadmaps.revisions.list",
      "projects.get",
      "events.subscribe",
    ] as const),
  }),
  Object.freeze({
    id: "master",
    title: "Master Agent",
    command: WELCOME_DENSA_COMMANDS.openMasterAgent,
    activityBarViewId: "densa-ade.master",
    editorViewType: "densa-ade.master",
    area: "editor-tab",
    requiresProjectSelection: true,
    openRefreshMethods: Object.freeze([] as const),
    capabilityMethods: Object.freeze(["master.send", "projects.get"] as const),
  }),
]);

/** Machine-readable surface catalog keyed by surface id. */
export const SURFACE_COMMANDS: Record<SurfaceId, string> = Object.freeze({
  dashboard: WELCOME_DENSA_COMMANDS.openDashboard,
  roadmap: WELCOME_DENSA_COMMANDS.openRoadmap,
  master: WELCOME_DENSA_COMMANDS.openMasterAgent,
});

export const SURFACE_ACTIVITY_BAR_VIEWS: Record<SurfaceId, string> = Object.freeze({
  dashboard: "densa-ade.dashboard",
  roadmap: "densa-ade.roadmap",
  master: "densa-ade.master",
});

export const SURFACE_EDITOR_VIEW_TYPES: Record<SurfaceId, string> = Object.freeze({
  dashboard: "densa-ade.dashboard",
  roadmap: "densa-ade.roadmap",
  master: "densa-ade.master",
});

/**
 * Disposable-view lifecycle contract. Closing or reopening a surface never
 * touches Core execution; reopening re-reads Core truth.
 */
export const SURFACE_LIFECYCLE = Object.freeze({
  /** Closing disposes the local editor tab handle only. */
  closeDisposes: "view-handle-only",
  /** Core keeps running while project policy allows it. */
  coreContinuesAfterClose: true,
  /** Reopening replays from the last applied sequence, then refreshes. */
  reopenRefreshesSnapshot: true,
  /** Surfaces never mark tasks complete optimistically. */
  optimisticComplete: false,
});

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Look up a surface by id. Throws on unknown ids instead of guessing. */
export function surfaceById(surfaceId: string): SurfaceDefinition {
  const found = SURFACE_DEFINITIONS.find((entry) => entry.id === surfaceId);
  if (found === undefined) {
    throw new Error(`Unknown Densa ADE surface: ${surfaceId}.`);
  }
  return found;
}

/** Look up the surface opened by an IDE command. Throws when unmapped. */
export function surfaceForCommand(command: string): SurfaceDefinition {
  const found = SURFACE_DEFINITIONS.find((entry) => entry.command === command);
  if (found === undefined) {
    throw new Error(`No Densa ADE surface opens command: ${command}.`);
  }
  return found;
}

/** Look up the surface behind an Activity Bar launcher view. */
export function surfaceForActivityBarView(viewId: string): SurfaceDefinition {
  const found = SURFACE_DEFINITIONS.find((entry) => entry.activityBarViewId === viewId);
  if (found === undefined) {
    throw new Error(`No Densa ADE surface owns activity bar view: ${viewId}.`);
  }
  return found;
}

/** Look up the surface behind an editor-area tab viewType. */
export function surfaceForEditorViewType(viewType: string): SurfaceDefinition {
  const found = SURFACE_DEFINITIONS.find((entry) => entry.editorViewType === viewType);
  if (found === undefined) {
    throw new Error(`No Densa ADE surface owns editor viewType: ${viewType}.`);
  }
  return found;
}

export interface SurfaceAvailabilityInput {
  readonly connectionState: SurfaceConnectionState;
  /** Explicitly selected persisted project, when the window has one. */
  readonly selectedProjectId?: string;
  /** Optional Core/transport detail surfaced verbatim in reasons. */
  readonly coreDetail?: string;
}

export interface SurfaceAvailability {
  readonly id: SurfaceId;
  readonly title: string;
  readonly command: string;
  readonly editorViewType: string;
  readonly area: SurfaceArea;
  readonly enabled: boolean;
  /** Human-readable explanation when `enabled` is false. Always present then. */
  readonly reason?: string;
}

function surfaceBlockedReason(
  connectionState: SurfaceConnectionState,
  coreDetail?: string,
): string {
  const suffix = isNonEmptyText(coreDetail) === true ? ` (${coreDetail.trim()})` : "";
  switch (connectionState) {
    case "connected":
      return "";
    case "connecting":
      return `Densa ADE Core is connecting. Wait for the connection before opening this surface${suffix}.`;
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

/**
 * Availability for every surface from connection state plus the explicitly
 * selected persisted project. Surfaces need Core (they render Core truth)
 * and a selected project; unavailable surfaces explain what is needed.
 */
export function buildSurfaceAvailability(
  input: SurfaceAvailabilityInput,
): readonly SurfaceAvailability[] {
  const selected =
    isNonEmptyText(input.selectedProjectId) === true ? input.selectedProjectId.trim() : undefined;
  return Object.freeze(
    SURFACE_DEFINITIONS.map((definition) => {
      if (input.connectionState !== "connected") {
        return Object.freeze({
          id: definition.id,
          title: definition.title,
          command: definition.command,
          editorViewType: definition.editorViewType,
          area: definition.area,
          enabled: false,
          reason: surfaceBlockedReason(input.connectionState, input.coreDetail),
        });
      }
      if (definition.requiresProjectSelection === true && selected === undefined) {
        return Object.freeze({
          id: definition.id,
          title: definition.title,
          command: definition.command,
          editorViewType: definition.editorViewType,
          area: definition.area,
          enabled: false,
          reason:
            "No Densa ADE project is open. Use Start Project to create one through Core, or open a folder for standard editing.",
        });
      }
      return Object.freeze({
        id: definition.id,
        title: definition.title,
        command: definition.command,
        editorViewType: definition.editorViewType,
        area: definition.area,
        enabled: true,
      });
    }),
  );
}

export type SurfaceOpenRefresh =
  | {
      readonly kind: "snapshot-refresh";
      readonly surfaceId: SurfaceId;
      readonly command: string;
      readonly editorViewType: string;
      readonly area: SurfaceArea;
      /** Existing Core v1 snapshot read backing first render. */
      readonly method: CoreV1Method;
      /** Persisted projectId carried through to Core; never invented. */
      readonly projectId: string;
    }
  | {
      readonly kind: "deferred-interaction";
      readonly surfaceId: SurfaceId;
      readonly command: string;
      readonly editorViewType: string;
      readonly area: SurfaceArea;
      /**
       * Opening Master Agent issues no Core request. This is the capability
       * the surface uses once the user actually sends a message.
       */
      readonly capability: CoreV1Method;
      /** Persisted projectId carried through to Core; never invented. */
      readonly projectId: string;
    };

/**
 * Resolve opening a surface to the Core truth it renders. Dashboard and
 * Roadmap refresh their authoritative snapshot for the persisted projectId;
 * Master Agent opens empty and defers `master.send` until the user sends a
 * message — opening never auto-sends. The IDE never fabricates a projectId.
 */
export function resolveSurfaceOpenRefresh(
  surfaceId: string,
  options: { readonly projectId?: string } = {},
): SurfaceOpenRefresh {
  const definition = surfaceById(surfaceId);
  if (isNonEmptyText(options.projectId) !== true) {
    throw new Error(
      `Surface ${surfaceId} requires a persisted projectId from Core (projects.list); the IDE does not invent one.`,
    );
  }
  const projectId = options.projectId.trim();
  for (const method of [...definition.openRefreshMethods, ...definition.capabilityMethods]) {
    if ((CORE_V1_METHODS as readonly string[]).includes(method) !== true) {
      throw new Error(`Surface ${surfaceId} maps to unknown Core method ${method}.`);
    }
  }
  if (definition.openRefreshMethods.length > 0) {
    const method = definition.openRefreshMethods[0];
    if (method === undefined) {
      throw new Error(`Surface ${surfaceId} has no open-refresh method.`);
    }
    return Object.freeze({
      kind: "snapshot-refresh",
      surfaceId: definition.id,
      command: definition.command,
      editorViewType: definition.editorViewType,
      area: definition.area,
      method,
      projectId,
    });
  }
  const capability = definition.capabilityMethods[0];
  if (capability === undefined) {
    throw new Error(`Surface ${surfaceId} has no interaction capability.`);
  }
  return Object.freeze({
    kind: "deferred-interaction",
    surfaceId: definition.id,
    command: definition.command,
    editorViewType: definition.editorViewType,
    area: definition.area,
    capability,
    projectId,
  });
}
