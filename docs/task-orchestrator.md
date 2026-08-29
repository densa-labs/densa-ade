# Persistent single-task orchestrator

Phase 5 Milestone 2 adds the editor-independent `SingleTaskOrchestrator` in Densa Core. It composes
the existing checkpoint, adapter, validation, rollback, and task-commit boundaries for one serial
implementation task. It does not schedule phases or implement execution modes.

## Durable ordering

For each attempt, Core persists the attempt number and audit event before preparing the workspace.
It then records the task checkpoint, transitions the task to `RUNNING`, and persists the `AgentRun`
before invoking `AgentAdapter.execute`. Adapter events are streamed to the caller through
`onAgentEvent`; observer failures cannot change the authoritative lifecycle outcome.

A successful agent terminal event only advances the task to `VALIDATING`. Core persists the
validation intent before invoking the task-aware validator. Only a persisted passing validation and
a verified atomic task commit can transition the task to `COMPLETED`; worker messages and terminal
prose never certify success.

## Failures and retries

Failed validation diagnostics are redacted and persisted through `AttemptRollbackService` before a
path-scoped rollback. The next worker prompt includes the most recent persisted failure evidence.
Core refuses a retry when that evidence is missing or when rollback cannot prove the checkpoint is
clean. Attempt completion timestamps and retry state changes are atomic, so reopening SQLite retains
the exact retry count. Four failed attempts transition the task to `BLOCKED`.

Cancellation transitions through `INTERRUPTED`, records diagnostics, rolls back owned output, and
then reaches `CANCELLED`. A thrown or nonterminal worker stream is recorded and rolled back but
remains `INTERRUPTED`; it is never silently retried. Existing `RUNNING` or `VALIDATING` work on a new
orchestrator invocation returns `RECOVERY_REQUIRED` so recovery inspection can determine the safe
next action without guessing an external process outcome.

## Usage waiting

P7M0 treats usage exhaustion as a pause boundary, not as worker success. Core requires both a
terminal `USAGE_LIMITED` error and a provider-neutral `UsageState { status: "limited" }` from the
same adapter. It captures and rolls back attempt-owned output, then atomically closes the attempt,
transitions the task and project to `WAITING_FOR_USAGE`, and appends `USAGE_LIMIT_REACHED` with the
observed usage data. The active phase remains `RUNNING` so a later milestone can resume it after
fresh state and workspace checks.

If classification is unknown, authentication failed, cleanup cannot be proven, or the authoritative
state changed concurrently, the usage-wait transition does not occur. Persisted state plus the
usage event reconstruct the waiting result after restart. `resetAt` is absent unless the adapter
actually observed and validated it; P7M0 does not schedule probes or auto-resume.

The orchestrator enforces one active worker per instance. Dependency selection remains the separate,
read-only scheduler responsibility, and Phase 5's later execution-mode and intervention milestones
remain out of scope.
