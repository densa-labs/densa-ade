# `@densa-ade/protocol`

This package owns Densa ADE's editor-neutral and agent-neutral domain and local IPC contracts. Public
contracts pair TypeScript types with Zod schemas so every value received across a process boundary
is validated before use.

## Wire rules

- `protocolVersion` is required on every envelope.
- Requests and responses carry a `requestId`; related activity may carry a `correlationId`.
- Notifications carry a stable event name and may use a correlation ID.
- Payloads are JSON values only. Dates cross the wire as ISO-8601 strings with an explicit offset;
  `Date`, `bigint`, `undefined`, non-finite numbers, and class instances are invalid.
- Unknown object fields are rejected for domain records and protocol envelopes.
- Core transport frames carry a per-instance authentication token around a versioned request.
- Event replay uses an exclusive per-project sequence cursor and a bounded page size; live committed
  facts use `core.event` notifications.
- The frozen IDE-facing operation catalog is exported as `CORE_V1_METHODS`. `CoreV1Client` validates
  every operation payload and result, so clients never need Core repository or database types.

On macOS the Core transport is a user-local Unix-domain socket. No TCP listener is part of the v0.1
protocol contract.

## Compatibility policy

Protocol `1.0.0` is frozen for the first IDE integration pass. New methods may be added within the v1
line because clients negotiate named capabilities; existing strict request and result shapes remain
frozen. Adding, removing, or renaming a field, changing a field's meaning, or changing
cursor/reconnect behavior requires a new protocol major and an explicit compatibility adapter at the
client/Core boundary. Core rejects unsupported versions with `PROTOCOL_VERSION_MISMATCH`; it never
guesses how to interpret them.

See [`docs/core-v1-protocol.md`](../../docs/core-v1-protocol.md) for the complete UI-operation map,
history bounds, and reconnect algorithm.

Persisted events also carry their own `eventVersion`. Readers must preserve old event facts and
upgrade their payloads through version-aware readers rather than rewriting event history.

`ProjectSpecification` is independently versioned with `formatVersion`. Its strict schema preserves
the exact project constraints and unresolved-question metadata used before roadmap generation;
rendering and contradiction detection remain editor- and model-neutral Core concerns.

`MasterRoadmap` and its mutation operations are independently strict. The roadmap schema validates
the complete dependency graph and supersession references. Mutation requests carry typed operation,
classification proposal, rationale, actor/session, application mode, and optional explicit approval
evidence; Core policy and persistence decide whether a request may apply.

`MasterAgentProposal` is the structured project-steering response contract. It separates explanatory
responses from roadmap proposals, project-constraint proposals, and pause/resume/mode commands.
Responses may cite typed internal IDs, but Core validates those citations against the requested
project and translates actions through authoritative domain services; the agent never receives a
direct state-mutation capability.

`Decision` is the durable steering record. Its strict contract distinguishes decisions from
constraints and records the statement, category, source, scope, active/superseded status,
supersession link, timestamps, and affected phase/task references used to construct future worker
context.
