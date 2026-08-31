# Phase 3 current-state release audit prompt

Audit Phase 3 of Densa ADE in `/Users/ivanuy/Desktop/Projects/active-projects/densa-ade` against the current repository, including every later integration that affects its guarantees. Construct and save this entire prompt before beginning the audit, then execute it immediately in the same turn. Historical phase completion is not evidence that the current implementation is correct.

Read `AGENTS.md`, applicable nested instructions, `MODEL_POLICY.md`, and `MASTER_ROADMAP.md`. Record the starting revision, branch, and working-tree state; preserve existing work. Recover the original requirements, acceptance criteria, invariants, architectural intent, lifecycle expectations, failure semantics, and externally observable behavior from P3M0–P3M3, prerequisite Phase 2 contracts, original milestone commits and architecture documentation. Reconcile historical names with intentional current namespaces without weakening the original contract. Distinguish unavailable historical evidence from verified facts.

Construct a requirement-to-current-evidence map covering at least:

- P3M0: structured, read-only workspace preflight identifies Git/non-Git/bare/unborn repositories, branch and HEAD, staged/unstaged/untracked user changes, merge/rebase/cherry-pick state, detached HEAD, ignored runtime artifacts, and existing Densa run ownership. Unsafe or incomplete evidence produces a classified stop/decision; no automatic stash or destruction of user work.
- P3M1: predictable safe run branch creation/reuse, collision and ownership checks, a known Git base before every task, durable checkpoint-to-task/attempt/starting-commit association, restart recovery, preserved user work, and no product pushes or broad destructive cleanup.
- P3M2: independent validation PASS precedes exact attempt/workspace verification, staging only intended changes, atomic task commit creation, durable commit SHA and audit fact, then centralized COMPLETED transition. Git failure never completes a task. Interrupted persistence must not lose or duplicate the commit; unrelated user changes are preserved, and no product push occurs.
- P3M3: bounded rollback restores only proven attempt-owned paths/state; detects overlapping human edits and stops instead of overwriting; preserves unrelated work, diagnostics and failed-attempt history; cleans owned temporary artifacts; survives partial application/restart; proves the next attempt starts from a known state.
- Phase 3's contribution to Gate B and later headless execution: user work survives failures/restarts, task commits reflect validated content, retries and recovery do not bypass ownership or checkpoint checks, Core remains authoritative and editor-independent, and side effects have persisted intent/outcome or explicit conservative recovery.

Expand the map for additional original requirements. Trace requirements into all relevant current code paths, callers, integrations, configuration, persistence migrations/repositories, tests, and changes in Phases 4–9. Review preflight, process/Git helpers, run checkpoints, task commit intents, output capture, rollback plans, validation, orchestration/retries, scheduler, execution controls, usage resume, recovery, reports/rundowns, and daemon/protocol/CLI exposure wherever they depend on Phase 3.

Passing tests are evidence, not proof. Actively search beyond tests for missing/incomplete implementation, partially satisfied acceptance criteria, weakened/violated invariants, architectural drift, later regressions, incorrect assumptions, integration failures, lifecycle/state-transition bugs, persistence/recovery problems, weak/missing validation, incorrect failure handling, boundary conditions, and realistic workflows that isolated tests miss. Inspect stale validation/output, mismatched graph identities, wrong branches/workspaces, dirty index versus worktree, renames/deletions/modes/symlinks/pathspecs, Git config/hooks/ignored files, overlapping edits, branch collisions, unexpected HEAD movement, crash windows around Git and SQLite, re-entry/idempotency, partial rollback, process termination, and retry readiness.

Distinguish confirmed defects from speculative concerns. For each confirmed defect, identify its violated requirement and concrete reachable path/reproduction. Fix every confirmed defect in Phase 3's intended requirements, including later callers that violate them. Preserve intentional later-phase behavior unless it conflicts with a required invariant or acceptance criterion. Do not weaken tests, broaden product scope, start another milestone, rewrite historical commits/tags, destroy user changes, or use paid agents for routine validation.

Add or strengthen meaningful regression coverage wherever practical for every confirmed defect. Use temporary real Git repositories and SQLite restart/fault fixtures. Run relevant unit, integration, regression, and acceptance checks after repairs, plus the full `npm run check`. Obtain narrowly scoped local process/socket access when required by deterministic tests; do not silently omit material validation. Reinspect affected implementations and callers after validation to establish the underlying guarantee, not merely a passing test.

Write `docs/phase-3-current-state-audit.md` with the reviewed revision/context, original contract and evidence map, concise scope, every confirmed finding and resolution, remaining uncertainty/unverified assumptions, and validation commands/results. End the report and user-facing audit result with exactly one applicable gate statement:

PASS — Cleared for release.

Use PASS only if available evidence supports that Phase 3's requirements, acceptance criteria, invariants, architecture, and intended behavior remain correctly implemented in the current codebase and no confirmed release-blocking issue remains.

FAIL — Issues remain; deeper fixes are required.

Use FAIL if any confirmed issue remains unresolved, required behavior cannot be demonstrated with sufficient confidence, or validation is materially incomplete.

On PASS, selectively commit the completed audit and repairs using a `densa-ade:` message and push normally to `origin/main`, as explicitly authorized. Inspect branch/upstream/divergence first; preserve unrelated work, never force-push, never rewrite phase tags, and verify local and remote main SHA plus ahead/behind before claiming synchronization. On FAIL preserve repairs and report gaps; do not make a completion commit/push.

The separate Densa Core Integration Audit is conditional: run it only after verifying that Phases 1–9 have individually passed their current-state audits. Historical milestone tags do not satisfy this prerequisite. Do not automatically audit the remaining phases to manufacture eligibility. When eligible, first construct a fresh self-contained integration prompt, then execute it immediately in that turn.
