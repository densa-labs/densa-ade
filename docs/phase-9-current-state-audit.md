# Phase 9 Current-State Release Audit

Audit completed: 2026-09-03. Candidate: `main` at
`9fb5936dc43f7a1e89f06feadac2fb8c99ea3931` plus the committed repairs listed below.
The initial checkout was clean. Historical Phase 9 completion is not the release decision for
this candidate.

## Sealed prompt and provenance

`docs/phase-9-current-state-audit-prompt.md` was fully constructed and saved before findings
inspection. Its 150-line contents remain unchanged, with SHA-256
`a2fb0a007f63c31dc33b2c095b17094e6a797a639821757061e937db9721158e`.
The current-state release-audit procedure was used to separate historical claims, current
implementation evidence, regressions, and the conditional whole-Core gate.

The original contract was recovered from `AGENTS.md`, `MODEL_POLICY.md`, Phase 9 and Gate C in
`MASTER_ROADMAP.md`, the P9M0 postmortem, the protocol documentation, and milestone history:
P9M0 `c6b77db`, P9M1 `cca14a7`, and P9M2 `0af532d` / `densa-phase-9-complete`.
The later Phase 1–8 audit changes were inspected as current dependencies, not assumed compatible
from their historical PASS lines.

## Review summary and requirements trace

| Original requirement                                                                                                                                                                                  | Current implementation and evidence                                                                                                                                                                  | Assessment                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P9M0: CLI/Core idea/specification → complete roadmap → one Phase-by-phase execution using CodexAdapter → checkpoints → independent validation/retry → task commits → phase report → AWAITING_APPROVAL | `LocalPhaseOneProofService`, `runHeadlessOnePhaseProof`, task/phase/project orchestrators, independent review, guarded task publication, SQLite, portable reports; deterministic proof passes        | Deterministic current-path evidence passes with fake worker/reviewer and fixed roadmap proposer. Live Codex proof remains historical (Aug 30 postmortem), recorded as unverified live assumption per validation policy. |
| P9M0: persisted state survives restart; report/Git agree; agent prose never certifies completion; failures leave a postmortem                                                                         | Proof reopens SQLite before and after execution; task validation and verified commit gate completion; report and reachable SHA checked; unexpected-failure artifacts and bounded validation repaired | Deterministic evidence passes. File-backed daemon restart test preserves the production workflow snapshot (project/roadmap/phases/tasks/events) across stop/start.                                                      |
| P9M1: two or more Continuous phases, worker failure/retry, validator failure/correction, four attempts → BLOCKED                                                                                      | `headless-continuous-recovery.test.mjs`, `SingleTaskOrchestrator`, `SingleTaskPhaseExecutor`, `ProjectExecutionOrchestrator`, phase reports, isolated Git worktrees                                  | Covered by repeated deterministic composed scenarios (three repetitions of two-phase retry) and the full corpus.                                                                                                        |
| P9M1: restart mid-task and during usage waiting; conservative auto-resume; pause/manual edit; explicit scope approval; preserve user work; coherent replay; no busy polling                           | `RecoveryInspector`, `UsageAutoResumeService`, execution controls, roadmap mutation/approval services, FakeClock, persisted attempts/events/configuration                                            | Focused six-scenario harness passes. Daemon execution-control pause/resume/stop enforce canonical workspace binding when a Core v1 binding exists.                                                                      |
| P9M2: every planned client interaction without direct DB access or Core internals                                                                                                                     | `CORE_V1_METHODS` (33), strict contracts, `CoreV1Client`, daemon `CoreRuntimeViews` + `CoreRuntimeMutations`, CLI callers                                                                            | Repaired: all 33 methods route through a real disposable authenticated daemon. `proof:p9m2` passes; workflow suite proves idea-to-start, revisions, approvals, settings/permissions, and restart.                       |
| P9M2: bounded histories, version compatibility, reconnect, editor independence                                                                                                                        | Protocol schemas/docs; authenticated Unix socket; project-scoped byte-bounded replay; client identity/connection checks                                                                              | Repaired transport paths have regression coverage. Documented bootstrap/replay/refresh workflow is production-routed and exercised.                                                                                     |
| Gate C: complete headless product loop and restart resilience before Code - OSS                                                                                                                       | Deterministic one-phase proof plus deterministic recovery harness plus production daemon workflow (create→answer→generate→start→approvals→restart)                                                   | Demonstrated deterministically. No Code - OSS work was started. Live provider remains the recorded unverified assumption.                                                                                               |

## Architecture and boundaries inspected

