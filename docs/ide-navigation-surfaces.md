# Densa ADE navigation surfaces (Phase 10 Milestone 3)

The primary navigation shells for Dashboard, Roadmap, and Master Agent. Each
surface opens as a full editor-area tab alongside source tabs — never content
cramped into a narrow chat sidebar. Activity Bar entries are launchers: they
reveal the surface and its open-as-editor-tab command, they do not host the
surface content.

## Prerequisite

Phase 9 is complete and Phase 10 Milestones 0–2 established the thin
downstream (overlay identity, zero workbench patches), the protocol-only
IDE↔Core connection (discovery/start, handshake, reconnect, replay), and the
Home/Welcome actions over Core truth. This milestone adds no orchestration,
scheduling, validation, or Master/roadmap-content changes beyond the
navigation shells.

## Requirement mapping

| Milestone item                            | Implementation                                                                                                                                                                         |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard command/view                    | `densa-ade.showDashboard` + `densa-ade.dashboard` launcher view + `densa-ade.dashboard` editor tab (`apps/ide-extension/src/surfaces.ts`, manifest `commands`/`views`/`customEditors`) |
| Roadmap command/view                      | `densa-ade.showRoadmap` + `densa-ade.roadmap` launcher view + `densa-ade.roadmap` editor tab (same files)                                                                              |
| Master Agent command/view                 | `densa-ade.showMasterAgent` + `densa-ade.master` launcher view + `densa-ade.master` editor tab (same files)                                                                            |
| Densa ADE command-palette group           | Every Densa ADE command shares the `Densa ADE` palette category (`SURFACE_COMMAND_CATEGORY`); asserted by `npm run ide:check`                                                          |
| Activity Bar entries                      | `densa-ade` activity-bar container with Dashboard / Roadmap / Master Agent launcher views (manifest `viewsContainers`/`views`)                                                         |
| Full editor-area tabs, not a chat sidebar | Each surface's primary `area` is `editor-tab` with its own `editorViewType`; content renders beside source tabs (see lifecycle below)                                                  |

Normal Code-OSS editor use is unchanged: no workbench patches, no default
file associations (`customEditors` priority is `option`, never default), and
the M2 welcome editor-native flows stay ungated.

## Architecture notes

- **Core stays authoritative and editor-independent.** `surfaces.ts` imports
  `@densa-ade/protocol` types (plus command constants from the equally
  protocol-only `welcome.ts`) — never `@densa-ade/core`, `@densa-ade/cli`,
  SQLite, or `vscode` / `vs/workbench`. `npm run ide:check` greps every
  extension source for those imports.
- **No invented state.** `resolveSurfaceOpenRefresh()` takes a surface id
  plus an explicitly selected persisted projectId. Dashboard resolves to the
  existing `dashboard.get` snapshot read, Roadmap to `roadmaps.get`. Opening
  Master Agent never auto-sends: it returns a `deferred-interaction` holding
  the `master.send` capability, which is used only once the user actually
  sends a message. A blank projectId throws instead of fabricating one.
- **Unavailable surfaces explain what is needed.**
  `buildSurfaceAvailability()` reports per-surface enabled state from
  connection state plus selection: disconnected/connecting,
  version-mismatch, auth-failed, and no-selection each produce a distinct
  human-readable reason. Editor-native flows remain available in every
  reason's context.
- **Disposable views, durable Core (`SURFACE_LIFECYCLE`).** Closing a tab
  disposes the local view handle only (`closeDisposes: view-handle-only`);
  Core keeps running while project policy allows it. Reopening replays from
  the last applied sequence and refreshes the authoritative snapshot before
  the next mutation whose preconditions may have changed, per
  `docs/core-v1-protocol.md`. Surfaces never mark tasks complete
  optimistically (`optimisticComplete: false`).
- **Thin-fork ordering (AGENTS.md §1.3)** is unchanged: zero workbench
  patches at M3. Navigation lives entirely in the built-in extension via
  standard contribution mechanisms (`commands`, `viewsContainers`, `views`,
  `customEditors`). No visual polish yet by design; surface content arrives
  in Phase 11.

## Acceptance mapping

| Acceptance criterion                                               | Evidence                                                                                                                                                                    |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User can open Dashboard/Roadmap/Master Agent alongside source tabs | `scripts/ide-navigation-surfaces.test.mjs`: every surface has `area: editor-tab`, a distinct `editorViewType`, and a manifest `customEditors` entry with `priority: option` |
| Closing/reopening surfaces does not affect Core execution          | Same suite (live Core): snapshot reads before/after a simulated close return identical project truth; daemon stays `running` after the IDE connection disposes              |
| Commands work from Command Palette                                 | Same suite: all five Densa ADE commands are contributed with the shared `Densa ADE` category; `surfaceForCommand()` resolves each surface command                           |

## Deferred (not in M3)

Surface content (Roadmap UI, Dashboard command center, Master Agent UI,
phase rundowns, pause/intervene UX — Phase 11), onboarding/settings/Open VSX
(Phase 12), Sparkle updater and packaging (Phase 13). The `*.densa-*`
filename patterns are non-default selectors reserving the viewTypes; they
claim no file ownership.
