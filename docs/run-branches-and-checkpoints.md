# Densa ADE run branches and task checkpoints

Phase 3 Milestones 1 and 2 introduce the Core-owned Git mutation boundaries around a task attempt.
`RunCheckpointService` consumes the read-only `WorkspacePreflight` decision, creates or reuses one
persisted run branch for a project, captures a content-sensitive Git snapshot, and records the
task/attempt checkpoint and audit event transactionally. After deterministic validation passes,
`TaskCommitService` maps the verified attempt to one local task commit.

## Branch identity and ownership

Run branches use `densa-ade/run/<project-slug>-<project-id-hash>`. The bounded slug is readable; the
SHA-256 suffix keeps unsafe or similar project identifiers deterministic without placing arbitrary
input directly into a Git ref. A pre-existing branch with the predicted name is never adopted
unless SQLite already records that project, workspace, source branch, and starting commit as its
owner. Otherwise setup stops with `BRANCH_COLLISION`.

The `densa_run_branches` table records a `CREATING` intent before `git switch --create` runs, then
transitions it to `ACTIVE` after a fresh preflight verifies the new branch and clean workspace. If
Core stops between those steps, the next invocation can verify and finish the same persisted
intent. Active ownership is reused after restart and may switch a clean source branch back to the
owned run branch. A missing, moved, failed, or different-workspace branch fails closed.

## Task checkpoint

Each attempt has at most one checkpoint. The record associates:

- project, task, and attempt IDs;
- the owned run branch;
- the starting `HEAD` commit;
- exact porcelain status and a content-sensitive workspace fingerprint;
- creation time and a human-readable description.

Foreign keys prevent cross-project task associations and cross-task attempts. The checkpoint and
`TASK_CHECKPOINT_CREATED` event commit in one SQLite transaction. Repeating the same request after
a restart returns the existing checkpoint only when the live Git snapshot still matches it; a
different ID, association, or workspace snapshot is a classified stop.

## Safety and remote boundary

Dirty, conflicted, detached, unborn, bare, and non-Git workspaces remain preflight stops. Densa ADE does
not stash, reset, clean, commit, delete, or discard files in this milestone. A second preflight and
double-captured snapshot detect changes that appear during setup; those files remain untouched and
no checkpoint is recorded.

The service invokes only local Git ref inspection and `git switch` for the owned branch. It never
fetches or pushes. Remote synchronization of the Densa ADE development repository is a maintainer
workflow and is unrelated to run branches created for projects managed by Densa ADE.

## Passing-task commits

`TaskCommitService` accepts one completed passing validation and an explicit list of normalized,
repository-relative changed files. Before invoking Git it verifies the project/task/attempt graph,
the active run-branch ownership, current branch, checkpoint parent commit, and task state. Broad
directory pathspecs, traversal, control characters, `.git`, unchanged intended paths, failed or
unfinished validation, and mismatched attempts fail closed.

Commit intent is persisted before staging. The intent fixes the workspace, branch, expected parent,
message, and exact path set for the attempt. Git stages those paths and commits them with
`--only`, so unrelated staged, unstaged, and untracked user changes remain outside the commit. A
post-commit check requires one parent at the checkpoint, the intended message, the owned branch at
the new SHA, and exactly the intended changed paths. Hooks and Git configuration remain active;
their failure leaves the task in `VALIDATING`.

The verified SHA is first attached to the persisted intent. One SQLite transaction then attaches
the SHA to the attempt, appends `TASK_COMMITTED`, and persists the centralized
`VALIDATING` to `COMPLETED` transition and its event. A transaction failure rolls back both the
attempt SHA and task state. If Core stops after Git commits but before completion persists, the next
call verifies the durable intent against `HEAD` and completes the same commit rather than creating
another one. This is bounded recovery of commit creation only; workspace rollback belongs to P3M3.

The task-commit command set contains no fetch or push operation. A configured remote is unchanged.