- `CoreDaemon` now composes `CoreRuntimeStore`, `CoreRuntimeViews`, `CoreRuntimeMutations`,
  `KeepAwakeManager`, and `ProjectExecutionControlService` over one SQLite instance. Reads derive
  from persisted facts; mutations use centralized transitions, permission policy, canonical
  workspace binding, and audit events.
- `@densa-ade/protocol` remains editor-neutral with no UI, repository, SQLite, or Core-service
  imports. `CoreV1Client` validates payloads/results and rejects cross-boundary identities.
- Project creation persists canonical workspace identity at creation; subsequent file/Git/control
  requests are checked against it before any run exists. Legacy projects without a binding fall
  back for listing but fail closed on mismatched mutation workspaces.
- The domain execution path remains dependency scheduling → task packet/checkpoint → isolated
  worker → independently persisted validation → guarded atomic task commit → phase validation/
  independent review → persisted report → approval or Continuous advancement.
- SQLite transactions and append-only events are authoritative. `.densa-ade/` is a derived portable
  projection. Worker/reviewer output is untrusted evidence.
- Roadmap revisions use `MasterRoadmapRevisionWorkflow`; Master explanations use the Core-owned
  rundown; settings use execution-mode/permission/keep-awake boundaries; permission resolutions
  append durable `RUNTIME_PERMISSION_RESOLVED` facts.

## Confirmed findings and resolutions

### F1 — High: frozen protocol catalog is not the production product boundary — repaired

The production dispatch implemented only `projects.pause`, `projects.resume`, `projects.stop`,
`events.replay`, and `events.subscribe`. The other 28 methods returned unsupported.

`CoreRuntimeViews` now serves `system.bootstrap`, `projects.list/get`, `projects.specification.get`,
`roadmaps.get`, `dashboard.get`, `settings.get`, `usage.get`, `phases.report.get`,
`decisions.list`, `roadmaps.revisions.list`, `attempts.list`, `validation.list/get`, `logs.list`,
`git.status/commit.get`. `CoreRuntimeMutations` implements `projects.create/interview.answer`,
`roadmaps.generate`, `projects.start`, `roadmaps.revisions.propose/resolve`, `master.send`,
`tasks.approve`, `phases.approve`, `settings.update`, `permissions.resolve` through authoritative
services with workspace binding and audit events. No stub successes or direct client DB access.

`npm run proof:p9m2` now passes (2 routed, 16 routed domain rejections, 0 unimplemented). The new
`scripts/core-v1-runtime-workflow.test.mjs` proves the full workflow through a real daemon,
including file-backed restart. The fake-client test remains schema-only by name.

### F2 — High: Guided task and permission approvals lacked runtime handlers — repaired

Schemas for `tasks.approve` and `permissions.resolve` existed without handlers. Handlers now:
append `GUIDED_TASK_APPROVED` or move task/project to `BLOCKED` on reject; approve phases
`AWAITING_APPROVAL→COMPLETED` with next-phase release or `→BLOCKED` on reject; resolve
`RUNTIME_PERMISSION_REQUESTED`/`PERMISSION_DECISION_RECORDED(ask_user)` with `RESOLVED` facts,
returning `APPROVED`/`REJECTED`/`UNCHANGED`/`STALE` truthfully. Views fixed to observe
`GUIDED_TASK_*` events and per-request permission resolutions.

### F3 — Medium: schema-valid responses could substitute another requested entity — repaired

Client validates request/result identity for project/phase/task/attempt/validation ownership and
approval/proposal/commit identities. Regressions cover cross-project pages and substituted IDs.
Positive cases preserve opaque history, canonical workspaces, and abbreviated SHAs.

### F4 — Medium: concurrent connection setup and duplicate IDs could orphan requests — repaired

Single-flight setup, generation-guarded disconnect, owned-socket callbacks, duplicate ID rejection.
Tests cover 12 concurrent first requests, duplicate IDs, and reconnect teardown.

### F5 — Medium: unresponsive endpoints and lifecycle errors leaked pending work — repaired

Bounded connect/request deadlines; timeout reports unknown outcome without retry; manager clients
disconnect in `finally`. Fake-endpoint and error-response regressions pass.

### F6 — Medium: protocol errors echoed credential-shaped untrusted values — repaired

Structured/text redaction with 16 KiB/64 KiB bounds. Secret-shaped method/version values do not
survive serialization.

### F7 — Medium: valid large event histories exceeded framing limits — repaired

