# Densa Core Integration Audit Prompt (Fresh, Self-Contained)

You are Codex working in the Densa ADE repository on the current `main` checkout (`/Users/ivanuy/Library/Mobile Documents/com~apple~CloudDocs/Projects/densa-ade` / symlink `/Users/ivanuy/Desktop/Projects/active-projects/densa-ade`). Perform a fresh, evidence-driven **Densa Core Integration Audit**. This document is the sealed scope and methodology. It must be fully constructed and saved before findings inspection begins. Do not treat historical milestone commits, phase tags, documentation claims, prior phase audits (Phases 1–9), or a passing existing test suite as proof that Core is correctly integrated.

## 0. Objective — one complete system

Treat **Densa Core as one complete composed system** — not another phase-by-phase review. Reconstruct the current Core architecture as it exists now and evaluate interactions across every subsystem, searching specifically for failures that isolated phase audits could miss.

Determine whether Densa Core is internally consistent, correctly integrated, resilient across its intended lifecycle (init → plan → execute → validate → approve → pause/resume/stop → restart/recovery → shutdown), and release-quality.

This is not a requirements re-verification of any single phase. It is a **composition audit**: assumptions that hold locally but fail when components are composed.

## 1. Governing constraints

1. Read and obey `AGENTS.md`, `MODEL_POLICY.md`, `MASTER_ROADMAP.md`. Core is the authoritative editor-independent state/mutation boundary. Clients use versioned authenticated local protocol, never mutate repositories/SQLite directly. Lifecycle changes use centralized validated services. SQLite is detailed runtime truth. `.densa-ade/` is inspectable non-secret projection. Events are append-only facts. Agents never certify success. Deterministic validation precedes agent review. User work is never destroyed. No auto-push. No secrets in logs/prompts/projections.
2. Evaluate the **current repository**, not historical code. Inspect every current caller, consumer, persistence path, integration, config, fixture, script, and test capable of strengthening, weakening, bypassing, or invalidating a cross-component guarantee.
3. Preserve intentional compatible behavior unless it conflicts with a required invariant.
4. Preserve user-owned/concurrent work. Do not overwrite, discard, stage, or commit unrelated changes. Stop and report ownership conflicts.
5. Distinguish confirmed defects from speculative concerns. Confirm only with current source evidence, executable reproduction, or logically complete current-path trace demonstrating failure.
6. Fix every confirmed defect within the intended contract. Do not weaken tests, validation, security, recovery, protocol strictness, bounds, auditability, or failure semantics to obtain passing results.
7. Add/strengthen regression or integration coverage wherever practical for every confirmed defect. Prefer focused failing reproduction before production changes.
8. If environmental restrictions block material validation (socket, loopback, browser, child-process, Git), rerun with required capability when permitted. If materially required validation remains incomplete, gate must be FAIL.
9. Only if exact PASS gate is justified: selectively stage audited snapshot, inspect for secrets/runtime artifacts, create one audit/remediation commit with `densa-ade:` prefix, push `main` normally to `origin`, verify remote reaches exact commit, verify `git rev-list --left-right --count origin/main...main` is `0 0`. Never force-push. Do not commit/push FAIL as release audit.

## 2. Reconstruct the current Core architecture

Inventory and reconstruct from current source (do not assume filenames unchanged):

- Entry/mutation boundary: `CoreRuntimeMutations.dispatch`, `CoreRuntimeViews.dispatch`, `CoreRuntimeStore`, `CoreDaemon` dispatch/routing, `CoreV1Client`, protocol catalog/schemas.
- Lifecycle: `StateTransitionService` (project/phase/task tables), `ExecutionModeService`, `ProjectExecutionControlService` (pause/resume/stop/cancel), `ExecutionSlot`, `Scheduler`, `TaskOrchestrator`, `PhaseOrchestrator`, `UsageAutoResume`.
- Planning: `ProjectSpecification`, `MasterRoadmap`, `RoadmapMutationService`, `MasterRoadmapRevisionWorkflow`, `ProjectDecisionService`, `TaskPacket`, `AdaptiveInterview`, `MasterAgent`.
- Workspace/Git: `WorkspacePreflight`, `IsolatedRunWorkspace`, `ValidationWorkspace`, `ProjectWorkspace`, `RunCheckpoint`, `AttemptRollback`, `TaskCommit`, `TaskPublication`, `GuardedPublication`, workspace-path evidence.
- Validation: `ValidationPipeline`, `ProjectValidationDetector`, `AcceptanceEvidence`, `IndependentReview`, `TaskProofHarness`, `HeadlessOnePhaseProof`, `BrowserValidation`, `BrowserProcessOwner`.
- Persistence: `DensaAdeDatabase`, `migrations`, `repositories`, `event-journal`/`EventPublisher`, `roadmap-runtime`, `portable-project`, transactions, `persistStateTransition` ordering.
- Cross-cutting: `daemon` + `daemon-bin` lifecycle, `KeepAwakeManager`, `PermissionPolicyService`, `Secrets` + `SecretRedaction`, `RecoveryInspector`, `Rundown`, `CoreRuntimeViews`, error taxonomy mapping (`CoreRuntimeError` → `CoreIpcError` → protocol errors), event replay/subscribe/pagination, logging bounds, cancellation/timeout/cleanup.

