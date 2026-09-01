# Phase 6 Current-State Release Audit Prompt

You are performing the Densa ADE Phase 6 current-state release audit in `/Users/ivanuy/Desktop/Projects/active-projects/densa-ade`.

This is a sealed, self-contained audit specification. It was constructed before findings work began. Audit the current repository candidate beginning at commit `c29618a428a0c63575572c3dae0b558cdd232252` on `main`; preserve and explicitly account for any working-tree changes created during this audit. Historical milestone commits and `densa-phase-6-complete` are requirement-recovery evidence only, never proof that the current code remains correct.

## Governing constraints

Read and obey `AGENTS.md`, `MODEL_POLICY.md`, and `MASTER_ROADMAP.md`. Densa ADE Core remains the editor-independent authoritative state and mutation boundary. All lifecycle changes go through centralized, transactional, append-only-audited transition paths. SQLite is detailed runtime truth; `.densa-ade/` is the portable inspectable projection and must contain no secrets. Agents never certify their own success. Deterministic evidence precedes independent review, and reviewer prose cannot override deterministic failure. Long-running validation must have explicit crash, cancellation, restart, recovery, bounded-output, teardown, and failure semantics. Preserve intentional later-phase behavior unless it conflicts with a Phase 6 requirement, acceptance criterion, or invariant. Do not begin another roadmap milestone or create/move a historical phase tag.

Do not use a live paid agent for routine testing. Use deterministic fakes and fixtures. Never represent a fake, fixture, or synthetic scenario as live-provider or real-user evidence. Do not weaken tests to obtain a release gate.

## Audit objective

Recover and review Phase 6's original requirements, acceptance criteria, invariants, architectural intent, lifecycle expectations, failure semantics, and intended externally observable behavior. Trace every recovered guarantee into the current implementation and determine whether it is genuinely guaranteed today, after all later integrations and changes.

Inspect all relevant production paths and actual callers, configuration, provider boundaries, persistence repositories and migrations, event facts, task/phase lifecycle gates, task commit/publication gates, recovery inspection and restart behavior, portable reports, protocol/CLI drill-down, browser artifacts and process ownership, tests, documentation, and later Phase 7-9 changes. Follow data and authority end to end rather than stopping at the original Phase 6 modules.

Passing tests, old audit reports, milestone commits, and tags are evidence, not proof. Look beyond existing tests and reason about realistic composed workflows.

## Original Phase 6 contract to recover and verify

### P6M0 — Provider-neutral validation pipeline

Validation is a first-class, editor- and provider-neutral Core pipeline. An explicit `ValidationPlan` composes versioned validator plugins for command/build, typecheck, lint, unit/integration tests, structured acceptance checks, browser/E2E, and independent review.

Each persisted result must safely and durably identify validator ID/version, required versus advisory policy, status, start/end, safe command/config metadata, exit code when applicable, bounded diagnostics, mapped acceptance criteria, evidence source, retry relevance, and deterministic plan position. Validators must be fakeable in unit tests. Ordering is deterministic. Required failure, error, or skip fails the aggregate unless policy explicitly marks that entry advisory; advisory evidence remains visible but cannot satisfy a required obligation. Completed results persist immutably and replay in exact order without rerunning plugins. Interruption leaves an unambiguous durable incomplete run and completed prefix; duplicate positions, cross-project/task/attempt/run substitution, malformed results, oversized unsafe metadata, and persistence failure must fail closed.

### P6M1 — Safe validation-command detection

Core performs bounded read-only inspection of initial v1 Node/TypeScript project metadata and proposes deterministic structured executable-plus-argument commands for exact supported build, typecheck, lint, and test conventions. Detection never evaluates script bodies, interpolates shell text, starts a process, or treats a guess as authorized execution. Policy/validation decides what may run, and approved execution uses no shell.

