# Event journal

Phase 2 Milestone 2 turns Core's persisted events into an ordered, replayable audit journal. Events
are facts that already happened (`TASK_STARTED`, `VALIDATION_FAILED`, and similar lifecycle facts),
not commands for a renderer or other client. SQLite remains authoritative; the in-process publisher
is only a low-latency view of facts that have already committed.

## Ordering and versioning

Each event has an immutable ID, an `eventVersion` for version-aware payload readers, and a positive
`sequenceNumber` that is allocated independently within its project. The sequence is insertion
order, not timestamp order, so equal or skewed clocks cannot make replay nondeterministic. Clients
resume with an exclusive cursor: `replay({ projectId, afterSequence: N })` returns committed events
after `N` in ascending sequence order.

Migration 2 upgrades the original event table without changing migration 1. Existing facts retain
their IDs, scopes, types, timestamps, actors, payloads, and versions. Their initial project sequence
is deterministically derived from `(occurredAt, id)`. Update and delete triggers are recreated on
the upgraded table so application code and raw SQL cannot rewrite old facts.

## Replay and subscriptions

Replay supports project, phase, task, and event-type filters. Results default to 500 records and are
capped at 1,000 records per call, so reconnecting clients page rather than loading an unbounded
journal into memory. Because sequence numbers restart for each project, `afterSequence` requires a
`projectId`.

`EventJournal.subscribe()` filters new in-process notifications using the same scopes. Repository
appends register an after-commit callback with the SQLite transaction boundary. Nested transactions
carry callbacks to their parent; rollback discards them. A subscriber therefore never observes an
event whose transaction later fails, and subscriber errors cannot roll back or invalidate a fact
that is already durable.

## Payload boundary

Event payloads remain JSON objects validated by `@densa-ade/protocol` and are limited to 64 KiB when
UTF-8 encoded. Raw process transcripts and unbounded logs do not belong in events; bounded local log
storage will use its own retention policy. Event queries are also bounded as described above.
