# Master Agent UI (Phase 11 Milestone 2)

The Master Agent surface answers: "What should happen next, and why?" It
renders as the full `densa-ade.master` editor-area tab beside source tabs
(contributed in Phase 10 Milestone 3), never cramped into a narrow chat
sidebar. This milestone adds its content model
(`apps/ide-extension/src/master.ts`).

## Prerequisite

Phase 9 is complete, Phase 10 Milestones 0–3 established the thin
downstream (overlay identity, zero workbench patches), the protocol-only
IDE↔Core connection (discovery/start, handshake, reconnect, replay), the
Home/Welcome actions over Core truth, and the Dashboard/Roadmap/Master
navigation shells, and Phase 11 Milestones 0–1 added the Roadmap content
model and Dashboard command center. This milestone adds no orchestration,
scheduling, validation, or Core-protocol changes beyond the Master content
model.

## Requirement mapping

| Milestone item                                                    | Implementation                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversation/control surface with example prompts                 | `MASTER_EXAMPLE_PROMPTS` covers "Why did you change the roadmap?", "Don't use Firebase anywhere.", "Add mobile support before QA.", "Pause after authentication.", "What is blocking us?", "Switch to Continuous after this phase." with expected intents                                                                   |
| Distinguish explanation from proposed state change                | `classifyMasterAction()` maps `respond` to `explanation` and every other action kind to `roadmap_proposal` / `constraint_proposal` / `revision_resolution` / `control_request`; `buildMasterModel()` renders `isExplanation` distinctly and `requiresApproval` only for non-explanations                                    |
| Show proposed roadmap/constraint changes before required approval | Turn views carry verbatim `response`, `citations`, `actionKind`, `affectedPhaseIds`/`affectedTaskIds`/`affectedDecisionIds`, `proposalEventId` (from Core `commandDetails` when present), and `commandStatus`; `approvalMethod` points at `roadmaps.revisions.resolve` / `decisions.list` as applicable                     |
| Link to affected tasks/phases/decisions                           | `resolveMasterDrilldown()` and `resolveMasterCitationDrilldown()` map citations to `phases.report.get`, `attempts.list`, `validation.list`/`validation.get`, `decisions.list`, `roadmaps.get`/`roadmaps.revisions.list`, `projects.get`, `events.replay` with persisted IDs                                                 |
| Never apply scope changes solely from assistant prose             | `MASTER_LIFECYCLE.optimisticComplete` is `false`; `resolveMasterSend()` returns only `master.send` (never a direct apply); roadmap approval resolves separately to `roadmaps.revisions.resolve`; scope without a Core `APPLIED` outcome stays `requiresApproval`                                                            |
| Stale proposal revalidated before application                     | `isMasterStaleOutcome()` + `reconcileMasterStaleOutcome()` prescribe refresh of `projects.get`, `events.replay`, `decisions.list`, `roadmaps.revisions.list` and retry from new state; stale phase/task citations throw with a refresh hint                                                                                 |
| Closing conversation does not lose durable decisions              | `MASTER_LIFECYCLE.closeDisposes` is `view-handle-only` with `coreContinuesAfterClose`; `resolveMasterReopenRefresh()` re-reads `projects.get` + `events.replay` + `decisions.list` + `roadmaps.revisions.list`; transcript is local, decisions persist in Core                                                              |
| Worker logs are not dumped into Master chat by default            | `MASTER_OPEN_REFRESH_METHODS` is `projects.get` only (no `master.send`, no `logs.list`); `MASTER_LIFECYCLE.workerLogsIncludedByDefault` is `false`; `masterEventIsRefreshHint()` ignores `run.log.appended`; worker detail needs explicit `resolveMasterDrilldown({kind:"worker-logs", confirmed:true})` with persisted IDs |

## Architecture notes

- **Core stays authoritative and editor-independent.** `master.ts` imports
  `@densa-ade/protocol` types only — never `@densa-ade/core`,
  `@densa-ade/cli`, SQLite, or `vscode` / `vs/workbench`.
  `npm run ide:check` greps every extension source (including `master.ts`)
  for those imports.
- **No invented state.** The model takes only a `projects.get` snapshot plus
  already-received Core `master.send` turns and an explicit session.
  Project-boundary crossings, unknown phase/task citations, moved rows, and
  duplicate turn ids throw with a "refresh … before rendering/retrying"
  hint instead of fabricating a fact. Opening never auto-sends.
- **Optimistic UI cannot apply scope.** Resolvers return Core request
  payloads to send; only Core `proposal`/`commandStatus` outcomes change the
  model. `resolveMasterSend()` never returns a revision-apply payload;
  `resolveMasterRoadmapResolve()`, `resolveMasterPause()`,
  `resolveMasterResume()`, and `resolveMasterModeChange()` each require an
  explicit actor/reason (and rationale/session where applicable).
- **Stale requests reconcile cleanly.** A Core `STALE` outcome (or a
  snapshot-disagreement throw) reconciles via
  `reconcileMasterStaleOutcome()`: refresh the reopen set, rebuild the
  model, and retry from the new revision/sequence. `isMasterStaleOutcome()`
  identifies the outcome.
- **Durable decisions outlive the transcript.** Closing disposes the local
  transcript handle only. Roadmap revisions, constraints, mode, and pause
  state persist in Core and are re-read on reopen. Live `core.event`
  notifications are refresh hints; `run.log.appended` is ignored by Master
  chat by default.
- **Thin-fork ordering (AGENTS.md §1.3)** is unchanged: zero workbench
  patches. Master content lives entirely in the built-in extension via the
  M3 `densa-ade.master` editor tab. No visual polish beyond the content
  model by design; phase rundowns and live-run UX arrive in later Phase 11
  milestones.

## Acceptance mapping

| Acceptance criterion                                   | Evidence                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Proposal/approval flow is clear                        | `scripts/master-agent-ui.test.mjs`: explanation vs roadmap/constraint/control turns assert distinct `kind`/`isExplanation`/`requiresApproval`/`approvalMethod`; `resolveMasterSend` returns only `master.send`; explicit resolve/pause/resume/mode resolvers execute live against Core     |
| Stale proposal is revalidated before application       | Same suite: synthetic `STALE` turn plus live-Core `STALE` via outdated `baseRevisionNumber` assert `isMasterStaleOutcome`, `reconcileMasterStaleOutcome` refresh set, and rebuilt-model retry carries the new revision; unknown citations throw with refresh hints                         |
| Closing does not lose durable decisions                | Same suite: `MASTER_LIFECYCLE` asserts plus live-Core round-trip (build, `master.send`, rebuild, dispose, reopen-refresh, rebuild) asserting `decisions.list` / `roadmaps.revisions.list` / `events.replay` facts survive transcript disposal                                              |
| Worker logs are not dumped into Master chat by default | Same suite: open-refresh excludes `master.send` and `logs.list`; `workerLogsIncludedByDefault` is `false`; `masterEventIsRefreshHint("run.log.appended")` is `false`; unscoped `worker-logs` drill-down throws and only scoped `confirmed:true` with persisted IDs resolves to `logs.list` |

## Deferred (not in M2)

Phase-completion rundown UX (M3), pause/intervene/live-run UX (M4),
onboarding/settings/Open VSX (Phase 12), Sparkle updater and packaging
(Phase 13). The Master model exposes `phases.report.get`,
`attempts.list`, `validation.list`/`validation.get`, and event replay
capabilities for those surfaces but implements no rundown/run-control
content.
