# Phase 4 current-state release audit — sealed execution prompt

Constructed 2026-08-31 before implementation inspection. Execute this entire prompt in the same task immediately after writing it. This document is the audit specification, not an audit result; do not retrospectively change it to fit findings.

## Objective and scope

Audit Phase 4 of Densa ADE in `/Users/ivanuy/Desktop/Projects/active-projects/densa-ade` against the current repository, including subsequent integrations. Do not merely review the implementation at the original phase-completion tag. Recover original requirements, acceptance criteria, invariants, architectural intent, lifecycle expectations, failure semantics, and intended externally observable behavior from `AGENTS.md`, `MASTER_ROADMAP.md`, architecture/milestone documentation, available history, and contracts. Record source locations and distinguish historical evidence from verified current behavior.

Phase 4 concerns structured project specifications, adaptive Master interviews, complete dependency-aware roadmaps, and classified, policy-controlled, auditable roadmap mutations. Verify that this scope matches the authoritative roadmap. Inspect prerequisites and later phases only insofar as they affect these guarantees. Preserve intentional later behavior unless it violates an original required invariant or acceptance criterion. Do not implement a later milestone, rewrite completed milestone history, or move historical phase tags.

## Procedure

1. Read applicable repository instructions, inspect branch/status and existing user changes, and record the starting commit. Preserve unrelated edits and detect concurrent changes. Never reset, clean, force-push, or stage unrelated work.
2. Build an explicit requirements-to-current-implementation matrix covering every Phase 4 milestone. For each requirement record the authoritative source, current enforcement paths, relevant later integrations, deterministic evidence, edge cases, and remaining confidence limits. Historical completion claims and passing tests are evidence, never proof.
3. Reconstruct the relevant architecture and trust boundaries: clients and Master agents propose; editor-independent Core validates and owns mutations; SQLite is authoritative; portable files are inspectable projections; events and decisions are durable facts; lifecycle changes use centralized transition services.
4. Read all relevant code paths, integrations, configuration, persistence/repositories/migrations, tests, and later modifications. Follow actual callers and consumers through protocol/CLI, interview/planning, runtime roadmap materialization, scheduler/task packets, Master revisions/decisions, portable synchronization, startup/recovery, and validation where applicable. Inspect behavior beyond what tests exercise.
5. Actively search for missing or incomplete implementation, partially met acceptance criteria, weakened invariants, architectural drift, later regressions, incorrect assumptions, integration failures, lifecycle/state-transition bugs, persistence/recovery defects, insufficient validation, incorrect failure handling, boundary failures, and realistic workflows that isolated tests miss.
6. Exercise meaningful adversarial scenarios: exact intent and decision preservation; contradictory or unsupported structured input; unanswered/high-impact ambiguity; safe and unsafe defaults; repeated/resumed/stale interviews; provider output failure and cancellation; full roadmap generation before execution; malformed/duplicate identifiers, missing dependencies and cycles; phase-level ordering versus task ordering; absent acceptance evidence; mutation classification and approval bypasses; stale approvals/revisions; active/completed work preservation; runtime/roadmap agreement; transactional rollback; durable outcomes with failed portable sync; restart after partial operations; project isolation; and repeated operations. Construct bounded deterministic fixtures rather than using paid agents for routine tests.
7. Classify each finding as confirmed or speculative. A confirmed defect requires a concrete violated requirement and an actual code path/reproduction. Record severity, affected guarantee, cause, and resolution. Do not present concerns as proven defects or dismiss a proven defect because current tests pass.
8. Fix every confirmed defect within Phase 4's intended requirements, including minimal prerequisite/integration repairs needed to restore its guarantees. Preserve user work and intended later behavior. Add or strengthen practical regression coverage for each confirmed defect; prove failures before fixes where feasible. Update architecture/contracts/documentation when behavior requires it.
9. Run the relevant unit, persistence/migration, integration, regression, and acceptance checks after fixes, followed by the repository-wide deterministic build/type/lint/test gate. Report exact commands, outcomes, skips and limitations. Do not weaken tests to obtain PASS. Reinspect affected code paths after validation and demonstrate why the underlying guarantee is restored, including adjacent branches and failure cases. Conduct the final review here from the sealed requirements; no separate external model session is needed.
10. Write a self-contained audit report with reviewed scope and architecture, recovered requirements and traceability, every confirmed finding and resolution, speculative concerns/uncertainties, exact validation evidence and unverified assumptions, and one final gate. Do not claim live provider evidence from fixtures.

## Release gate and synchronization

The report must contain exactly one of these gate lines:

PASS — Cleared for release.

Use PASS only if available evidence supports that the phase's requirements, acceptance criteria, invariants, architecture, lifecycle, and intended observable behavior remain correctly implemented in the current repository, with no confirmed release-blocking defect remaining.

FAIL — Issues remain; deeper fixes are required.

Use FAIL if a confirmed issue remains unresolved, required behavior cannot be demonstrated with sufficient confidence, or validation is materially incomplete. Explain what prevents release and preserve unfinished work.

Only after PASS, selectively commit the audited changes and evidence using a `densa-ade:` message and push normally to private `origin/main`, as explicitly authorized by the user. Verify the actual candidate snapshot, remote SHA, and ahead/behind. Stop on history divergence without rewriting it; report synchronization failures separately from local validation. Do not create or move an old phase-completion tag.

## Conditional subsequent Core integration audit

The user also requested a whole-Core integration audit only after Phases 1–9 have individually passed current-state audits. Verify that prerequisite using actual audit evidence; never infer it from milestone completion tags. Do not start the other phase audits as implicit scope expansion. If the prerequisite is not established, report the integration audit as deferred.

Once that prerequisite is established, first construct a separate fresh, self-contained Core integration audit prompt, then immediately execute it. Reconstruct current Core architecture as one system, not another phase-by-phase checklist. Inspect cross-phase assumptions, incompatible invariants, duplicate truth, transitions, lifecycle ordering, persistence, restart/recovery, interrupted writes, failure propagation/masking, stale state, cleanup, dependency ordering, initialization/shutdown, and race-sensitive composition. Construct realistic end-to-end cross-component scenarios, inspect exercised implementation paths, classify and fix every confirmed integration finding, add practical integration regressions, rerun all relevant Core validation and acceptance suites, and re-evaluate affected invariants. Its final report must include architecture and trust/state boundaries, scenarios, findings/resolutions, uncertainties, validation and the same exact PASS/FAIL gate semantics. Commit and push to main only on that integration audit's own PASS.
