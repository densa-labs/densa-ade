# Phase 8 Current-State Release Audit

Date: 2026-09-01

Branch: `main`

Audit basis: current repository state, including integrations added after the original Phase 8
milestones

## Sealed audit prompt

The audit prompt was fully constructed before implementation inspection or remediation began. It is
stored in `docs/phase-8-current-state-audit-prompt.md`, contains 162 lines, and has SHA-256
`74a0839f916dfcb00ac45cf6afd2f7e0d6cb1af79452cc41f9cd6bf28598290a`. It remained unchanged
through the audit.

## Original requirements recovered

The Phase 8 requirements and acceptance contracts were recovered from `MASTER_ROADMAP.md` and
traced through the current Core implementation:

| Milestone | Original guarantee                                                                                                                                                                                                                                  | Current implementation and evidence                                                                                                                                                                                                            |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P8M0      | A distinct, read-only Master role receives authoritative project context, returns structured proposals with citations, and can mutate only through validated Core commands. Worker execution remains independent.                                   | `MasterAgentService`, `AgentAdapterMasterAgent`, `DatabaseMasterProjectContextReader`, and `ValidatedMasterCoreCommandGateway`; exercised by `scripts/master-agent.test.mjs`.                                                                  |
| P8M1      | Decisions and constraints are durable, scoped, auditable, conflict-aware, portable, and included in future task packets without exposing secrets.                                                                                                   | `ProjectDecisionService`, SQLite decision/event repositories, `DECISIONS.md` synchronization, and `TaskPacketBuilder`; exercised by `scripts/master-agent.test.mjs` and `scripts/task-packet.test.mjs`.                                        |
| P8M2      | Master-led roadmap changes preserve the user-approved goal and promises, classify impact, bind approvals to an exact inspected revision, apply atomically at safe boundaries, persist revision history/events, and regenerate the portable roadmap. | `MasterRoadmapRevisionWorkflow`, `RoadmapMutationService`, approval-bound decision records, revision/proposal repositories, and scheduler/task-packet consumers; exercised by roadmap workflow, mutation, scheduler, and orchestration suites. |
| P8M3      | Project, phase, task, failure, and usage rundowns are concise, authoritative, bounded, drillable, and honest about unavailable facts; phase completion reconciles DB, validator, and Git evidence.                                                  | `ProjectRundownService`, `LocalGitRundownReader`, protocol rundown schemas, and Core-owned Master response rendering; exercised by `scripts/rundown.test.mjs` and `scripts/master-agent.test.mjs`.                                             |

The review also traced Phase 8 through current persistence migrations, permission policy, execution
control/modes, scheduling, task packets, phase execution, portable synchronization, daemon/Core v1
contracts, recovery ownership, and later Phase 9 stress/proof coverage. Passing historical tests and
phase tags were treated as evidence, not proof.

## Architecture and trust boundaries reviewed

- The conversational Master is a replaceable, read-only agent. It receives a bounded, redacted
  snapshot and produces one schema-validated proposal.
- Core validates citations and converts only supported proposal actions into typed commands. The
  gateway invokes the same authoritative domain services used by non-conversational clients.
- SQLite remains authoritative for projects, roadmaps, decisions, constraints, proposals, revisions,
  lifecycle state, validation, attempts, and append-only events. Portable Markdown is a derived,
  inspectable projection whose synchronization outcome is explicit.
- Roadmap approval is bound to an exact proposal, base revision, before/after snapshot, operation
  list, classification, and durable approval decision. Active task context defers application to a
  safe boundary.
- Rundown facts are reconstructed from current Core state, validation evidence, and Git inspection;
  conversational prose is not a source of truth.

## Confirmed findings and resolutions

1. **Master factual explanations were not guaranteed to use authoritative rundown facts.** The
   rundown service existed, but `MasterAgentService` returned model-authored response text for
   project status, phase status, and failure summaries. A model could therefore invent counts while
   still citing valid IDs. The service now renders these intents from a Core-generated rundown and
   renders command outcomes deterministically. The database context reader now includes the current
   specification and canonical roadmap, so the Master receives the project intent it is expected to
   preserve. A regression proves a fake Master claiming 999 tasks and validations cannot alter the
   returned facts.

2. **The model-neutral Master boundary did not consistently enforce redaction or aggregate bounds.**
   A custom `MasterConversationAgent` could receive raw persisted context and user text; only the
   adapter-specific prompt path had a redaction boundary. Context and provider response sizes were
   also not bounded end to end, and provider error messages could escape unredacted. The coordinator
   now redacts the full structured context and message before every Master implementation, rejects
   context above 1 MiB before provider execution, retains the 64 KiB message limit, bounds structured
   provider output at 256 KiB, and redacts provider failure text. Regressions verify both fail-closed
   sizing and removal of credential-shaped input before a custom agent sees it.

