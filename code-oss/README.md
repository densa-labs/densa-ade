# Code-OSS downstream (thin fork)

This directory is the **thin Densa ADE downstream of Code-OSS** (`microsoft/vscode`).
It contains overlays, product identity, patch inventory, and reproducible development
workflows — not a vendored copy of upstream source.

- Upstream source is checked out separately at `code-oss/upstream/` (git-ignored).
  That directory must never be committed. See [`UPSTREAM.md`](UPSTREAM.md).
- Densa ADE product identity lives in [`product.overlay.json`](product.overlay.json).
  The overlay is applied at build time on top of upstream `product.json` defaults.
- Every direct upstream patch is documented in [`PATCHES.md`](PATCHES.md) and tracked
  in [`patches/inventory.json`](patches/inventory.json). An empty inventory is the
  expected Phase 10 Milestone 0 state: identity + extension only, no workbench patches.
- Placeholder branding policy lives in [`BRANDING.md`](BRANDING.md). Text only; the
  product logo comes later.
- Reproducible macOS development workflow lives in [`DEVELOPMENT.md`](DEVELOPMENT.md).
- Architecture and milestone acceptance mapping lives in
  [`../docs/code-oss-downstream.md`](../docs/code-oss-downstream.md).

## Thin-fork policy (AGENTS.md §1.3)

If a feature can reasonably live outside Code-OSS core, it **must**. Prefer, in order:

1. normal extension contribution APIs;
2. the built-in Densa ADE extension (`../apps/ide-extension/`);
3. isolated `vs/workbench/contrib/...` integration;
4. minimal workbench/core patching only when the required product UX cannot be
   achieved otherwise.

Do not rewrite or fork the editor, Explorer, terminal, SCM, debugger, extension
host, Monaco, or other mature upstream systems to make them "more Densa ADE."

Every direct Code-OSS core patch must document:

- why an extension/built-in contribution could not do the job;
- what upstream area is touched;
- how to test the patch during upstream merges.

## Licensing boundary

- Densa-written files in this directory are **Apache-2.0**. See [`../LICENSE`](../LICENSE).
- Upstream Code-OSS remains **MIT (Microsoft Corporation)**. See
  [`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).
- Modified Code-OSS files of any kind retain Microsoft's MIT notice alongside the
  Densa ADE overlay comment. See `THIRD_PARTY_NOTICES.md` §1 for the exact header.

## Layout

```text
code-oss/
├── README.md               # this file (thin-fork policy)
├── UPSTREAM.md             # upstream tracking + sync workflow
├── upstream.json           # machine-readable upstream pin
├── product.overlay.json    # Densa ADE product identity overlay
├── BRANDING.md             # temporary text/placeholder branding
├── PATCHES.md              # patch policy + human-readable patch log
├── DEVELOPMENT.md          # reproducible macOS build/launch workflow
└── patches/
    ├── README.md           # patch format + review checklist
    ├── inventory.json      # machine-readable patch inventory (empty at M0)
    └── 0000-template.md    # patch record template (no workbench patch at M0)
```

`code-oss/upstream/` (the actual `microsoft/vscode` checkout) is intentionally absent
from version control. `npm run ide:doctor` verifies the overlay without requiring a
checkout; `npm run ide:check` additionally validates a present checkout when one exists.
