# Durable project decisions and constraints

Phase 8 Milestone 1 makes project steering authoritative Core data instead of conversational
memory. `ProjectDecisionService` is the only mutation boundary for new decision and constraint
records. It validates project-scoped references, applies permission policy before portable writes,
persists the record and audit event atomically, and then regenerates `.densa-ade/DECISIONS.md`.

Each record has a stable ID, statement, display title and rationale, category, source
(`user`, `master`, or `system`), scope (`project`, `phase`, or `task`), active/superseded status,
creation and optional supersession timestamps, an optional `supersedesId`, and affected phase/task
references. Supersession never deletes or rewrites the old statement. Migration 13 converts older
decision rows into active system-sourced project decisions in the `legacy` category.

## Constraint relevance and conflict handling

Every future `TaskPacket` is built from current SQLite state. It automatically includes active
constraint records whose scope applies to the task:

- project constraints apply to every task;
- phase constraints apply to tasks in an affected phase;
- task constraints apply only to affected tasks.

Superseded records and Master/worker conversation events are excluded. Architectural decisions
remain explicitly selected, but selecting a superseded decision fails closed.

Constraint conflicts are deterministic and conservative. Active constraints conflict when they
share a category, have overlapping scope, and have different normalized statements. Core does not
guess which statement is correct: it appends `PROJECT_CONSTRAINT_CONFLICT_DETECTED` with the
conflicting decision IDs and returns `CONFLICT_REQUIRES_USER_DECISION`. An explicit replacement
must identify the active record through `supersedesId`; Core then marks the old record superseded,
creates the replacement, and appends `PROJECT_DECISION_SUPERSEDED` in one transaction.
Widening a scoped replacement must not overlap another active constraint in the same category; that
case also returns the explicit conflict flow instead of leaving contradictory active records.

Master constraint proposals use this same service through `ValidatedMasterCoreCommandGateway`.
Additions become Master-sourced project constraints; replacements explicitly supersede the active
record in the same category; removals create an auditable decision record that supersedes the
removed constraint. Conflicting or ambiguous changes return a blocked decision flow rather than
silently changing worker context.

The SQLite record/event transaction remains authoritative when portable regeneration fails. An
idempotent retry of the same active constraint retries `.densa-ade/DECISIONS.md` synchronization
without creating another decision or event. After a run branch establishes project ownership,
portable regeneration is bound to its persisted source workspace and rejects path substitution.
