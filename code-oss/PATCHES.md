# Upstream patches

Every direct Code-OSS core patch is documented here and tracked in
[`patches/inventory.json`](patches/inventory.json). The two files always agree:
`PATCHES.md` is the human-readable log, `inventory.json` is the machine-readable
manifest verified by `npm run ide:check` and `scripts/code-oss-downstream.test.mjs`.

## Policy (AGENTS.md §1.3)

Prefer, in order:

1. normal extension contribution APIs;
2. the built-in Densa ADE extension (`../apps/ide-extension/`);
3. isolated `vs/workbench/contrib/...` integration;
4. minimal workbench/core patching only when the required product UX cannot be
   achieved otherwise.

A patch record must explain:

- **why** an extension/built-in contribution could not do the job;
- **what** upstream area is touched (e.g. `vs/workbench/contrib/welcome/`);
- **how** to test the patch during upstream merges.

Patches that skip that justification are rejected in review. Never rewrite the
editor, Explorer, terminal, SCM, debugger, extension host, or Monaco to make them
"more Densa ADE."

## Patch log

| ID  | Upstream area | Why not an extension | Merge test | Status |
| --- | ------------- | -------------------- | ---------- | ------ |
| —   | —             | —                    | —          | —      |

No direct upstream patches at Phase 10 Milestone 0. The downstream is product
identity (`product.overlay.json`) plus the built-in extension
(`../apps/ide-extension/`) only. This empty table is the expected M0 state and is
what "patchset is small and documented" means at bootstrap: zero workbench patches,
one overlay, one extension scaffold.

## Adding a patch (future milestones)

1. Copy `patches/0000-template.md` to `patches/NNNN-short-name.md`.
2. Fill in every section, including the MIT-retention header check.
3. Add the entry to `patches/inventory.json` (schema in `patches/README.md`).
4. Add a row to the log table above.
5. Run `npm run ide:check` and the full `npm run check`.

## License retention

Modified Code-OSS files of any kind retain Microsoft's MIT notice alongside the
Densa ADE overlay comment. The exact header is specified in
[`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) §1. `npm run ide:check`
verifies that every `inventory.json` entry records `mitRetained: true`.
