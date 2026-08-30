# Bounded failed-attempt rollback

Phase 3 Milestone 3 adds the only Core boundary allowed to return failed Densa ADE work to its task
checkpoint. `AttemptRollbackService` is deliberately a two-step protocol: it records evidence
first, then performs a separately requested, path-scoped rollback. It never invokes `git reset`,
`git clean`, a repository-wide checkout, or a remote operation.

## Durable failure boundary

`captureAttemptOutput()` runs at the controlled worker terminal boundary while the latest attempt
is still `RUNNING` and before any validation record exists. It requires the exact attempt's
persisted `AgentRun` to be unfinished. The trusted worker boundary provides the explicit normalized
paths attributed to that run and marks the subset that are temporary artifacts. Core independently
captures each path as absent, a regular file, or a symbolic link, with SHA-256 digests covering
kind, executable mode, and content for both the worktree and Git index. One SQLite transaction
marks that `AgentRun` complete, stores its ID and immutable path/hash manifest, and appends
`ATTEMPT_OUTPUT_CAPTURED`. A run already completed without that atomic manifest fails closed and
cannot later claim caller-supplied files. The boundary also verifies the persisted project, task,
attempt, run-branch, workspace root, branch, and checkpoint `HEAD`.

After validation fails (or the task is classified `INTERRUPTED`/`RETRYING`),
`recordFailedAttempt()` redacts and transactionally attaches diagnostics plus
`ATTEMPT_ROLLBACK_PLANNED` to that existing manifest. The attempt must still be the task's latest
attempt, must not have a commit, and must be at a `VALIDATING`/`INTERRUPTED`/`RETRYING` boundary.
Rollback rechecks those conditions and the absence of any passing validation immediately before
workspace mutation, so stale failure evidence cannot claim a newer or subsequently passing
attempt's files. Both evidence stages are durable before a workspace file is changed.
The 64 KiB diagnostics limit prevents unbounded logs. Core redacts secret-like keys (including
camelCase and prefixed forms), bearer values, API keys, and known token shapes before measuring or
persisting the structured diagnostics; callers should still pass concise failure evidence rather
than raw transcripts.

## Conflict and rollback rules

Before mutation, rollback compares every owned path with both the worker-terminal output snapshot
and the checkpoint tree. A path matching the first is eligible for rollback. A path already
matching the checkpoint supports restart after a partially completed rollback. Any other content
is treated as a possible post-terminal-capture human edit: Core appends
`ATTEMPT_ROLLBACK_BLOCKED`, reports
the overlapping paths, and performs no rollback operation.

For eligible tracked paths, `git restore` names the exact file and checkpoint for both index and
worktree. Attempt-created files absent from the checkpoint are unstaged if necessary and unlinked
individually; temporary paths are reported separately. Directories, submodules, `.git`, traversal,
absolute paths, control characters, and parents resolving outside the workspace fail closed. No
glob or broad cleanup target is accepted; Git receives every validated filename through literal
pathspec magic so metacharacters in a real filename cannot expand to neighboring paths.

Changed paths outside the owned set are classified as preserved human work and never touched. The
owned rollback may still complete, but `workspaceReadyForRetry` remains false until that work is
resolved through policy. With no preserved changes, a fresh content-sensitive workspace probe
must exactly match the persisted checkpoint before the result can claim a known retry state.

## Crash and audit behavior

The plan is one-to-one with the attempt and survives Core restart. Repeating output capture or
failure recording is idempotent only when its evidence is identical. A crash during file
restoration is recoverable when the worktree and index components each independently match either
the captured output or checkpoint; this admits only the bounded half-restored combinations created
by the scoped commands, never unknown bytes. After all owned paths verify, SQLite records the
applied timestamp and `ATTEMPT_ROLLED_BACK` together. Failed-attempt history and diagnostics are
retained; rollback never rewrites prior events or deletes the attempt.

The service does not create the next attempt or mutate task state. The scheduler must request
canonical lifecycle transitions separately. A subsequent `RunCheckpointService.prepareTask()` can
establish the next attempt only when the post-rollback workspace is again a verified known state.
