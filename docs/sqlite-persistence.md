# SQLite persistence

Phase 2 Milestone 1 makes SQLite the authoritative detailed runtime store owned by Densa Core.
Clients do not receive a database connection and repository interfaces do not expose direct status
updates. New projects, phases, and tasks begin in their canonical initial states; later state changes
must come from `StateTransitionService` and are persisted with their audit event in one transaction.

## Runtime and dependency choice

Core uses Node's built-in `node:sqlite` binding. It is available at Densa's Node 22.13 minimum,
keeps the production dependency set unchanged, supports parameterized statements, and exposes the
foreign-key and transaction behavior required here. These synchronous calls run in the separate
Densa Core process, never in an IDE renderer or UI thread. If database workloads grow enough to
affect Core responsiveness, the same repository boundary can move onto a dedicated worker without
changing client or orchestration contracts.

## Schema and repositories

Migration 1 creates repositories and integrity-constrained tables for:

- projects, specifications, phases, tasks, task dependencies, and acceptance criteria;
- attempts, agent runs, and validation runs;
- decisions, roadmap revisions, checkpoints, events, and project settings.

Foreign keys are enabled on every connection. Composite foreign keys prevent a task from naming a
phase in another project, a dependency from naming a task in another project, a validation run from
naming an attempt for another task, and a task-scoped event from disagreeing with its phase/project.
Acceptance criteria and task dependencies are stored as child records but round-trip through the
aggregate Task contract. JSON columns use SQLite `json_valid` checks and are parsed through protocol
schemas when read.

`@densa/core/persistence` exports `DensaDatabase` and its repository contracts without eagerly
loading SQLite for consumers of other Core modules. `DensaDatabase.transaction()` supports nested
repository work with savepoints. Task creation uses that boundary for its task, criteria, and
dependency rows. `persistStateTransition()` uses an optimistic current-state predicate and writes
the accepted state plus its versioned event in the same transaction; a stale snapshot or failed
event insert rolls the state update back.

Migration 2 upgrades events with deterministic per-project sequence numbers and the canonical
`eventVersion` field. Replay, filtering, payload bounds, post-commit publication, and subscriptions
are documented in [event-journal.md](./event-journal.md).

Migration 3 adds nullable recovery evidence without changing older records: agent runs may record a
worker PID plus opaque process-identity hash, and checkpoints may record Git `HEAD`, porcelain
status, and a content-sensitive workspace fingerprint. Repository list/latest queries expose
attempts, agent and validation runs, checkpoints, and the last project event through the Core
boundary. Recovery remains read-only and is documented in
[recovery-inspection.md](./recovery-inspection.md).

Migration 4 adds durable `densa_run_branches` ownership plus task, attempt, and run-branch
associations on checkpoints. Older project-level checkpoints remain valid with null associations;
new task checkpoints require all association fields and a Git base together. The run intent,
activation, one-checkpoint-per-attempt constraint, and audit behavior are documented in
[run-branches-and-checkpoints.md](./run-branches-and-checkpoints.md).

Migration 5 adds the nullable attempt `commit_sha` outcome and durable `task_commit_intents` used
to bridge the Git/SQLite crash boundary. Intent exists before local Git mutation; the verified SHA,
`TASK_COMMITTED` audit fact, and centralized task completion transition are persisted in failure-safe
order. The detailed recovery and unrelated-change rules are documented in
[run-branches-and-checkpoints.md](./run-branches-and-checkpoints.md).

Migration 6 adds one durable `attempt_rollback_plans` record per rollback-eligible attempt. It
persists the owned-path content snapshot at the worker terminal boundary, later attaches bounded
structured failure diagnostics, and records an optional applied timestamp only after the scoped
files have been verified against their checkpoint. The overlap and retry-safety rules are documented in
[bounded-attempt-rollback.md](./bounded-attempt-rollback.md).

