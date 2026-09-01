# Phase 8 Current-State Release Audit Prompt

You are Codex working in `/Users/ivanuy/Desktop/Projects/active-projects/densa-ade` on the current `main` checkout. Perform a fresh, evidence-driven current-state release audit of **Phase 8 only**. This document is the sealed scope and methodology for the audit. It must predate implementation findings. Do not treat historical completion, milestone commits, the `densa-phase-8-complete` tag, documentation claims, or a passing existing test suite as proof that Phase 8 is currently correct.

## Objective

Determine whether every original Phase 8 requirement remains genuinely guaranteed by the repository as it exists now, including all later integrations and changes. Recover the original contract, trace it into current implementation and realistic workflows, repair every confirmed in-scope defect, add practical regression coverage, run all relevant validation, reinspect repaired guarantees, and issue exactly one release gate.

The audit is not complete until the current implementation has been followed across trust, mutation, persistence, lifecycle, recovery, protocol, and externally observable boundaries. Existing tests are evidence, not proof.

## Governing constraints

1. Read and obey `AGENTS.md`, `MODEL_POLICY.md`, and `MASTER_ROADMAP.md`. In particular, Densa ADE Core is authoritative and editor-independent; Master and worker roles are logically separate; all mutations and lifecycle transitions pass through validated Core domain services; SQLite is the detailed source of truth; portable files are inspectable projections; events are append-only facts; roadmap mutations are classified and audited; state changes are crash-safe; secrets and unrelated transcripts are excluded; and deterministic validation outranks agent claims.
2. Evaluate Phase 8 against the **current repository**, not merely the implementation present when Phase 8 was completed. Inspect later changes that call, expose, persist, transform, recover, or rely on Phase 8 behavior.
3. Preserve intentional later-phase behavior unless it conflicts with a required Phase 8 invariant or acceptance criterion.
4. Audit Phase 8 only. Do not begin another roadmap phase or silently expand remediation beyond the smallest complete fixes required to restore Phase 8 guarantees.
5. Preserve user-owned or concurrent work. Do not overwrite, discard, stage, or commit unrelated changes. Stop and report an ownership conflict that cannot be resolved safely.
6. Distinguish confirmed defects from speculative concerns. Confirm a defect only with current source evidence, an executable reproduction, or a logically complete current-path trace demonstrating the failure.
7. Fix every confirmed defect within the intended Phase 8 contract. Do not weaken tests, security, policy, validation, recovery, auditability, or failure semantics merely to obtain a passing result.
8. If environmental restrictions block material validation, rerun with the required authorized capability when permitted. If materially required validation remains incomplete, the final gate must be FAIL.
9. Only if the exact PASS gate is justified: selectively stage the audited snapshot, inspect it for secrets and runtime artifacts, create one audit/remediation commit using the current repository's required `densa-ade:` prefix, push `main` normally to `origin`, verify the remote reaches the exact commit, and verify `git rev-list --left-right --count origin/main...main` is `0 0`. Never force-push. Do not commit or push a FAIL result as a successful release audit.

## Original Phase 8 contract to recover and verify

Recover Phase 8's original requirements, acceptance criteria, invariants, architectural intent, lifecycle expectations, failure semantics, machine-readable errors, persistence expectations, and intended externally observable behavior from the governing documents, original roadmap text, milestone history, current documentation, schemas/migrations, tests/fixtures, and phase tag. Relevant historical anchors are the original P8M0–P8M3 commits `ce019e5`, `ceec39f`, `a9b6dae`, and `02eba7e`, plus the peeled target of `densa-phase-8-complete`; these are provenance, not proof of current correctness.

Build a traceability matrix mapping every recovered requirement and acceptance criterion to present implementation paths, schema/persistence support, callers and consumers, tests, externally visible behavior, and executed validation evidence.

At minimum, reconstruct and verify the following milestone contracts. The bullets below are an audit index, not a substitute for reading the original sources and recovering all details.

### P8M0 — Master Agent service boundary

The project-level Master Agent is a coordinator using a logically separate agent session, not an unrestricted code editor and not an authority over project state. It supports explaining project status, phases, failures, blockers, tasks, and roadmap/decision rationale; proposing roadmap and constraint changes; requesting pause, resume, and execution-mode changes; and citing current internal task, decision, event, roadmap-revision, phase, and project identities where supported.

