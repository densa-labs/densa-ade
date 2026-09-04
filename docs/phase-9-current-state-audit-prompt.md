# Phase 9 Current-State Release Audit Prompt

You are Codex working in `/Users/ivanuy/Desktop/Projects/active-projects/densa-ade` on the current `main` checkout. Perform a fresh, evidence-driven current-state release audit of **Phase 9 only**. This document is the sealed scope and methodology for the audit. It must be fully constructed and saved before findings inspection begins. Do not treat historical completion, milestone commits, the `densa-phase-9-complete` tag, documentation claims, or a passing existing test suite as proof that Phase 9 is currently correct.

The candidate began at commit `9fb5936` on `main`. Preserve and explicitly account for working-tree changes created during this audit.

## Objective

Determine whether every original Phase 9 requirement remains genuinely guaranteed by the repository as it exists now, including all later audit remediations and integrations. Recover the original requirements, acceptance criteria, invariants, architectural intent, lifecycle expectations, failure semantics, and intended externally observable behavior; trace them through current implementation and realistic workflows; repair every confirmed in-scope defect; add practical regression coverage; run all relevant validation; reinspect repaired guarantees; and issue exactly one release gate.

The audit is not complete until the current implementation has been followed across client, protocol, trust, mutation, persistence, Git/workspace, validation, lifecycle, restart/recovery, process, and externally observable boundaries. Existing tests are evidence, not proof.

## Governing constraints

1. Read and obey `AGENTS.md`, `MODEL_POLICY.md`, and `MASTER_ROADMAP.md`. Densa ADE Core is the authoritative editor-independent state and mutation boundary. Clients use a versioned authenticated local protocol and never mutate Core repositories or SQLite directly. Lifecycle changes use centralized validated services, SQLite is detailed runtime truth, `.densa-ade/` is an inspectable non-secret projection, events are append-only facts, agents never certify their own success, deterministic validation precedes agent review, and user work is never destroyed.
2. Evaluate Phase 9 against the **current repository**, not merely the implementation present when Phase 9 was completed. Inspect every current caller, consumer, persistence path, integration, configuration, and later Phase 0-8 audit remediation capable of strengthening, weakening, bypassing, or invalidating Phase 9 behavior.
3. Preserve intentional compatible later behavior unless it conflicts with a required Phase 9 invariant or acceptance criterion.
4. Audit Phase 9 only. Do not begin Code - OSS or any later roadmap milestone. Do not move, recreate, or reinterpret the historical Phase 9 tag.
5. Preserve user-owned or concurrent work. Do not overwrite, discard, stage, or commit unrelated changes. Stop and report an ownership conflict that cannot be resolved safely.
6. Distinguish confirmed defects from speculative concerns. Confirm a defect only with current source evidence, an executable reproduction, or a logically complete current-path trace demonstrating the failure.
7. Fix every confirmed defect within the intended Phase 9 contract. Do not weaken tests, validation, security, recovery, protocol strictness, bounds, auditability, or failure semantics merely to obtain a passing result.
8. Add or strengthen regression tests wherever practical for every confirmed defect. Prefer a focused failing reproduction before production changes.
9. If environmental restrictions block material local socket, loopback, browser, child-process, or Git validation, rerun with the required authorized capability when permitted. If materially required validation remains incomplete, the final gate must be FAIL.
10. Only if the exact PASS gate is justified: selectively stage the audited snapshot, inspect it for secrets and runtime artifacts, create one audit/remediation commit using the required `densa-ade:` prefix, push `main` normally to `origin`, verify the remote reaches the exact commit, and verify `git rev-list --left-right --count origin/main...main` is `0 0`. Never force-push. Do not commit or push a FAIL result as a successful release audit.

## Original Phase 9 contract to recover and verify

Recover the complete original Phase 9 contract from `MASTER_ROADMAP.md`, `AGENTS.md`, `MODEL_POLICY.md`, milestone history, the peeled Phase 9 tag, current documentation, schemas, migrations, protocol catalogs, fixtures, tests, and implemented behavior. Historical anchors include P9M0 commit `c6b77db`, P9M1 commit `cca14a7`, P9M2 commit `0af532d`, and the peeled target of `densa-phase-9-complete`; these establish provenance only, not current correctness.

Build a traceability matrix mapping every recovered requirement and acceptance criterion to current implementation paths, schema/persistence support, actual callers and consumers, tests, externally visible behavior, and executed current-state evidence.

The following milestone summaries are an audit index, not a substitute for recovering the full original sources.

