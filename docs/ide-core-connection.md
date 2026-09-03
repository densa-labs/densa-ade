# IDE Core connection (Phase 10 Milestone 1)

The Densa ADE IDE is a disposable, protocol-only client of the durable Core
daemon. This document maps the milestone requirements to the implementation
and states the reconnect contract the UI relies on.

## Prerequisite

Phase 9 is complete and Phase 10 Milestone 0 established the thin downstream
(overlay identity, zero workbench patches, built-in extension scaffold). This
milestone adds no orchestration, scheduling, validation, Dashboard, Roadmap,
or Master UI changes.

## Requirement mapping

| Milestone task              | Implementation                                                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Core discovery/start        | `IdeCoreConnection.discover()` / `ensureRunning()` + `discoverIdeCoreStatus()` in `apps/ide-extension/src/ide-connection.ts`; shared socket layout in `runtime-paths.ts` |
| Secure local IPC connection | `IdeCoreIpcTransport` in `apps/ide-extension/src/ide-transport.ts`: Unix socket, per-instance token, `0700`/`0600` checks, 1 MiB frame bound, no TCP                     |
| Protocol handshake/version  | `core.status` + `system.bootstrap` check against `PROTOCOL_VERSION` in `IdeCoreConnection`; `assertCompatibleProtocol()` fails closed with `PROTOCOL_VERSION_MISMATCH`   |
| Reconnect                   | `IdeCoreConnection.reconnect()` / `resync()`: disposable socket, durable Core; replay → subscribe → snapshot refresh per `docs/core-v1-protocol.md`                      |
| Event subscription/replay   | `events.subscribe` + `events.replay` loop with `IdeProjectEventCache` dedup (`apps/ide-extension/src/event-cache.ts`); short pages followed via `hasMore`                |
| Connection status           | `IdeCoreConnection.connectionStatus`: `disconnected` / `connecting` / `connected` / `version-mismatch` / `auth-failed`, plus daemon `instanceId`                         |
| Commands through protocol   | `IdeCoreConnection.request()` delegates to `CoreV1Client`; no direct DB, state-transition, or workbench import                                                           |

## Architecture notes

- **Core stays authoritative and editor-independent.** The extension imports
  `@densa-ade/protocol` only — never `@densa-ade/core`, `@densa-ade/cli`,
  SQLite, or `vs/workbench` / `vscode`. `npm run ide:check` and
  `scripts/code-oss-downstream.test.mjs` grep every extension source for those
  imports, and `scripts/ide-core-connection.test.mjs` re-checks the M1 files.
- **Closing the IDE never stops Core.** `disconnect()` / `dispose()` close the
  window socket only. The daemon lifecycle is owned by `densa-ade core start`
  / `stop` and the injected `IdeCoreStarter`; UI loss never mutates project
  truth.
- **Notifications are hints.** `core.event` payloads are validated and applied
  through the per-project cache. Unknown shapes are ignored; authoritative
  state always comes from `events.replay` / `projects.get` / `dashboard.get`.
- **Thin-fork ordering (AGENTS.md §1.3)** is unchanged: zero workbench patches
  at M1. The connection lives entirely in the built-in extension.

## Acceptance mapping

| Acceptance criterion                                          | Evidence                                                                                                                    |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Open/close/reopen while a fake long-running project continues | `scripts/ide-core-connection.test.mjs`: daemon stays `running` after `disconnect()`; second client connects and replays     |
| Reconnect catches up via event replay                         | Same suite: events appended while disconnected are replayed from `lastAppliedSequence`; `resync()` refreshes `projects.get` |
| Protocol mismatch shows a clear error, no state corruption    | Same suite: `99.0.0` envelope fails with `PROTOCOL_VERSION_MISMATCH`; cache sequence unchanged; `assertCompatibleProtocol`  |
| No duplicate event application after reconnect                | Same suite: `IdeProjectEventCache` dedups replay pages + notifications; second replay/subscribe applies zero new facts      |

## Deferred (not in M1)

Home/Welcome actions (M2), Activity Bar/commands and custom editor surfaces
(M3), Dashboard/Roadmap/Master UI (Phase 11), onboarding/settings/Open VSX
(Phase 12), Sparkle updater and packaging (Phase 13).
