# Phase 3 current-state audit — 2026-08-31

## Scope and provenance

The complete [audit prompt](./phase-3-current-state-audit-prompt.md) was saved before implementation
inspection began and executed immediately in the same task. The audit started on clean `main` at
`d68c3ea4d719ebd7bc9fc39e9ecb762d69e95a82`, after the Phase 0–2 audit commits and Phase 9 implementation.
This report covers that revision plus the audit repairs and tests. Existing work was
preserved. No production database or existing tag was changed. Maintainer commit/push is conditional on the final gate.

Original contracts were recovered from `AGENTS.md`, local `MASTER_ROADMAP.md` P3M0–P3M3 and Gate B,
original milestone history (`2f42312`, `076a4b1`, `575440e`, `04791eb`), historical architecture docs,
and implementation notes. The local roadmap is not a tracked historical source; historical milestone
docs/source provide the cross-check. Old paths/names/test counts were not treated as current proof.
Intentional `.densa-ade/` namespace migration and legacy branch compatibility remain intact.
Final synchronization discovered the newer README-only commit `e34d63842e170e0ee47f931e50f89324cef36d9b`;
main was fast-forwarded without stashing or altering audit changes, preserving that upstream work.

## Requirement and current evidence map

| Original requirement / intended observable behavior                                                                                                                                                                                       | Current implementation and audit evidence                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P3M0: structured read-only Git preflight; detect staged, unstaged, untracked, detached/unborn, bare/non-Git, merge/rebase/cherry-pick, runtime artifacts and reserved branches; never stash/discard user work                             | `workspace-preflight.ts` and real-repository tests. Added hidden-index-flag rejection. Dirty/unsafe states remain classified stops; preflight performs no mutations.                                                                                                                                                                      |
| P3M1: predictable owned branch, collision handling, known task/attempt base, durable restart-safe checkpoints, preservation of user work, no product push                                                                                 | `run-checkpoint.ts`, migrations 4/15/16 and repositories; creation-intent/reopen, collision, real remotes, dirty-state, late-snapshot and ignored-file collision tests. Added isolated worktrees and final source/execution identity/cleanliness checks.                                                                                  |
| P3M2: independent validation before intended-file commit; verify expected attempt/workspace; persist SHA before centralized completion; Git failure cannot complete; preserve unrelated work and recover interrupted commit persistence   | `task-commit.ts`, `validation-workspace.ts`, pipeline/orchestrator, migration 5/15, `persistTaskCommitCompletion`; exact filenames/bytes/modes, latest evidence, hooks, staged renames/deletions, secret-path refusal, persistence faults and reopen tests.                                                                               |
| P3M3: diagnostics before bounded rollback; preserve failed history; restore only proven worker-owned state; detect post-start overlapping human edits; preserve unrelated work; clean owned temporary artifacts; known next-attempt state | `attempt-rollback.ts`, shared path evidence, migration 6/15 and tests. Clean rollback, post-terminal overlap, staged-only overlap, literal filenames, partial restore/reopen, temporary cleanup, stale attempts and retry checks pass. Source edits before terminal capture remain outside isolated rollback authority and are preserved. |
| Gate B: state survives restart, user work is not destroyed, checkpoints and commits are coherent                                                                                                                                          | SQLite reopen and crash-boundary tests, actual local child lifecycle checks, and current headless recovery workflows. Isolated execution, guarded publication, dual-workspace recovery and commit/persistence fault tests cover the repaired guarantees.                                                                                  |

The review followed later permission checks, acceptance-evidence gates, task/phase orchestration,
retry and cancellation, usage waiting/resume, pause/resume reconciliation, read-only recovery,
Git reachability in rundowns/reports, and Core daemon/CLI/protocol consumers. SQLite remains the
authority; Git side effects retain persisted intent/outcome boundaries; Core remains editor-independent.
Migrations, foreign-key associations, append-only events, rollback plans, and commit-intent recovery
were inspected in current source. Existing tests were supplemented by adversarial real Git/SQLite
scenarios and a fresh-context read-only review required by `AGENTS.md` §8.3.

## Confirmed findings and resolutions

1. **Resolved — human edits before terminal capture were erased.** The original shared filesystem
   let worker-terminal capture label a human save as owned output. A non-skipped real-repository
   regression first demonstrated data loss. Migration 16 now persists distinct source/execution
   identities; workers and validators run in a locked owned worktree, rollback is restricted to it,
   and source edits remain untouched. Guarded publication refuses overlapping source changes. The
   original failing regression now passes without weakening the post-start protection requirement.
2. **Resolved — ignored user files were overwritten by branch reuse.** Git's default switch
   behavior overwrote a colliding ignored file. Source switching has been eliminated; guarded
   publication and execution-branch operations use `--no-overwrite-ignore` to preserve collisions.
3. **Resolved — late dirty snapshots became checkpoints.** A clean preflight followed by new user
   work could produce a stable but dirty snapshot that was accepted. Snapshot cleanliness/HEAD and
   final branch/preflight checks now reject it without storing a checkpoint.
