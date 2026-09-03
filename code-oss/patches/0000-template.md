# Patch record template (copy to NNNN-short-name.md)

<!--
Copy this file to patches/NNNN-short-name.md and fill in every section.
Add the matching entry to patches/inventory.json and a row to code-oss/PATCHES.md.
Delete this comment block in the copy.
-->

## ID

`NNNN-short-name`

## Status

`proposed` | `applied` | `upstreamed` | `dropped`

## Upstream area

`<e.g. vs/workbench/contrib/welcome/>` — one upstream area per patch.

## Why an extension contribution could not do the job

`<Required. Explain which extension/built-in contribution points were tried and why
the required product UX cannot be achieved through them. Patches without this
justification are rejected.>`

## What changed

`<Files changed relative to the pinned upstream ref in code-oss/upstream.json,
with before/after behavior.>`

## MIT retention

`MIT retained: true`

Every modified upstream file keeps its Microsoft copyright line and the Densa ADE
overlay comment specified in `THIRD_PARTY_NOTICES.md` §1:

```text
// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See THIRD_PARTY_NOTICES.md.
// ---
// Densa ADE downstream change (Apache-2.0). See code-oss/PATCHES.md.
```

## How to test during upstream merges

`<Required. Concrete steps: launch the downstream, exercise the patched surface,
re-apply after fetching the new pinned ref, expected result.>`
