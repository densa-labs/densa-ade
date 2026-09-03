# Pause/intervene/live-run UX (Phase 11 Milestone 4)

Live autonomous execution answers: "What is running right now, and how do I
stay in control?" The surface exposes Pause, Cancel current run (where
supported), Stop Project, Open current task, View Agent Run, View Changes,
and Resume after intervention, while rendering the current lifecycle state
accurately (`RUNNING`, `VALIDATING`, `RETRYING`, `WAITING_FOR_USAGE`,
`WAITING_FOR_USER`, `BLOCKED`, and the rest verbatim). This milestone adds
its content model (`apps/ide-extension/src/live-run.ts`).

## Prerequisite

Phase 9 is complete, Phase 10 Milestones 0–3 established the thin
downstream (overlay identity, zero workbench patches), the protocol-only
IDE↔Core connection (discovery/start, handshake, reconnect, replay), the
Home/Welcome actions over Core truth, and the Dashboard/Roadmap/Master
navigation shells, and Phase 11 Milestones 0–3 added the Roadmap content
model, Dashboard command center, Master Agent UI, and phase-completion
rundown. This milestone adds no orchestration, scheduling, validation, or
Core-protocol changes beyond the live-run content model.

## Requirement mapping

| Milestone item                                    | Implementation                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pause / Stop Project / Resume after intervention  | `resolveLiveRunPause()` → `projects.pause`; `resolveLiveRunStop()` → `projects.stop`; `resolveLiveRunResume()` → `projects.resume` with optional `acknowledgeIntervention`. Payloads carry the persisted `projectId`/`workspacePath` plus an explicit actor; only Core outcomes change what is shown                                     |
| Cancel current run where supported                | `resolveLiveRunCancel()` → the daemon-supported `project.cancel` transport alias (same payload shape as `projects.pause`; see `docs/execution-controls.md`) with frozen `projects.pause` as the fallback for strictly-v1 transports. Cancel aborts the worker through Core, leaves the task `INTERRUPTED`, and never orphans the process |
| Open current task / View Agent Run / View Changes | `resolveLiveRunDrilldown()` → `attempts.list` (current task), `logs.list` scoped by persisted phase/task/attempt IDs (agent run; unscoped fetches throw), `git.status` / `git.commit.get` (changes). Validation, phase-report, usage, and event drill-downs reuse the same frozen catalog                                                |
| Accurate lifecycle states                         | `buildLiveRunModel()` derives `lifecycle.kind` from the authoritative project state plus the current task state (`RUNNING`+`VALIDATING` → validating, `RETRYING` → retrying, `PAUSED` → paused, waits/blocked verbatim, pre-start states → idle). All states render verbatim, never remapped                                             |
| Paused workspace edits detected before resume     | A `PAUSED` project with observed `git.status` changes (or a Core `INTERVENTION_REQUIRED` outcome) sets `intervention.detected` with changed paths and `resumeRequiresAck`; the notice explains resume revalidates and recontextualizes while preserving manual edits. Resume without acknowledgement returns `INTERVENTION_REQUIRED`     |

## Architecture notes

- **Core stays authoritative and editor-independent.** `live-run.ts`
  imports `@densa-ade/protocol` types only — never `@densa-ade/core`,
  `@densa-ade/cli`, SQLite, or `vscode` / `vs/workbench`.
  `npm run ide:check` greps every extension source (including
  `live-run.ts`) for those imports.
- **No invented state.** The model takes only a `projects.get` snapshot
  plus an optional `dashboard.get` aggregate, `git.status` observation,
  and the last verbatim Core control outcome. Project-boundary
  disagreements, missing runtime rows, unknown states, and unscoped log
  requests throw with a "refresh … before rendering" hint instead of
  fabricating a fact.
- **Optimistic UI cannot change lifecycle state.**
  `LIVE_RUN_LIFECYCLE.optimisticComplete` is `false`. Resolvers return Core
  request payloads to send; `applyLiveRunControlOutcome()` never edits the
  snapshot model — it returns a refresh recipe plus a notice, and the
  caller rebuilds from fresh Core reads. `UNCHANGED` outcomes are reported
  as idempotent no-ops.
- **Intervention is reported, never auto-resolved.** The IDE never
  overwrites manual edits; acknowledgement is an explicit resume field
  that Core enforces before rebuilding the next Task Packet.
- **Thin-fork ordering (AGENTS.md §1.3)** is unchanged: zero workbench
  patches. Live-run content lives entirely in the built-in extension and
  reuses the M3 `densa-ade.dashboard` editor-area tab. No new
  activity-bar entries and no visual polish beyond the content model by
  design.

## Acceptance mapping

| Acceptance criterion                                      | Evidence                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI commands are idempotent                                | `scripts/live-run-ux.test.mjs`: live-Core round-trip repeats pause and stop and asserts Core returns `UNCHANGED`; `applyLiveRunControlOutcome()` maps it to an idempotent effect that keeps the last refreshed snapshot                                                                                                                               |
| State changes only shown after Core acknowledgment/event  | Same suite: the model rebuilds only from fresh `projects.get`/`dashboard.get` reads after each control outcome; resolvers return payloads, never state edits; `optimisticComplete` is `false`                                                                                                                                                         |
| Cancel does not leave an orphan process                   | Same suite: `resolveLiveRunCancel()` payload drives `ProjectExecutionControlService.cancelCurrentAgent()` against a held-open `FakeAgentAdapter` worker; the run reaches terminal `cancelled`, `cancelledRunIds` records it, the live-worker counter returns to zero, and the project is `PAUSED`                                                     |
| Manual intervention path tested end-to-end with FakeAgent | Same suite: the intervention loop runs end-to-end through a live Core daemon and real Git workspace with no live agent (Core schedules no worker while paused or while intervention is unacknowledged, so no worker exists to be live); the cancel loop runs end-to-end against a held-open `FakeAgentAdapter` worker. No test uses a live paid agent |

## Deferred (not in M4)

Onboarding/settings/Open VSX (Phase 12), Sparkle updater and packaging
(Phase 13). The live-run model exposes `usage.get`, `phases.report.get`,
and event replay capabilities for those surfaces but implements no
settings or recovery-policy content.
