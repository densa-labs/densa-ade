# Densa ADE development workflow (macOS)

Reproducible development loop for the thin Code-OSS downstream on macOS.
Phase 10 Milestone 0 established identity, inventory, and verification;
Phase 10 Milestone 1 connects the IDE to the existing Core daemon over the
frozen v1 protocol. The full upstream build comes online incrementally.

## Prerequisites

- macOS (Apple Silicon or Intel; v1 targets macOS only).
- Node.js `>=22.13.0` and npm `11.9.0` (see root `package.json` `engines` /
  `packageManager`).
- Git.
- No Apple Developer enrollment required for this milestone (unsigned/ad-hoc
  development builds; Sparkle signing arrives in Phase 13).

## Reproducible setup

```sh
# 0. From the densa-ade repository root:
node --version   # >=22.13.0
npm --version    # 11.9.0

# 1. Install Densa ADE dependencies (lockfile-pinned):
npm ci

# 2. Verify the downstream overlay without an upstream checkout:
npm run ide:doctor

# 3. Full overlay + inventory verification:
npm run ide:check

# 4. Standard repository acceptance checks (must stay green):
npm run check
```

## Upstream checkout (optional at M0, present from M1)

```sh
git clone https://github.com/microsoft/vscode.git code-oss/upstream
git -C code-oss/upstream remote add upstream https://github.com/microsoft/vscode.git
# Record the exact commit in code-oss/upstream.json (pinnedRef + lastSync).
npm run ide:check   # additionally validates the present checkout
```

The M1 checkout is a single-branch `main` clone pinned in
`code-oss/upstream.json` (see `UPSTREAM.md`). No overlay is applied yet and no
workbench patch is introduced at M1; the IDE/Core boundary is exercised through
the built-in extension's protocol-only client (`scripts/ide-core-connection.test.mjs`).

`code-oss/upstream/` is git-ignored. Never commit it, never import from it in
Densa ADE Core/CLI/protocol packages.

## Building and launching

| Goal                                                 | Command              | Notes                                                                           |
| ---------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------- |
| Verify overlay only                                  | `npm run ide:doctor` | No upstream checkout required                                                   |
| Verify overlay + inventory (+ checkout when present) | `npm run ide:check`  | Used by CI and the downstream acceptance tests                                  |
| Build Densa ADE Core/CLI/extension                   | `npm run build`      | TypeScript project references, includes `apps/ide-extension`                    |
| Verify IDE↔Core connection                           | `npm test`           | Runs `ide-core-connection.test.mjs`: open/close/reopen, replay, mismatch, dedup |
| Launch upstream-based app                            | see below            | Requires `code-oss/upstream/` checkout (present from M1)                        |

From Phase 10 Milestone 1, launching the downstream app follows the upstream build
with the Densa ADE overlay applied:

```sh
# (M1+) Inside code-oss/upstream, apply code-oss/product.overlay.json over
# product.json defaults, build per upstream macOS instructions, and launch:
#   ./scripts/code.sh --no-sandbox --user-data-dir /tmp/densa-ade-profile
```

At M0 the acceptance bar is deliberately narrower: **Densa ADE launches as a
distinct app identity** means the overlay identity is specified, distinct from
upstream (`densa-ade` vs `code-oss`/`code`), and verified by
`scripts/code-oss-downstream.test.mjs` — not that a full `.app` bundle is produced
yet. Normal editor/file/terminal behavior is preserved by construction (zero
workbench patches; see `PATCHES.md`).

## Troubleshooting

- `ide:doctor` reports Node/Git problems: install the pinned toolchain above.
- `ide:check` reports patch inventory drift: keep `PATCHES.md` and
  `patches/inventory.json` in agreement per `patches/README.md`.
- Full `npm run check` failures: fix Core/CLI/protocol first; the downstream
  overlay never excuses a red Core suite (AGENTS.md §16).
