# Dependency scheduler

Phase 5 Milestone 0 adds the editor-independent, read-only `DependencyScheduler` in Densa ADE Core. It
selects at most one executable task from the authoritative persisted roadmap and runtime state; it
does not change lifecycle state, reserve work, create checkpoints, or invoke an `AgentAdapter`.
Those side effects belong to the later orchestrator lifecycle.

## Inputs and fail-closed boundary

`selectNext` reads the persisted project, master-roadmap revision, phases, tasks, and hard
dependencies through Core repositories. Before selection it verifies that executable roadmap work
has matching runtime state, phase/task ordering is current, and dependency metadata agrees. Missing
or contradictory records return `PERSISTED_ROADMAP_INCONSISTENT` rather than guessing.

The request must also include a complete `SchedulerGateSnapshot` containing outstanding user
decision IDs and permission blockers. Phase 5 does not pre-empt the later permission and decision
persistence models: their authoritative services will build this provider-neutral snapshot. Missing
or malformed gate evidence returns `GATE_SNAPSHOT_INVALID`, so absent policy evidence is never
treated as permission.

## Selection rules

The scheduler selects a task only when all of these remain true at evaluation time:

- project state is `READY` or `RUNNING`;
- phase state is `READY` or `RUNNING`;
- task state is exactly `READY`;
- every hard dependency is `COMPLETED`;
- no blocking user decision or applicable permission blocker exists;
- no task is already `RUNNING`, `VALIDATING`, or `RETRYING`.

One active task owns the serial execution slot. Multiple active tasks are reported as
`SERIAL_EXECUTION_VIOLATION`. A blocked task or scoped permission denial is skipped, allowing
independent eligible work to continue; project-scoped blockers stop selection.

When several tasks are eligible, the scheduler uses authoritative roadmap phase order, then task
order, with the stable task ID included in the returned tie-break evidence. It returns immediately
after one selection and never relies on array order in place of dependency checks.

## No-work outcomes

No selection is represented as `status: "no_work"` with immutable structured reasons. Reasons
distinguish invalid evidence, blocked work, an idle lifecycle boundary, and complete work. Examples
include incomplete dependencies, outstanding decisions, permission blocks, an occupied serial
slot, paused/terminal project state, no `READY` task, and all executable tasks completed.

`scripts/scheduler.test.mjs` exercises persisted SQLite graphs for dependency blocking,
deterministic ties, decision and permission gates, blocked lifecycle states, serial execution, full
completion, missing gate evidence, and stale runtime-roadmap metadata.
