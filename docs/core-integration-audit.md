# Densa Core Integration Audit Report

Prompt: `docs/core-integration-audit-prompt.md` (constructed and saved before inspection began; executed immediately in the same turn).
Checkout: `main`, sealed audit of Core as one composed system (not phase-by-phase).

## 1. Summary

Reconstructed Densa Core from current source, evaluated cross-subsystem interactions across
lifecycle, persistence, daemon/IPC, planning, validation, workspace/Git, and cross-cutting
services. Built 14 cross-component scenarios (S1–S14), inspected actual implementation paths,
classified 3 confirmed integration defects, fixed all 3 with failing-first regression coverage
(`scripts/core-integration-audit.test.mjs`, 3 tests), updated one existing fixture that relied
on the old bypass, reran full validation (`npm run check`: 464 tests, 461 pass, 0 fail,
3 skipped), and re-evaluated affected invariants jointly.

## 2. Reconstructed architecture

Modules (current `packages/core/src`):

- Boundary: `core-runtime-mutations.ts` (writes), `core-runtime-views.ts` (reads),
  `core-runtime-state.ts` (`CoreRuntimeStore`, `workspace()` binding, `paginate`),
  `daemon.ts` (`CoreDaemon`, `CoreIpcClient`, `CoreDaemonManager`), protocol
  (`@densa-ade/protocol` catalog/schemas).
- Lifecycle: `state-transitions.ts`, `execution-control.ts`, `execution-modes.ts`,
  `execution-slot.ts`, `scheduler.ts`, `task-orchestrator.ts`, `phase-orchestrator.ts`,
  `usage-auto-resume.ts`, `keep-awake.ts`, `recovery-inspector.ts`, `run-checkpoint.ts`,
  `attempt-rollback.ts`.
- Planning: `project-specification.ts`, `master-roadmap.ts`, `roadmap-mutations.ts`,
  `roadmap-revision-workflow.ts`, `project-decisions.ts`, `task-packet.ts`,
  `adaptive-interview.ts`, `master-agent.ts`.
- Workspace/Git: `workspace-preflight.ts`, `isolated-run-workspace.ts`,
  `validation-workspace.ts`, `project-workspace.ts`, `run-checkpoint.ts`,
  `attempt-rollback.ts`, `task-commit.ts`, `task-publication.ts`, `guarded-publication.ts`.
- Validation: `validation-pipeline.ts`, `project-validation-detector.ts`,
  `acceptance-evidence.ts`, `independent-review.ts`, `task-proof-harness.ts`,
  `headless-one-phase-proof.ts`, `browser-validation.ts`, `browser-process-owner.ts`.
- Persistence: `persistence/database.ts` (`persistStateTransition` atomic state+event),
  `persistence/repositories.ts`, `persistence/event-journal.ts`, `event-publisher.ts`,
  `persistence/roadmap-runtime.ts` (positions re-normalized contiguously on every sync),
  `persistence/portable-project.ts`, `persistence/migrations.ts`.
- Cross-cutting: `permission-policy.ts`, `secrets.ts`, `secret-redaction.ts`,
  `recovery-inspector.ts`, `rundown.ts`, `execution-control.ts` error taxonomy
  (`CoreRuntimeError` → `CoreIpcError` → wire).

```text
CLI / IDE / Dashboard
        |  versioned authenticated IPC (Unix socket 0600, token timing-safe, 1MiB frames)
        v
   CoreDaemon (#dispatchCoreV1 -> Views | Mutations | ExecutionControl | events)
        +-- CoreRuntimeStore (project + coreRuntime settings + workspace() realpath binding)
        +-- StateTransitionService + persistStateTransition (conditional UPDATE + event, one txn)
        +-- ExecutionControl (pause/resume/stop/cancel, finalize, recovery gates)
        +-- Scheduler / Task+Phase orchestrators / UsageAutoResume / KeepAwake
        +-- Planning (spec -> roadmap -> revisions/decisions/packets)
        +-- Validation (pipeline -> acceptance -> review -> commit -> report -> approve)
        +-- Workspace/Git (preflight -> checkpoint -> isolated run -> guarded publish -> commit)
        +-- SQLite (authoritative) / events (append-only) / .densa-ade/ (projection, non-secret)
```

Trust boundaries: client↔daemon (auth, user-only perms, no symlink, stale PID/socket recovery,
single-startup lock); daemon↔DB (ownsDatabase close semantics, BEGIN IMMEDIATE txns, deferred
publish-after-commit); Core↔workspace/Git (canonical `realpath` binding, preflight read-only,
no destructive cleanup, no push); Core↔adapter (structured output only, no self-certification);
Core↔validation (deterministic first, commit-gated COMPLETED); Core↔projection (SQLite truth,
events facts, `.densa-ade/` inspectable).

