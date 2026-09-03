# Densa ADE Home/Welcome actions (Phase 10 Milestone 2)

The welcome surface keeps familiar Code-OSS behavior usable while adding
Densa ADE project entry points. Standard editor use is never blocked by
Densa ADE setup; Densa ADE actions resolve to the existing Core v1 protocol.

## Prerequisite

Phase 9 is complete and Phase 10 Milestones 0–1 established the thin
downstream (overlay identity, zero workbench patches) and the protocol-only
IDE↔Core connection (discovery/start, handshake, reconnect, replay). This
milestone adds no orchestration, scheduling, validation, Dashboard, Roadmap,
or Master UI changes beyond the welcome entry points.

## Requirement mapping

| Milestone action                 | Command                                                      | Implementation                                                                                |
| -------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Open Folder                      | `workbench.action.files.openFolder` (built-in)               | Referenced in `WELCOME_ACTIONS`; always enabled, never gated on Core                          |
| Open File                        | `workbench.action.files.openFile` (built-in)                 | Same as above                                                                                 |
| New Window                       | `workbench.action.newWindow` (built-in)                      | Same as above                                                                                 |
| Start Project                    | `densa-ade.startProject` (contributed)                       | `apps/ide-extension/src/welcome.ts` → `projects.create` (existing Core project-creation flow) |
| Open Dashboard                   | `densa-ade.showDashboard` (contributed)                      | Same module → `dashboard.get` for the selected persisted project                              |
| Open Roadmap                     | `densa-ade.showRoadmap` (contributed)                        | Same module → `roadmaps.get` for the selected persisted project                               |
| Open Master Agent                | `densa-ade.showMasterAgent` (contributed)                    | Same module → `master.send` capability for the selected persisted project                     |
| Resume Project                   | `densa-ade.resumeProject` (contributed)                      | Same module → `projects.resume` (+ `projects.get` refresh) for the selected persisted project |
| Recent Densa ADE projects/status | `projects.list` section, opens via `densa-ade.resumeProject` | `toWelcomeRecentProjects()` projects Core summaries verbatim in Core order (max 10)           |

Normal Code-OSS welcome/open flows remain usable: the three editor-native
entries are built-in workbench commands that this extension does not
contribute, does not wrap, and does not gate. `npm run ide:check` and
`scripts/densa-welcome-home.test.mjs` assert they stay enabled when Core is
stopped, mismatched, or unauthenticated.

## Architecture notes

- **Core stays authoritative and editor-independent.** `welcome.ts` imports
  `@densa-ade/protocol` types only — never `@densa-ade/core`, `@densa-ade/cli`,
  SQLite, or `vscode` / `vs/workbench`. `npm run ide:check` greps every
  extension source for those imports.
- **No invented state.** `buildWelcomeModel()` takes only the connection state
  plus the authoritative `projects.list` page and an explicitly selected
  persisted projectId. Recent entries are direct projections
  (`toWelcomeRecentProject()`); unknown selections are reported as stale
  instead of guessed.
- **Unavailable actions explain what is needed.** Disconnected/connecting,
  version-mismatch, auth-failed, no-projects-yet, no-selection, and
  stale-selection each produce a distinct human-readable reason that names the
  required step (`densa-ade core start`, protocol alignment, project creation
  or selection). Editor actions remain available in every reason string's
  context.
- **Thin-fork ordering (AGENTS.md §1.3)** is unchanged: zero workbench patches
  at M2. The welcome catalog lives entirely in the built-in extension.

## Acceptance mapping

| Acceptance criterion                                          | Evidence                                                                                                                                                                                                                                     |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Standard editor use is not blocked by Densa ADE setup         | `scripts/densa-welcome-home.test.mjs`: editor-native actions enabled when disconnected, version-mismatch, auth-failed, and with no projects                                                                                                  |
| Start Project reaches the existing Core project creation flow | Same suite: `resolveWelcomeCoreAction("start-project")` yields `projects.create` (a frozen `CORE_V1_METHODS` entry); live Core creates through `IdeCoreConnection.request("projects.create", …)`                                             |
| Resume opens the persisted project correctly                  | Same suite: live Core `projects.create` → `projects.list` → welcome recent entry → `projects.get` snapshot identity matches; `resolveWelcomeCoreAction("resume-project", { projectId })` requires the persisted id and refuses to invent one |

## Deferred (not in M2)

Activity Bar/commands and custom editor surfaces (M3), Dashboard/Roadmap/
Master UI (Phase 11), onboarding/settings/Open VSX (Phase 12), Sparkle updater
and packaging (Phase 13).
