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

Events have append-only database triggers from the first schema. Phase 2 Milestone 2 will add
per-project sequence numbers, replay, filtering, post-commit publication, and subscriptions; those
features are intentionally not included here.

## Migration compatibility

`_densa_migrations` records each contiguous migration version, stable name, SHA-256 checksum, and
ISO-8601 application timestamp. Opening a database applies pending migrations transactionally and
fails closed if an already-applied migration differs from the current build. Migration files are
immutable after release: future schema changes append a new version instead of editing migration 1.

The zero-to-version-1 path is the only upgrade path in this milestone. There is no downgrade path;
a newer database must not be opened by an older Core build. Future destructive or data-transforming
migrations must document backup, forward, and rollback assumptions alongside their migration tests.

## Data and secret boundary

All timestamps are validated ISO-8601 strings and SQLite receives only parameterized values.
Detailed prompt transcripts and raw process logs have no columns in this schema, so they are not
persisted by default. Project settings are for non-secret values or references; credentials and
secret values belong in the user-managed secret store described by the engineering constitution.