Master output is structured, schema-validated, bounded, project-scoped, and treated as an untrusted proposal. Core constructs authoritative context from current persisted facts. Master cannot directly mutate authoritative state, invent valid citations, bypass policy or centralized state-transition/domain services, substitute another project/workspace/session, or make worker execution depend on an active Master conversation. Codex-specific integration remains behind the agent abstraction, with deterministic fake-agent coverage for routine tests. Invalid structure, invented/stale/cross-project citations, unsupported commands, ambiguous authority, and provider failure must fail closed with stable classified behavior before mutation.

Acceptance includes proving that Master proposals map only to validated Core commands, policy/state services cannot be bypassed, worker execution remains independent, and citations are checked against the exact authoritative project snapshot.

### P8M1 — Durable project decisions and constraints

User steering becomes durable Core-owned data rather than conversational memory. Decision/constraint records include stable identity, statement, category, source (`user`, `master`, or `system`), timestamp, scope, active/superseded status, explicit supersession, and affected project/phase/task or roadmap references. Scoped references must belong to the same project and survive restart. Legacy persistence remains readable through explicit migrations without silently losing audit history.

Only relevant active constraints enter future Task Packets. Project constraints apply project-wide; phase/task constraints apply only to their exact scope. Superseded records and old Master/worker conversation events remain auditable but never become authoritative current context. Explicitly selected decisions must be current and valid. Adds, replacements, and removals use one centralized permission-aware mutation boundary, create durable append-only facts, and synchronize `.densa-ade/DECISIONS.md` as a non-authoritative inspectable projection without replaying an already committed database mutation after projection failure.

Conflicting or ambiguous constraints are detected conservatively and surface an explicit user-decision flow rather than silently choosing, dropping, merging, or overriding intent. Atomicity must cover the authoritative record, supersession relationship, conflict outcome where applicable, and event linkage. Input, audit fields, projections, prompts, events, and Task Packets must remain bounded and redacted.

Acceptance includes demonstrating that an added constraint affects subsequent relevant Task Packets, old sessions are not authoritative memory, superseded decisions remain inspectable but inactive, restart preserves decisions, project isolation is enforced, projection behavior is safe, and conflicting constraints block for a decision.

### P8M2 — Master-led roadmap revision workflow

Natural-language steering is converted into structured proposed mutations, then handled by authoritative Core flow: interpret intent, bind a proposal to an exact base revision and before/after content, classify it as `MINOR`, `SIGNIFICANT`, or `SCOPE`, validate graph and policy, obtain approval when required, wait for a safe execution boundary when active work would be affected, apply atomically, append audit events/revision history, regenerate `.densa-ade/ROADMAP.md`, and explain affected work.

The workflow wraps rather than bypasses the canonical roadmap preview/apply services. The user can inspect exact before/after snapshots, rationale, affected IDs, classification, and approval requirements. Significant changes obey the configured permission policy; scope changes always require explicit user approval. Changes cannot weaken promised requirements or acceptance criteria without required approval, produce an invalid/cyclic/dependency-broken roadmap, mutate active task context mid-flight, silently alter completed/historical work, or cross project boundaries.

Approval is bound to the exact inspected proposal, base revision, operation batch, before snapshot, after snapshot, classification, affected IDs, and decision evidence. Intervening revisions, altered operations, substituted approvals, changed active-task state, or stale safety evidence cause a fail-closed stale/blocked result; Core never silently rebases or rewrites the inspected change. A successful authoritative update persists the new roadmap, revision/proposal resolution, and `ROADMAP_CHANGED` event transactionally. Portable projection happens afterward and a projection failure is reported without duplicating the committed mutation on retry or restart.

Acceptance includes significant/scope policy enforcement, graph validity, inspectable before/after and rationale, safe-boundary handling for running work, transaction rollback on failure, idempotent terminal outcomes, restart/recovery behavior, and correct treatment of representative steering requests such as adding/reordering work, durable technology constraints, pause-after-boundary requests, and scope-changing phase replacement.

### P8M3 — Trustworthy project, phase, and task rundowns

Concise human-readable rundowns are derived from structured authoritative persisted facts, never conversational memory. Covered views include current project status, phase completion, blocked state, usage waiting, recent changes, task/phase/project progress, retry/failure history, decisions, validation results, and Git/checkpoint facts.