4. **Resolved — index flags hid tracked human changes.** Assume-unchanged/skip-worktree let preflight
   claim a clean workspace. Such flags now produce `INSPECTION_FAILED` without altering user data.
5. **Resolved — intended filenames expanded as Git pathspecs.** A filename such as `literal*.txt`
   staged/committed neighboring human files before post-commit verification failed. Mutation argv
   now uses literal pathspecs. Regression verifies the actual commit contains only the named file.
6. **Resolved — staged renames/deletions failed commit preparation.** Rename heuristics obscured
   the source path, and staging an already-staged deletion failed. Exact non-rename enumeration and
   skipping redundant staging of absent index/worktree entries restore the intended operation.
7. **Resolved — an older attempt could complete a task after a newer attempt existed.** Latest
   attempt checks now run before commit preparation and before completion persistence.
8. **Resolved — an earlier PASS could override newer failed validation.** Commit authorization now
   requires the selected validation to be the latest run for the attempt.
9. **Resolved — validation did not bind the committed bytes.** Later edits, mutating validators,
   or hooks could change contents while path/message/parent checks still passed. Durable versioned
   workspace evidence now links validation to content/index hashes; validation checks before/after,
   commit checks before staging, and Git blob/mode verification runs after commit and during recovery.
   Missing legacy evidence stops safely. Public checkpointed pipeline callers also produce evidence.
10. **Resolved — orchestration destroyed recoverability after Git/persistence failure.** Every
    stopped commit previously completed the attempt as blocked, making the service's VALIDATING
    recovery path unreachable. Stops now preserve VALIDATING and unfinished attempt state. A real
    commit plus injected completion fault recovers exactly the same SHA after reopening Core.
11. **Resolved — adapter stream failure could trigger rollback with a live worker.** Iterator failure
    was treated as process completion. A real-child reproduction confirmed rollback while the child
    remained alive. Orchestration now requests bounded cancellation, preserves unfinished process
    evidence and workspace bytes, records the unknown termination, and returns recovery-required.
12. **Resolved — symlink parent aliases could claim unrelated workspace files.** Containment alone
    allowed an alias into another local directory. Shared evidence capture now rejects every symlink
    parent, preserving the actual human file and leaving the worker capture unfinished.
13. **Resolved — index-only human edits were omitted from rollback reporting.** Combined HEAD/worktree
    diff hid staged content when the worktree matched HEAD. Changed-path inspection now includes
    cached diff; the path is reported preserved, staged bytes remain intact, and retry-ready is false.
14. **Resolved — explicit secret markers leaked into rollback diagnostics.** The original redactor
    lacked later Core marker/token support. Diagnostics now also pass through the shared redactor;
    tests verify the marked canary is absent from the durable plan and events.
15. **Resolved — automatic task commits accepted `.env`.** Explicit intended-path lists previously
    bypassed this constitutional exclusion. `.env` now produces `POLICY_DENIED` before Git mutation;
    a real-repository regression checks unchanged HEAD and index.

16. **Resolved — an initial publication implementation inherited autostash configuration.** A real
    reproduction with `merge.autostash=true` lost unrelated source staging. Publication explicitly
    disables autostash and uses a copied private index; distinct staged/unstaged human bytes survive.
17. **Resolved — source branch changes between intent and publication targeted the wrong branch.**
    The reproduced branch-switch boundary previously advanced `human-branch`. Publication now holds
    the real index lock and a prepared expected-HEAD/ref transaction, verifies the symbolic branch
    after preparation, and performs guarded checkout through a private detached Git administrative
    directory. The wrong branch, source bytes and original branch remain unchanged in regression.
18. **Resolved — the intermediate read-tree repair could overwrite late ignored files.** Real Git
    evidence showed `read-tree -m -u` ignores this preservation requirement. It was replaced with
    private detached `merge --ff-only --no-autostash --no-overwrite-ignore`. A file appearing after
    verification is preserved by Git's mutation-time guard. Publication also disables source merge
    and reference-transaction hooks, preventing hook side effects during this operation.
19. **Resolved — recovery inspected only the source after execution moved to a worktree.** Recovery
    now verifies persisted worktree identity and observes both source and execution snapshots, checks
    the source branch and exposes publication intent. A clean source cannot hide dirty execution.
20. **Resolved — public checkpointed validation could still run against the source checkout.** The
    public pipeline now routes source requests to the owned execution workspace and rejects unknown
    paths. A regression verifies the actual validator context and subsequent commit authorization.
21. **Resolved — committed human intervention could strand a clean isolated run.** Preparation can
    fast-forward only a clean execution branch to a descendant source commit with no unfinished
    worker. It does not rebase existing checkpoints, import dirty source files or overwrite divergent
    execution history. A real-repository next-task regression verifies the new base.

22. **Resolved — split-index source repositories could not publish.** Copying only their index
    left a shared-index reference unresolved in private Git metadata. Core expands the copied index
    against the original Git directory and disables split-index generation for private publication.
    The installed source index is self-contained; regression verifies readable state and preserved staging.