Only allowlisted exact script names are inferred. Local TypeScript tooling must resolve to a regular file within the workspace. Malformed, oversized, ambiguous, unsupported, or symlinked metadata/tooling; unsafe working directories; unsupported package managers; unknown projects; and traversal or injection attempts return explicit unknown/manual configuration rather than fabricated coverage. User structured-argv overrides replace guesses only after durable versioned audit recording with actor and reason. Audit metadata exposes safe identity/category/policy/argument-count/digest data, not secret argument values. Audit failure blocks use of the override. Fixture projects must produce expected plans, malicious names/arguments cannot execute extra commands, and unknown projects remain explicit.

### P6M2 — Acceptance criteria bound to evidence

Worker claims never satisfy acceptance. Every task-owned criterion is mapped deterministically to exact persisted evidence from deterministic validators, targeted checks, browser tests, independent review, or an explicitly manual audited decision. Criterion states are `satisfied`, `failed`, `not_evaluated`, or `manual_review_required` with fail-closed semantics. Advisory results cannot satisfy required criteria. Legacy or unmapped evidence remains inspectable but inconclusive.

Manual criteria require durable decisions atomically paired with append-only events containing exact project/task/run/criterion identity, actor, reason, and decision. Manual criteria cannot simultaneously consume automatic evidence. Mixed sources, duplicate criterion text, stale or substituted validation runs, repeated decisions, missing rows, skipped validators, and cross-project identity collisions must not produce false satisfaction. Task completion requires both a passing selected plan run and every criterion satisfied. Phase completion independently checks exact current task/run reports and blocks unresolved or unevaluated required criteria. Concise acceptance reports remain available to current consumers and portable reporting.

### P6M3 — Managed Playwright browser validation

Browser validation is an explicit task-aware `browser_test` plugin, enabled only when roadmap/policy classifies the work as browser-relevant. Irrelevant tasks do not inspect project metadata or become browser-enabled merely because a framework exists. Relevant tasks require explicit credential-free loopback HTTP configuration; remote URLs, embedded credentials, guessing, unsafe paths, and unsupported configuration fail closed to manual setup.

App start commands are structured argv and run without a shell inside the workspace. The validator owns the complete dev-server process group for the validation attempt, waits boundedly for readiness, invokes a provider-neutral Playwright runner, supports timeout/cancellation, and tears down the entire owned process group on pass, test failure, runner error, readiness failure, cancellation, and crash/recovery paths. It must not kill unrelated processes or leak inherited secrets. Server and browser diagnostics are bounded and redacted; request-failure URLs omit query and fragment secrets.

The runner supports the intended initial page-load, visible-text, and visible-selector checks. A failing browser test produces useful screenshot/trace evidence in private local runtime storage, never portable `.densa-ade/`; paths and artifact ownership are safe. Browser results map to criteria as `browser_test` evidence, but failed, cancelled, missing, stale, or substituted results block satisfaction. Fixture workflows prove start/test/shutdown, failure artifacts, orphan cleanup, and acceptance contribution without being mislabeled as live evidence.

### P6M4 — Fresh-context independent review

The Reviewer is logically separate from the implementing worker and uses `AgentAdapter` through a new logical review identity, run ID, invocation, and context for every validation. Reviewer input is constructed by Core from the exact task/phase goal, owned criteria, bounded relevant diff, deterministic results already persisted for that validation boundary, and relevant architecture constraints. It does not ask the reviewer to defend or continue the worker and does not dump unrelated or raw worker transcripts. Workspace access is read-only where supported.

Reviewer output is strict structured data: `pass`, `advisory`, or `fail`; bounded findings and severities; unambiguous criterion mapping; confidence; and unknowns. Invalid, missing, multiple, mismatched, late-failing, cancelled, or provider-error streams fail closed. Raw provider transcripts and secrets are not persisted. Core redacts every provider-owned string before SQLite, events, reports, diagnostics, or portable projection.

Review intent is persisted before the external call and immutable outcome after it, with atomic append-only started/completed facts. Task review is bound to the exact current validation run; phase review is bound to the exact durable phase-validation-start boundary, parsed timestamp ordering, context hash, and returned review identity. Workspace fingerprinting covers HEAD, index, tracked/untracked content, and ignored-file metadata before and after review so any review-time mutation invalidates the result. Cancellation propagates to the adapter and remains failed even if a nonconforming adapter later emits apparent success.

