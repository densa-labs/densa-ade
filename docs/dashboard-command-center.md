# Dashboard command center (Phase 11 Milestone 1)

The Dashboard answers: "What is happening to my project?" It renders as the
full `densa-ade.dashboard` editor-area tab beside source tabs (contributed in
Phase 10 Milestone 3), never cramped into a narrow chat sidebar. This
milestone adds its content model
(`apps/ide-extension/src/dashboard.ts`).

## Prerequisite

Phase 9 is complete, Phase 10 Milestones 0–3 established the thin
downstream (overlay identity, zero workbench patches), the protocol-only
IDE↔Core connection (discovery/start, handshake, reconnect, replay), the
Home/Welcome actions over Core truth, and the Dashboard/Roadmap/Master
navigation shells, and Phase 11 Milestone 0 added the Roadmap content model.
This milestone adds no orchestration, scheduling, validation,
Master-content, or Core-protocol changes beyond the Dashboard content model.

## Requirement mapping

| Milestone item                                                                     | Implementation                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PROJECT (status, execution mode, phase/task progress, elapsed runtime where known) | `buildDashboardModel()` projects `dashboard.get` summary (verbatim state/mode, completed/total, phase/task counts, attention flag) plus per-phase progress joined from `projects.get`; elapsed time is `updatedAt - createdAt` only when both parse and order deterministically, otherwise omitted |
| CURRENT (active agent/run, current task/attempt, lifecycle state)                  | Verbatim `currentPhase`/`currentTask` pointers from `dashboard.get` cross-checked against `projects.get` rows; lifecycle state is the authoritative project state; attempt/run detail stays in Core via `attempts.list` / `logs.list` drill-downs                                                  |
| HEALTH (build/typecheck/lint/tests/browser/review as applicable)                   | `dashboard.get` validation totals (`passed`/`failed`/`incomplete`) plus `recentFailureCount`/`retryCount`; detail via `validation.list` / `validation.get`                                                                                                                                         |
| CHANGES (commits, files changed, additions/deletions if available)                 | Optional `git.status` projection (`available`, `headSha`, `branch`, `dirty`, `changedPaths`); commit detail via `git.commit.get`; additions/deletions are explicitly `unavailable` because Core v1 Git views do not report them                                                                    |
| AGENTS/USAGE (backend/version, run counts, usage/reset only if known, retries)     | Backend always `unknown` (Core v1 exposes no adapter version here); run counts are `retryCount`/`recentFailureCount`; `usage` rendered verbatim with `resetAt` only when the persisted observation carries it                                                                                      |
| EVENTS (recent persisted timeline)                                                 | `events.replay` page carried as `recentEvents` plus `latestEventSequence`; live `core.event` notifications are refresh hints via `dashboardEventIsRefreshHint()`                                                                                                                                   |
| Every metric drillable                                                             | `resolveDashboardDrilldown()` maps each section to an existing Core v1 operation (`dashboard.get`, `projects.get`, `events.replay`, `logs.list`, `attempts.list`, `validation.list`/`validation.get`, `git.status`/`git.commit.get`, `usage.get`, `phases.report.get`, `decisions.list`)           |
| Live but reconstructable                                                           | `DASHBOARD_OPEN_REFRESH_METHODS` (`dashboard.get`, `projects.get`, `events.replay`) plus `resolveDashboardReopenRefresh()`; identical snapshots rebuild to identical facts                                                                                                                         |

## Architecture notes

- **Core stays authoritative and editor-independent.** `dashboard.ts`
  imports `@densa-ade/protocol` types only — never `@densa-ade/core`,
  `@densa-ade/cli`, SQLite, or `vscode` / `vs/workbench`.
  `npm run ide:check` greps every extension source (including
  `dashboard.ts`) for those imports.
- **No invented state.** The model takes only `dashboard.get`,
  `projects.get`, an `events.replay` page, and an optional `git.status`
  result plus connection state. Project-ID, workspace-path, progress-total,
  sequence, event/Git-boundary, and current-row disagreements throw with a
  "refresh … before rendering" hint instead of fabricating a fact.
- **No fabricated metrics.** There are no token/cost fields. Usage reset
  appears only when persisted; otherwise the model says unknown and offers
  no countdown. Backend/version is `unknown`. Additions/deletions are
  `unavailable`. Elapsed time appears only when persisted timestamps order
  deterministically.
- **Optimistic UI cannot mark things completed.**
  `DASHBOARD_LIFECYCLE.optimisticComplete` is `false`. Resolvers return Core
  request payloads to send; only Core outcomes and refreshed snapshots
  change the model.
- **WAITING/BLOCKED are explicit.** `WAITING_FOR_USAGE` banners quote the
  persisted usage observation (with reset only when known) and point at
  `usage.get` / `git.status` / opt-in auto-resume settings. `BLOCKED`
  banners count blocked tasks/phases with retries/failures and point at
  `attempts.list` and validation evidence. `WAITING_FOR_USER` banners list
  pending approvals.
- **Thin-fork ordering (AGENTS.md §1.3)** is unchanged: zero workbench
  patches. Dashboard content lives entirely in the built-in extension via
  the M3 `densa-ade.dashboard` editor tab. No visual polish beyond the
  content model by design; Master Agent UI, rundowns, and live-run UX arrive
  in later Phase 11 milestones.

## Acceptance mapping

| Acceptance criterion                                          | Evidence                                                                                                                                                                                           |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reconnect/reload yields the same Dashboard facts              | `scripts/dashboard-command-center.test.mjs`: pure rebuild determinism plus a live-Core round-trip (build, dispose, reconnect, rebuild) asserting identical project/mode/counts/sequence            |
| Tests/retries/commits/events are clickable into detail        | Same suite: every drill-down kind resolves to its Core method and executes live (`attempts.list`, `validation.list`, `usage.get`, `logs.list`, `git.status`, `events.replay`)                      |
| WAITING_FOR_USAGE and BLOCKED states are clear and actionable | Same suite: synthetic limited-with-reset, limited-without-reset, unknown, and blocked fixtures assert banner kind, verbatim reset handling, no countdown fabrication, and Core-backed next actions |

## Deferred (not in M1)

Master Agent UI (M2), phase-completion rundown UX (M3),
pause/intervene/live-run UX (M4), onboarding/settings/Open VSX (Phase 12),
Sparkle updater and packaging (Phase 13). The Dashboard model exposes
`phases.report.get`, `decisions.list`, and event replay capabilities for
those surfaces but implements no Master/run-control content.
