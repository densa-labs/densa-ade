# Phase 5 current-state release audit — sealed prompt

Constructed on 2026-08-31 before implementation inspection. Execute this entire prompt immediately in the same task. This document is the audit specification, not evidence that the phase passes.

## Objective and authority

Audit Phase 5, P5M0–P5M5, against the current Densa ADE repository at `/Users/ivanuy/Desktop/Projects/active-projects/densa-ade`, including changes made after Phase 5 originally shipped. Read AGENTS.md and MODEL_POLICY.md. Preserve concurrent/unrelated work. Do not begin another milestone or treat historical phase tags, completion claims, or passing tests as proof. Recover original requirements from MASTER_ROADMAP.md, milestone-era Git history, architecture documentation, contracts, and tests; explicitly record contradictions or unavailable evidence. Follow requirements through current implementations and all relevant later integrations.

## Original requirements to recover and demonstrate

For each milestone, reconstruct requirements, acceptance criteria, invariants, architecture, lifecycle ordering, failure semantics, and intended externally observable behavior. Map each guarantee to present source paths, persistence records, callers, tests, and direct evidence:

- P5M0: read-only dependency scheduler selects only persisted READY work, respects project/phase/task states, completed hard dependencies, outstanding user decisions, permissions and blocked states; deterministic tie breaking; one implementation worker at a time; scheduler never invokes an agent. Cover DAG dependencies, blocked work, completed prerequisites, and multiple ready candidates.
- P5M1: deterministic, bounded, secret-filtered Task Packet contains a short project summary, applicable global constraints and architectural decisions, phase/task goals, acceptance criteria, dependencies, relevant workspace paths/summaries, latest relevant retry diagnostics, permission envelope, explicit scope limits, and audited context sources. Omit unrelated decisions, raw Master conversations, and full event history. Verify clean rendering, secret fixtures, and retry evidence.
- P5M2: persist attempt number before checkpoint/worker execution; READY to checkpoint to RUNNING to adapter execution to VALIDATING; independent PASS permits atomic commit and COMPLETED; failure persists diagnostics, safely rolls back, enters RETRYING, and supplies revised failure evidence; default four failed attempts block or wait for user. Stream bounded events; never trust agent prose as completion; cancellation, crashes, unknown termination, restart, and interrupted validation have explicit safe behavior. Verify first-try success, fail-then-pass, four failures, cancellation, crash, Git/state coherence, durable diagnostics/counters, and editor independence.
- P5M3: start phase, serially execute eligible tasks, prevent blocked required tasks from completing phase, validate phase, and durably report completed tasks, validators, commits, changed files, decisions, roadmap changes, retry/failure history, unresolved issues, and next phase. PHASE stops at AWAITING_APPROVAL; CONTINUOUS permits completion/next eligibility only after validation. Verify realistic multi-task execution and portable `.densa-ade/reports` output. Preserve later intentional deferred report projection when it maintains the durable-report and workspace-safety guarantees.
- P5M4: GUIDED stops for approval after each validated task; PHASE stops after phase validation/report; CONTINUOUS advances after valid phases but cannot bypass mandatory decisions, scope/permission/security/usage blockers or hard failure. Mode changes persist, emit audit facts, and apply at safe boundaries, including restart.
- P5M5: Core/CLI expose graceful pause, supported immediate worker cancellation, resume only after workspace/recovery checks, and stop without deleting work. Controls are idempotent, detect human intervention while paused, and require re-contextualization/acknowledgement of manual changes. Verify pause during execution and between tasks, repeated controls, stop, resume after edits, no orphan workers, and recovery checks before every resume.

## Inspection and adversarial execution

Reconstruct the actual call graph from CLI/authenticated Core protocol and Master commands through project/phase/task orchestration, scheduler, context builder, adapters, validators, state transitions, SQLite repositories/migrations, Git checkpoints/commit/rollback, portable synchronization, usage resume, permission policies, secrets, recovery, and teardown. Inspect relevant configuration, tests, and later Phase 6–9 integrations, as well as earlier Phase 1–4 dependencies. Core remains the sole authoritative mutation boundary; clients never invent state, status mutations use centralized audited transitions, events remain append-only, and external effects have durable intent/outcome evidence.

