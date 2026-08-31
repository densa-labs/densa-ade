# Phase 5 current-state release audit

- Audit date: 2026-09-01
- Repository: `/Users/ivanuy/Desktop/Projects/active-projects/densa-ade`
- Starting revision: `a4238cb` (`main`, initially equal to `origin/main`)
- Sealed audit prompt: `docs/phase-5-current-state-audit-prompt.md`
- Sealed prompt SHA-256: `e8b17b41b4dc2b1ef8f335ec2ba7e436360999c7b261c23ae72e255eb7162cfc`

The prompt was constructed and hashed before implementation inspection. Its digest was rechecked after
remediation and remained unchanged. The audit recovered P5M0-P5M5 from `MASTER_ROADMAP.md`, the
milestone commits `d618d4f` through `67fb1e0`, the phase tag, architecture documentation, contracts,
and milestone/current tests. Historical completion evidence was used to reconstruct intent, not to
establish the current gate.

## Requirement traceability and reviewed architecture

| Original guarantee                                                                                                                                                                                  | Current implementation and evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P5M0 dependency scheduling is read-only, dependency and policy driven, deterministic, and serial                                                                                                    | `scheduler.ts` reads persisted project/phase/task/dependency state and complete gate snapshots. It never invokes an adapter. `execution-slot.ts` now coordinates live task, phase, and project owners across service instances and database connections in the authoritative Core process. Scheduler, phase, task, recovery, and composed Continuous-mode regressions cover READY selection, blockers, deterministic ordering, recovered retries, and serial ownership.                                                                                                                                                                                                                                                      |
| P5M1 Task Packets are focused, bounded, secret filtered, scope aware, and auditable                                                                                                                 | `task-packet.ts` builds packets from explicit context selections and records source/truncation evidence. Current checks cover constraints, decisions, relevant paths, dependencies, retry evidence, permissions, secrets, stale selections, and bounds. Selected decisions must now be active architectural decisions whose declared scope applies to the requested phase/task. Raw Master transcripts and unbounded event history remain excluded.                                                                                                                                                                                                                                                                          |
| P5M2 one task lifecycle persists attempts/checkpoints before work, independently validates, commits only accepted output, safely retries/rolls back, caps attempts at four, and recovers explicitly | `task-orchestrator.ts` composes the Phase 1 adapter and validation boundary, Phase 2 durable state/events/recovery, and Phase 3 checkpoint/rollback/commit services. Attempts and process evidence precede execution, validation precedes publication, and completion requires matching durable commit evidence. Cancellation during validation now invalidates the result and rolls back. An unfinished fourth attempt is inspected as recovery evidence before exhaustion is considered. Tests exercise first-pass, retry-pass, four failures, usage waiting, cancellation, adapter crash, persistence failure, rollback, restart, and exact commit/state coherence.                                                       |
| P5M3 phase execution is serial, cannot complete around unresolved work, performs phase-final validation/review, persists a complete report, and projects it safely                                  | `phase-orchestrator.ts` selects at most one eligible task, now explicitly continues a reconciled `RETRYING` owner, verifies executor claims against persisted state/commit evidence, requires fresh phase review, and writes immutable durable reports. Deferred portable projection in Continuous mode remains intentional: projection occurs only at a no-more-tasks boundary so Core-owned report files cannot contaminate the next Git checkpoint. Multi-task, blocked, report, restart, and headless phase proofs pass.                                                                                                                                                                                                 |
| P5M4 Guided, Phase, and Continuous modes enforce distinct durable approval/policy boundaries and observe mode changes at safe points                                                                | `execution-modes.ts` and `phase-orchestrator.ts` persist mode changes/events and enforce Guided task approvals, Phase approval after report, and Continuous progression only after validation. Guided approval recovery now scans the complete paginated event history. Mandatory decisions, permissions, scope proposals, hard failures, usage waiting, restart, and repeated recovery stress remain fail closed.                                                                                                                                                                                                                                                                                                           |
| P5M5 pause/cancel/resume/stop are authoritative, idempotent, recovery aware, intervention safe, and do not delete work                                                                              | CLI requests now carry explicit project/workspace identity through the authenticated daemon into `ProjectExecutionControlService`; absent identity is rejected before IPC. Pause/stop finalization rechecks durable control and worker evidence after asynchronous inspection. Every resume performs preflight, recovery, and workspace inspection, rechecks concurrent control changes, accepts only specifically understood recovery evidence, fingerprints manual changes, and requires the exact intervention revision to be applied to the rebuilt Task Packet before a worker starts. Stop works at the later usage-wait boundary and preserves work. Real daemon/socket and deterministic control/restart tests pass. |

The current call graph was followed from CLI and frozen Core v1 methods through the authenticated local
daemon, Master command gateway, execution controls, project/phase/task orchestrators, scheduler, Task
Packet provider, adapters, validators, centralized transitions, SQLite transactions/events, Git
checkpoint/publication/rollback, portable phase reports, usage auto-resume, recovery inspection,
permission gates, and later Phase 6-9 validation/headless integrations. Core remains the mutation and
state authority; no editor API enters these paths.

## Confirmed findings and resolutions

1. **Live serial ownership was local to one orchestrator object.** Two service instances could overlap
   during asynchronous checkpoint preparation. Core now reserves process-wide slots by canonical
   database identity before the first await and releases them in `finally`. A regression reproduced the
   prior overlap and proves the second task owner is rejected.
