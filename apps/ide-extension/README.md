# Densa ADE IDE extension (built-in)

Protocol-only IDE client for the thin Code-OSS downstream. Phase 10 Milestone 0
established the package boundary; Phase 10 Milestone 1 connects the IDE to the
existing Core daemon; Phase 10 Milestone 2 adds the Home/Welcome actions;
Phase 10 Milestone 3 adds the Dashboard/Roadmap/Master navigation shells.
Phase 11 Milestone 0 adds the Roadmap content model, Milestone 1 the
Dashboard command center, Milestone 2 the Master Agent UI, Milestone 3 the
phase-completion rundown, and Milestone 4 the pause/intervene/live-run UX.
Phase 12 Milestone 0 adds first-launch onboarding and the resize transition.
Phase 12 Milestone 1 adds the Open VSX extension gallery experience.

## Boundary (AGENTS.md §1.1–§1.2)

- Imports `@densa-ade/protocol` only. Never `@densa-ade/core`, `@densa-ade/cli`,
  SQLite repositories, daemon internals, or Code-OSS workbench APIs.
- Densa ADE Core is authoritative. The extension renders Core snapshots and sends
  versioned protocol requests; it never mutates project truth locally and never
  marks tasks complete optimistically.
- Connection uses the local Unix-domain socket + per-instance auth token with
  `protocolVersion` handshake, reconnect, and event replay from a sequence number
  (see `src/ide-connection.ts`, `src/ide-transport.ts`, and
  `docs/core-v1-protocol.md`).

## Connection (M1)

- Discovery: probe `core.status` on the shared runtime socket
  (`~/.densa-ade/runtime` or `DENSA_CORE_RUNTIME_DIR`). Missing socket with no
  live owner PID means `stopped`; a live owner with no endpoint is an explicit
  error.
- Start: `IdeCoreConnection.ensureRunning()` delegates to an injected starter
  (production shells to `densa-ade core start`). The extension never spawns Core
  by importing it.
- Handshake: `core.status` + `system.bootstrap` version check. Mismatch fails
  closed with `PROTOCOL_VERSION_MISMATCH` and leaves cached truth untouched.
- Reconnect: the socket is disposable, Core is durable. Reconnect replays from
  the last applied per-project sequence (`events.replay` loop), re-subscribes
  (`events.subscribe`), and refreshes the authoritative snapshot
  (`projects.get`) before the next mutation. Duplicates are ignored, gaps
  require a fresh replay.
- `disconnect()` closes the IDE window only. Core keeps running while project
  policy allows it; connection loss never changes project truth.

## Contributions (M0 scaffold, M2 welcome, M3 navigation shells)

- Command palette group `Densa ADE`: Open Dashboard / Roadmap / Master Agent,
  Start Project, Resume Project. Every command shares the category so the
  palette group stays coherent.
- Activity Bar container `densa-ade` with Dashboard / Roadmap /
  Master Agent launcher views. Launchers navigate; they do not host content.
- Editor-area tabs (M3): `densa-ade.dashboard`, `densa-ade.roadmap`, and
  `densa-ade.master` custom-editor viewTypes opened via the surface commands,
  rendered beside source tabs (`priority: option`, never a default file
  association). Opening Dashboard/Roadmap refreshes the authoritative Core
  snapshot (`dashboard.get` / `roadmaps.get`) for the selected persisted
  project; opening Master Agent never auto-sends (`src/surfaces.ts`).
  Closing or reopening a tab never affects Core execution. No visual polish
  yet; surface content arrives in Phase 11.
- Welcome/Home (M2): familiar `Open Folder` / `Open File` / `New Window`
  workbench commands stay usable without Core; Densa ADE entries resolve to the
  existing Core v1 operations (`projects.create`, `dashboard.get`,
  `roadmaps.get`, `master.send`, `projects.resume`, `projects.list`) via
  `src/welcome.ts`. Unavailable project actions explain what is needed; the IDE
  never invents project state. See `docs/densa-welcome-home.md`.
