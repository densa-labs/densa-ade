# Persistent phase lifecycle and execution modes

Phase 5 Milestone 3 added the editor-independent `PhaseLifecycleOrchestrator`. It executes one
persisted roadmap phase over the existing dependency scheduler and single-task lifecycle boundary.
Phase 5 Milestone 4 adds `ProjectExecutionOrchestrator` and `ExecutionModeService` over that same
phase/task lifecycle. Pause, resume, stop, and intervention controls remain outside this milestone.

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

## Independent phase validation

After every executable task in the phase is complete, Core persists `RUNNING -> VALIDATING` before
calling the phase validation hook. Structured validation evidence must include at least one check,
and a passing aggregate cannot contain a failing check.

- Phase mode persists `AWAITING_APPROVAL` after validation passes.
- Guided and Continuous modes persist `COMPLETED` and make only the immediately following
  `PENDING` phase `READY`, in the same SQLite transaction.
- Failed or skipped validation persists `BLOCKED`; the next phase remains ineligible.

## User-control boundaries

All modes use the same serial task and phase orchestrators:

- **Guided** stops after every durably completed, validated, and committed task. Core appends
  `GUIDED_TASK_APPROVAL_REQUIRED`; a matching explicit approval appends `GUIDED_TASK_APPROVED`
  before scheduling more work. On restart, Core derives any missing boundary from the authoritative
  task-completion event, so a crash between task completion and boundary publication fails closed.
- **Phase** runs and validates the current phase, saves its report, and stops with the phase in
  `AWAITING_APPROVAL`. Explicit phase approval atomically completes that phase and makes only its
  immediate `PENDING` successor `READY`.
- **Continuous** saves every phase report and continues through later phases automatically. A
  mandatory user decision or permission/safety blocker stops the project loop before task
  scheduling or phase validation; Continuous never treats missing approval evidence as permission.

When all required phases complete, the project transitions through the centralized state service to
`COMPLETED`.

## Persistent mode changes

`ExecutionModeService` updates `projects.execution_mode` and appends `EXECUTION_MODE_CHANGED` in one
SQLite transaction. The event records the previous mode, new mode, actor, and that the change takes
effect at a safe boundary. A running task is never interrupted merely to apply a mode change.

The phase loop rereads the authoritative mode between tasks and before finalizing a phase. Switching
away from Guided or Phase at an existing approval boundary appends a superseding audit fact before
continuing. Switching into Guided while work is active takes effect after the current task reaches
its durable completion boundary. Because the mode lives on the authoritative project record, it
survives Core restart without a separate in-memory setting.

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