State boundaries/sources of truth: SQLite rows (authoritative runtime); `project_settings`
`coreRuntime` (`workspacePath` immutable, `initialization`, `executionRequested`,
`taskApproval`/`phaseApproval` hints — write-only, never read for decisions);
`executionControl` (paused/stopped/running + snapshot); `keepAwake` (reasons/assertion/policy);
events (facts; views derive usage/approvals/logs, never manufacture); Git (workspace truth,
checkpoint-pinned).

Init/shutdown: `ensureRuntimeDir(0700)` → `acquireStartupLock` → `recoverStaleState`
(live PID/socket fail, else unlink) → `token` → `DB.open+chmod(0600)` → `keepAwake.recover`
→ `pid write` → `listen+chmod/assert` → `finally releaseLock`; stop idempotent via
`#stopPromise` (`unsubscribe` → `destroy clients` → `keepAwake.dispose` → `server.close` →
`db.close[owns]` → `unlink(socket/token/pid)` only if instance matches).

## 3. Cross-component scenarios (paths exercised, verdicts)

- S1 lifecycle create→answer→generate→start→pause→resume→stop
  (`mutations.createProject/answerInterview/generateRoadmap/startProject`,
  `store.transition/write/workspace`, `daemon.#dispatch` control branch,
  `execution-control.#requestBoundary/#finalize/resume`): PASS after F1 (binding now fail-closed).
- S2 guided task + phase approve (`mutations.approveTask/approvePhase`, event journal
  `GUIDED_*`, `phaseApproval` txn COMPLETED+next-READY+PHASE_APPROVED): PASS (positions
  contiguous via `roadmap-runtime` re-normalization; next-phase `position+1` safe; txn stale
  checks cover concurrent revision).
- S3 revision propose→resolve (`revision-workflow`, `roadmap-mutations.applyBatch`,
  `database.persistRoadmapMutation` OCC + deepEqual, decisions approval binding): PASS.
- S4 settings update (`mutations.updateSettings`, permission diff, keep-awake policy):
  FIXED (F2 — battery-policy clobber).
- S5 permission resolve (`mutations.resolvePermission` + `views.approvals` + `policy`):
  FIXED (F3 — alias double-resolve).
- S6 daemon lifecycle (start/status/stop/restart, stale recovery, perms, token compare, frames,
  subscription buffering): PASS (one fixture updated to bind workspace; behavior tightened by F1).
- S7 replay/subscribe/pagination (`daemon.eventPage`, `paginate` digest cursors, `latestSequence`
  scoped authoritative; unscoped legacy `events.list` window-max noted as low-severity legacy-only):
  PASS with noted limitation.
- S8 crash/interrupt at intent/side-effect/outcome boundaries (`persistStateTransition`
  conditional-UPDATE+event atomicity, retry counters, checkpoint survival, `RecoveryInspector`):
  PASS.
- S9 workspace/Git (`preflight` read-only, `isolated-run` locked worktree, `guardedPublication`
  index.lock + ff-only + update-ref two-phase, `task-commit` verify + atomic
  `persistTaskCommitCompletion`, no push): PASS.
- S10 taxonomy propagation (`CoreRuntimeError` → `asRuntimeError`/`asCoreIpcError` →
  `normalizedProtocolError`, redaction/truncation): PASS (F1 restores PERSISTENCE_FAILURE code
  instead of swallowing to REJECTED/INTERNAL).
- S11 keep-awake + control (`acquire/release/recover/dispose`, battery re-eval, monitor
  unref): PASS after F2.
- S12 master send + rundown (workspace binding enforced, session/message validation, 8000-char
  truncation with citations): PASS.
- S13 joint project/phase/task coherence (`phase-orchestrator` verifiers
  `PERSISTED_STATE_INCONSISTENT`, scheduler roadmap↔persisted checks, auto-resume
  `waitingBoundary`): PASS.
- S14 init flags (`pending` vs `complete`, `executionRequested` on successful start only,
  `workspacePath` immutability, invalid `coreRuntime` fail-closed): PASS after F1.

## 4. Confirmed findings (all resolved)

