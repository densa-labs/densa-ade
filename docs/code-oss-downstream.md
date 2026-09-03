# Code-OSS downstream (Phase 10 Milestone 0)

Bootstrap record for the thin Densa ADE downstream of Code-OSS. This document maps
the milestone requirements to the files that satisfy them and states what is
deliberately deferred.

## Prerequisite

Phase 9 is complete (`densa-phase-9-complete` tag): the headless one-phase loop —
idea/spec → roadmap → Phase 1 execution → validation → report → approval — is proven
before any Code-OSS fork work, per the hard sequencing rule in `MASTER_ROADMAP.md`
and AGENTS.md §21. This milestone adds no orchestration, scheduling, or validation
changes.

## Requirement mapping

| Milestone task                       | Implementation                                                                                                                                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clean upstream tracking strategy     | [`code-oss/UPSTREAM.md`](../code-oss/UPSTREAM.md), [`code-oss/upstream.json`](../code-oss/upstream.json); checkout at git-ignored `code-oss/upstream/`                                                     |
| Downstream product identity          | [`code-oss/product.overlay.json`](../code-oss/product.overlay.json): `Densa ADE` / `densa-ade` / `labs.densa.ade`, distinct from upstream `code-oss` / `code`                                              |
| Temporary text/placeholder branding  | [`code-oss/BRANDING.md`](../code-oss/BRANDING.md); no binary logo assets; enforced by test                                                                                                                 |
| Preserve Code-OSS editor behavior    | Zero workbench patches ([`code-oss/PATCHES.md`](../code-oss/PATCHES.md) log empty, [`code-oss/patches/inventory.json`](../code-oss/patches/inventory.json) `[]`); preserved surfaces listed in the overlay |
| Document every direct upstream patch | `PATCHES.md` + `patches/README.md` schema + `patches/0000-template.md` record template + `inventory.json` manifest                                                                                         |
| Built-in Densa ADE extension package | [`apps/ide-extension/`](../apps/ide-extension/) — protocol-only client scaffold (Core stays authoritative, AGENTS.md §1.1–§1.2)                                                                            |
| Reproducible macOS dev scripts       | [`code-oss/DEVELOPMENT.md`](../code-oss/DEVELOPMENT.md), `scripts/code-oss-dev.mjs` (`npm run ide:doctor`, `npm run ide:check`)                                                                            |
| Apache-2.0 + Microsoft MIT boundary  | [`LICENSE`](../LICENSE), [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md), `license: Apache-2.0` in root + workspace `package.json` files                                                             |

## Acceptance mapping

| Acceptance criterion                                  | Evidence                                                                                                                                                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Densa ADE launches as a distinct app identity         | Overlay identity verified by `scripts/code-oss-downstream.test.mjs` (applicationName/dataFolder/bundleId distinct from upstream); full `.app` bundle arrives with later Phase 10–13 packaging work |
| Normal editor/file/terminal basics still work         | Preserved by construction: no workbench/editor/terminal/SCM/debugger/Monaco patches at M0; preserved surfaces enumerated in `product.overlay.json`                                                 |
| Patchset relative to upstream is small and documented | Patchset is empty at M0 and fully inventoried; patch policy + template + schema in place for future milestones                                                                                     |
| Upstream remote/sync workflow is documented           | `code-oss/UPSTREAM.md` (clone, remote naming, pinning, sync, what-goes-where)                                                                                                                      |

## Architecture notes

- **Core stays authoritative and editor-independent.** The IDE (extension +
  workbench surfaces from M1–M3) is a client of Densa ADE Core over the frozen
  Core v1 protocol (`docs/core-v1-protocol.md`). The extension imports
  `@densa-ade/protocol` only — never `@densa-ade/core`, SQLite repositories, or
  workbench internals. The acceptance test greps the extension source for those
  imports.
- **Thin-fork ordering (AGENTS.md §1.3)** is enforced by the patch review checklist
  in `code-oss/patches/README.md`: extension APIs first, isolated
  `vs/workbench/contrib/...` second, core patching last with written justification.
- **No vendored upstream.** `code-oss/upstream/` is git-ignored; the repository
  carries overlays only. This keeps clones small and the patchset re-basable.
- **Licensing.** Densa-written code is Apache-2.0; upstream and modified Code-OSS
  files retain Microsoft's MIT notice. See `THIRD_PARTY_NOTICES.md` §1 for the
  required dual header.

## Deferred (not in M0)

Dashboard/Roadmap/Master surfaces (M2–M3, Phase 11), Core connection + reconnect
(M1), Home/Welcome actions (M2), Activity Bar/commands (M3), Open VSX gallery
configuration (Phase 12 M1), Sparkle updater + packaging (Phase 13). No logo binaries
until product polish.
