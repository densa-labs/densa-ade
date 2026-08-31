# Phase 2 current-state release audit prompt

Audit Densa ADE Phase 2 — Authoritative State, SQLite, Events, and Recovery Primitives — in `/Users/ivanuy/Desktop/Projects/active-projects/densa-ade`. Execute this prompt in the current task after constructing it completely. Do not launch another task or an external model review. Evaluate the actual working tree, including intentional later integrations and existing uncommitted work; the original phase completion commit or tag is historical evidence, not the audit target.

## Recover the contract before judging implementation

Read the applicable `AGENTS.md`, Phase 2 milestones P2M0–P2M4 and Gate B in `MASTER_ROADMAP.md`, architecture documentation, original milestone history, and relevant prerequisite/later milestone contracts. Recover the original requirements, acceptance criteria, invariants, architectural intent, lifecycle expectations, failure semantics, and intended externally observable behavior. Explain intentional contract evolution, including the `.densa` to `.densa-ade` namespace migration, without silently weakening requirements.

Build an explicit requirement-to-current-code-and-evidence map covering:

- P2M0: canonical project/phase/task states, centralized validated transitions, illegal transitions, immutable domain snapshots, terminal behavior, and atomic state/audit persistence.
- P2M1: authoritative editor-independent Core SQLite repositories, explicit checked migrations, relational integrity, durable records, transaction rollback, stale writes, restart persistence, and error classification.
- P2M2: versioned append-only events, ordered durable replay/filtering, subscription delivery after successful commit, nested transaction/reentrant behavior, bounded payloads, and replay visibility through current client interfaces.
- P2M3: deterministic portable project intent/configuration/roadmap/decisions/reports/logs, SQLite authority, safe atomic filesystem writes, conflict detection, user edits, partial writes/restarts, and secret exclusion.
- P2M4: read-only recovery inspection of interrupted attempts, process identity/liveness, Git checkpoints and workspace changes, conservative classification, safe recommendations, contradictory/missing evidence, and no automatic resume from insufficient evidence.

Expand this map for any additional requirement recovered from the original sources. Record source locations and current observable evidence, not only test names.

## Audit the current guarantees

Trace every requirement through all relevant current code paths, integrations, configuration, persistence mechanisms, tests, and later-phase changes. Inspect scheduler/orchestrator, validation, Git/checkpoints/rollback, usage waiting and resume, roadmap/specification/decision mutations, Core daemon/protocol/CLI, and headless recovery workflows where they depend on or alter Phase 2 guarantees. Follow callers and mutation entry points; do not stop at the original Phase 2 modules.

Look beyond existing tests. Passing tests are evidence, not proof. Actively search for missing/incomplete implementation, partially satisfied acceptance criteria, weakened or violated invariants, architectural drift, later regressions, incorrect assumptions, integration failures, lifecycle/state-transition bugs, persistence/recovery problems, weak or missing validation, incorrect failure handling, boundary conditions, meaningful edge cases, and realistic workflows that fail despite isolated tests passing.

Inspect crash windows, rollback/savepoint behavior, migration failure, malformed records and events, concurrent/stale state, ordering, unknown/future versions, filesystem conflicts/symlinks, checkpoint identity, process reuse, missing or contradictory lifecycle evidence, and the distinction between process completion and validated task completion. Verify that failures preserve authoritative state and user work and remain visible through stable errors or conservative recovery results.

## Fix and validate

Distinguish confirmed defects from speculative concerns. Confirm findings with a concrete reachable path, reproduction, or regression test and explain the violated requirement. Fix every confirmed defect within Phase 2's intended requirements, including defects in later integrations that break those guarantees. Preserve intentional later-phase behavior unless it conflicts with a required invariant or acceptance criterion. Do not broaden scope, start another milestone, weaken tests, rewrite history/tags, or commit/push unrelated existing changes.

Add or strengthen meaningful regression tests wherever practical for every confirmed defect. Run the relevant unit, integration, regression, and acceptance checks after fixes, including the repository-wide `npm run check` and current headless persistence/recovery integration coverage. Use deterministic fixtures and temporary workspaces; do not invoke live paid agents. Record exact commands and results. If sandbox restrictions prevent socket/process tests, seek the narrow authorized execution capability rather than treating environment failures as product defects or silently skipping required validation.

Reinspect affected implementations and callers after validation: establish that each fix restores the underlying guarantee, rather than merely satisfying its test. Preserve all pre-existing uncommitted work. Update architecture documentation when an invariant or contract needs clarification. Do not mark Phase 2 complete merely because its historical tag exists.

## Deliverable and release gate

Write a reviewable audit report recording the audited repository revision and working-tree context, recovered requirement map, concise review scope, every confirmed finding and its resolution, speculative concerns separately, remaining uncertainty or unverified assumptions, and validation commands/results. Report material validation gaps honestly. The final response must include a concise summary of these points and exactly one of the following gate statements:

PASS — Cleared for release.

Use PASS only if the available evidence supports that Phase 2's requirements, acceptance criteria, invariants, architecture, and intended behavior remain correctly implemented in the current codebase and no confirmed release-blocking issue remains.

FAIL — Issues remain; deeper fixes are required.

Use FAIL if any confirmed issue remains unresolved, required behavior cannot be demonstrated with sufficient confidence, or validation is incomplete in a way that materially affects release confidence.
