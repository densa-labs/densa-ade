# `@densa/protocol`

This package owns Densa's editor-neutral and agent-neutral domain and local IPC contracts. Public
contracts pair TypeScript types with Zod schemas so every value received across a process boundary
is validated before use.

## Wire rules

- `protocolVersion` is required on every envelope.
- Requests and responses carry a `requestId`; related activity may carry a `correlationId`.
- Notifications carry a stable event name and may use a correlation ID.
- Payloads are JSON values only. Dates cross the wire as ISO-8601 strings with an explicit offset;
  `Date`, `bigint`, `undefined`, non-finite numbers, and class instances are invalid.
- Unknown object fields are rejected for domain records and protocol envelopes.

## Compatibility policy

Before v0.1, contract changes may update `PROTOCOL_VERSION` while the protocol is still being
formed. Once v0.1 ships, additive changes that preserve meaning remain within the same supported
protocol line. Breaking field, meaning, or payload changes require a new protocol version and an
explicit compatibility adapter at the client/Core boundary. Core rejects unsupported versions with
`PROTOCOL_VERSION_MISMATCH`; it never guesses how to interpret them.

Persisted events also carry their own `eventVersion`. Readers must preserve old event facts and
upgrade their payloads through version-aware readers rather than rewriting event history.

`ProjectSpecification` is independently versioned with `formatVersion`. Its strict schema preserves
the exact project constraints and unresolved-question metadata used before roadmap generation;
rendering and contradiction detection remain editor- and model-neutral Core concerns.

`MasterRoadmap` and its mutation operations are independently strict. The roadmap schema validates
the complete dependency graph and supersession references. Mutation requests carry typed operation,
classification proposal, rationale, actor/session, application mode, and optional explicit approval
evidence; Core policy and persistence decide whether a request may apply.
