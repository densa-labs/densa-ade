# Densa run branches and task checkpoints

Phase 3 Milestone 1 introduces the Core-owned Git mutation boundary used before an implementation
worker starts. `RunCheckpointService` consumes the read-only `WorkspacePreflight` decision, creates
or reuses one persisted run branch for a project, captures a content-sensitive Git snapshot, and
records the task/attempt checkpoint and audit event transactionally.

## Branch identity and ownership

Run branches use `densa/run/<project-slug>-<project-id-hash>`. The bounded slug is readable; the
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

Dirty, conflicted, detached, unborn, bare, and non-Git workspaces remain preflight stops. Densa does
not stash, reset, clean, commit, delete, or discard files in this milestone. A second preflight and
double-captured snapshot detect changes that appear during setup; those files remain untouched and
no checkpoint is recorded.

The service invokes only local Git ref inspection and `git switch` for the owned branch. It never
fetches or pushes. Remote synchronization of the Densa development repository is a maintainer
workflow and is unrelated to run branches created for projects managed by Densa.