2. **Cancellation during validation could accept a late passing result and commit.** The task lifecycle
   now turns a result observed after cancellation into failed validation, rolls back owned output, and
   durably ends the attempt/task as interrupted or cancelled without publication. Regression coverage
   confirms no commit and no additional attempt.
3. **The maximum-attempt check ran before unfinished-attempt recovery.** A crashed fourth attempt could
   be reported as ordinary exhaustion. The lifecycle now inspects the unfinished attempt first and
   returns `RECOVERY_REQUIRED`; only four completed failures produce exhaustion.
4. **A resumed `RETRYING` task could strand its phase.** General selection correctly rejected active
   work but provided no explicit continuation path. `selectRetry` now continues only the reconciled
   serial owner while still rejecting other active or unfinished work.
5. **Guided approval recovery was bounded to the first 1,000 events.** Long-running projects could miss
   the current approval boundary. `EventJournal.scan` now walks bounded pages and the phase lifecycle
   derives approval state incrementally. A regression places the relevant boundary after 1,000 events.
6. **Pause finalization could race a newer stop/control request.** After workspace inspection, the stale
   finalizer now reloads project/control state, respects an already finalized or newer request, and
   refuses to finalize over unfinished worker evidence.
7. **Resume could race control changes and accepted arbitrary `UNKNOWN` recovery.** Resume now captures
   and rechecks its durable control revision after all inspections. `UNKNOWN` is accepted only for the
   two specifically understood no-checkpoint or confirmed-interrupted cases; other ambiguity blocks.
8. **Manual-intervention context could become stale when dirty bytes changed without a HEAD change.**
   The durable control record now binds the context to the full workspace fingerprint and refreshes it
   whenever that fingerprint changes.
9. **Acknowledged intervention context was returned but not enforced on the next worker packet.** The
   control service carries it into project/phase execution, and `SingleTaskPhaseExecutor` requires the
   details provider to acknowledge the exact `detectedAt` revision before invoking a worker.
10. **CLI control commands were advertised but sent empty requests, and the daemon did not dispatch
    them.** The CLI accepts and requires explicit project/workspace identity (plus resume
    acknowledgement), the daemon validates frozen v1 payload/results and dispatches v1 and CLI aliases
    through the authoritative control service, and missing identity is rejected before IPC.
11. **Explicit stop was rejected at `WAITING_FOR_USAGE`.** Stop now remains available at any state whose
    centralized transition matrix permits a safe move to `PAUSED`; graceful pause retains its narrower
    running/paused contract.
12. **A Task Packet caller could select a decision scoped to another task.** Context selection now
    rejects non-decision records and phase/task scope mismatches instead of relying on caller honesty.
13. **Public Phase 5 actor fields could persist secret-bearing metadata.** Execution mode, project,
    phase, task, and control boundaries now apply the shared secret redaction before durable events or
    transitions. Worker/task diagnostic text remains bounded and redacted by the existing evidence
    pipeline.

All confirmed findings were repaired. No confirmed release-blocking issue remains. Candidate code was
reinspected after validation to confirm the guards sit at the authoritative lifecycle boundaries rather
than only in test fixtures.

## Validation

- Six adversarial regressions were first run against the original implementation and reproduced the
  serial-owner race, validation-cancellation commit risk, stale intervention context, Guided history
  truncation, stranded `RETRYING` task, and stale pause finalizer.
- The composed Phase 5 and later-integration selection passed: 151 tests, 151 passed, 0 failed.
- `node --test scripts/task-orchestrator.test.mjs` passed: 19 tests, 19 passed, including unfinished
  fourth-attempt recovery.
- `node --test scripts/cli.test.mjs` passed: 12 tests, 12 passed, including identity validation and
  control payloads.
- Final `npm run check` passed formatting, build, TypeScript typecheck, ESLint, and the complete test
  suite: 417 tests, 414 passed, 0 failed, 3 skipped, duration 38.1 seconds.
- The three skips are explicit opt-in paid/live Codex checks: authenticated adapter smoke, Master
  interview, and task proof. Deterministic fake-adapter coverage and real local process, SQLite, Git,
  browser, Unix-socket daemon/CLI, restart, and headless recovery tests all ran.
- `git diff --check` passed. The sealed prompt digest remained
  `e8b17b41b4dc2b1ef8f335ec2ba7e436360999c7b261c23ae72e255eb7162cfc`.

## Remaining uncertainty

- No fresh paid-provider execution was performed; provider-independent lifecycle guarantees are covered
  deterministically, and installed-Codex contract/process fixtures ran, but the three opt-in live checks
  remain unverified in this audit.
- Live execution slots coordinate the authoritative single Core process. Restart safety is established
  separately by durable SQLite attempt/process/checkpoint facts and fail-closed recovery; multi-daemon
  execution is prevented by the authenticated daemon's singleton runtime ownership.
- Core structurally proves that the exact manual-intervention revision reached the Task Packet details
  provider. The semantic quality of newly generated prose remains provider/caller dependent, so a
  missing revision acknowledgement stops execution instead of being guessed.
- Current-state PASS reports exist for Phases 1-5 only. Phase 6, 7, 8, and 9 individual current-state
  audits are absent, so the requested Densa Core integration audit prerequisite is not met and that
  audit was not started.

PASS — Cleared for release.