The structured fact boundary reconciles exact project/phase/task identity and lifecycle state with attempts, commits and Git reachability, validation runs/results and acceptance evidence, append-only events, decisions/constraints, roadmap revision state, phase reports, and current usage state. Completed claims must fail closed when supporting persisted or Git/validation evidence is absent, contradictory, stale, cross-project, or unreachable. Histories and payloads are bounded and deterministically ordered. Unknown token, cost, reset, duration, or other unavailable metrics remain explicitly unknown or omitted rather than inferred.

The Master may render approved facts into prose but cannot change underlying values, replace identities, invent metrics, add unsupported claims, or create drill-down references not present in the exact fact snapshot. Prose validation must bind to a digest or equivalent integrity check of the facts being rendered. Generated summaries expose stable drill-down IDs/references for later clients and protocol consumers. Malformed data and agent/provider failures return classified failures without converting uncertainty into a trustworthy rundown.

Acceptance includes phase report agreement with database, Git, lifecycle, and validation state; Fake Master inability to alter numeric/status facts or references; honest unknown usage/cost/reset handling; authoritative retry/failure history; bounded deterministic results; and stable drill-down identities suitable for clients.

## Current integration boundaries that must be traced

Inspect the actual current implementation and all relevant paths, including:

- Master service/session construction, project-context readers, structured schemas, provider adapters, context bounding/redaction, citation allowlists, fact digests, and command gateways;
- decision/constraint domain types, repositories, migrations, schema constraints, service boundaries, permission checks, events, supersession/conflict logic, portable `DECISIONS.md` synchronization, and Task Packet selection;
- roadmap proposal repositories and migrations, preview/classification, approval and decision binding, safe-boundary handling, atomic apply/revision/event transactions, stale/idempotent outcomes, graph validation, portable `ROADMAP.md` synchronization, and restart/recovery;
- rundown fact construction and prose presentation for project/phase/task scopes, reports, attempts, commits, Git reachability, validators and acceptance evidence, decisions, events, usage state, pagination/bounds, references, integrity validation, and error behavior;
- centralized state transitions, scheduler/orchestrator, execution modes and controls, validation/phase completion, usage waiting/resume, permission policy, recovery, Git/workspace services, and portable projection paths that Phase 8 consumes or can affect;
- Core daemon, protocol v1, CLI/headless clients, event replay, pagination, serialization/deserialization, service registration, initialization/shutdown, and later Phase 9 integrations exposing Phase 8 behavior;
- all configuration, defaults, compatibility behavior, fixtures, unit/integration/process/recovery tests, and later audit/remediation changes capable of weakening Phase 8 guarantees.

Follow actual callers, callees, transactions, and data flow. Inspect successful execution plus every meaningful refusal, cancellation, interruption, projection failure, provider failure, stale-input, partial-write, restart, and retry boundary. Look beyond existing tests.

## Active defect search and realistic scenarios

Actively search for:

- missing or incomplete implementation and partially satisfied acceptance criteria;
- violated, weakened, duplicated, contradictory, or bypassable invariants and sources of truth;
- architectural drift, direct Master mutation, adapter leakage, policy/transition bypass, or reliance on conversational memory;
- later-phase regressions, protocol/CLI integration failures, unregistered or mismatched services, and incompatible schemas;
- lifecycle ordering, initialization, shutdown, cancellation, cleanup, safe-boundary, and state-transition bugs;
- persistence, migration, transaction, event-ordering, projection, restart, idempotency, and recovery problems;
- partial writes, committed-database/failed-projection outcomes, repeated commands, duplicated events, and stale proposal or authorization evidence;
- invalid roadmap graphs, weakened acceptance promises, substituted approval, unsafe active-work mutation, and incorrect classification;
- decision supersession cycles, dangling/cross-project references, ambiguous conflict handling, stale constraints in Task Packets, and lost durable user intent;
- fabricated, stale, contradictory, unbounded, nondeterministic, or cross-project rundown facts and drill-down references;
- unreachable or mismatched commits, incomplete validation evidence, misleading completion/status claims, and accidental recovery from inconsistent evidence;
- missing validation, incorrect failure classification/propagation, error masking, and unclassified exceptions crossing protocol boundaries;
- malformed inputs, empty or oversized fields, duplicate identities, Unicode/serialization edge cases, pagination/cursor boundaries, missing rows, legacy schemas, and meaningful edge conditions;
- secret or unrelated prompt/transcript leakage through context, proposals, decisions, events, errors, projections, summaries, nested metadata, or protocol payloads;
- race-sensitive late results, stale snapshots, revision wins, cancellation/supersession, repeated terminal actions, and behavior that passes isolated tests but fails in a composed workflow.