### P9M0 — Real one-phase headless product proof

Using the real CLI and editor-independent Core boundary, the headless system accepts a small project idea/specification, persists the project and portable representation, generates the complete phase-level roadmap before autonomous execution, selects Phase-by-phase execution, executes Phase 1 through the official authenticated `CodexAdapter`, establishes known Git/workspace checkpoints, independently validates each task, retries only with new actionable evidence, atomically commits accepted task work, runs phase-final validation and independent review, persists an accurate phase report, and stops at the durable `AWAITING_APPROVAL` boundary.

The proof must not hand-edit SQLite, replace official-agent evidence with a fake while claiming a real run, accept agent prose as completion, skip the actual Core/CLI path, fabricate acceptance evidence, or leak secrets/transcripts. Every task has concrete acceptance criteria; validation evidence and task commits map to exact task/attempt/checkpoint identities; Git history maps to tasks; phase completion follows task and phase validation; and project, phase, task, attempts, events, reports, checkpoints, commits, and approval state survive Core/database restart coherently.

Failure semantics include classified agent unavailability/authentication/usage/process/validation/workspace/Git/persistence/protocol failures, bounded retry with a default maximum of four attempts, safe rollback or explicit recovery when outcome is uncertain, correct cancellation and child-process cleanup, preservation of pre-existing user work, and fail-closed handling when completion, commit, validation, process termination, or restart evidence is contradictory or incomplete.

Gate C must remain demonstrable in the current composition: idea/spec -> complete roadmap -> Phase 1 task execution -> independent validation -> task commits -> phase validation/report -> approval, with a Core restart not breaking or falsifying the run. The original real-provider proof and postmortem are historical evidence; current deterministic regressions and present-path inspection must establish that later changes have not invalidated its guarantees. Never describe fake/synthetic fixtures as current real-provider proof.

### P9M1 — Deterministic Continuous mode and recovery stress proof

A stable end-to-end harness uses `FakeAgentAdapter`, fake/bounded time, file-backed SQLite, temporary Git repositories, and current production orchestration paths to exercise two or more phases in Continuous mode plus realistic interruption and recovery. Required scenarios include agent failure then retry, validation failure then corrected retry, usage limitation then conservative auto-resume, Core restart mid-task, Core restart while `WAITING_FOR_USAGE`, user pause, manual workspace change while paused, scope mutation requiring approval, and four failed attempts transitioning to `BLOCKED`.

Every scenario ends in the exact correct persisted project/phase/task/attempt/control state; append-only event replay tells a complete, ordered, project-scoped, version-compatible story; retry counts survive restart; portable projections and phase reports remain coherent; user work is preserved; manual intervention is detected and recontextualized rather than overwritten; scope changes cannot bypass required approval; usage availability is never guessed; auto-resume revalidates recovery/workspace/control state; there is no busy polling; timers and background work are bounded and cleaned up; repeated runs are deterministic; and Continuous mode cannot advance around unresolved validation, approval, usage, recovery, permission, control, or workspace blockers.

Inspect behavior across repeated cycles and reopened Core/database instances, not only one isolated fixture. Search for stale owners or execution slots, duplicate scheduling, late adapter/validator results, repeated terminal actions, incomplete process evidence, partially persisted events/reports/projections, inconsistent state after a crash boundary, forgotten timers/listeners/processes, and cross-project contamination.

### P9M2 — Frozen Core v1 protocol for IDE integration

The versioned Core v1 protocol exposes every operation needed by the planned Home/Start Project, Dashboard, Roadmap, Master Agent, phase approval, pause/resume/stop, settings/policy, usage, event, run-log, Git, validation, and drill-down clients. A fake client can perform every planned first-pass IDE interaction without direct database access or imports from Core implementation internals. The client boundary is editor neutral: protocol packages contain no React, webview, VS Code workbench, repository, SQLite, or Core service types.

Requests, responses, errors, notifications, and events use strict versioned machine-readable schemas, bounded payloads, stable error codes, project/workspace scoping, and compatibility behavior that fails closed on unsupported versions, methods, malformed payloads, invalid cursors, or unauthenticated access. The frozen method catalog and `CoreV1Client` agree with daemon routing and actual Core services; every declared operation is callable and every planned interaction is represented. No daemon method silently bypasses domain authorization, policy, workspace binding, state transitions, persistence, or audit events.

