![Densa ADE Logo](assets/Densa-ADE-Logo.png)

# Densa ADE

Densa ADE is an experimental macOS development environment planned around an editor-independent TypeScript/Node Core and a thin Code - OSS client. This repository is rebuilding v2. It currently contains the P0M0 development foundation, documentation, branding assets, and a static website. There is no runnable Densa application, runtime Core, Codex adapter, or release installer yet.

## Development

Use Node **24.14.0** and npm **11.9.0** (also recorded in `.node-version`, `.nvmrc`, and `package.json`). From the repository root:

```sh
npm ci
npm run build
npm run typecheck
npm run lint
npm test
```

The build emits the four empty package boundaries under `dist/`. It does not launch a product or open project state. See the [architecture notes](docs/architecture.md), [evidence process](docs/evidence/README.md), and [development ledger](docs/evidence/ledger.json). The execution environment must also provide `AGENTS.md`, `MASTER_ROADMAP.md`, and `MODEL_POLICY.md` at the root; these authoritative documents are intentionally ignored in the existing repository configuration. A Git-only checkout needs those exact documents supplied before ledger and documentation checks can pass. Do not substitute historical instructions.

## Planned behavior

The v2 roadmap specifies idea-to-specification planning, approved phase roadmaps, isolated implementation, independent validation, and Core-owned local result commits. Users will inspect and integrate results with ordinary Git/editor tools; automatic source-checkout application and remote pushes are excluded.

Usage auto-resume is **off by default**. Future opt-in continuation must wait for a reliable usage reset and revalidate authorization, workspace, configuration, evidence, and remaining attempt budget. Pause, cancellation, recovery barriers, and required decisions can prevent continuation. Runtime models require explicit compatible configuration; there is no automatic model fallback.

Keep-awake is planned to default on during active autonomous work and off while waiting. Battery policy releases the assertion at 20% and reacquires above 25% or on AC power. This is not a guarantee against every sleep, shutdown, or interruption. Guided, Phase (default), and Continuous execution modes remain planned functionality.

Historical/unknown SQLite, `.densa/`, and `.densa-ade/` state must be detected read-only and refused by future runtime owners. No v1 compatibility or migration is promised. P0M0 does not implement a state reader or migration.

## License and status

Densa Labs' original code is licensed under [Apache License 2.0](LICENSE.md). [Third-party notices](THIRD_PARTY_NOTICES.md) describe development dependencies and future downstream obligations. Code - OSS is planned for P12 after the headless gates; its source is not present here. No public platform-support, live-provider, safety, recovery, or release claim is established by foundation tests.