- Navigation shells (M3): see `docs/ide-navigation-surfaces.md`.
- Roadmap UI (Phase 11 M0): see `docs/roadmap-ui.md` (`src/roadmap.ts`).
- Dashboard command center (Phase 11 M1): see `docs/dashboard-command-center.md`
  (`src/dashboard.ts`).
- Master Agent UI (Phase 11 M2): conversation/control surface over
  `master.send` with explanation vs proposal distinction, explicit
  roadmap/constraint approval, stale revalidation, durable decisions, and no
  worker-log dumping by default (see `docs/master-agent-ui.md` and
  `src/master.ts`).
- Phase-completion rundown (Phase 11 M3): persisted `phases.report.get`
  stopping point with gated Start Next Phase approval (see
  `docs/phase-completion-rundown.md` and `src/phase-completion.ts`).
- Pause/intervene/live-run UX (Phase 11 M4): Pause, immediate Cancel, Stop,
  current-task/agent-run/changes drill-downs, and acknowledge-to-resume
  intervention over Core truth with no optimistic state changes (see
  `docs/live-run-ux.md` and `src/live-run.ts`).
- First-launch onboarding (Phase 12 M0): compact `densa-ade.onboarding` window
  via `densa-ade.showOnboarding` checks Codex, Codex auth (unknown unless
  reliably observed), Git, and the product defaults (Phase-by-phase, Standard,
  keep-awake on, telemetry off), then resizes to the full workspace without
  creating a second authoritative state (see `docs/onboarding.md` and
  `src/onboarding.ts`). Missing Codex gives install/setup guidance without
  blocking basic editing.
- Extension gallery (Phase 12 M1): Open VSX Registry endpoints from
  `code-oss/product.overlay.json` with settings/about labeling, pure
  search/install/enable/remove/update gating, and understandable
  Marketplace-only/offline explanations that never claim Microsoft
  Marketplace compatibility (see `docs/open-vsx-gallery.md` and
  `src/extensions-gallery.ts`). The built-in extension works without
  registry access.
- No binary icons. The container uses the `$(placeholder)` codicon until product
  polish.

## Layout

```text
apps/ide-extension/
├── package.json   # contributes.commands/views/customEditors, engines.vscode, protocol-only deps
├── tsconfig.json  # composite build, references @densa-ade/protocol
└── src/
    ├── index.ts         # extension id, product binding, commands/views, summary
    ├── connection.ts    # Core socket options + protocol version guard (M0)
    ├── runtime-paths.ts # shared socket/pid/token layout, no Core import (M1)
    ├── ide-transport.ts # authenticated IPC transport, reconnectable (M1)
    ├── event-cache.ts   # replay dedup + gap detection per project (M1)
    ├── ide-connection.ts # discovery/start, handshake, replay/subscribe (M1)
    ├── welcome.ts       # Home/Welcome catalog over Core truth, no invented state (M2)
    ├── surfaces.ts      # Dashboard/Roadmap/Master editor-area shells, disposable views (M3)
    ├── roadmap.ts       # Roadmap content model over Core truth (P11M0)
    ├── dashboard.ts     # Dashboard command center over Core truth (P11M1)
    ├── master.ts        # Master Agent UI over Core truth, no worker-log dumping (P11M2)
    ├── phase-completion.ts # Phase-completion rundown over Core truth (P11M3)
    ├── live-run.ts      # Pause/intervene/live-run UX over Core truth (P11M4)
    ├── onboarding.ts    # First-launch onboarding + resize transition (P12M0)
    └── extensions-gallery.ts # Open VSX registry model, labeling, gating (P12M1)
```

## Verification

```sh
npm run build       # includes apps/ide-extension via project references
npm run ide:check   # validates manifest deps + protocol-only imports
npm test            # runs scripts/code-oss-downstream.test.mjs + ide-core-connection.test.mjs
```

## Licensing

Densa-written extension code is Apache-2.0 (`SPDX-License-Identifier: Apache-2.0`).
Upstream Code-OSS remains MIT; see `THIRD_PARTY_NOTICES.md`.
