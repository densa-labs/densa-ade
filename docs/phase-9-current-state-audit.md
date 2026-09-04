# Phase 9 Current-State Release Audit

Audit completed: 2026-09-04. Candidate: current `main` worktree based on
`b52e7b7c5b241bb028f26e138164593a830cf505`, including the repairs recorded below.
The gate evaluates the repository as it exists now, not the implementation present when Phase 9
was originally completed.

## Sealed prompt and recovered contract

`docs/phase-9-current-state-audit-prompt.md` was fully constructed and saved before audit
execution. It remains 150 lines with SHA-256
`a2fb0a007f63c31dc33b2c095b17094e6a797a639821757061e937db9721158e`.

The original contract was recovered from `AGENTS.md`, `MODEL_POLICY.md`, Phase 9 and Gate C in
`MASTER_ROADMAP.md`, the P9M0 postmortem, protocol documentation, milestone history, and the
historical Phase 9 audit. The audit then traced those requirements through the current daemon,
protocol, CLI, adapter, scheduler, task/phase/project orchestration, permission, validation,
Git/worktree, persistence, portable projection, recovery, tests, and later audit changes.

## What was reviewed

- P9M0 and Gate C: idea/specification, complete roadmap, Phase-by-phase execution,
  `CodexAdapter`, checkpoints, independent validation and review, retries, atomic task commits,
  phase validation/reporting, approval, and restart persistence.
- P9M1: multi-phase Continuous execution, failure and validation retries, four-attempt
  exhaustion, usage waiting and auto-resume, mid-task restart classification, pause/manual edits,
  scope approval, event coherence, user-work preservation, timer cleanup, and deterministic
  repetition.
- P9M2: the complete frozen v1 operation catalog, strict request/result identities, authenticated
  daemon routing, bounded paging/framing, reconnect and timeout semantics, subscriptions,
  compatibility, CLI use, and editor independence.
- Current composition: production `projects.create` through `projects.start`, Master commands,
  policy changes and exact approvals, background execution ownership, graceful shutdown,
  interrupted retry, SQLite transactions, portable synchronization, and later Phase 7/8
  hardening.

## Reconstructed current architecture

`CoreDaemon` owns one SQLite database, authenticated user-only Unix socket, keep-awake manager,
execution-control service, adapter instance, runtime views/mutations, and background execution
registry. Clients use the editor-neutral `@densa-ade/protocol` contracts and never mutate
repositories directly.

Planning uses strict read-only Master-role adapter runs for adaptive interview, roadmap generation,
and project steering. `projects.start` persists execution intent and dispatches
`CoreRuntimeExecutionService`, which composes dependency scheduling, exact-scope planning, a
bounded Task Packet, isolated Git checkpoint/worktree, one workspace-write worker, deterministic
validation, fresh-context review, guarded atomic commit/publication, phase validation/reporting,
and the configured approval boundary. SQLite and append-only events are authoritative;
`.densa-ade/` is a redacted derived projection.

## Confirmed findings and resolutions

### F1 — Critical: current main had lost the Phase 9 production implementation

The recovery commit at the audit base retained later website/README work but removed the Phase 9
daemon/protocol/proof implementation that had passed historically. This was a current release
failure, regardless of tags or old reports.

The Phase 9 file set was restored from the audited `3cac314` implementation and then reconciled
with the later `0101ee7` Core integration fixes. This reinstated:

- all frozen v1 routes and strict client result-identity checks;
- guided-task and permission approval methods;
- authenticated daemon framing, replay/subscription ordering, paging, timeout, reconnect, and
  error-redaction fixes;
- bounded one-phase proof execution, diagnostics, exact Git/report checks, and CLI error details;
- canonical workspace handling and the real-daemon runtime acceptance proof.

Regression coverage for those boundaries passes in the current tree.

### F2 — High: `projects.start` recorded intent but did not execute anything

`executionRequested: true` had no consumer. A project could report `RUNNING` while no scheduler,
worker, validator, commit, report, or approval lifecycle existed.

`CoreRuntimeExecutionService` now composes the existing audited lifecycle services, and the daemon
owns background dispatch, cancellation, continuation, error classification, shutdown cleanup, and
event publication. Production workflow tests now reach task commit and phase approval through the
real authenticated daemon rather than a direct harness.

### F3 — High: production planning and Master routes fabricated local success

Project creation produced a synthetic empty specification/question, roadmap generation created a
shallow deterministic roadmap, and `master.send` ignored the user's message.

Creation and interview continuation now use `AdaptiveInterviewPlanner` with a strict read-only
Master interview adapter. Roadmap generation uses `MasterRoadmapGenerator` and preserves the exact
specification goal. Master messages use a separate read-only Master adapter,
`DatabaseMasterProjectContextReader`, the authoritative rundown, and the validated command
gateway.

### F4 — High: production execution bypassed the current permission preset

The worker Task Packet always claimed `standard`, and cautious projects could enter execution
without exact `write_workspace` and `git_mutation` approval. An outer approval was also lost at
the inner checkpoint/commit/publication boundaries, causing approval loops.

Execution now evaluates the current persisted policy before dispatch. Ask-user and deny outcomes
produce truthful `WAITING_FOR_USER` or `BLOCKED` project state. Approval creates an exact active
user decision, the policy service issues an unforgeable operation context, and the same Git
authorization is propagated through isolated worktree creation, checkpoint preparation, atomic
task commit, and guarded publication. Task Packets render the current preset and network
disposition. A cautious end-to-end regression proves no worker starts before both approvals.

### F5 — High: project creation was neither crash-atomic nor lost-response idempotent

Project, runtime state, specification, and audit writes could partially persist. Retrying a
lost-response create could bind another project to the same canonical workspace.