Migration 7 replaces free-form specification content with schema-versioned structured JSON. Legacy
non-empty text is retained exactly as the version 1 project goal while all newly introduced
collection fields begin empty; empty legacy records receive an explicit no-goal placeholder.
Repository reads and writes validate the complete `ProjectSpecification`; portable
`SPEC.md` output is rendered from that authoritative value. The contract and round-trip rules are
documented in [project-specification.md](./project-specification.md).

Migration 8 adds the authoritative versioned `master_roadmaps` document and extends roadmap
revision history with the typed operation, actor session, and optional approval evidence. The
mutation service replaces the expected roadmap revision, stores full before/after values, and
appends `ROADMAP_CHANGED` in one transaction. Policy, recovery, and inspection rules are documented
in [audited-roadmap-mutations.md](./audited-roadmap-mutations.md).

Migration 9 adds durable phase reports. Migration 10 extends validation runs with plan identity and
adds ordered `validation_results` records for versioned plugin identity, required/advisory policy,
status, timing, safe execution metadata, bounded diagnostics, acceptance mappings, and retry
relevance. Each plugin result commits before the next plugin begins, so a restarted Core can replay
the completed prefix of an interrupted plan. The aggregate policy and provider boundary are
documented in [validation-framework.md](./validation-framework.md).

Migration 11 maps acceptance criteria to detailed validator or audited manual evidence. Migration
12 adds `independent_reviews`, persisting the fresh-context Reviewer intent before agent execution
and the validated structured verdict, findings, criterion mapping, confidence, and unknowns after
completion. Task and phase foreign keys keep each review within its authoritative project graph;
the unique reviewer run ID prevents accidental logical-session reuse. Each task review is also bound
to its exact `validation_runs` row, while each phase review is bound to the exact persisted
`PHASE_VALIDATION_STARTED` event; the authoritative orchestrators require those IDs to match the
current validation boundary. Reviewer-owned text is redacted in Core before it reaches these rows.
Matching append-only start/completion events carry the review ID, reviewer run ID, context hash, and
validation boundary so task/phase completion does not accept an unproven standalone row.

The project-scoped list queries added for portable export retain repository isolation and stable
ordering. Phase 2 Milestone 3 uses them to create `.densa/` snapshots without exposing raw SQL or
making the filesystem authoritative; see [portable-project.md](./portable-project.md).

## Migration compatibility

`_densa_migrations` records each contiguous migration version, stable name, SHA-256 checksum, and
ISO-8601 application timestamp. Opening a database applies pending migrations transactionally and
fails closed if an already-applied migration differs from the current build. Migration files are
immutable after release: future schema changes append a new version instead of editing migration 1.

The supported paths are zero-to-latest and any contiguous older migration to the current schema.
Migration 4 rebuilds the checkpoint table while preserving legacy rows and leaving its new
association columns null. Migrations 5 and 6 add only nullable attempt data and new intent/evidence
tables, so existing attempts remain valid without commit or rollback outcomes. Migration 7 rebuilds
only the specification table and carries non-empty old free-form content losslessly into the version
1 goal. Migration 8 is additive: existing projects begin without a persisted Master Roadmap and
legacy roadmap revisions retain null operation/session/approval metadata. Migration 10 is also
additive: existing validation runs retain their aggregate outcome with null plan identity and no
detailed child results. Migrations 11 and 12 are additive; existing validations and phase reports
remain readable with no fabricated review evidence. There is no downgrade path; a newer database
must not be opened by an older Core build. Future destructive or data-transforming migrations must
document backup, forward, and rollback assumptions alongside their migration tests.

Migration 12 compares review request/completion timestamps with SQLite `julianday()` so valid
ISO-8601 numeric offsets are ordered by instant rather than lexically.

## Data and secret boundary

All timestamps are validated ISO-8601 strings and SQLite receives only parameterized values.
Detailed prompt transcripts and raw process logs have no columns in this schema, so they are not
persisted by default. Project settings are for non-secret values or references; credentials and
secret values belong in the user-managed secret store described by the engineering constitution.
