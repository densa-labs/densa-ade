# Open VSX extension gallery (Phase 12 Milestone 1)

Coherent extension experience for the thin Code-OSS downstream using
Open VSX. Code-OSS ships no gallery by default; Densa ADE pins the
downstream to Open VSX and never claims Microsoft Marketplace
compatibility.

## Prerequisite

Phases 10–11 and Phase 12 Milestone 0 are complete: the thin downstream,
the protocol-only IDE↔Core connection, Home/Welcome actions, navigation
shells, Dashboard/Roadmap/Master/phase-rundown/live-run content models,
and first-launch onboarding. This milestone adds no orchestration,
scheduling, validation, Master, roadmap-content, or onboarding changes.

## Requirement mapping

| Milestone item                              | Implementation                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configure downstream gallery for Open VSX   | `code-oss/product.overlay.json` `identity.extensionsGallery`: `serviceUrl https://open-vsx.org/vscode/gallery`, `itemUrl https://open-vsx.org/vscode/item`, `resourceUrlTemplate https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}`, `extensionUrlTemplate https://open-vsx.org/vscode/gallery/{publisher}/{name}/latest` (Open VSX Marketplace-API adapter per `Using Open VSX in VS Code`); verified by `npm run ide:check` |
| Verify install/search/update behavior       | Upstream workbench Extensions view driven by the overlay plus pure operation gating in `apps/ide-extension/src/extensions-gallery.ts` (`resolveGalleryOperation()`): `search`/`install`/`update` require `reachable`, `enable`/`disable`/`uninstall` act on local state offline; manual dev-build procedure below                                                                                                                                 |
| Label registry/source in settings/about     | `getGallerySettingsCopy()` / `getGalleryAboutCopy()` / `getGalleryRegistryLabel()` (`Open VSX Registry`, `open-vsx.org`); settings and about surfaces render this copy verbatim                                                                                                                                                                                                                                                                   |
| Handle unavailable extensions gracefully    | `classifyGalleryFailure()` (`registry-unreachable`, `extension-not-found`, `marketplace-only`, `incompatible`, `unknown`) plus `describeMarketplaceOnlyUnavailable()`; every failure names a next action, never blocks basic editing, never marks work complete optimistically                                                                                                                                                                    |
| Do not claim Marketplace-only compatibility | No `marketplace.visualstudio.com` URL anywhere in the overlay, extension sources, or docs except in explicit non-compatibility statements; `npm run ide:check` and `scripts/open-vsx-gallery.test.mjs` fail on such URLs                                                                                                                                                                                                                          |

## Architecture notes

- **Thin-fork ordering (AGENTS.md §1.3)** is unchanged: zero workbench
  patches. Gallery behavior stays in the upstream Extensions view driven by
  `product.json`; Densa ADE contributes only the build-time overlay plus the
  protocol-only labeling/gating/explanation model in the built-in extension.
- **Core stays authoritative and editor-independent.**
  `extensions-gallery.ts` imports nothing from `@densa-ade/core`,
  `@densa-ade/cli`, SQLite, or `vscode` / `vs/workbench`, performs no
  network I/O, and issues no Core request (`EXTENSIONS_GALLERY_LIFECYCLE`:
  `createsNewAuthoritativeState: false`, `issuesCoreRequest: false`).
  Reachability is caller-observed; `unknown` is honest, never guessed.
- **Built-in extension is independent of registry availability.**
  `buildGalleryModel()` always reports `builtInIndependent: true` and
  `blocksEditor: false`. Gallery outages degrade to guidance while the
  built-in extension, editor, and Core execution keep working.
- **Upstream field note.** The pinned upstream `product.ts`
  `IProductConfiguration.extensionsGallery` lists `serviceUrl`,
  `controlUrl`, `extensionUrlTemplate`, `resourceUrlTemplate`, and `nlsBaseUrl`;
  the upstream manifest service additionally reads `itemUrl` (and optional
  `publisherUrl`) via its gallery config cast — the same shape VSCodium
  carries. The overlay sets the four Open VSX fields the wiki documents;
  no `product.ts` patch is introduced.

## Manual dev-build verification (acceptance procedure)

Requires the `code-oss/upstream/` checkout and the overlay applied per
`code-oss/DEVELOPMENT.md`:

```sh
npm run ide:check
# Inside code-oss/upstream, apply code-oss/product.overlay.json over
# product.json defaults, build per upstream macOS instructions, launch:
#   ./scripts/code.sh --no-sandbox --user-data-dir /tmp/densa-ade-profile
```

Then, with network access, in the development build:

1. Open the Extensions view; confirm the source reads **Open VSX Registry**.
2. Search a known Open VSX extension (for example `rust-lang.rust-analyzer`):
   confirm results link to `open-vsx.org/vscode/item?itemName=…`.
3. Install it, confirm it enables, then disable, re-enable, and remove it.
   Each step completes through the Extensions view without a second
   authoritative state and without touching Core execution.
4. Search a known Marketplace-only extension id; confirm the view reports it
   as unavailable with the marketplace-only explanation, not as installable.
5. Disconnect the network; confirm search/install/update report the registry
   as unreachable with a retry-or-manual-`.vsix` next action, while
   enable/disable/remove of already-installed extensions still work and the
   built-in Densa ADE extension stays functional.

The automated suite (`scripts/open-vsx-gallery.test.mjs`) pins the overlay
endpoints, URL builders, operation gating, failure copy, labeling, and
built-in independence so the manual pass stays a behavior check, not a
configuration discovery.

## Acceptance mapping

| Acceptance criterion                                                                         | Evidence                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Known Open VSX extension can be searched, installed, enabled, removed in a development build | Overlay endpoints plus `resolveGalleryOperation()` gating (`scripts/open-vsx-gallery.test.mjs`: reachable allows search/install/enable/disable/uninstall/update; URL builders produce the Open VSX item/latest/resource URLs); manual procedure above                    |
| Failures are understandable                                                                  | Same suite: every `classifyGalleryFailure()` kind has a title, detail, and next action; offline search/install/update is denied with retry-or-manual-`.vsix` guidance; `unknown` never claims a result                                                                   |
| Built-in extension remains independent of external registry availability                     | Same suite: manifest deps stay protocol-only, gallery sources avoid forbidden imports and perform no network I/O, `buildGalleryModel()` reports `builtInIndependent: true` / `blocksEditor: false` for all reachabilities, offline enable/disable/uninstall stay allowed |

## Deferred (not in M1)

Settings/policy UI (M2), recovery/waiting UX (M3), telemetry upload (M4),
Sparkle updater and packaging (Phase 13). No `product.ts` type patch, no
Marketplace credentials, no mirrored-gallery infrastructure.
