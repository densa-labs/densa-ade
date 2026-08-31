# Project execution controls

Phase 5 Milestone 5 adds the editor-independent `ProjectExecutionControlService`. It wraps the
existing serial project orchestrator and exposes the same operations to a future local Core server
that the headless CLI names as `project.pause`, `project.cancel`, `project.resume`, and
`project.stop`. No renderer or CLI process owns authoritative control state.

The authenticated daemon accepts the frozen Core v1 `projects.pause`, `projects.resume`, and
`projects.stop` methods plus the singular CLI aliases, including `project.cancel`. CLI callers must
identify the project and absolute workspace explicitly with `--project` and `--workspace`.

## Control boundaries

- Graceful pause records `PROJECT_PAUSE_REQUESTED`, lets an active task reach its next safe serial
  boundary, then atomically moves the project to `PAUSED` and records `PROJECT_PAUSED`.
- Immediate cancel records the same durable pause intent and aborts the active adapter run. The task
  lifecycle calls `AgentAdapter.cancel`, confirms the terminal stream, rolls back only attempt-owned
  output, and leaves the task `INTERRUPTED` rather than permanently cancelled.
- Stop is graceful. It does not delete, reset, stash, or roll back completed work. Core records a
  stopped execution-control disposition while using the canonical project state `PAUSED`; the
  control record makes stop distinct and prevents an ordinary resume. Stop also releases the
  project's built-in keep-awake assertion immediately, even when worker shutdown must wait for the
  next safe boundary.
- Repeated pause and stop commands observe the durable control record and return unchanged instead
  of appending conflicting facts or repeating state transitions.

The control record is stored in authoritative SQLite project settings. Project lifecycle changes
still pass exclusively through `StateTransitionService`, and their audit facts are committed in the
same database transaction as the control update.

## Resume and human intervention

Pausing captures a bounded Git workspace fingerprint. Every resume, including a resume that will be
rejected, runs both `WorkspacePreflight` and `RecoveryInspector` and captures the workspace again.
Unknown process/recovery evidence, Git operations in progress, unsafe workspace identity, or a
missing pause snapshot fail closed.

If the workspace fingerprint changed while paused, Core records `HUMAN_INTERVENTION_DETECTED` and
returns `INTERVENTION_REQUIRED` with changed relative paths and old/current Git heads. It changes no
files and schedules no worker. An explicit acknowledgement can resume the project and returns the
same `RecontextualizationContext`; the caller must use that context when rebuilding the next focused
task packet. Any interrupted task becomes `RETRYING` only in the atomic, checked resume transaction.
This prevents post-pause edits from being silently overwritten or treated as agent output.
Core carries that durable context into the next phase-task request. The Task Packet details provider
must acknowledge the exact `detectedAt` revision before Core starts a worker, so accepting an
intervention cannot silently fall back to stale worker context.
