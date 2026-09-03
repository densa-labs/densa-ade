# Branding (temporary text/placeholder)

Phase 10 Milestone 0 uses **temporary text/placeholder visual branding only**.
The product logo comes later.

## What this means

- Product identity is text: `Densa ADE` (`nameShort` / `nameLong`), executable and
  data-folder name `densa-ade`. See [`product.overlay.json`](product.overlay.json).
- No binary logo, icon (`.png`, `.icns`, `.ico`, `.svg` logo), or font assets are
  added in this milestone. The acceptance test fails if any appear under `code-oss/`
  (outside `code-oss/upstream/`, which is ignored anyway) or `apps/ide-extension/`.
- The running app window, About dialog, and welcome surfaces show the `Densa ADE`
  text wordmark using the platform default font. No custom artwork.

## What is explicitly deferred

- Final product logo and icon set.
- Custom splash / welcome artwork.
- Marketing website re-brand beyond the existing placeholder page.
- Dark/light icon variants, file-type icons, and macOS Dock tile polish.

Those arrive with the product-polish milestones (Phase 12). Adding them early would
create large binary diffs against upstream for zero milestone value.

## When branding changes

Any later branding change updates this file, `product.overlay.json`, and the patch
inventory if upstream branding files are touched — with before/after screenshots or
text snapshots attached to the milestone commit.
