# Phase 7 Current-State Release Audit Prompt

You are Codex working in `/Users/ivanuy/Desktop/Projects/active-projects/densa-ade` on the current `main` checkout. Perform a fresh, evidence-driven current-state release audit of **Phase 7 only**. This prompt is the sealed scope and methodology for the audit. Do not treat historical completion, old milestone commits, phase tags, or a passing existing test suite as proof that Phase 7 is currently correct.

## Objective

Determine whether every original Phase 7 requirement remains genuinely guaranteed by the repository as it exists now, including all later integrations and changes. Repair every confirmed in-scope defect, add practical regression coverage, run relevant validation, reinspect the repaired guarantees, and issue exactly one release gate.

The audit is not complete until the current implementation has been traced through realistic lifecycle and failure paths. Evidence must come from the present source, configuration, schemas and migrations, persistence behavior, integrations, tests, and executed validation.

## Governing constraints

1. Read and obey the repository `AGENTS.md`, `MODEL_POLICY.md`, and `MASTER_ROADMAP.md`, including milestone scope, Core authority, centralized state transitions, crash safety, secure local IPC, privacy and secret handling, deterministic validation, Git safety, and release discipline.
2. Preserve all intentional later-phase behavior unless it conflicts with a required Phase 7 invariant or acceptance criterion.
3. Do not begin another roadmap phase or expand into a whole-Core integration audit.
4. Do not overwrite, discard, stage, or commit unrelated work. Stop and report any ownership conflict that cannot be resolved safely.
5. Classify observations as confirmed defects or speculative concerns. A concern becomes a confirmed defect only when current source evidence, an executable reproduction, or a logically complete current-path trace demonstrates the failure.
6. Fix every confirmed defect that falls within Phase 7's intended requirements. Do not weaken tests, validation, security, recovery, or failure semantics to obtain a passing result.
7. If environmental restrictions block material validation, rerun with the required authorized capability when permitted. If material validation remains incomplete, the gate must be FAIL.
8. Only if the exact PASS gate is justified: create one selective audit/remediation commit using the repository's `densa-ade:` history style, push `main` normally to `origin`, verify the remote reaches the exact commit, and verify `origin/main...main` is `0 0`. Never force-push. Do not commit or push a FAIL result as a successful release audit.

## Required reconstruction

Recover and review Phase 7's original:

- requirements;
- milestone-by-milestone acceptance criteria;
- invariants and trust boundaries;
- architectural intent;
- lifecycle expectations;
- failure semantics and machine-readable error behavior;
- intended externally observable behavior.

Use the original roadmap and policy text, relevant Phase 7 milestone commits and phase tag, migrations and protocol versions, historical tests and fixtures, and current documentation as sources. Resolve conflicts in favor of explicit governing policy and the original required guarantees, while recognizing compatible intentional evolution.

At minimum, determine the exact original contract for every Phase 7 subsystem identified by the repository, including usage-limit classification and durable waiting, conservative usage recovery and auto-resume, centralized permission policy and authorization contexts, opaque secret references and redaction, macOS keep-awake lifecycle and battery policy, and authenticated local Core daemon/IPC behavior. This list is an audit index, not a substitute for recovering the actual requirements and acceptance criteria.

Create a traceability matrix mapping each recovered requirement and acceptance criterion to its present implementation paths, persistence/schema support, current callers and consumers, tests, externally visible behavior, and validation evidence.

## Current-state implementation audit

Trace the reconstructed contract into the current repository and determine whether it is still genuinely guaranteed. Inspect all relevant:

- domain models, state machines, transition services, lifecycle coordinators, and schedulers;
- adapter boundaries and structured provider-event classification;
- permission decisions, policy presets, guarded operations, authorization-context issuance and validation, and audit events;
- secret stores, secret-reference persistence, child-process injection, environment/argv/stdin handling, and all logging/event/prompt/task-packet redaction boundaries;
- usage-state persistence, probe scheduling, cancellation and supersession, restart restoration, rollback/workspace/decision/permission revalidation, and resume transitions;
- keep-awake demand calculation, process ownership, battery thresholds, stale-process recovery, teardown, initialization, shutdown, and crash behavior;
- daemon startup and ownership, runtime-file permissions, socket/token/PID/database handling, authentication, framing, schema/protocol validation, request/response errors, event replay and cursors, live subscriptions, cleanup, and conflicting/stale runtime state;
- SQLite migrations, repositories, transactions, atomicity, event publication ordering, portable projections, and restart/recovery paths;
- CLI, Master, scheduler/orchestrator, validation, UI/client, and later-phase integrations that call or depend on Phase 7 behavior;
- configuration defaults, compatibility behavior, fixtures, unit/integration/process/IPC/recovery tests, and later changes capable of weakening Phase 7 guarantees.

