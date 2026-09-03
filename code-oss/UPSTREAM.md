# Upstream tracking strategy

Upstream is **`microsoft/vscode` (Code-OSS)**, tracked as a separate checkout — never
vendored into `densa-ade`.

- **Upstream repository:** https://github.com/microsoft/vscode.git
- **Tracking branch:** `main`
- **Machine-readable pin:** [`upstream.json`](upstream.json)
- **Local checkout directory (git-ignored):** `code-oss/upstream/`

## Why a separate checkout

Vendoring all of upstream into this repository would bury the Densa ADE patchset,
inflate every clone, and violate the thin-fork rule (AGENTS.md §1.3). The Densa ADE
repository keeps only overlays (`product.overlay.json`), the patch inventory
(`patches/inventory.json`), and docs. Upstream history stays in the upstream clone,
where `git log`, `git blame`, and `git merge` keep working normally.

## Initial setup (macOS)

```sh
# 1. Clone upstream once, next to (not inside) the Densa ADE history:
git clone https://github.com/microsoft/vscode.git code-oss/upstream

# 2. Register it as a named remote inside that checkout (name must be `upstream`):
git -C code-oss/upstream remote add upstream https://github.com/microsoft/vscode.git

# 3. Record the pinned ref in code-oss/upstream.json (see "Pinning" below).

# 4. Verify the overlay without building upstream:
npm run ide:doctor
```

`code-oss/upstream/` is listed in `.gitignore` and must never be committed. The
acceptance test `scripts/code-oss-downstream.test.mjs` fails if an upstream checkout
is accidentally staged under version control.

## Pinning

`upstream.json` is the single source of truth for which upstream commit the
downstream was last verified against:

```json
{
  "pinnedRef": "<40-char upstream commit SHA, or null before the first sync>"
}
```

Rules:

- Before the first real sync, `pinnedRef` is `null`. That is the expected Phase 10
  Milestone 0 state: strategy + overlay exist, no upstream build has been certified yet.
- When a sync is performed, set `pinnedRef` to the exact upstream commit SHA, plus
  `lastSync` (ISO-8601) and the sync procedure used.
- Never pin to a moving ref (`main`, `latest`). Always a full commit SHA.
- The pin update and the patch re-application check travel in the same milestone
  commit so the patchset is always relative to a known upstream commit.

## Sync workflow

```sh
cd code-oss/upstream
git fetch upstream
git checkout <pinnedRef>            # reproduce the certified base, or:
git checkout upstream/main          # to evaluate a new upstream tip
# Re-apply Densa ADE overlay + patches per code-oss/PATCHES.md, then:
npm run ide:check                   # overlay + patch inventory + (when present) checkout checks
```

After verifying:

1. update `code-oss/upstream.json` (`pinnedRef`, `lastSync`, `syncNotes`);
2. update `code-oss/PATCHES.md` patch log if any patch needed re-basing;
3. run the full milestone acceptance checks (`npm run check`);
4. commit the pin + patch updates as one logical `densa-ade:` milestone commit.

## Upstream remotes — what goes where

| Repository          | Remote     | URL                                           |
| ------------------- | ---------- | --------------------------------------------- |
| `densa-ade`         | `origin`   | `https://github.com/densa-labs/densa-ade.git` |
| `code-oss/upstream` | `upstream` | `https://github.com/microsoft/vscode.git`     |

Never add the Densa ADE `origin` as a remote of the upstream checkout, and never add
`microsoft/vscode` as a remote of the Densa ADE repository. Keeping the two histories
separate is what keeps the patchset small, reviewable, and re-basable.

## What "small patchset" means

Phase 10 Milestone 0 acceptance requires the patchset relative to upstream to be
small and documented. Concretely:

- `patches/inventory.json` lists every direct upstream patch (empty at M0).
- `PATCHES.md` explains each entry: why an extension could not do the job, which
  upstream area is touched, and how to test it during upstream merges.
- Anything achievable via `apps/ide-extension/` contribution points must not become
  a workbench patch. Reviewers reject patches that skip that justification.
