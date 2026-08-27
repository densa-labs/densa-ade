# Persistent phase lifecycle

Phase 5 Milestone 3 adds the editor-independent `PhaseLifecycleOrchestrator`. It executes one
persisted roadmap phase over the existing dependency scheduler and single-task lifecycle boundary.
It deliberately does not implement Guided-mode approval after every task, execution-mode changes,
pause/resume controls, or the next roadmap milestone.

## Serial execution and readiness

The phase must begin in `READY` while its project is already `RUNNING`. Core records the
`READY -> RUNNING` transition before any task work. It promotes only `PENDING` tasks whose hard
dependencies are durably `COMPLETED`, asks `DependencyScheduler` for at most one task, and invokes a
`PhaseTaskExecutor` serially. `SingleTaskPhaseExecutor` is the production bridge to
`SingleTaskOrchestrator`; its details provider supplies each task's focused prompt, owned paths,
adapter, and validator. Deterministic tests use a fake executor without weakening the
persisted-state checks.

An executor result never certifies completion by itself. The phase loop verifies that SQLite records
both the task's `COMPLETED` state and the reported commit SHA before it schedules dependent work. A
blocked or cancelled required task prevents phase completion. Permission, decision, usage, and other
nonterminal no-work boundaries stop without guessing a lifecycle outcome.

## Independent phase validation and mode boundary

After every executable task in the phase is complete, Core persists `RUNNING -> VALIDATING` before
calling the phase validation hook. Structured validation evidence must include at least one check,
and a passing aggregate cannot contain a failing check.

- Phase-by-phase mode persists `AWAITING_APPROVAL` after validation passes.
- Continuous mode persists `COMPLETED` and makes only the immediately following `PENDING` phase
  `READY`, in the same SQLite transaction.
- Failed or skipped validation persists `BLOCKED`; the next phase remains ineligible.

Guided mode returns an explicit unsupported boundary because its per-task stop behavior belongs to
Phase 5 Milestone 4.

## Durable reports and recovery

Migration 9 adds authoritative, versioned `phase_reports` JSON records. Report creation, validation
outcome events, the current phase transition, and any continuous-mode next-phase eligibility change
commit atomically. Reports contain completed tasks, task and phase validators, commits, changed-file
paths from `TASK_COMMITTED` facts, decisions, roadmap revisions, retry/failure counts, unresolved
issues, and the next-phase summary.

After the SQLite transaction commits, Core renders the immutable report to a deterministic file
under `.densa/reports/` using a durable temp-file-and-rename write. Real-directory and regular-file
checks reject symlink or human-edit conflicts. If portable projection is interrupted, SQLite remains
authoritative and re-invoking the lifecycle re-synchronizes the already committed report without
rerunning completed tasks or validation. Descriptive report text passes through the portable secret
redactor before it enters the durable report.