Follow actual call graphs and data flow across boundaries. Inspect both successful flows and every meaningful failure or interruption point. Look beyond existing tests: passing tests are evidence, not proof.

## Active defect search

Actively search for:

- missing or incomplete implementation;
- acceptance criteria that are only partially satisfied;
- violated, bypassed, contradictory, or weakened invariants;
- architectural drift or duplicated/inconsistent sources of truth;
- regressions introduced by later phases;
- incorrect assumptions and integration failures;
- lifecycle ordering, initialization, shutdown, cleanup, cancellation, and state-transition bugs;
- persistence, transaction, partial-write, restart, and recovery problems;
- stale state or stale authorization/recovery evidence;
- weak, missing, or incorrectly scoped validation;
- incorrect failure classification, propagation, masking, or accidental recovery;
- boundary-condition failures, malformed inputs, size limits, pagination/cursor errors, and meaningful edge cases;
- races or late asynchronous results that can mutate state after cancellation or supersession;
- secret exposure through uncommon outputs, nested structures, metadata, error messages, or process boundaries;
- permission or authentication bypasses, context substitution, cross-project confusion, and insecure filesystem behavior;
- behavior that passes isolated tests but fails in realistic workflows.

Construct realistic scenarios spanning each Phase 7 subsystem and its current consumers. For each suspected defect, inspect the exact current implementation path and, where practical, add a focused failing regression before changing production code.

## Remediation and verification

For every confirmed in-scope defect:

1. Record the violated original requirement or acceptance criterion and the current-path evidence.
2. Implement the smallest complete architectural fix that restores the underlying guarantee.
3. Preserve compatible later-phase behavior.
4. Add or strengthen focused regression tests wherever practical, including failure and recovery semantics.
5. Run the focused tests first, then all relevant unit, integration, process, IPC, recovery, regression, and acceptance validation.
6. Run the repository-wide release gate, including `npm run check`, plus clean build/typecheck/lint/format or other commands required by the recovered Phase 7 contract. Run `git diff --check` and inspect the candidate diff for secrets and runtime artifacts.
7. Reinspect every affected call path and integration after validation to establish that the fix restores the required guarantee instead of merely satisfying a test fixture.

Do not label a speculative concern as a defect, but include material remaining uncertainty in the report. Do not declare PASS if a confirmed issue remains unresolved or if a required behavior cannot be established with sufficient confidence.

## Required audit artifact and final response

Write a standalone report to `docs/phase-7-current-state-audit.md`. It must contain:

- a concise summary of what was reviewed;
- the reconstructed original Phase 7 contract and traceability matrix;
- realistic workflows and failure paths inspected;
- every confirmed finding, its severity and evidence, and its resolution;
- speculative concerns clearly separated from confirmed defects;
- remaining uncertainty or unverified assumptions;
- validation commands and exact results, including failures, skips, environmental limitations, and reruns;
- post-validation reinspection conclusions;
- commit, push, remote SHA, and ahead/behind evidence only if PASS;
- exactly one final gate, as the final gate line of the report and final response.

The final gate must be exactly one of:

`PASS — Cleared for release.`

Use PASS only if the available current-state evidence supports that Phase 7's requirements, acceptance criteria, invariants, architecture, lifecycle, failure semantics, and intended externally observable behavior remain correctly implemented and no confirmed release-blocking issue remains.

`FAIL — Issues remain; deeper fixes are required.`

Use FAIL if any confirmed issue remains unresolved, required behavior cannot be demonstrated with sufficient confidence, or validation is incomplete in a way that materially affects release confidence.

After completing this Phase 7 audit, separately inspect the existing current-state audit reports for Phases 1–9. A whole-Core integration audit is eligible only if every phase has its own current-state PASS evidence. Historical milestone commits, tags, or old tests do not satisfy that prerequisite. If even one phase lacks qualifying evidence, explicitly defer the whole-Core audit and identify the missing phase reports; do not construct or execute the Core integration audit yet.
