# Patches directory

Machine-readable patch inventory plus one record template. Human-readable log lives
in [`../PATCHES.md`](../PATCHES.md); the two must agree.

## Files

- [`inventory.json`](inventory.json) — the normative patch manifest. Empty array at
  Phase 10 Milestone 0 (identity + extension only, no workbench patches).
- [`0000-template.md`](0000-template.md) — patch record template for future milestones.

## `inventory.json` schema

Each entry is an object with exactly these fields:

| Field          | Type    | Meaning                                                                       |
| -------------- | ------- | ----------------------------------------------------------------------------- |
| `id`           | string  | `NNNN-short-name`, matches the record filename (`NNNN-short-name.md`)         |
| `upstreamArea` | string  | Upstream path touched, e.g. `vs/workbench/contrib/welcome/`                   |
| `reason`       | string  | Why an extension contribution could not do the job (non-empty)                |
| `mergeTest`    | string  | How to test the patch during upstream merges (non-empty)                      |
| `status`       | string  | `proposed` \| `applied` \| `upstreamed` \| `dropped`                          |
| `mitRetained`  | boolean | Must be `true`: Microsoft MIT notice retained (see THIRD_PARTY_NOTICES.md §1) |
| `record`       | string  | Record filename, e.g. `0001-welcome-entry.md`                                 |

`npm run ide:check` and `scripts/code-oss-downstream.test.mjs` validate this schema,
verify each `record` file exists (except the template), and verify the record
contains the MIT-retention marker and the three justification sections.

## Review checklist for a new patch

- [ ] Achievable via extension contribution APIs? If yes, do that instead.
- [ ] Isolated to one upstream area?
- [ ] `reason`, `upstreamArea`, `mergeTest` filled in?
- [ ] Microsoft MIT notice retained in every modified upstream file?
- [ ] `PATCHES.md` log table updated?
- [ ] `npm run ide:check` green?