Byte-aware paging with envelope accounting; `hasMore` preserves continuation; single oversize event
fails explicitly. 35-event large-history regression passes; per-frame and remainder bounds enforced.

### F8 — Medium: raw v1 replay bypassed required project scope — repaired

Daemon validates v1 `events.replay` payload before legacy parsing. Missing scope rejected; legacy
`events.list` remains compatible.

### F9 — Medium: live notifications could overtake subscription replay — repaired

Listener buffers bounded notifications until replay response is written. Microtask-boundary
regression proves wire ordering.

### F10 — Medium: unexpected proof failures lost diagnostic artifact locations — repaired

Proof retains redacted diagnostics and typed paths; CLI preserves them. Clock-failure regression
verifies artifact and redaction.

### F11 — Medium: proof validation could hang indefinitely — repaired

Git/validation commands reuse the bounded process-tree runner (15s default). Hung-validation
regression ends BLOCKED after four attempts with diagnostics and no commit/review.

### F12 — Low: proof Git assertion did not bind reachability to the verified SHA — repaired

Assertion requires exact persisted SHA reachable with task-mapped subject and matching phase report.

### F13 — Medium: canonical workspace checks leaked ENOENT instead of failing closed — repaired

`CoreRuntimeStore.workspace()` now maps missing/unresolvable paths to `WORKSPACE_CONFLICT`.
Regression uses a non-existent sibling workspace and expects a workspace error, not `ENOENT`.

### F14 — Low: CLI test harness broke on encoded file URLs with spaces — repaired

`scripts/cli.test.mjs` and `scripts/core-daemon.test.mjs` now use `fileURLToPath` instead of
`URL.pathname`, fixing `Mobile Documents` (`%20`) detached-daemon runs. No product behavior changed.

### F15 — Medium: approval views missed guided events and conflated permission resolutions — repaired

Views now observe `GUIDED_TASK_APPROVAL_REQUIRED` and per-request `RUNTIME_PERMISSION_RESOLVED`
sequencing. Workflow regressions prove pending→approved→unchanged transitions.

## Validation

- Focused proof/recovery/protocol:
  `npm run pretest && node --test scripts/headless-one-phase-proof.test.mjs scripts/headless-continuous-recovery.test.mjs scripts/core-v1-protocol.test.mjs`:
  **15 passed, zero failed/skipped**.
- Production workflow (new):
  `node --test scripts/core-v1-runtime-workflow.test.mjs`:
  **5 passed, zero failed**. Covers idea-to-start, revision approve/reject, guided/phase approvals,
  settings/permissions, and file-backed restart.
- `npm run proof:p9m2`: **PASS**; 2 routed, 16 routed domain rejections, 0 unimplemented.
- Final `npm run check`: **exit 0**. Prettier, build, typecheck, ESLint zero warnings, and
  **461 tests: 458 passed, 3 skipped, zero failed/cancelled**. Skips are opt-in live Codex
  interview, adapter smoke, and task-proof tests.
- `git diff --check` clean. Sealed prompt hash rechecked unchanged. No databases, sockets, logs,
  or build artifacts in tracked paths; secret-shaped regression strings are synthetic.
- Live Codex proof and live-provider tests remain skipped. August 30 real-proof postmortem is
  historical context, not fresh evidence. Deterministic composed paths plus present-path inspection
  establish the contract for this gate.

## Remaining uncertainty and post-validation review

No confirmed release-blocking defect remains. Remaining assumptions are explicitly non-blocking:
live CodexAdapter behavior is historical, not refreshed; split-Unicode framing was source-reviewed;
failures before temp allocation or unwritable diagnostics cannot guarantee artifacts; pattern-based
redaction cannot prove arbitrary unlabeled secrets are always recognized.

Reinspection followed runtime store/workspace binding, view/mutation dispatch, revision
approval/decision binding, guided/phase approval transitions, settings/permission persistence,
rundown-backed Master responses, deterministic roadmap preservation of the exact specification
goal, and restart coherence. Repairs operate at architectural boundaries and preserve legacy
controls, exact v1 shapes, state machines, and intentional later-phase behavior.

## Whole-Core prerequisite and synchronization

Standalone Phase 1–8 reports contain PASS decisions, but the current composition changes Core
daemon, persistence, workspace, and protocol paths that those reports predate. They are therefore
stale relative to relevant changes. The whole-Core integration audit is deferred; its prerequisite
cannot be replaced by historical tags or a green unit corpus. No whole-Core prompt was created.

Commit and push evidence will be recorded here only after the PASS commit reaches `origin/main`.

## Final gate

PASS — Cleared for release.