3. **Roadmap approval resolution was not idempotent and could fabricate approval evidence.** Repeated
   approval of an already applied proposal created another durable user decision. Approving an
   approval-free proposal also created a decision that did not correspond to a required user gate.
   The gateway now reuses terminal or already-bound proposal state and applies approval-free
   proposals without manufacturing approval. Regressions prove repeated resolution leaves exactly
   one approval record and a safe-boundary, approval-free proposal leaves none.

4. **A stale roadmap proposal was not terminal under rejection.** Application treated `stale` as
   terminal, but rejection could rewrite it as `rejected`, obscuring the reason it was no longer
   applicable. Rejection now returns `STALE` without changing the proposal or appending misleading
   state.

5. **Committed Phase 8 mutations could leave portable state stale with no idempotent repair path.** A
   decision could commit while `DECISIONS.md` failed, after which the duplicate retry returned
   `UNCHANGED` without regenerating the file. An applied roadmap proposal had the same problem for
   `ROADMAP.md`. Unchanged decision retries and applied-proposal retries now resynchronize their
   portable projections, report the synchronization outcome, and do not replay authoritative
   decisions, revisions, or events. Regressions force projection failure, repair the filesystem, and
   prove a retry restores the portable record while authoritative counts remain unchanged.

6. **Phase 8 file and Git operations accepted a caller-substituted workspace after execution
   ownership existed.** Decision projection, roadmap preview/apply/resynchronization, and rundown Git
   inspection trusted any absolute caller path. A shared project-workspace guard now binds these
   operations to persisted source/run ownership or persisted execution/usage control configuration
   and fails with `WORKSPACE_CONFLICT` on substitution. A regression proves the mismatch is rejected
   before mutation.

7. **Replacing one constraint could create a contradictory active set by widening its scope over
   another constraint.** Explicit supersession excluded the selected record but did not reject a
   second overlapping active constraint in the same category. Conflict detection now evaluates every
   other active same-category record when a replacement is requested. A regression widens one of two
   phase constraints to project scope and proves the operation blocks without superseding either
   original.

8. **Task-scoped rundowns included unrelated phase, decision, and revision facts.** Counts and
   drill-down references could therefore imply work outside the requested task scope. Task scope now
   includes only its owning phase, filters decisions and revisions by applicability, and enforces a
   10,000-record aggregate bound before rendering. A regression proves unrelated phase/task
   decisions and counts are excluded.

All confirmed findings are resolved. No speculative concern was represented as a defect.

## Validation and post-validation reinspection

- The strengthened Phase 8 and persistence/protocol suite passed: 58 tests, 58 passed, 0 failed.
- `npm run check` passed Prettier verification, build, TypeScript checking, ESLint with zero warnings,
  pretest compilation, and the complete repository test corpus: 443 tests, 440 passed, 3 skipped,
  0 failed, exit code 0.
- The three skips are the documented opt-in live Codex interview, worker smoke, and task-proof checks.
  Deterministic adapters and fixtures cover the Phase 8 structured contracts without consuming a
  paid provider.
- The first sandboxed full run was not used as release evidence: test-only loopback and Unix-socket
  listeners were denied with `EPERM`. The same browser and daemon cases passed in the authorized
  rerun, establishing that the failures were environmental restrictions rather than product
  regressions.
- Candidate-diff formatting and whitespace checks passed. After validation, the changed Master,
  decision, roadmap workflow, portable recovery, workspace ownership, rundown, and task-packet paths
  were reinspected against the guarantees above; the fixes operate at the trust/state boundaries and
  do not merely special-case the regression fixtures.

## Remaining uncertainty

- The normal release gate does not invoke a live paid/authenticated Codex account. Phase 8 correctness
  relies on schema validation, deterministic fakes, Core-owned factual rendering, and provider-neutral
  boundaries rather than trusting live-provider prose.
- Before a project has persisted run ownership or execution/usage control state, the current schema
  has no independent project-root field against which an initial absolute workspace can be compared.
  Once any current ownership binding exists, Phase 8 rejects substitution. Establishing a canonical
  root at project initialization belongs to the still-unaudited Phase 9/Core v1 initialization path;
  it is recorded here as a cross-phase uncertainty, not evidence that a recovered Phase 8 acceptance
  criterion remains broken.
- Node reports its built-in SQLite API as experimental. Current schema migrations, transactions,
  restart behavior, foreign keys, and Phase 8 repositories are covered by the green persistence and
  full regression suites.

## Densa Core integration-audit prerequisite

The whole-Core integration audit was not started. Current-state PASS reports now exist for Phases
1-8, but the repository still has no equivalent Phase 9 current-state audit report. Historical Phase
9 completion, its tag, and its passing tests do not satisfy the explicit prerequisite. A fresh,
self-contained whole-Core integration prompt must be constructed and executed only after Phase 9
individually passes its current-state audit.

## Final gate

PASS — Cleared for release.