Independent review is required by default for risky tasks and phase-final review. It supplements deterministic evidence: deterministic failure can never be overridden by reviewer prose. A review supports completion only when its verdict, mapped criteria, errors, and critical findings satisfy policy. High/critical-risk task completion independently refuses absent or substituted current review evidence; missing reviewer infrastructure stops before worker execution and does not consume a retry. Phase completion independently checks the exact current review. Findings, mappings, severities, confidence/unknowns remain visible in authoritative and portable phase reports.

## Current integration boundaries that must be traced

Reconstruct actual current call graphs and authority boundaries for:

- validation-plan construction, plugin registration, execution, persistence, replay, aggregation, and diagnostics;
- project inspection, configured-command audit, command execution, environment minimization, and permission/policy decisions;
- task lifecycle from checkpoint through worker result, `VALIDATING`, criterion mapping, review, rollback/retry, commit/publication, and `COMPLETED`;
- phase lifecycle through phase validation, exact review binding, report persistence/projection, approval modes, completion, and next-phase eligibility;
- migrations and schema constraints for validation runs/results, manual acceptance, review runs/findings, events, attempt associations, and backward-compatible legacy evidence;
- recovery/restart after intent without outcome, partial result persistence, browser/reviewer interruption, late provider output, Core death, and reopened SQLite state;
- portable sync and protocol/CLI/dashboard drill-down behavior where Phase 6 evidence is exposed or consumed;
- later usage, permission, secret-redaction, daemon/IPC, Master, roadmap-mutation, headless continuous/recovery, and editor/client integrations that can weaken or bypass Phase 6 guarantees.

## Active defect search and adversarial scenarios

Actively search for missing or incomplete implementation; only partially met acceptance criteria; violated or weakened invariants; architectural drift; regressions introduced by later phases; incorrect assumptions; integration failures; lifecycle/state-transition defects; persistence, transaction, replay, and recovery problems; weak or missing validation; incorrect failure handling; boundary-condition failures; meaningful edge cases; and behavior that passes isolated tests but fails in realistic workflows.

At minimum, construct and trace bounded deterministic scenarios covering:

1. required/advisory mixtures, failed/skipped/error plugins, validator exceptions, cancellation between results, duplicate/reordered results, persistence faults, replay after reopen, and diagnostics/metadata at size and trust boundaries;
2. malicious or malformed package metadata, script names and arguments, symlink/traversal/local-tool boundaries, unsupported managers, override audit failure, unsafe working directories, secret-like argv, and later execution that accidentally reintroduces a shell;
3. criteria with mixed evidence, duplicated text, no mapping, legacy rows, manual approval/rejection, stale/newer/substituted/cross-project runs, atomic event failure, and task/phase completion races;
4. relevant versus irrelevant tasks, loopback URL edge cases including IPv4/IPv6 and credentials, slow/failed readiness, runner crash, timeout/cancel races, child/grandchild server cleanup, process identity reuse, unrelated-process safety, artifact-path containment, log/URL redaction, and restart after interrupted browser validation;
5. worker/reviewer identity separation, missing reviewer infrastructure, malformed/multiple/late streams, adapter error/cancellation, duplicated criteria and bounded diff, deterministic failure plus reviewer pass, workspace changes through index/tracked/untracked/ignored/HEAD states, stale phase/task review substitution, timestamp/context/event binding, persistence/event faults, and redaction across SQLite/events/reports/portable files;
6. realistic end-to-end serial task and multi-task phase flows crossing scheduler, checkpoint, worker, validation, acceptance, review, rollback/retry, Git commit, phase report, approval/continuous mode, restart/recovery, and current authenticated Core protocol/CLI consumers.

Inspect actual production paths exercised by these scenarios. Do not infer safety from interfaces or intended design when a caller can bypass it.

## Findings and remediation protocol

Maintain a requirement-to-implementation-and-evidence trace. Distinguish confirmed defects from speculative concerns. A confirmed defect must have concrete current-code evidence or a deterministic reproduction. A speculative concern must be labeled and must not be presented as a defect.