Actively search beyond existing tests for missing/partial implementation, partially satisfied criteria, weakened invariants, architectural drift, later regressions, false assumptions, integration failures, invalid transitions, stale snapshots, lifecycle ordering errors, persistence/recovery defects, weak validation, incorrect failure handling, boundary conditions, and realistic composed workflows that isolated tests miss. Exercise malformed and contradictory evidence, mandatory blockers, stale roadmap/context, empty/partial validation, failures around commit/rollback/report writes, process interruption, cancellation during async boundaries, restart with unfinished attempts, repeated controls, human edits, and serial-slot races where applicable. Do not weaken tests or create synthetic evidence presented as live-agent evidence.

## Remediation and validation

Classify findings as confirmed defects (with source/reproduction evidence) or speculative concerns. Fix every confirmed defect within Phase 5's intended requirements, including integration defects in later code that break those guarantees. Preserve intentional later behavior unless it conflicts with a required invariant/criterion. Add meaningful regression coverage wherever practical for each confirmed defect. Avoid unrelated redesign, dependencies, UI changes, destructive cleanup, history rewriting, or automatic pushes of projects managed by Densa.

Run relevant deterministic unit, integration, regression, and acceptance suites after fixes, then the repository build/type/lint/test gate (`npm run check`), and `git diff --check`. Use fake adapters for routine tests and real temporary Git repositories/SQLite/socket/process lifecycle tests where appropriate. Record exact commands, outcomes, skips, and environmental restrictions; resolve material validation gaps before PASS. Reinspect affected source paths after validation, evaluating the underlying guarantee rather than just the regression assertion. Perform a final distinct critical review of the candidate diff and requirement matrix before selecting the gate.

## Report, release gate, and synchronization

Write a self-contained audit report with baseline/current revision, scope and requirement traceability, concise reviewed areas/scenarios, every confirmed finding and resolution, remaining uncertainties/unverified assumptions, exact validation outcomes, and exactly one final gate line:

`PASS — Cleared for release.`

Use PASS only when available evidence supports that Phase 5 requirements, acceptance criteria, invariants, architecture, and intended current behavior are correctly implemented and no confirmed release blocker remains.

`FAIL — Issues remain; deeper fixes are required.`

Use FAIL if a confirmed issue remains, important required behavior cannot be demonstrated with sufficient confidence, or materially relevant validation is incomplete. Never use a qualified or substitute gate.

If PASS, selectively commit the reviewed audit/fixes/tests/docs using a `densa-ade:` message and push normally to private `origin/main`, as explicitly authorized. Verify remote SHA and ahead/behind. Preserve unrelated changes, do not force-push or recreate historical phase tags, and report synchronization failures separately from code evidence. Stop on divergent history requiring user direction.

## Whole-Core audit prerequisite

Check authoritative current audit reports for individual PASS gates for every Phase 1–9; milestone completion tags are insufficient. Only after all nine individual audits pass, construct a separate fresh, complete, self-contained Densa Core Integration Audit prompt before executing it in the same turn. Do not silently expand this request into unauthorised individual audits of other phases. If prerequisite evidence is absent, report exactly which phase gates are missing and do not start the integration audit.

The later integration prompt must treat Core as one system, reconstruct its architecture and trust/state boundaries, and inspect cross-phase assumptions, contradictory invariants, duplicate truth, invalid transitions, ordering, persistence, restart/recovery, interrupted/partial writes, failure propagation/masking, stale state, teardown, dependency order, initialization/shutdown, races, and jointly unsatisfied requirements. It must construct realistic cross-component scenarios, inspect their actual implementation, distinguish confirmed defects from speculation, fix all confirmed integration findings, add practical regressions, rerun relevant Core suites, and reevaluate affected guarantees. Its report must contain architecture/boundaries, scenarios, findings/resolutions, uncertainty, validation, and the same exact binary gate. PASS requires internally consistent, correctly integrated, lifecycle-resilient, release-quality Core, followed by an authorized normal commit and push to main; unresolved confirmed issues or material uncertainty/incomplete validation require FAIL.
