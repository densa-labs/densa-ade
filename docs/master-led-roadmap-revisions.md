# Master-led roadmap revisions

Phase 8 Milestone 2 adds a durable steering workflow around the authoritative roadmap mutation engine. The Master Agent still cannot edit roadmap state directly: it emits structured operations, and Densa ADE Core previews, classifies, validates, persists, and applies them.

## Workflow

1. The Master translates the user's request into one primary operation and, when needed, an ordered batch of additional operations.
2. `MasterRoadmapRevisionWorkflow` previews the complete batch against the current authoritative roadmap. Each intermediate graph and the final graph must remain valid.
3. Core calculates the highest required `minor`, `significant`, or `scope` classification. A caller cannot under-classify a batch or weaken an existing acceptance promise without raising it to `scope`.
4. Core persists a `roadmap_revision_proposals` record and a `ROADMAP_REVISION_PROPOSED` event. The record contains the exact base revision, operations, rationale, before/after snapshots, affected IDs, approval requirement, and active-task boundary information.
5. Minor proposals may apply automatically when policy permits and no affected task is active. Significant changes follow the permission-policy preset or override. Scope changes always wait for an explicit active user decision.
6. A proposal that affects a `RUNNING`, `VALIDATING`, or `RETRYING` task stays `waiting_for_safe_boundary`. Its worker context is not changed in flight. Calling `applyProposal` after the task reaches a non-active state revalidates the same proposal against the same base revision before applying it.
7. Accepted operation batches replace the authoritative roadmap, write one roadmap revision, resolve the proposal, and append `ROADMAP_CHANGED` in one SQLite transaction. `ROADMAP.md` is regenerated afterward as a portable projection. A portable-sync failure is reported without replaying the already committed authoritative transaction.

## Inspection and audit

The Master command result exposes the proposal ID and event ID, classification, rationale, operation kinds, approval requirement, affected and active task IDs, and exact before/after values. Recent proposal records are also included in bounded Master context and may be cited by proposal ID.

Proposal states are:

- `awaiting_approval`
- `waiting_for_safe_boundary`
- `ready_to_apply`
- `applied`
- `rejected`
- `stale`

If another roadmap revision wins before a proposal is applied, the proposal becomes `stale`; Core never rebases or silently rewrites the user's inspected change.
`stale`, `rejected`, and `applied` are idempotent terminal outcomes. Repeated approval cannot create
another approval decision, and an approval-free minor proposal waiting at an active-task boundary
does not fabricate user-approval evidence. Retrying an applied proposal may regenerate a previously
failed portable projection, but it never replays the authoritative roadmap revision or event.

Phase 4's current mutation boundary also checks the exact stored proposal, reconciles runtime rows
transactionally, includes indirectly shifted tasks in affected IDs, and treats unfinished attempts
as active. The phase executor refreshes accepted changes between tasks; phase validation and
completed work retain their original promises. See [audited-roadmap-mutations.md](./audited-roadmap-mutations.md)
for approval binding, supersession, historical-work protection, and rollback guarantees.

Examples map to existing validated operations and commands:

- “Add mobile support before QA” can be an atomic `add_task` plus `change_dependency` batch.
- “Don't use Firebase” remains a durable project constraint handled by `ProjectDecisionService`.
- “Move search earlier” maps to `reorder_task`.
- “Pause after authentication” uses the existing controlled pause request and execution safe boundary.
- “Replace the deployment phase with local-only packaging” can be an inspected `add_phase` plus `remove_phase` scope batch and therefore requires explicit approval.
