# P0M0 architecture and scope

The authoritative roadmap defines product behavior. These notes choose only the development layout and build mechanisms permitted by P0M0.

| Workspace | Responsibility when implemented | Allowed workspace imports |
| --- | --- | --- |
| `packages/contracts` | Shared editor/provider-neutral contracts; P0M1–P0M4 own schemas | None |
| `packages/core` | Sole runtime authority; persistence and services start in P1 | contracts |
| `packages/adapters` | External provider implementations; live adapter owned by P4 | contracts |
| `packages/clients` | Thin command/query clients; real CLI/IDE owned by P3/P12 | contracts |

All current entry points export nothing. They are compilation boundaries, not handlers or success-returning stubs. Core has no client, adapter-implementation, Code - OSS, VS Code, or Electron dependency. Future production composition must inject adapters through neutral contracts; add a separately reviewed composition boundary when its owning milestone requires it. Package public exports and declared dependencies must be added by their producer milestones, not inferred from these empty packages.

`scripts/checks.mjs` checks TypeScript AST import/export/import-type/require/dynamic-import forms, package dependency directions, undeclared/deep imports, and relative escapes. Computed imports and alternate loaders require explicit review. Unknown packages/source kinds and symlinks in source fail closed. This is a development architecture check, not a security sandbox or an adversarial JavaScript execution boundary. P2 owns actual containment.

TypeScript strict checking and declaration emission use one root configuration. npm workspaces avoid a task orchestrator and Node's built-in test runner avoids another test dependency. ESLint and its TypeScript parser provide actual source linting. No product runtime dependencies are installed. The pinned development environment is the observed Node 24.14.0/npm 11.9.0; it is not the future bundled runtime or a public support matrix. Exact versions and lockfile integrity bind installation. `npm ci` rejects lock drift; engine checks return a setup error for unsupported development versions. Model availability must be verified separately from current session metadata under MODEL_POLICY; npm cannot certify it.

The existing website deployment workflow, branding, and audit prompts are independent baseline artifacts and remain untouched. Authoritative documents are pre-existing ignored local inputs; provenance records their hashes without staging or rewriting them. A clean install requires these inputs for the full checks. Generated `node_modules/`, `dist/`, and compiler metadata are ignored. No Git commit, push, release tag, or publication is performed by build/test scripts.

Historical-state refusal is a v2 requirement, not a foundation implementation claim. P1M0 owns newer/unknown schema refusal and migration safety; P1M2 owns portable identity inspection; P5 owns workspace preflight. P0M0 opens no runtime state. Runtime DB, execution, IDE, Code - OSS imports, release assets, and all P0M1 schemas remain out of scope.