The initialization writes now share one SQLite transaction. An identical canonical-workspace retry
returns the existing project; substituted name, idea, or mode fails with `WORKSPACE_CONFLICT`;
incomplete prior initialization fails with `PERSISTENCE_FAILURE`.

### F6 — Medium: initial roadmap success did not guarantee a coherent portable projection

Initial sync failures were ignored, retries returned the stored roadmap without repairing the
projection, and the first sync occurred before `PLANNING → READY`, leaving `project.json`
immediately stale.

Generation now classifies and persists sync failure, repairs on retry without regenerating the
authoritative roadmap, transitions to `READY`, and synchronizes again so a success response
guarantees the portable state matches SQLite.

### F7 — Medium: approval continuation could be dropped at an active-promise boundary

An approval arriving while the current lifecycle promise was finishing could be ignored. The
daemon now retains one latest pending request per project and dispatches it after the owning
promise clears. Tests exercise phase and guided continuation.

### F8 — Medium: the production worker did not explicitly request workspace-write access

The task orchestrator relied on the adapter default. It now passes
`accessMode: "workspace-write"`; planning, roadmap, Master, and review roles remain read-only.

### F9 — Medium: independent review rejected valid projects with no architecture constraints

The review input incorrectly required a non-empty constraint array, making valid unconstrained
projects impossible to certify. Empty arrays are now accepted; blank constraint entries remain
invalid. The regression distinguishes absent constraints from malformed constraints.

### F10 — Medium: graceful interruption had no safe production retry route

Shutdown could leave a correctly interrupted and rolled-back task, but a later
`projects.start` could not resume it. A new explicit start now changes only interrupted tasks
whose latest attempt has a durable interrupted completion event and applied scoped rollback to
`RETRYING`; all incomplete or contradictory evidence remains blocked. A file-backed
daemon-stop-mid-worker regression proves attempt 2 is created only after those guarantees.

### F11 — Medium: lifecycle state and portable state were ordered inconsistently on stop

Portable synchronization ran before the final project `BLOCKED` transition for a stopped
lifecycle. The transition now commits first and projection synchronization follows, preserving one
recoverable boundary.

### F12 — Medium: later Core fixes were absent from the recovered Phase 9 baseline

The restored baseline was updated with later confirmed integration repairs: unbound daemon control
requests fail closed, keep-awake settings preserve active/recovery state and assertion identity,
and permission-request aliases resolve exactly once. Their existing regressions pass.

### F13 — Validation blocker: the pinned Playwright browser runtime was absent

The full gate initially failed two real browser tests because Playwright's pinned Chromium
headless-shell executable was not installed. `npm run playwright:install` installed Chromium
151.0.7922.34 / Playwright browser revision 1234. Both real browser cases then passed, including
bounded logs, screenshot/trace capture, and dev-server cleanup. Test assertions now include the
structured redacted outcome when these cases fail.

### F14 — Low: current later-phase README/website files violated the mandatory format gate

Prettier reported `README.md` and `website/index.html` before Phase 9 changes were considered.
They were normalized with the repository's existing formatter. Inspection confirmed formatting-only
changes and no content or UI behavior change.

## Validation performed

- Sealed prompt: 150 lines; SHA-256
  `a2fb0a007f63c31dc33b2c095b17094e6a797a639821757061e937db9721158e`.
- Focused affected suites: 122 passed, zero failed/skipped. This covered the production workflow,
  P9M0/P9M1, Core v1 protocol and daemon, permissions, independent review, checkpoint, commit,
  publication, task orchestration, and recovery.
- Production workflow suite: 7 passed, zero failed. It covers real-daemon idea-to-start,
  revision/task/phase approvals, exact cautious permissions, file-backed restart, and an
  interrupted-worker restart.
- `npm run proof:p9m2`: PASS; 2 successful real-daemon reads, 16 expected routed domain
  rejections, zero unimplemented routes.
- Real browser suite after the declared install: 6 passed, zero failed.
- Final `npm run check`: exit 0. Prettier, build, typecheck, and ESLint passed; 463 tests ran,
  460 passed, 3 opt-in live Codex tests skipped, zero failed/cancelled.
- `git diff --check`: clean before report authoring and rerun during release inspection.

After validation, the affected execution paths were reread: permission resolution and context
propagation, roadmap READY/sync ordering, background request ownership, STOPPED persistence,
interrupted-attempt evidence, task access mode, fresh review input, workspace binding, and
shutdown cleanup. The fixes enforce the underlying guarantees rather than special-casing test
fixtures.

## Remaining uncertainty

- The three opt-in live Codex tests were not run: Master interview, adapter smoke, and live task
  proof. The August 30 real-provider P9M0 postmortem remains historical evidence only. Current
  confidence comes from strict adapter contract tests, deterministic composed workflows, and
  present implementation inspection; no synthetic run is represented as current real-provider
  evidence.
- Abrupt missing-worker recovery remains intentionally fail-closed: P9M1 proves read-only
  classification and user-work preservation, while the production regression proves graceful
  interruption and explicit safe retry. Core never guesses an unknown process outcome.
- Pattern-based redaction cannot prove recognition of every unlabeled future secret shape.

None of these uncertainties is a confirmed release-blocking Phase 9 defect under the recovered
acceptance criteria.

## Whole-Core prerequisite

The current Phase 9 repair changes daemon, permission, Git lifecycle, persistence ordering, and
protocol composition after the existing Phase 1–8 reports. Those earlier PASS reports are
therefore stale for affected guarantees. Per the required prerequisite, no Densa Core integration
audit was started and no integration-audit prompt was constructed. Phases 1–8 must first receive
applicable current-state PASS evidence.

## Final gate

PASS — Cleared for release.
