# Recovery inspection

Phase 2 Milestone 4 adds read-only restart inspection primitives. `RecoveryInspector` reconstructs
what Core knew at its last durable boundary and returns a plan; it does not signal processes,
change project/task state, run validators, reset Git, or write workspace files.

## Evidence and authority

The inspector reads authoritative project and task snapshots, ordered attempts, agent runs,
validation runs, the latest checkpoint, and the latest append-only event from SQLite. Migration 3
adds optional worker PID plus an opaque process-identity hash, and an optional Git snapshot with
`gitHead`, `gitStatus`, and a content-sensitive workspace fingerprint. Older version-2 rows remain
valid with those fields absent; recovery for such rows fails closed as `UNKNOWN` when the missing
evidence is required.

The default probes perform two bounded, read-only observations:

- `NodeProcessProbe` uses signal 0 for liveness and compares a SHA-256 hash of OS-observed process
  start time plus executable name. A PID that exists without matching persisted identity remains
  unknown; an identity mismatch means the original worker is gone even if the PID was reused.
- `GitWorkspaceProbe` reads `HEAD`, porcelain status, a binary tracked-file diff, and bounded hashes
  of untracked file/symlink content with isolated Git configuration and optional locks disabled. It
  captures twice and returns unknown if the workspace changes during inspection.

Both probes are injectable so abrupt termination, process loss, permissions, and workspace changes
can be tested without live workers. Only the opaque identity hash is persisted; full command lines
are neither captured nor stored.

## Classifications and plans

The result classifies the observed state as:

- `CLEANLY_IDLE` — no active task and Git matches the latest checkpoint;
- `ACTIVE_PROCESS_ALIVE` — one serial task has an incomplete attempt/run and its PID exists;
- `TASK_PROCESS_GONE` — a persisted active task has an incomplete run whose PID no longer exists;
- `VALIDATION_INTERRUPTED` — validation intent/run has no persisted outcome;
- `WORKSPACE_DIVERGED` — an idle workspace differs from its last Git checkpoint;
- `UNKNOWN` — required evidence is absent, contradictory, or could not be observed safely.

Workspace divergence remains visible in the evidence during an active worker or interrupted
validation, where changes relative to the task checkpoint are expected. Multiple active tasks,
an active task outside a `RUNNING` project, a `RUNNING` project with no active task, an already
`INTERRUPTED` task, a latest state event that disagrees with its entity, unfinished older or
duplicate attempt/validation records, incomplete run metadata, missing PID/identity evidence, and
probe failures all fail closed as unknown. Validation never receives a rerun plan while any worker
history is contradictory or a verified worker is still alive.

`TASK_PROCESS_GONE` and `VALIDATION_INTERRUPTED` may recommend `INTERRUPTED`, but the inspector does
not apply it. A later recovery coordinator must request that edge through `StateTransitionService`,
persist it transactionally with its event, revalidate the workspace, and only then perform any
external recovery action. `automaticActionsPerformed` is always `false` in this milestone.

## Current integration and consistency guarantees

A completed worker run with an open attempt is expected while that task is `VALIDATING`: worker
termination is not task completion. Recovery may classify this interval as interrupted validation
without pretending the attempt succeeded. A completed attempt that stopped before launching a
worker does not leave a fictitious unfinished run. Validation records naming an attempt must match
the inspected attempt. Unfinished histories on inactive tasks also block recovery of another task.

Before returning a plan, the inspector rereads project, phase, task, attempt/run, validation,
checkpoint, and latest-event evidence. Changes during asynchronous probes return `UNKNOWN`.
Probe/persistence failures also return unknown without leaking raw diagnostics. The latest state
fact for each entity is checked independently of subsequent unrelated events; an unsupported state
payload version is not interpreted as version 1.

Workspace fingerprints also include the staged binary diff. This detects index-only changes that
leave `HEAD`, porcelain status, and working files identical. Fingerprints with no staged changes
retain the previous format. Older fingerprints captured with staged changes may conservatively
report divergence and require reinspection; they are not silently trusted or rewritten. Recovery
plans remain read-only and must be revalidated at the later mutation boundary.
