# Phase-completion rundown UX (Phase 11 Milestone 3)

The Phase-by-phase stopping point answers: "Is this phase really done, and
what happens next?" When a phase reaches `AWAITING_APPROVAL` the surface
shows the persisted phase report — title and duration where determinable,
tasks completed, validator/test summary, commits/files changed, key
decisions, roadmap changes, retries/issues, unresolved blockers, and the
next-phase summary — with actions for Inspect Changes, Open Roadmap, Ask
Master Agent, and Start Next Phase. In Continuous mode the same persisted
report remains viewable without blocking unless policy requires it. This
milestone adds its content model
(`apps/ide-extension/src/phase-completion.ts`).

## Prerequisite

Phase 9 is complete, Phase 10 Milestones 0–3 established the thin
downstream (overlay identity, zero workbench patches), the protocol-only
IDE↔Core connection (discovery/start, handshake, reconnect, replay), the
Home/Welcome actions over Core truth, and the Dashboard/Roadmap/Master
navigation shells, and Phase 11 Milestones 0–2 added the Roadmap content
model, Dashboard command center, and Master Agent UI. This milestone adds no
orchestration, scheduling, validation, or Core-protocol changes beyond the
rundown content model.

## Requirement mapping

| Milestone item                                                           | Implementation                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase title and duration if known                                        | `buildPhaseCompletionModel()` projects `phases.report.get` (`phaseTitle`, `phaseStartedAt`, `generatedAt`, `reportPath`) plus the runtime phase row from `projects.get`; duration is `generatedAt - phaseStartedAt` only when both parse and order deterministically, otherwise `durationKnown` is false |
| Tasks completed                                                          | Persisted `tasksCompleted` (`taskId`, `title`, `attemptCount`) rendered verbatim; per-task history stays in Core via `attempts.list`                                                                                                                                                                     |
| Validator/test summary                                                   | Persisted `validations` checks plus `phaseValidation` status/summary, summarized as `validationSummary` (`passed`/`failed`/`total`); detail via `validation.list` / `validation.get`                                                                                                                     |
| Commits/files changed                                                    | Persisted `commits` (`taskId`, `sha`) and `filesChanged` (`taskId`, `paths`) rendered verbatim; workspace overview via `git.status`, per-commit detail via `git.commit.get` (SHA must name a reported commit)                                                                                            |
| Key decisions                                                            | Persisted `importantDecisions` rendered verbatim; full history stays in Core via `decisions.list`                                                                                                                                                                                                        |
| Roadmap changes                                                          | Persisted `roadmapChanges` rendered verbatim; full history stays in Core via `roadmaps.revisions.list`                                                                                                                                                                                                   |
| Retries/issues                                                           | Persisted `retriesAndFailures` rendered verbatim                                                                                                                                                                                                                                                         |
| Unresolved blockers                                                      | Persisted `unresolvedIssues` rendered verbatim; `hasUnresolvedBlockers` is true when issues remain, the outcome is `blocked`, or phase validation `failed`                                                                                                                                               |
| Next phase summary                                                       | Persisted `reportedNextPhase` from the report plus `liveNextPhase` (`id`, `title`, `state`, `position`) derived from the current snapshot ordering                                                                                                                                                       |
| Inspect Changes / Open Roadmap / Ask Master Agent / Start Next Phase     | `resolvePhaseCompletionInspectChanges()` → `git.status`; `resolvePhaseCompletionOpenRoadmap()` → `roadmaps.get` + `densa-ade.showRoadmap`; `resolvePhaseCompletionMasterAsk()` → `master.send` + `densa-ade.showMasterAgent`; `resolvePhaseCompletionPhaseApproval()` → `phases.approve`                 |
| Continuous saves the same report without blocking unless policy requires | `liveExecutionMode` comes from the snapshot; `continuousStored` is true in Continuous mode; `blocksForApproval` is true only while the runtime phase is `AWAITING_APPROVAL` (Continuous persists `COMPLETED`, so the same report renders non-blocking)                                                   |

## Architecture notes

- **Core stays authoritative and editor-independent.** `phase-completion.ts`
  imports `@densa-ade/protocol` types only — never `@densa-ade/core`,
  `@densa-ade/cli`, SQLite, or `vscode` / `vs/workbench`.
  `npm run ide:check` greps every extension source (including
  `phase-completion.ts`) for those imports.
- **No invented state.** The model takes only a `phases.report.get` record
  plus a `projects.get` snapshot and connection state. Project-ID
  mismatches, missing runtime rows, cross-boundary rows, missing workspace
  paths, unknown commit SHAs, and unknown report task IDs throw with a
  "refresh … before rendering" hint instead of fabricating a fact. Duration
  appears only when persisted timestamps order deterministically.
- **Optimistic UI cannot mark things completed.**
  `PHASE_COMPLETION_LIFECYCLE.optimisticComplete` is `false`. Resolvers
  return Core request payloads to send; only Core outcomes and refreshed
  snapshots change the model. `resolvePhaseCompletionPhaseApproval()`
  refuses any phase not already in `AWAITING_APPROVAL`, and an `approve`
  decision additionally requires persisted `phaseValidation.status` to be
  `passed`.
- **Reports outlive the view.** `PHASE_COMPLETION_LIFECYCLE.closeDisposes`
  is `view-handle-only` with `coreContinuesAfterClose`;
  `resolvePhaseCompletionReopenRefresh()` re-reads `phases.report.get` and
  `projects.get` and rebuilds. Live `core.event` notifications are refresh
  hints via `phaseCompletionEventIsRefreshHint()`; `run.log.appended` is
  ignored so worker transcripts never spill into the rundown without an
  explicit `run-logs` drill-down.
- **Thin-fork ordering (AGENTS.md §1.3)** is unchanged: zero workbench
  patches. Rundown content lives entirely in the built-in extension and
  reuses the M3 `densa-ade.roadmap` / `densa-ade.dashboard` editor tabs and
  the `densa-ade.showRoadmap` / `densa-ade.showMasterAgent` commands. No new
  activity-bar entries and no visual polish beyond the content model by
  design; pause/intervene/live-run UX arrives in M4.

## Acceptance mapping

| Acceptance criterion                                          | Evidence                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Report facts come from persisted state                        | `scripts/phase-completion-rundown.test.mjs`: synthetic report + snapshot fixtures assert every section projects the persisted values verbatim, and project/phase-boundary disagreements throw instead of inventing state                                                                         |
| Start Next Phase is unavailable until phase validation passed | Same suite: `canStartNextPhase` is true only at `AWAITING_APPROVAL` with `phaseValidation.status === "passed"`; `resolvePhaseCompletionPhaseApproval({decision:"approve"})` throws otherwise, while `reject` remains available at the boundary; a live-Core round-trip executes `phases.approve` |
| Continuous still stores/viewable phase reports                | Same suite: a Continuous-mode snapshot with a persisted `completed` report builds with `continuousStored === true` and `blocksForApproval === false` while exposing identical report facts                                                                                                       |
| Report remains available after restart                        | Same suite: live-Core round-trip (build, dispose the IDE connection, reconnect, rebuild) asserts identical phase/report/mode/counts/sequence; the reopen recipe refreshes `phases.report.get` + `projects.get`                                                                                   |

## Deferred (not in M3)

Pause/intervene/live-run UX (M4), onboarding/settings/Open VSX (Phase 12),
Sparkle updater and packaging (Phase 13). The rundown model exposes
`attempts.list`, `validation.list`/`validation.get`, `logs.list`,
`decisions.list`, `roadmaps.revisions.list`, and event replay capabilities
for those surfaces but implements no run-control content.
