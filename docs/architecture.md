# P0M0 architecture and scope

The authoritative roadmap defines product behavior. These notes choose only the development layout and build mechanisms permitted by P0M0.

| Workspace | Responsibility when implemented | Allowed workspace imports |
| --- | --- | --- |
| `packages/contracts` | Shared editor/provider-neutral contracts; P0M1–P0M4 own schemas | None |
| `packages/core` | Sole runtime authority; persistence and services start in P1 | contracts |
| `packages/adapters` | External provider implementations; live adapter owned by P4 | contracts |
| `packages/clients` | Thin command/query clients; real CLI/IDE owned by P3/P12 | contracts |

At the P0M0 baseline, the entry points exported nothing. The contracts package now exports the P0M1 schemas and P0M2 pure decisions described below; Core, adapters and clients remain empty compilation boundaries. Core has no client, adapter-implementation, Code - OSS, VS Code, or Electron dependency. Future production composition must inject adapters through neutral contracts; add a separately reviewed composition boundary when its owning milestone requires it. Package public exports and declared dependencies must be added by their producer milestones, not inferred from these empty packages.

`scripts/checks.mjs` checks TypeScript AST import/export/import-type/require/dynamic-import forms, package dependency directions, undeclared/deep imports, and relative escapes. Computed imports and alternate loaders require explicit review. Unknown packages/source kinds and symlinks in source fail closed. This is a development architecture check, not a security sandbox or an adversarial JavaScript execution boundary. P2 owns actual containment.

TypeScript strict checking and declaration emission use one root configuration. npm workspaces avoid a task orchestrator and Node's built-in test runner avoids another test dependency. ESLint and its TypeScript parser provide actual source linting. No product runtime dependencies are installed. The pinned development environment is the observed Node 24.14.0/npm 11.9.0; it is not the future bundled runtime or a public support matrix. Exact versions and lockfile integrity bind installation. `npm ci` rejects lock drift; engine checks return a setup error for unsupported development versions. Model availability must be verified separately from current session metadata under MODEL_POLICY; npm cannot certify it.

The existing website deployment workflow, branding, and audit prompts are independent baseline artifacts and remain untouched. Authoritative documents are pre-existing ignored local inputs; provenance records their hashes without staging or rewriting them. A clean install requires these inputs for the full checks. Generated `node_modules/`, `dist/`, and compiler metadata are ignored. No Git commit, push, release tag, or publication is performed by build/test scripts.

Historical-state refusal is a v2 requirement, not a foundation implementation claim. P1M0 owns newer/unknown schema refusal and migration safety; P1M2 owns portable identity inspection; P5 owns workspace preflight. P0M0 opens no runtime state. Runtime DB, execution, IDE, Code - OSS imports, release assets, and P0M1 schemas were outside P0M0's scope; subsequent contract additions are described below.

## Shared wire boundary (P0M1)

[Executable contract notes and catalog](contracts.md) define typed identities, canonical digests, strict message schemas, explicit operation uncertainty, partial success, event watermarks and independent H/I/U/L versions. The contracts package remains dependency-free and independently compilable. Root tests build the contracts before importing their generated JavaScript. No Core service, persistence, socket, lifecycle reducer, authorization implementation or updater payload was added.

P1M1 must consume the pure digest/replay decisions inside its transactional command service, increment scope aggregate revisions, persist deduplication outcomes and journal external effects. P0M2–P0M4 own the more detailed lifecycle/planning/authority/evidence/configuration schemas; P3M1 owns authenticated transport and availability registration. P11M4 must replace every H unavailable obligation with real route evidence. U/L remain reserved for their named P15/P16 producers.

## Pure lifecycle and planning contracts (P0M2)

[Lifecycle notes, guard definitions and scenario specification](lifecycle.md) document explicit transition/hold tables, four-attempt and three-call accounting, graph readiness/splits, role-result decisions, cancellation seams, renewal/repair, sponsorship and reopen initialization. The contracts have no dependency or runtime side effect. P1M1 must persist their proposals and validate facts under the transaction fence; no client can assign a guard or authoritative state. P0M3/P0M4 retain authority, capability, evidence and configuration record ownership.

The implementation uses finite rule arrays plus small pure decision functions, preserving the existing four-package architecture. Unit tests carry a separate expected adjacency and scenario outcomes. No scheduler, OS/Git action, worker/provider call, UI, new production dependency or public handler was introduced. P0M2 root evidence supersedes affected earlier root-suite claims; later normal-route, recovery, security and packaged evidence remains required.