Produce:

- Module map with responsibilities.
- Reconstructed architecture diagram (text).
- Major trust boundaries (client↔daemon auth, daemon↔DB, Core↔workspace/Git, Core↔agent adapter, Core↔validation, Core↔portable projection).
- Major state boundaries and sources of truth (SQLite vs in-memory vs `.densa-ade/` vs events vs Git vs settings keys like `coreRuntime`, `taskApproval`, `phaseApproval`, `executionRequested`, `initialization`).
- Initialization and shutdown sequencing.
- Dependency ordering.

## 3. Interaction evaluation — required attention list

Evaluate interactions across every subsystem with particular attention to:

1. broken cross-phase assumptions;
2. incompatible or contradictory invariants;
3. duplicated or inconsistent sources of truth;
4. invalid state transitions (including transitions that are individually legal but jointly incoherent across project/phase/task);
5. lifecycle ordering problems;
6. persistence correctness (transactional atomicity, ordering of state vs event vs projection vs Git);
7. restart and recovery behavior (daemon restart, DB reopen, crash between intent/side-effect/outcome);
8. partial-write or interrupted-operation behavior (mid-transaction crash, partial Git operation, partial projection, partial event append, oversized frame truncation);
9. failure propagation across subsystem boundaries (daemon↔control↔scheduler↔orchestrator↔adapter↔validation↔persistence↔protocol);
10. error masking or accidental recovery (swallowed errors, `UNCHANGED`/`STALE`/`APPROVED` misclassification, fallback that hides failure, redaction that destroys diagnosability vs required redaction);
11. stale state (stale snapshots, owners, slots, approvals, cursors, PID/socket/token, workspace binding, usage state, permission decisions);
12. cleanup and teardown behavior (sockets, tokens, PID files, locks, subscriptions, listeners, timers, child processes, keep-awake assertions, temp dirs/worktrees);
13. dependency ordering (scheduler vs execution mode vs permissions vs approvals vs workspace vs usage vs control);
14. initialization and shutdown sequencing (runtime dir perms, stale recovery, lock acquisition, DB open/chmod, keep-awake recover, PID write, listen/chmod, stop idempotency, ownsDatabase handling);
15. concurrency and race-sensitive interactions where applicable (serial-execution invariant, overlapping pause/resume/stop, concurrent IPC, subscribe-then-notify gap, late adapter/validator results, repeated terminal actions);
16. assumptions that hold locally but fail when composed;
17. end-to-end workflows crossing multiple phases (create→interview→roadmap→start→execute→validate→commit→report→approve→next-phase; revision propose→approve→apply; settings update; permission resolve; guided approvals; pause/resume/stop; usage-limited auto-resume; crash recovery);
18. requirements that appear individually satisfied but are not jointly guaranteed.

Existing tests are evidence, not proof. Passing tests do not establish joint guarantees.

## 4. Active defect search — cross-component scenarios

Construct realistic cross-component scenarios and inspect the actual implementation paths they exercise. Minimum coverage:

