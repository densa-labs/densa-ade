# Workspace preflight and dirty-state policy

`WorkspacePreflight` is the read-only Phase 3 safety boundary that runs before Densa establishes a
task checkpoint or starts an implementation worker. Its versioned result is structured for later
Core protocol and UI use; it is not itself authoritative persisted state.

## Evidence captured

Preflight resolves the real repository root and reports the current branch and commit, detached or
unborn HEAD, staged changes, unstaged changes, untracked files, and active merge, rebase, or
cherry-pick state. It also reports ignored Densa-named database, PID, socket, and
`.densa/runtime/` artifacts without treating them as user changes.

The `densa/run/` branch namespace is reserved for Densa-owned run branches. Preflight recognizes
and reports current or existing branches in that namespace without treating the name alone as
authoritative ownership. P3M1 validates ownership against SQLite before creating or reusing a run
branch; see [run-branches-and-checkpoints.md](./run-branches-and-checkpoints.md).

## Decisions

| Evidence                                  | Decision                                       |
| ----------------------------------------- | ---------------------------------------------- |
| Clean normal branch                       | `PROCEED / CLEAN_REPOSITORY`                   |
| Clean `densa/run/*` branch                | `PROCEED / EXISTING_DENSA_RUN`                 |
| Staged, unstaged, or untracked user work  | `STOP / USER_CHANGES_PRESENT`                  |
| Merge, rebase, or cherry-pick in progress | `STOP / GIT_OPERATION_IN_PROGRESS`             |
| Detached or unborn HEAD                   | `STOP / DETACHED_HEAD` or `STOP / UNBORN_HEAD` |
| Bare or non-Git directory                 | classified stop                                |
| Incomplete or failed inspection           | `STOP / INSPECTION_FAILED`                     |

Operation state takes precedence over dirty-state classification because conflict files are a
consequence of an active Git operation. Every stop requires an explicit user decision. Ignored
Densa runtime artifacts do not make an otherwise clean repository dirty.

## Safety boundary

Inspection disables optional Git locks and interactive prompts. It does not invoke `stash`,
`reset`, `clean`, `checkout`, `switch`, `commit`, or any ref-writing command. The returned
`automaticActionsPerformed` value is always `false`. Later milestones may act on the result, but
they must preserve user changes and persist checkpoint ownership before doing so.

`RunCheckpointService` is the P3M1 mutation boundary. It consumes a proceed decision, persists run
intent before branch creation, repeats preflight after switching, and records a task/attempt Git
snapshot only while the workspace remains clean. It never adopts an unowned colliding branch.