For every confirmed defect within intended Phase 6 requirements:

1. reproduce it with a focused regression test wherever practical, before the fix;
2. repair the authoritative boundary rather than papering over a symptom;
3. preserve intentional later-phase behavior unless it conflicts with a required invariant or acceptance criterion;
4. update migrations/contracts/documentation when the repaired guarantee requires it;
5. add or strengthen regression coverage for the defect and adjacent failure branches;
6. reinspect affected implementations and callers after validation to prove the underlying guarantee is restored rather than merely making a test pass.

Do not make unrelated speculative hardening changes. Preserve user-owned and concurrent work. If ownership becomes unclear, evidence is inconclusive, or a confirmed defect cannot be resolved safely, stop expanding scope and issue FAIL.

## Validation

After fixes, run relevant focused unit, persistence/migration, process lifecycle, browser, reviewer, acceptance-evidence, task/phase integration, recovery/restart, protocol/CLI, headless regression, and Phase 6 acceptance coverage. Then run the repository-wide `npm run check`, including formatting, build/typecheck, lint, and the complete deterministic suite. Use the permitted authorization path for material local socket, loopback/browser, or process fixtures if sandbox restrictions block them; do not misclassify environment restrictions as product defects or silently omit material evidence.

Record exact commands, test counts, outcomes, skips, and limitations. Opt-in live-agent checks may remain skipped if deterministic coverage establishes the contract, but state that they are unverified and do not fabricate live evidence. Reinspect the final diff, production paths, callers, persistence/recovery behavior, security/redaction boundaries, and actual candidate snapshot after validation.

## Required report and release action

Write `docs/phase-6-current-state-audit.md` as a self-contained report containing:

1. concise scope and current architecture/trust-boundary summary;
2. recovered requirement and acceptance-criterion trace into current implementation and evidence;
3. every confirmed finding and its resolution;
4. speculative concerns separately, plus every remaining uncertainty or unverified assumption;
5. exact validation performed and results, including skips/blocked evidence and why;
6. reinspection evidence showing repaired guarantees hold in actual workflows;
7. exactly one final gate statement, verbatim and unmodified:

`PASS — Cleared for release.`

Use PASS only if available current-state evidence supports that all Phase 6 requirements, acceptance criteria, invariants, architecture, lifecycle/failure semantics, and intended observable behavior remain correctly implemented and no confirmed release-blocking issue remains.

Otherwise use exactly:

`FAIL — Issues remain; deeper fixes are required.`

Use FAIL if any confirmed issue remains unresolved, required behavior cannot be demonstrated with sufficient confidence, or validation is incomplete in a way that materially affects release confidence.

Only after the report contains PASS, selectively stage the audited candidate and audit artifacts, verify the staged snapshot contains no secrets or runtime artifacts, commit on `main` with an appropriate `densa-ade:` current-state audit message, and push normally to private `origin/main`. Never force-push. Verify the local and remote commit SHA and require `git rev-list --left-right --count origin/main...main` to be `0 0`. If history diverges or synchronization fails, do not rewrite history; report it precisely. Do not create or move `densa-phase-6-complete`.

## Whole-Core integration-audit prerequisite

Do not execute the Densa Core integration audit merely because historical phase tags exist or old tests pass. First establish fresh current-state PASS reports for every Phase 1 through Phase 9 in this repository. If any individual report is absent, FAIL, stale relative to relevant later changes, or materially incomplete, record the prerequisite as unmet and stop; the current request does not authorize substituting historical completion evidence.

Only after that prerequisite is genuinely met, first create and save a separate fresh self-contained Densa Core integration audit prompt before inspecting for integration findings, then execute it immediately. That later audit must treat Core as one complete system, reconstruct architecture/trust/state boundaries, construct realistic cross-component scenarios, inspect actual paths, find and classify composition defects isolated phase audits can miss, fix all confirmed defects, add practical regressions, run all relevant Core validation, reinspect repaired invariants, report the required architecture/scenarios/findings/uncertainties/results, and use the same exact PASS/FAIL gate semantics. Commit and push to `main` only on that integration audit's own PASS.
