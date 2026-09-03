# Roadmap UI (Phase 11 Milestone 0)

The Roadmap surface answers: "What is going to happen, and where are we?"
It renders as the full `densa-ade.roadmap` editor-area tab beside source tabs
(contributed in Phase 10 Milestone 3), never cramped into a narrow chat
sidebar. This milestone adds its content model (`apps/ide-extension/src/roadmap.ts`).

## Prerequisite

Phase 9 is complete and Phase 10 Milestones 0–3 established the thin
downstream (overlay identity, zero workbench patches), the protocol-only
IDE↔Core connection (discovery/start, handshake, reconnect, replay), the
Home/Welcome actions over Core truth, and the Dashboard/Roadmap/Master
navigation shells. This milestone adds no orchestration, scheduling,
validation, Master-content, or Core-protocol changes beyond the Roadmap
content model.

## Requirement mapping

| Milestone item                | Implementation                                                                                                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overall phase structure       | `buildRoadmapModel()` joins `roadmaps.get` plan phases (order, titles, goals, required) with `projects.get` runtime phases (state, position) by stable ID                                                                       |
| Phase/task states             | Runtime `PhaseState`/`TaskState` rendered verbatim; `ROADMAP_CANONICAL_PHASE_STATES`/`ROADMAP_CANONICAL_TASK_STATES` assert the AGENTS.md §2.3/§2.4 vocabularies                                                                |
| Dependencies                  | Plan `dependencyIds` plus runtime-derived `blockedBy` (incomplete deps); no array-order guessing                                                                                                                                |
| Acceptance criteria           | Persisted runtime `acceptanceCriteria` (falling back to the plan only when no runtime row exists for a non-executable task)                                                                                                     |
| Current task/attempt          | `currentPhaseId` (first non-`COMPLETED` phase) and `currentTaskId` (first `RUNNING`/`VALIDATING`/`RETRYING`/`WAITING_FOR_USER`/`WAITING_FOR_USAGE` task, mirroring Dashboard); attempt detail stays in Core via `attempts.list` |
| Task history                  | `resolveRoadmapDrilldown({kind:"attempts"})` → `attempts.list` with persisted `projectId`/`taskId`                                                                                                                              |
| Roadmap mutations/reasons     | `roadmaps.revisions.list` projected to `RoadmapRevisionView` (classification, reason, actor, timestamp, affected phases/tasks, operation kinds, approval presence)                                                              |
| Phase completion criteria     | Plan `completionCriteria` per phase plus `phases.report.get` drill-down for evidence                                                                                                                                            |
| Select phase/task             | Pure validated selection in `buildRoadmapModel()`; unknown or cross-phase IDs throw with a refresh hint                                                                                                                         |
| Inspect attempt history       | `resolveRoadmapDrilldown({kind:"attempts"})`                                                                                                                                                                                    |
| Inspect acceptance evidence   | `resolveRoadmapDrilldown({kind:"validation-runs"})` → `validation.list`, then `({kind:"validation-detail"})` → `validation.get`                                                                                                 |
| Request allowed roadmap edits | `resolveRoadmapPropose()` → `roadmaps.revisions.propose` and `resolveRoadmapResolve()` → `roadmaps.revisions.resolve` (the same Core revision flow the Master Agent uses)                                                       |
| Approve next phase            | `resolveRoadmapPhaseApproval()` → `phases.approve`, enabled only when the modeled phase is already `AWAITING_APPROVAL`                                                                                                          |

## Architecture notes

- **Core stays authoritative and editor-independent.** `roadmap.ts` imports
  `@densa-ade/protocol` types only — never `@densa-ade/core`, `@densa-ade/cli`,
  SQLite, or `vscode` / `vs/workbench`. `npm run ide:check` greps every
  extension source (including `roadmap.ts`) for those imports.
- **No invented state.** The model takes only `roadmaps.get`,
  `projects.get`, and `roadmaps.revisions.list` results plus an explicit
  selection. Project-ID mismatches, missing runtime rows, moved rows, and
  unknown selection IDs throw with a "refresh … before rendering/retrying"
  hint instead of fabricating a state. Non-executable plan tasks may have no
  runtime row; executable tasks must have one.
- **Optimistic UI cannot mark things completed.** `ROADMAP_LIFECYCLE.optimisticComplete`
  is `false`. Resolvers return Core request payloads to send; only Core
  outcomes and `core.event` notifications change the model. Phase approval
  additionally refuses any phase not already in `AWAITING_APPROVAL`.
- **Audit history is always shown.** Every revision view keeps its
  classification, reason, actor, timestamp, affected phase/task IDs,
  operation kinds, and approval presence. `oldValue`/`newValue` payloads stay
  in Core; the view never rewrites them.
- **Stale requests reconcile cleanly.** Proposals carry the model's current
  `revisionNumber` as `baseRevisionNumber`. A Core `STALE` outcome (or a
  snapshot-disagreement throw) reconciles via
  `reconcileRoadmapStaleOutcome()`: refresh `roadmaps.get`, `projects.get`,
  and `roadmaps.revisions.list`, rebuild the model, and retry from the new
  revision. `isRoadmapStaleOutcome()` identifies the outcome.
- **Thin-fork ordering (AGENTS.md §1.3)** is unchanged: zero workbench
  patches. Roadmap content lives entirely in the built-in extension via the
  M3 `densa-ade.roadmap` editor tab. No visual polish beyond the content
  model by design; Dashboard, Master Agent UI, rundowns, and live-run UX
  arrive in later Phase 11 milestones.

## Acceptance mapping

| Acceptance criterion                                   | Evidence                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixture project renders all canonical states           | `scripts/roadmap-ui.test.mjs`: synthetic `roadmaps.get` + `projects.get` fixture covers every canonical phase state (7) and task state (11) verbatim, plus dependencies, acceptance criteria, current task, revisions, and completion criteria                                            |
| Phase approval transitions through Core                | Same suite (live Core): a real daemon project is driven to `AWAITING_APPROVAL` through the centralized transition service, the model resolves `phases.approve` through `IdeCoreConnection`, and Core returns `APPROVED` with the phase `COMPLETED`                                        |
| Invalid/stale mutation request gets reconciled cleanly | Same suite (live Core): a proposal against an outdated `baseRevisionNumber` returns `STALE`; `reconcileRoadmapStaleOutcome()` prescribes the refresh set, and a rebuilt model retries from the new revision; unknown selection IDs and premature phase approvals throw with refresh hints |

## Deferred (not in M0)

Dashboard command center (M1), Master Agent UI (M2), phase-completion
rundown UX (M3), pause/intervene/live-run UX (M4), onboarding/settings/Open
VSX (Phase 12), Sparkle updater and packaging (Phase 13). The Roadmap model
exposes `phases.report.get`, `tasks.approve`, and event replay capabilities
for those surfaces but implements no Dashboard/Master/run-control content.