Large event and log histories use deterministic bounded pagination. Event replay is project-scoped and resumes exclusively after the last contiguous sequence, returning coherent `latestSequence` and `hasMore` semantics. Reconnect behavior is documented and implementable: bootstrap an authoritative snapshot, replay missed events, subscribe without gaps, reject/detect duplicates or holes, and refresh authoritative state before mutation when continuity is uncertain. Live notifications cannot overtake replay unnoticed or cause stale snapshots to authorize mutations.

Local transport remains an authenticated, user-only Unix-domain socket with safe stale socket/PID recovery, token comparison that avoids disclosure, bounded framing/request handling, cancellation/timeout behavior, correct initialization before accepting clients, and cleanup on shutdown/crash. Protocol/log/event serialization and error conversion redact secrets and unrelated prompt/transcript data. Protocol contract tests prove catalog, schema, bounds, compatibility, replay/pagination, daemon/client parity, authentication, and current externally observable behavior.

## Current paths and integrations to inspect

Inventory and follow, without assuming filenames remain unchanged:

- CLI project creation/specification/roadmap/execution/approval/control commands and their real daemon/Core v1 call paths;
- `CoreV1Client`, protocol method catalog, schemas, serialization, compatibility negotiation, request/response/error/notification types, event replay and log pagination;
- daemon dispatch, authentication, Unix-socket lifecycle, service initialization/shutdown, stale endpoint recovery, cancellation, timeouts, connection cleanup, and protocol-to-domain error mapping;
- project/specification and roadmap creation, centralized lifecycle transitions, dependency scheduling, task packet construction, execution modes, execution controls, usage resume, permission policy, roadmap approval, and Master command integration;
- adapter detection/authentication/execution/cancellation/usage, structured output validation, process metadata, termination evidence, redaction, bounded logs, and live-proof opt-in boundaries;
- workspace preflight, isolated execution, checkpointing, rollback, guarded publication, task commit evidence, Git reachability, user-change preservation, and recovery across source/execution workspaces;
- independent validation, acceptance evidence, phase-final validation/review, retry context, durable reports, portable synchronization, and approval/Continuous progression;
- SQLite migrations, repositories, transactions, event publication ordering, attempt/process/checkpoint/validation/commit associations, projections, restart/reopen behavior, and partial-write recovery;
- current Phase 0-8 audit remediations and all tests, docs, configuration, fixtures, scripts, and package commands capable of affecting Phase 9 guarantees.

## Active defect search

Look beyond existing tests. Passing tests are evidence, not proof of correctness. Actively search for:

- missing or incomplete implementation and acceptance criteria that are only partially satisfied;
- violated or weakened invariants, architectural drift, and regressions introduced by later changes;
- incorrect assumptions, dead or unregistered protocol operations, client/daemon/catalog/schema drift, and integrations that bypass Core authority;
- lifecycle and state-transition bugs, invalid ordering, stale snapshots/owners/approvals, duplicate scheduling, late results, and repeated terminal actions;
- persistence, migration, transaction, append-only event, partial-write, projection, restart, replay, idempotency, and recovery failures;
- weak or missing independent validation, fabricated or mismatched evidence, completion without reachable task commits, inaccurate phase reports, and agent self-certification;
- incorrect failure classification, masking, accidental recovery, swallowed daemon/domain errors, unsafe retries, and ambiguous outcome handling;
- boundary-condition failures in pagination, cursors, sequence gaps, bounds, empty/malformed/oversized inputs, Unicode/serialization, unknown versions/methods, disconnects, cancellation, timeouts, and partial frames;
- authentication, authorization, project/workspace isolation, secret redaction, socket permissions, stale socket/PID identity, traversal/symlink, and cross-project leakage defects;
- meaningful edge cases involving dirty user work, manual edits during pause, interrupted Git/database/projection operations, four-attempt exhaustion, unknown usage reset time, and restarts at every intent/outcome boundary;
- behavior that passes isolated tests but fails in realistic CLI -> daemon -> protocol -> Core -> adapter/Git/validation -> persistence -> replay/client workflows.

Construct realistic current-state scenarios and inspect the actual paths they exercise. At minimum cover the Gate C one-phase workflow, repeated deterministic Continuous cycles, every required P9M1 failure/restart/control scenario, a fake-client tour of every frozen v1 method family, authenticated daemon round trips, reconnect/replay at empty/one-page/multi-page/boundary/gap conditions, malformed and unsupported protocol requests, shutdown/restart/stale-socket behavior, and persistence/Git/validation contradictions that must fail closed.

## Findings and remediation protocol

For every suspected issue, follow the exact current path and classify it as either confirmed or speculative. For every confirmed in-scope defect:

