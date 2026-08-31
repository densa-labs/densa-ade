# Densa ADE run branches and task checkpoints

`RunCheckpointService` owns preparation of an attempt's Git workspace. `TaskCommitService` binds
independently validated output to one task commit, safely publishes it to the source checkout, and
only then persists centralized task completion. These services remain local: they never fetch or push.

## Source and execution ownership

A branch alone is not filesystem isolation. Workers and validators execute in a separate Git worktree;
the user's source checkout stays on its original branch. Run names remain
`densa-ade/run/<project-slug>-<project-id-hash>`. Core never adopts a colliding unowned branch or path.

Migration 16 adds `source_workspace_path` to `densa_run_branches`. `workspace_path` identifies the
execution worktree. The record binds both canonical paths, the source/run branches, starting commit,
and creation lifecycle. A `CREATING` intent precedes `git worktree add --lock`; `ACTIVE` follows
verification of the registration, branch, common Git directory, and clean matching source/execution
snapshots. The execution directory is deterministic beneath the common Git directory's
`densa-ade-workspaces/` folder. Core rejects symlink containers and mismatched worktree identities.
An interrupted creation is resumed only against the recorded branch, path and starting commit.

Both paths survive Core restart. Owned worktrees are retained and Git-locked across attempts and
project completion for inspection, commit recovery and history; Core does not automatically prune or
delete them. Ignored source files, dependencies, secrets and runtime artifacts are not copied into
execution. Worker setup/validation must install or otherwise provide its own needed dependencies.
The worktree isolates ordinary source editing; it is not an OS security sandbox against arbitrary
same-user programs deliberately writing outside their assigned workspace.

Legacy rows remain readable and retain their original path/branch, with a null source path. They do
not gain isolation authority by migration. Mutating shared-workspace resume/rollback requires explicit
reconciliation; Core stops rather than assigning historical human bytes to a worker. No prior event,
checkpoint, branch or commit is rewritten to imply isolation that did not exist.

## Known checkpoints and source intervention

Each attempt has at most one checkpoint containing project/task/attempt IDs, owned run branch,
starting HEAD, porcelain status, content-sensitive fingerprint and creation metadata. Foreign keys
bind the associations. The checkpoint and `TASK_CHECKPOINT_CREATED` event persist transactionally.
Repetition is idempotent only for the identical attempt and live snapshot.

Dirty, conflicted, detached, unborn, bare and non-Git source workspaces stop preparation. Index
assume-unchanged/skip-worktree flags also stop: ordinary Git status cannot prove those files clean.
Final source/execution checks reject user work appearing during setup without storing a checkpoint.
Core never stashes source edits or switches the user's branch.

After an explicitly committed human intervention, Core may fast-forward a clean execution worktree
from its existing HEAD to the source HEAD. It refuses unfinished workers, dirty execution state or
divergent history. It never rebases, resets, or imports uncommitted source content. A new checkpoint
still requires both workspaces to agree; an existing checkpoint cannot be silently rebased.

## Validation and atomic task commits

Only the latest attempt and its latest completed passing validation can authorize a commit.
Checkpointed `ValidationPipeline` requests naming the source are routed to the owned execution
worktree, as are worker, lifecycle-validator, rollback and commit operations. Standalone validation
without a checkpoint remains supported but cannot authorize a task commit.

Validation captures workspace evidence before running validators and verifies it afterward. The
passing outcome and `VALIDATION_WORKSPACE_VERIFIED` v1 event persist together. Evidence binds the
canonical execution path, HEAD/status/fingerprint, and changed-path kind/content/index SHA-256 hashes;
it contains no file contents. Changes during validation fail the run. Older validation rows lacking
this evidence require revalidation, not inferred certification.

Before staging, the commit service rechecks evidence, graph, state, ownership and exact path set.
Paths are normalized repository-relative files, with literal Git pathspecs. Traversal, directories,
`.git`, symlink parents, `.env`, stale attempts and missing evidence fail closed. Non-rename diff
inspection includes both index and worktree changes; already-staged deletions are supported.

Durable commit intent precedes `git add` and `git commit --only`. Unrelated staged, unstaged and
untracked execution changes remain outside the task commit. Task commit hooks/configuration remain
active, but a failed hook cannot complete a task, and a hook changing validated bytes fails post-commit
verification. The resulting commit must have the checkpoint as its sole parent, the intended message,
exact paths, and validated blob content/modes. Retry permits only the intended paths' own staging
changes. Recovery verifies the same commit rather than creating a second one.

## Guarded publication to the source

After the execution commit is verified, `task_publication_intents` durably records attempt, source
path/branch, expected source HEAD, commit SHA and timestamps. Publication requires the original source
branch, source HEAD at the checkpoint or already at that verified SHA, and unchanged intended source
paths. A human edit made before worker-terminal capture is therefore preserved, never attributed to
the worker. Unrelated source index/worktree changes remain intact.

Publication acquires the real source `index.lock` exclusively and rechecks source identity/content.
A prepared `git update-ref --stdin` transaction locks HEAD and its referent against the expected old
SHA. The symbolic branch is checked again after preparation. Core then uses a private detached Git
administrative directory and copied index, sharing the object database and source worktree, to run
`merge --ff-only --no-autostash --no-overwrite-ignore`. This retains Git's guarded checkout behavior
without changing the real locked HEAD. Publication hooks are disabled, including reference-transaction
hooks. Split indexes are expanded against the original Git directory before private publication; the installed index has no dependency on private shared-index files. Core installs the private index, then commits the prepared real ref transaction. It neither
forces a ref nor stashes user changes. A branch switch before locking stops before source mutation;
late ignored-file collisions are refused by Git itself.

After source HEAD/branch and intended path contents/index verify, Core records `TASK_COMMIT_PUBLISHED`.
Only then may the completion transaction record the attempt SHA, `TASK_COMMITTED`, and centralized
`VALIDATING` -> `COMPLETED` transition. Persistence failures leave the task validating and attempt
unfinished. Reopening after successful Git publication but failed outcome/completion persistence can
verify and finish exactly the same SHA.

## Interrupted publication and recovery

Git plus filesystem plus SQLite is not one atomic transaction. Intent, private Git metadata and
checks distinguish unpublished, fully published, and uncertain partial outcomes. An interruption
inside checkout/index/ref mutation is explicitly non-resumable without inspection when current source
paths no longer match either verified boundary. Core preserves both branches and never resets the
source to conceal the partial operation.

A process killed while holding a publication lock can leave `index.lock` containing the Core owner,
attempt ID, process ID, expected SHA and target SHA. Failed private administrative directories are
retained beneath the source Git directory with `publication.json` and index/HEAD evidence. Core never
removes an existing lock or overwrites a retained directory merely because the process ID looks stale.
Normal successful publication releases locks and removes only its private administrative directory.

Recovery is read-only: it checks both persisted workspaces and exposes pending publication intent.
Before manual reconciliation, confirm all related Core/Git/worker processes have stopped, preserve the
source worktree/index and retained private metadata, and compare both commit trees with the durable
intent. Resolve human differences explicitly. Only after those checks may owned stale lock/private
metadata be removed and verified completion retried. Never remove an unrelated Git lock, broadly
reset the source, or infer success from a task's validation result alone.

Maintainer synchronization of this repository is separate from product behavior: managed projects
are never pushed automatically. See the [Phase 3 audit](./phase-3-current-state-audit.md) for evidence.
