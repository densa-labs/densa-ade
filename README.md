# Densa

Densa is a local-first orchestration layer for an AI development IDE. This repository contains
the editor-independent TypeScript/Node foundation, a provider-neutral agent boundary, the first
single-task proof loop, and migration-backed authoritative SQLite persistence. It does not yet
contain the long-running orchestrator or editor integration.

## Process boundary

```text
Densa clients (CLI / IDE / future tools)
                  |
          versioned local IPC
                  v
             Densa Core
                  |
           AgentAdapter boundary
                  v
        authenticated agent tool
                  |
                  v
             user workspace
```

Densa Core owns authoritative project state. Clients request mutations over the local protocol;
they do not import Core internals or hold authoritative state themselves. Agent implementations
are replaceable adapters, and Core remains independent of Code - OSS and VS Code APIs.

## Repository boundaries

- `packages/protocol` owns versioned, editor- and agent-neutral wire contracts.
- `packages/agent-sdk` owns the replaceable agent adapter boundary.
- `packages/core` owns editor-independent orchestration and authoritative state.
- `packages/cli` is a client of Core over local IPC; it is not an alternate source of truth.
- `packages/testing` owns reusable fakes, fixtures, and test helpers.
- `apps` is reserved for client applications such as the later built-in IDE extension.

Dependency flow points inward: clients may depend on protocol contracts, Core may depend on the
protocol and agent SDK, and no Core package may depend on an app or editor API.

The protocol package documents its JSON wire rules and post-v0.1 compatibility policy in
[`packages/protocol/README.md`](packages/protocol/README.md).

## Authoritative state transitions

Core exposes one `StateTransitionService` for project, phase, and task lifecycle changes. The
canonical transition tables are explicit, terminal states have no outgoing edges, and invalid
jumps fail with `INVALID_STATE_TRANSITION`. Project, phase, and task records parsed by the protocol
are immutable snapshots: callers request a transition instead of assigning `state` directly.

An accepted transition returns a new immutable snapshot plus a versioned event draft containing
the actor, timestamp, prior state, next state, optional reason, and relevant project/phase/task
identifiers. The Core-owned SQLite repository consumes both in one transaction and rejects stale
transition snapshots without appending an event.

## Authoritative SQLite persistence

`DensaDatabase` migrates a fresh SQLite database, exposes repository interfaces for the Phase 2
runtime records, and keeps its raw connection and state-update statements private. Foreign keys,
checks, aggregate task writes, nested transaction savepoints, and append-only event triggers enforce
the initial integrity boundary. In-memory and temporary file databases support deterministic tests.

The schema, migration compatibility rules, transaction behavior, and data/secret boundary are
documented in [`docs/sqlite-persistence.md`](docs/sqlite-persistence.md). Event sequencing, replay,
filters, and post-commit subscriptions are documented in
[`docs/event-journal.md`](docs/event-journal.md).

## Recovery inspection

`RecoveryInspector` compares authoritative project/task/attempt records, verified worker process
identity, incomplete validation, the latest event/checkpoint, and a content-sensitive Git snapshot
after restart. It classifies clean idle, live worker, missing worker, interrupted validation,
workspace divergence, and unknown evidence while returning plans only—P2M4 performs no automatic
state or workspace mutation. The evidence rules and fail-closed behavior are documented in
[`docs/recovery-inspection.md`](docs/recovery-inspection.md).

## Workspace preflight

`WorkspacePreflight` captures a read-only, structured Git safety report before Densa-controlled
work begins. It distinguishes clean repositories, existing `densa/run/*` branches, user changes,
active merge/rebase/cherry-pick operations, detached or unborn HEADs, bare repositories, and
non-Git directories. Unsafe or ambiguous states return a classified stop requiring a decision;
P3M0 never stashes, resets, checks out, creates branches, or otherwise alters user work. The
evidence and policy are documented in
[`docs/workspace-preflight.md`](docs/workspace-preflight.md).

`RunCheckpointService` then creates or reuses a predictably named, SQLite-owned `densa/run/*`
branch and records the verified starting commit against the task and attempt. Branch intent and
checkpoint metadata survive Core restart, collisions fail closed, user work remains untouched,
and the service never pushes. The model and safety boundary are documented in
[`docs/run-branches-and-checkpoints.md`](docs/run-branches-and-checkpoints.md).

## Portable project representation

`PortableProjectSynchronizer` exports important SQLite-backed project intent to deterministic
`.densa/` JSON and Markdown without making those files an alternate runtime database. It preserves
meaningful human edits as explicit conflicts, atomically replaces generated files, creates the
portable reports/logs directories, and redacts secret-like values before writing. The authority
boundary and synchronization protocol are documented in
[`docs/portable-project.md`](docs/portable-project.md).

## Headless CLI

Phase 0 provides a deliberately small `densa` client shell. `doctor`, `version`, project lifecycle,
and event commands are available; project and event commands report an explicit unavailable-Core
placeholder until local IPC exists. The CLI never becomes an alternate source of project truth.

```sh
npm run build
node packages/cli/dist/bin.js --help
node packages/cli/dist/bin.js doctor
node packages/cli/dist/bin.js --json version
```

The stable JSON output contract and injected service boundaries are documented in
[`packages/cli/README.md`](packages/cli/README.md).

## Single-task proof harness

Phase 1 includes a deliberately small temporary-Git-repository harness in `@densa/core`. It creates
an initially failing fixture, records a clean Git checkpoint, builds a scoped Task Packet, invokes
an `AgentAdapter`, records file changes, and runs the fixture's Node test directly. PASS requires a
successful terminal agent event, an in-scope workspace change, no test tampering, and passing
deterministic acceptance checks; agent prose never affects the verdict.

Each run retains a redacted, bounded, mode-0600 `attempt.json` in a separately randomized temporary
diagnostics directory created after the worker exits. The caller owns cleanup of both returned
temporary roots. Runs time out and require confirmed adapter cancellation before workspace
inspection; unconfirmed workers leave their workspace quarantined for escalation. Unexpected
symlinks fail closed, oversized retained events are labeled as truncated, and post-run inspection
errors still produce a FAIL diagnostic. The harness intentionally remains isolated from the newer
authoritative database boundary while its attempt evidence stays inspectable. Routine tests cover
passing, failing, deliberately lying, stalled, and workspace-tampering fake agents. The
authenticated Codex demonstration is opt-in because live agents are not used for routine tests:

```sh
npm run test:live:task-proof
```

## Development

Use Node.js 22.13 or newer and the npm version recorded in `packageManager`.

```sh
npm ci
npm run check
```

The individual acceptance commands are `npm run build`, `npm run typecheck`, `npm run lint`, and
`npm test`. Formatting is checked as part of `npm run check` and can be applied with
`npm run format`.