| ID  | Severity | Joint guarantee violated                                                                                                                  | Evidence                                                                                                                                                                                                                                            | Resolution                                                                                                                                                          | Regression                                                                                                                               |
| --- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | High     | Control-plane workspace trust: pause/resume/stop must fail closed when the canonical binding is missing/invalid                           | `daemon.ts` control branch swallowed `PERSISTENCE_FAILURE` and proceeded to `ExecutionControl` (bypassing `CoreRuntimeStore.workspace` binding)                                                                                                     | Fail closed: map `PERSISTENCE_FAILURE` (and `WORKSPACE_CONFLICT`) to `CoreIpcError`                                                                                 | `core-integration-audit.test.mjs`: unbound pause+resume reject `PERSISTENCE_FAILURE` (fails pre-fix)                                     |
| F2  | Medium   | Settings/keep-awake composition: battery-policy update must not destroy live keep-awake reasons/assertions                                | `core-runtime-mutations.ts updateSettings` built fresh `{state:inactive,reasons:[]}` with `void base` discarding stored state                                                                                                                       | Preserve stored `state/reasons/assertion/batteryState`; only replace `batteryPolicy` (+ validity guard inactive⇒[] and assertion only for active/recovery_required) | Same file: declined+reason survives policy update (fails pre-fix)                                                                        |
| F3  | Medium   | Permission composition: one logical request (event-id alias vs payload-decisionId alias) must resolve at most once across Mutations+Views | `resolvePermission` allowed `e.id==X OR payload.decisionId==X` on request but recorded only one alias and checked only `payload.decisionId/requestId` (dead `requestId` branch, never written); `views.approvals` matched only `payload.decisionId` | Canonicalize aliases: record `{decisionId: canonical, requestEventId}` and match either alias in both mutations duplicate-check and views pending computation       | Same file: resolve via event-id then via decisionId ⇒ `UNCHANGED`, dashboard shows no pending permission (fails pre-fix with `REJECTED`) |

Fixture update (not a product defect): `scripts/core-daemon.test.mjs` alias-dispatch test
relied on the F1 bypass (unbound `project-daemon` expecting `REJECTED`). Updated to establish
a valid `coreRuntime` binding (`realpath(runtimeDirectory)`) so the test exercises alias
routing through authoritative Core; still expects `REJECTED` (DRAFT not controllable).

Evaluated and NOT confirmed (no change): `position+1` next-phase lookups (positions are
transactionally re-normalized to contiguous indices in `roadmap-runtime.ts:190-213`; removal
of non-PENDING phases with history is forbidden `:98-103`); stop→project-PAUSED mapping
(correct — canonical project states have no STOPPED; stopped/pause distinguished in
`executionControl` + events); `taskApproval`/`phaseApproval` non-atomic single-slot writes
(write-only hints, never read for decisions); cancel-on-UNCHANGED abort (no-op without live
execution; concurrent resume race negligible single-threaded between sync boundary and abort);
unscoped `latestSequence` window-max (legacy `events.list` only; v1 requires project scope).

## 5. Speculative concerns (separated, do not block)

- Cross-process double-`execute` across two `DensaAdeDatabase` objects on the same file:
  `execution-slot` keyed by in-memory identity and `WeakMap` executions cannot exclude a second
  OS process; mitigated by SQLite `BEGIN IMMEDIATE` + stale-snapshot checks, but no end-to-end
  multi-process test. Would need a two-process harness to confirm.
- `views.approvals`/`usage` multi-replay joins (1000-limit truncation, non-transactional
  row+event snapshot skew) could transiently misreport under very large or racing histories;
  no reproduction at current scale.

## 6. Remaining uncertainties

- Live-provider paths (`DENSA_LIVE_CODEX*`) remain skipped by policy; deterministic
  fake-adapter coverage + path inspection establishes the contract for this audit.
- Browser validation ran as part of `npm test` where applicable; no separate live-browser matrix.
- The two speculative items above have no confirming reproduction.

## 7. Validation

- `npm run pretest` — pass (builds protocol/agent-sdk/core/cli/testing).
- New `scripts/core-integration-audit.test.mjs` — 3/3 pass post-fix; verified 0/3 pass pre-fix
  (all three fail on stashed originals, confirming reproductions).
- `scripts/core-daemon.test.mjs` — 15/15 pass after fixture binding fix.
- Full `npm run check` (`format:check` + `build` + `typecheck` + `lint` + `test`) — pass:
  464 tests, 461 pass, 0 fail, 3 skipped.
- `git diff --check` — clean.
- Staged-candidate scan: source + test + prompt/report docs only; no secrets, credentials,
  databases, sockets, logs, or build artifacts.

## 8. Post-validation reinspection

Re-read fixed regions after green suite: daemon control branch now fails closed on both
`WORKSPACE_CONFLICT` and `PERSISTENCE_FAILURE`; keep-awake update preserves valid
state/reasons/assertion with schema-validity guards; permission resolve/views share canonical
alias logic (`decisionId` + `requestEventId`) with sequence ordering (`>` request). Affected
callers (pause/resume/stop, settings, permissions, dashboard/approvals) re-evaluated jointly;
no new bypass introduced. Existing alias-dispatch test updated to bound workspace and still
pins `REJECTED` for non-controllable DRAFT.

## 9. Sync evidence

(Recorded at commit/push time below.)

Final gate:

`PASS — Cleared for release.`
