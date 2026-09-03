# Densa ADE IDE extension (built-in)

Protocol-only IDE client scaffold for the thin Code-OSS downstream. Phase 10
Milestone 0 establishes the package boundary; Dashboard/Roadmap/Master surfaces
arrive in later milestones.

## Boundary (AGENTS.md §1.1–§1.2)

- Imports `@densa-ade/protocol` only. Never `@densa-ade/core`, SQLite repositories,
  daemon internals, or Code-OSS workbench APIs.
- Densa ADE Core is authoritative. The extension renders Core snapshots and sends
  versioned protocol requests; it never mutates project truth locally and never
  marks tasks complete optimistically.
- Connection uses the local Unix-domain socket + per-instance auth token with
  `protocolVersion` handshake, reconnect, and event replay from a sequence number
  (see `src/connection.ts` and `docs/core-v1-protocol.md`).

## Contributions (M0 scaffold)

- Command palette group `densa-ade`: Open Dashboard / Roadmap / Master Agent,
  Start Project, Resume Project.
- Activity Bar container `densa-ade` with placeholder Dashboard / Roadmap /
  Master Agent views (full editor-area tabs arrive in Phase 10 Milestone 3).
- No binary icons. The container uses the `$(placeholder)` codicon until product
  polish.

## Layout

```text
apps/ide-extension/
├── package.json   # contributes.commands/views, engines.vscode, protocol-only deps
├── tsconfig.json  # composite build, references @densa-ade/protocol
└── src/
    ├── index.ts       # extension id, product binding, commands/views, summary
    └── connection.ts  # Core socket options + protocol version guard
```

## Verification

```sh
npm run build       # includes apps/ide-extension via project references
npm run ide:check   # validates manifest deps + protocol-only imports
npm test            # runs scripts/code-oss-downstream.test.mjs
```

## Licensing

Densa-written extension code is Apache-2.0 (`SPDX-License-Identifier: Apache-2.0`).
Upstream Code-OSS remains MIT; see `THIRD_PARTY_NOTICES.md`.
