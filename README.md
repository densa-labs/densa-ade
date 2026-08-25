# Densa

Densa is a local-first orchestration layer for an AI development IDE. This repository contains
the editor-independent TypeScript/Node foundation, a provider-neutral agent boundary, and the
first non-persistent single-task proof loop. It does not yet contain authoritative persistence or
editor integration.

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

Each run retains a mode-0600 `diagnostics/attempt.json` beside the temporary workspace. The caller
owns eventual cleanup, which keeps attempt evidence inspectable without introducing SQLite or a
long-lived runtime source of truth. Routine tests cover passing, failing, and deliberately lying
fake agents. The authenticated Codex demonstration is opt-in because live agents are not used for
routine tests:

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
