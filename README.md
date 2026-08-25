# Densa

Densa is a local-first orchestration layer for an AI development IDE. This repository begins
with the editor-independent TypeScript/Node foundation for Densa Core; it does not yet contain
agent execution, persistence, or editor integration.

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

## Development

Use Node.js 22.13 or newer and the npm version recorded in `packageManager`.

```sh
npm ci
npm run check
```

The individual acceptance commands are `npm run build`, `npm run typecheck`, `npm run lint`, and
`npm test`. Formatting is checked as part of `npm run check` and can be applied with
`npm run format`.