Construct realistic end-to-end Phase 8 scenarios using deterministic fixtures/fakes rather than paid live agents for routine validation. At minimum exercise: a valid explanatory Master turn; invented and cross-project citations; every command kind through its real Core gateway; adding, replacing, removing, conflicting, and scoped constraints across restart and Task Packet creation; projection failure after a durable decision; minor/significant/scope roadmap proposals; stale approval and intervening revision; active-task safe-boundary changes; transactional failure and retry after portable-sync failure; valid and contradictory project/phase/task rundowns; unreachable Git evidence; unknown usage metrics; forged prose values/references; malformed provider output; and current protocol/CLI access to Phase 8 operations.

For each suspected defect, inspect the exact present implementation path and, where practical, add a focused failing regression before changing production code.

## Findings and remediation protocol

For every confirmed in-scope defect:

1. Record the violated original requirement or acceptance criterion and the current-path evidence.
2. Explain why it is confirmed rather than speculative.
3. Implement the smallest complete architectural fix that restores the underlying guarantee.
4. Preserve compatible later-phase behavior and current data compatibility.
5. Add or strengthen regression tests wherever practical, including failure, restart, project-isolation, and recovery semantics.
6. Run focused tests first, then all relevant unit, integration, persistence/migration, protocol/IPC, process, recovery, Git, regression, and acceptance validation.
7. Reinspect the changed implementation and every affected caller/consumer after validation to establish that the fix restores the guarantee instead of merely satisfying the added fixture.

Keep speculative concerns separate and state what evidence would resolve them. A speculative concern does not justify changing behavior without evidence, but material uncertainty can still prevent PASS when a required guarantee cannot be established.

## Validation

Run the exact focused checks discovered during the audit, then the repository-wide release gate including `npm run check`. Also run any separate clean build, typecheck, lint, format, migration, protocol, or acceptance commands required by the reconstructed Phase 8 contract. Run `git diff --check`, inspect the candidate diff and untracked files, and scan the selectively staged audit snapshot for secrets, credentials, generated runtime databases/sockets/logs, and unrelated artifacts.

Record exact commands, pass/fail counts, intentional skips, environmental limitations, authorized reruns, and whether any live-provider coverage was opt-in and skipped. Never present fake-agent or synthetic fixture evidence as real-provider or real-user proof.

## Required audit artifact and release action

Write a standalone report to `docs/phase-8-current-state-audit.md` containing:

- a concise summary of what was reviewed;
- provenance and the reconstructed original Phase 8 contract;
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

Use PASS only if the available current-state evidence supports that Phase 8's requirements, acceptance criteria, invariants, architecture, lifecycle, failure semantics, and intended externally observable behavior remain correctly implemented and no confirmed release-blocking issue remains.

`FAIL — Issues remain; deeper fixes are required.`

Use FAIL if any confirmed issue remains unresolved, required behavior cannot be demonstrated with sufficient confidence, or validation is incomplete in a way that materially affects release confidence.

## Conditional whole-Core integration audit

After completing the Phase 8 audit, inspect the current standalone audit reports for Phases 1–9. A Densa Core integration audit is eligible only if every phase has its own current-state PASS evidence. Historical milestone commits, phase tags, roadmap completion, and passing tests do not satisfy this prerequisite.

If even one phase lacks qualifying current-state PASS evidence, explicitly defer the whole-Core audit and identify the missing phase reports; do not construct or execute the Core integration audit yet.

Only if every Phase 1–9 prerequisite is satisfied, first create and fully save a fresh self-contained Densa Core integration-audit prompt before inspecting for integration findings. Then execute it immediately in the same turn. Treat Core as one composed system and specifically search for broken cross-phase assumptions, contradictory invariants, duplicated sources of truth, invalid transitions, lifecycle ordering, persistence/recovery and partial-write behavior, failure propagation and masking, stale state, teardown, dependency and initialization/shutdown ordering, race-sensitive behavior, and end-to-end guarantees that appear locally satisfied but fail jointly. Fix confirmed defects, add practical integration regressions, rerun all relevant Core validation and acceptance suites, reinspect affected invariants, issue the same exact PASS/FAIL gate, and commit/push `main` only after PASS.