- S1: Full lifecycle create→answer→generate→start→pause→resume→stop across `Mutations`+`Store`+`Views`+`Daemon`+`ExecutionControl`+`StateTransitions`+persistence. Check state coherence, `executionRequested`/`initialization` flags, first-phase READY promotion, idempotent start, WAITING/BLOCKED short-circuits.
- S2: Guided task approve + phase approve composed with execution modes, event journal (`GUIDED_TASK_APPROVAL_REQUIRED`/`APPROVED`/`SUPERSEDED`), `taskApproval`/`phaseApproval` settings keys, and transaction atomicity (phase COMPLETED + next-phase READY + PHASE_APPROVED event). Check double-approve, approve-after-terminal, reject paths, non-guided UNCHANGED, next-phase lookup by position vs sorted order.
- S3: Roadmap revision propose→resolve composed with decisions, approvals, workspace binding, and running execution. Check base-revision staleness, approvalRequired flows, double-apply, reject-after-apply, cross-project proposal IDs.
- S4: Settings update (executionMode + permissionPolicy + keepAwake battery policy) composed with running/paused tasks. Check override diffing, event emission, keep-awake projection clobbering (`state: inactive` overwrite), partial-update atomicity.
- S5: Permission resolve composed with decisions + event journal. Check STALE vs UNCHANGED vs APPROVED/REJECTED, decisionId vs event-id lookup, double-resolution, cross-project leakage.
- S6: Daemon lifecycle: start→status→stop→restart with stale socket/PID/token/lock, permission modes (0o700/0o600), ownership checks, symlink rejection, `ownsDatabase` close semantics, `stop()` idempotency, `core.stop` fire-and-forget, manager start/stop timeouts, token timing-safe compare, frame bounds, subscription buffering and destroy-on-overflow.
- S7: Event replay/subscribe/pagination composed with notifications: empty/one-page/multi-page/boundary/gap, `latestSequence` semantics (global vs per-project), `hasMore` with limit+1, buffered-notifications-until-afterResponse gap, oversized single-event frame, malformed/unsupported/unauthenticated requests, cursor scope binding (`paginate` digest), invalid cursor fail-closed.
- S8: Crash/interrupt at every intent/side-effect/outcome boundary: between state transition and event, between checkpoint and agent start, between agent finish and validation, between validation and commit, between commit and COMPLETED, between phase COMPLETED and portable report. Check `persistStateTransition` atomicity, retry-counter persistence, checkpoint metadata survival, `RecoveryInspector` classification.
- S9: Workspace/Git composition: preflight→checkpoint→isolated run→validation workspace→guarded publication→task commit→rollback. Check dirty-user-work preservation, detached-worktree vs user-workspace confusion, commit→task-ID mapping, failed-attempt visibility, push prohibition, path traversal/symlink/canonicalization (`realpath` vs `resolve` vs `mkdir -p` in `ensureWorkspace`).
- S10: Failure taxonomy propagation: every `CoreRuntimeError` code through `asRuntimeError`/`asCoreIpcError`/`normalizedProtocolError` to wire. Check code allowlist drift, message truncation vs diagnosability, secret redaction completeness, `INVALID_STATE_TRANSITION` preservation, unknown-code collapse to `INTERNAL_INVARIANT_VIOLATION`.
- S11: Keep-awake + execution-control composition: acquire/release ordering, battery policy, crash recovery (`keepAwake.recover`), dispose on daemon stop, display-vs-system sleep invariant.
- S12: Master send + rundown composition: workspace binding enforcement, session/message validation, context reader freshness, response truncation (8000 chars) vs citation integrity.
- S13: Project/phase/task joint state coherence: project RUNNING while phases BLOCKED, phase COMPLETED while tasks non-terminal, task CANCELLED/BLOCKED while project claims progress, WAITING_FOR_USAGE vs usage auto-resume revalidation.
- S14: Initialization flags: `initialization: pending` vs `complete`, `executionRequested` set only on successful start, `workspacePath` immutability enforcement, missing/invalid `coreRuntime` fail-closed.

For each scenario: list exact files/functions/lines exercised, inputs, expected joint guarantee, observed behavior, verdict.

## 5. Findings and remediation protocol

For every suspected issue, follow the exact current path and classify as confirmed or speculative. For every confirmed integration defect:

1. Record violated joint guarantee and current-path evidence (file:line + trace).
2. Explain why confirmed rather than speculative (reproduction or complete trace).
3. Add focused failing reproduction before production change wherever practical.
4. Implement smallest complete architectural fix restoring the guarantee.
5. Preserve schema/data compatibility and compatible later behavior.
6. Add/strengthen regression/integration coverage (including restart/isolation semantics where relevant).
7. Run focused + full relevant suites.
8. Reinspect repaired implementation and every affected caller/consumer; re-evaluate affected invariants jointly, not in isolation.

Keep speculative concerns separate with resolving evidence stated. Material uncertainty prevents PASS.

## 6. Validation

Run focused checks first, then repository-wide validation:

- `npm run pretest` (build core/protocol/agent-sdk/cli/testing)
- `npm test` (all `scripts/*.test.mjs`) — record counts
- `npm run check` (`format:check` + `build` + `typecheck` + `lint` + `test`)
- `git diff --check`
- Any separate migration, protocol-contract, daemon/IPC, Git/workspace, restart/recovery, acceptance commands required by reconstructed contract
- Inspect final diff + untracked files; scan staged candidate for secrets, credentials, databases, sockets, logs, build artifacts, unrelated files

Record exact commands, counts, outcomes, skips, environmental limits, reruns. Opt-in live-provider checks may remain skipped only when deterministic coverage + path inspection establishes the contract; record unverified live assumption. Never present fake-agent fixtures as real-agent evidence.

## 7. Required audit artifact

Write `docs/core-integration-audit.md` containing:

- Concise summary of what was reviewed
- Reconstructed Core architecture + major trust/state boundaries (with diagram)
- Cross-component scenarios reviewed (S1–S14 + extras) with paths exercised and verdicts
- Confirmed findings table (severity, joint guarantee violated, evidence, resolution, regression test)
- Speculative concerns (separated)
- Remaining uncertainties / unverified assumptions
- Validation commands + exact results (counts, failures, skips, reruns)
- Post-validation reinspection conclusions
- Commit/push/remote SHA + ahead/behind evidence only if PASS
- Exactly one final gate as final gate line

Final response must likewise summarize: architecture/boundaries, scenarios, confirmed findings+resolutions, remaining uncertainties, validation results, sync evidence if PASS, and exactly one final gate as its final gate line.

Final gate must be exactly one of:

`PASS — Cleared for release.`

Use PASS only when available evidence supports that Densa Core is internally consistent, correctly integrated, resilient across its intended lifecycle, and release-quality.

`FAIL — Issues remain; deeper fixes are required.`

Use FAIL if any confirmed integration defect remains, an important cross-component guarantee cannot be established, or validation is materially incomplete.
