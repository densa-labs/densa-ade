# Built-in macOS keep-awake

Phase 7 Milestone 4 adds an editor-independent `KeepAwakeManager` in Densa Core. Long-running work
opts in by acquiring a project-scoped, stable reason ID. Core persists those reasons in the
project's authoritative SQLite settings and exposes `KeepAwakeStatus` through the versioned
protocol package. The status reports whether system sleep is actually prevented, the associated
project/reasons, the last observed battery state, and the effective threshold. UI clients must not
infer an active assertion from demand alone.

The macOS platform implementation starts `/usr/bin/caffeinate -i -w <core-pid>` without a shell.
Only the idle-system-sleep assertion is requested: Densa never passes `-d`, so display sleep remains
allowed. Tying the assertion to the Core PID also lets macOS remove it if Core exits unexpectedly.
Amphetamine is not required and is not part of this boundary.

## Lifecycle and battery policy

- Acquiring the same reason repeatedly is idempotent. Multiple reasons for one project share one
  assertion.
- Releasing the final reason terminates and confirms cleanup of the project assertion. Project stop
  invokes the same project-wide release immediately, including while the scheduling stop waits for
  a safe task boundary.
- Core checks the power source before acquiring and every minute while demand remains. External
  power is allowed. Battery power is allowed only at or above the configured threshold (20% by
  default). Unknown power evidence fails closed.
- If the battery drops below the threshold, Core releases the assertion but retains the reasons as
  demand. It may reacquire after a later verified external-power or sufficient-battery observation.
- `dispose()` releases all assertions owned by that manager during orderly shutdown.

## Recovery and authority

SQLite records demand, battery observations, disposition, and the opaque platform handle. It does
not make an operating-system assertion true. A new manager therefore reports a persisted active
handle as `recovery_required`, never optimistically active. Startup recovery enumerates all project
settings, verifies and terminates only a matching Densa `caffeinate -i -w` process, clears stale
demand/state, and records the outcome. An identity mismatch or unconfirmed termination remains
`recovery_required` for inspection rather than risking an unrelated process.

The platform abstraction is injectable. Tests use a fake implementation to prove lifecycle,
battery release/reacquisition, restart recovery, and final-reason cleanup without creating a real
sleep assertion.
