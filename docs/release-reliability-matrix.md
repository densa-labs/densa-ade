# P13M0 Release Reliability Matrix

Phase 13 Milestone 0 is verified by `npm run proof:p13m0`.
The matrix is implemented in `scripts/release-reliability-matrix.test.mjs`
and runs deterministically with `FakeAgentAdapter`, `FakeClock`,
file-backed SQLite, and temporary Git repositories. It never invokes
a paid or network agent and never requires Playwright browsers
(the browser-failure case uses a fake runner plus a real managed
dev-server lifecycle).

## Coverage (release-blocking)

- R01 new project -> spec -> roadmap -> Phase 1 -> approval (Phase mode).
- R02 Guided mode task boundaries (`AWAITING_TASK_APPROVAL` per task).
- R03 Phase mode boundary (`AWAITING_PHASE_APPROVAL` per phase).
- R04 Continuous multi-phase flow (no approval stops).
- R05 retry then success with persisted failure evidence.
- R06 four retries -> `BLOCKED` with diagnostics and clean Git.
- R07 deterministic validation failure (`ValidationPipeline` required failure).
- R08 browser validation failure (retry-relevant, bounded evidence, server cleanup).
- R09 roadmap minor auto-apply plus scope rejection without approval; graph stays valid.
- R10 user pause/resume (durable, idempotent).
- R11 cancel current worker (deterministic terminal event, no orphan).
- R12 manual edit while paused (`INTERVENTION_REQUIRED`, file preserved).
- R13 Core crash mid-run (`TASK_PROCESS_GONE` -> `INTERRUPTED`, read-only).
- R14 IDE crash while Core continues (second reader survives).
- R15 Core restart preserves authoritative state.
- R16 usage wait checkpoints then auto-resumes with bounded probing.
- R17 unknown usage never enters `WAITING_FOR_USAGE` and invents no `resetAt`.
- R18 dirty Git repo stops (`USER_CHANGES_PRESENT`) without destroying work.
- R19 Git commit failure leaves task `VALIDATING` with no SHA.
- R20 secret redaction in logs/events.
- R21 policy denial (`deny`, audited, no auth context).
- R22 protocol reconnect/replay without duplication.
- R23 migration from a legacy fixture schema preserves rows and reaches current version.
- R24 critical scenarios repeat deterministically (stability gate).

Each scenario asserts coherent append-only event replay
(monotonic `sequenceNumber` and non-decreasing `occurredAt`) where
project events exist, and reopens SQLite where restart durability
is under test.

## Relation to focused suites

The matrix is a release gate, not a replacement for focused regression tests.
Representative mappings:

- R02-R04 -> `scripts/execution-modes.test.mjs`
- R05-R06, R11, R16-R17 -> `scripts/task-orchestrator.test.mjs`, `scripts/headless-continuous-recovery.test.mjs`, `scripts/usage-auto-resume.test.mjs`
- R07 -> `scripts/validation-pipeline.test.mjs`
- R08 -> `scripts/browser-validation.test.mjs` (real Playwright cases remain there)
- R09 -> `scripts/roadmap-mutations.test.mjs`
- R10, R12 -> `scripts/execution-controls.test.mjs`, `scripts/headless-continuous-recovery.test.mjs`
- R13, R15 -> `scripts/recovery-inspector.test.mjs`, `scripts/headless-continuous-recovery.test.mjs`
- R14, R22 -> `scripts/core-daemon.test.mjs`, `scripts/core-v1-protocol.test.mjs`
- R18 -> `scripts/workspace-preflight.test.mjs`
- R19 -> `scripts/task-commit.test.mjs`
- R20 -> `scripts/secrets.test.mjs`
- R21 -> `scripts/permission-policy.test.mjs`
- R23 -> `scripts/sqlite-persistence.test.mjs`

Every regression discovered during release hardening must add a focused
test in the relevant suite above in addition to remaining green in this matrix.

## Repeatability and flake policy

```sh
npm run proof:p13m0
npm run proof:p13m0  # second run must also pass with isolated temp dirs
```

The suite uses isolated temporary directories and in-memory or
file-backed databases per test, a manual clock for usage probing,
and no sleeps or network. R24 explicitly repeats the critical
single-task pass path. The release cannot be declared healthy while
any matrix scenario is flaky: a flaky scenario blocks the release
until it is fixed or replaced by a deterministic equivalent with
a documented reason.