1. Record the violated original requirement or acceptance criterion and current-path evidence.
2. Explain why it is confirmed rather than speculative.
3. Add a focused failing reproduction before changing production code wherever practical.
4. Implement the smallest complete architectural fix that restores the underlying guarantee.
5. Preserve compatible later-phase behavior and schema/data compatibility.
6. Add or strengthen regression coverage for the defect, including failure/restart/project-isolation semantics where relevant.
7. Run focused unit, integration, persistence/migration, process, Git, protocol/IPC, recovery, regression, proof, and acceptance checks.
8. Reinspect the repaired implementation and every affected caller/consumer after validation to ensure the guarantee is restored rather than the fixture merely being satisfied.

Keep speculative concerns separate and state what evidence would resolve them. A speculative concern does not by itself justify changing behavior, but material uncertainty prevents PASS when a required guarantee cannot be established.

## Validation

Run focused checks first, then all Phase 9 proof commands and the repository-wide `npm run check`. Also run any separate clean build/typecheck/lint/format, migration, protocol contract, authenticated daemon/IPC, Git/workspace, restart/recovery, or acceptance commands required by the reconstructed contract. Run `git diff --check`; inspect the final diff and untracked files; and scan the selectively staged candidate for secrets, credentials, generated databases, sockets, logs, build artifacts, and unrelated files.

Record exact commands, test counts, outcomes, intentional skips, environmental limitations, and authorized reruns. Opt-in live-provider checks may remain skipped only when deterministic coverage and present-path inspection establish the contract; explicitly record the unverified live assumption. Never present fake-agent fixtures or seed scenarios as real-agent or real-user evidence.

## Required Phase 9 audit artifact

Write `docs/phase-9-current-state-audit.md` containing:

- a concise summary of what was reviewed;
- provenance and the reconstructed original Phase 9 contract;
- a requirement/acceptance-criterion traceability matrix;
- architecture, trust/mutation/state boundaries, and current integration paths;
- realistic workflows and failure paths inspected;
- every confirmed finding, severity, evidence, violated guarantee, and resolution;
- speculative concerns clearly separated from confirmed defects;
- remaining uncertainty or unverified assumptions;
- validation commands and exact results, including failures, skips, environmental restrictions, and reruns;
- post-validation reinspection conclusions;
- commit, push, remote SHA, and ahead/behind evidence only if PASS;
- exactly one final gate as the final gate line.

The final response must likewise summarize what was reviewed, every confirmed finding and resolution, remaining uncertainty, validation performed and results, synchronization evidence if PASS, and exactly one final gate as its final gate line.

The final gate must be exactly one of:

`PASS — Cleared for release.`

Use PASS only if available current-state evidence supports that Phase 9 requirements, acceptance criteria, invariants, architecture, lifecycle, failure semantics, Gate C, and intended externally observable behavior remain correctly implemented and no confirmed release-blocking issue remains.

`FAIL — Issues remain; deeper fixes are required.`

Use FAIL if any confirmed issue remains unresolved, required behavior cannot be demonstrated with sufficient confidence, or validation is incomplete in a way that materially affects release confidence.

## Conditional Densa Core integration audit

After the Phase 9 audit gate is decided and any authorized PASS commit/push is complete, inspect the current standalone audit reports for Phases 1-9. A Densa Core integration audit is eligible only if each phase has fresh current-state PASS evidence applicable to the resulting repository state. Historical milestone commits, tags, roadmap completion, or generic passing tests do not satisfy the prerequisite.

If any report is absent, FAIL, stale relative to relevant changes, or materially incomplete, explicitly defer the whole-Core audit and identify the unmet prerequisite. Do not create or execute its prompt.

Only if every Phase 1-9 prerequisite is satisfied, first construct and fully save a fresh self-contained Densa Core integration-audit prompt before inspecting for integration findings. Then execute it immediately in the same turn. Treat Core as one complete composed system, not another phase-by-phase review. Reconstruct the current architecture and search specifically for broken cross-phase assumptions; contradictory invariants; duplicated sources of truth; invalid transitions; lifecycle, initialization, shutdown, cleanup, dependency, and partial-write ordering defects; persistence/restart/recovery failures; masked or mispropagated failures; stale state; race-sensitive composition; and end-to-end guarantees that appear locally satisfied but fail jointly. Construct realistic cross-component scenarios, inspect their actual implementation paths, confirm and fix integration defects, add practical coverage, rerun all relevant Core validation/regression/acceptance suites, reinspect affected invariants, write the required Core integration report, issue the same exact gate, and commit/push `main` only after PASS.