23. **Resolved — newer failed validation arriving during publication could still complete a task.**
    An injected publication-boundary failure record reproduced `COMMITTED` despite superseding
    validation. The service rechecks the latest validation before completion, and the SQLite transaction
    independently checks the latest attempt and validation at persistence time. The regression now stops
    with `NOT_VALIDATED`, retaining VALIDATING and the unfinished attempt.

## Current architecture and lifecycle boundaries

The source checkout remains the user's workspace. A separately persisted, registered and Git-locked
execution worktree hosts the serial worker, validation and bounded rollback. SQLite owns identities,
checkpoints, validation evidence, commit/publication intents, attempt history and transitions. Git
owns commit objects, branches, index and guarded checkout. Neither a worker's success claim nor a
passing test result directly completes a task.

Creation intent precedes worktree creation. Checkpoint persistence precedes execution. Terminal
capture is atomic with AgentRun completion. Validation binds bytes before/after validators. Commit
intent precedes staging, verified Git SHA precedes source publication, and verified publication
precedes transactional task completion. Failed publication/commit persistence leaves the attempt
unfinished and task VALIDATING; a verified completed publication recovers the same SHA on reopen.

Worktrees are retained for recovery and inspection, never automatically pruned. Publication success
releases owned locks/private administrative metadata. A kill or uncertain partial checkout leaves
identifiable lock/private-index evidence and durable intent. Such partial mutation is explicitly
non-resumable without inspection; Core never guesses lock ownership or resets source content.
Documentation gives the reconciliation prerequisites. This is distinct from the tested automatic
verification of fully completed Git publication after an outcome-persistence interruption.

## Validation and reinspection

The initial regression suite demonstrated actual failures before fixes, including wildcard expansion,
staged rename handling, stale attempt completion, dirty checkpoint acceptance and pre-terminal human
edit loss. The first full check passed formatting/build/types/lint but failed that human-edit test;
the audit continued through the isolation repair instead of treating other passing tests as proof.

Focused validation after isolation passed 45 Git/checkpoint/rollback/commit cases. Subsequent coverage
adds guarded publication locks, late ignored collisions, real child termination, durable publication
reopen, migration 15->16 legacy safety, dual-workspace recovery and committed source intervention.
A complete release check after isolation passed 386 tests: 383 passed, zero failed, three intentional opt-in live-agent skips. The final rerun includes the additional split-index and late-validation regressions.

Reinspection follows actual argv and Git identities, validation hashes and committed blobs/modes,
latest-attempt/validation gates, transactional completion, cancellation uncertainty, symlink parents,
index-only preservation, source publication locks and crash evidence. Tests use temporary real Git
repositories, SQLite databases and local child processes; synthetic workers are not live Codex proof.

## Remaining uncertainty and scope

- Live paid Codex sessions and physical power-loss testing are not part of this deterministic audit.
  Real local process termination, reopen and injected persistence failures are covered separately.
- Isolation protects ordinary edits in the source checkout. It is not an OS sandbox against arbitrary
  same-user programs deliberately writing into Core's private worktree, replacing locks or changing
  Git internals. Task commit hooks/filters remain trusted local configuration; changed committed
  bytes are rejected, and source-publication hooks are disabled.
- Legacy shared-workspace runs and validations lacking byte evidence remain readable but cannot be
  silently certified. They require explicit reconciliation/revalidation. Unknown partial publication
  or stale locks require inspection; automated destructive recovery is intentionally forbidden.
- No evidence establishes individual current-state audit passes for all Phases 1–9. The separate
  whole-Core integration audit is therefore not eligible and was not started. No phase tag is changed.

## Final validation and gate

- Final `npm run check` passed formatting, build, TypeScript, ESLint and all routine suites:
  **388 tests total; 385 passed, zero failed, three intentional opt-in live-agent skips**.
- This includes Git/workspace, rollback, migration, persistence, recovery, adapter/process lifecycle,
  Core IPC, browser, validation/acceptance, orchestration and both headless Phase 9 workflows.
- Focused final publication coverage: four passed, including source locks/hooks, late ignored files,
  killed-Core evidence retention and split indexes. Late-validation regression passed after first
  reproducing an incorrect completion against the prior repair.
- The sandbox-only full attempt was interrupted after restricted browser/socket/process operations
  prevented completion. The successful final suite ran with approved local OS access; no tests were
  weakened or skipped to hide those restrictions.
- Final fresh-context read-only reinspection reported no remaining confirmed issue. Source/ref/index
  locks, private detached Git publication, self-contained indexes, latest validation/attempt checks,
  and documented partial-operation behavior were reinspected after focused validation.
- `git diff --check` passed. No production database, secret store, live paid agent or user project
  remote was used. Existing phase tags and historical milestone commits remain unchanged.

All confirmed findings above are resolved. The evidence supports the original Phase 3 requirements,
acceptance criteria, Core authority, preservation invariants and intended current lifecycle. No
confirmed release-blocking issue remains. Commit and normal push to `main` are authorized by this gate.

PASS — Cleared for release.
