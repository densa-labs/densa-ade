# Master roadmap generation

Phase 4 Milestone 2 turns a sufficiently resolved `ProjectSpecification` into Densa ADE's complete
initial Master Roadmap. The version 1 roadmap contract is editor- and model-neutral. Densa ADE Core,
not the Master agent, owns readiness checks, structural validation, rendering, and scheduling.

## Readiness and agent boundary

`MasterRoadmapGenerator` rejects planning before invoking an agent when the specification still has
a high-impact question, a medium-impact question without an explicit safe default, or a structural
contradiction. Low-impact questions and medium-impact questions with explicit safe defaults can be
carried into planning under the P4M1 stop condition.

The model-neutral `MasterRoadmapAgent` returns a proposal. `AgentAdapterMasterRoadmapAgent` supplies
the strict response schema to an `AgentAdapter`, requires exactly one terminal event and one bare
JSON document, and preserves stable adapter failure classifications. Core parses the proposal
again, rejects unknown fields and unsupported versions, and requires its `projectGoal` to equal the
specification goal byte-for-byte. A model cannot silently rewrite the project's purpose.

The provider response schema explicitly requires every declared object property, including an empty
`supersededByTaskIds` array for initial tasks. The persisted version 1 schema continues to accept
older tasks without that optional field. Initial authoritative persistence repeats the readiness
check and atomically materializes the runtime graph, so direct persistence cannot bypass a blocking
question checked by the generator.

## Version 1 roadmap contract

A `MasterRoadmap` contains ordered phases for the full intended project arc. Every phase has a
stable ID, title, goal, required/optional classification, explicit phase completion criteria, and
tasks. Every task has:

- a stable globally unique ID;
- a clear goal and executable/non-executable classification;
- dependency task IDs;
- concrete acceptance criteria;
- a `low`, `medium`, `high`, or `critical` risk level;
- expected deterministic or review validator categories.

Executable tasks must include at least one acceptance criterion and one validator category. The
strict schema also rejects duplicate phase/task IDs, repeated dependencies, dependencies that do
not name a roadmap task, dependency cycles, and required phases without tasks or completion
criteria. Optional phases with executable work also require completion criteria. Executable tasks
cannot depend on non-executable tasks or on tasks in later phases: the current serial phase
lifecycle cannot satisfy those dependencies before finishing the active phase.
Errors identify the affected task, dependency, or phase so a proposal can be corrected
without guessing.

Task dependencies can cross from a later phase to an earlier phase. Phase order governs lifecycle
progression; task array order alone is not sufficient scheduling authority.
`topologicallyScheduleRoadmap()` validates the complete graph and returns a
deterministic topological order, using roadmap order only to break ties between ready tasks. Phase
5's persisted scheduler can consume this dependency-aware structure without trusting model prose.

## `ROADMAP.md`

`renderMasterRoadmapMarkdown()` creates a deterministic, human-readable view with project goal,
phase goals and completion criteria, task risks, dependencies, validators, and acceptance criteria.
A marked canonical JSON block preserves the full versioned graph. `parseMasterRoadmapMarkdown()`
round-trips only renderer-produced documents and reruns strict schema and cycle validation.

The structured roadmap remains the authoritative Core value. `ROADMAP.md` is its portable,
inspectable representation; parsing the file does not itself authorize a lifecycle mutation.
Persisted roadmap evolution is handled by the audited mutation boundary described in
[audited-roadmap-mutations.md](./audited-roadmap-mutations.md).

Runtime phase/task IDs are global SQLite keys. Use project-qualified stable IDs for multiple
projects. A collision with another project's IDs produces an actionable error and rolls back the
entire initial write; Core never adopts another project's runtime rows or silently renames a plan.
Legacy graphs that violate the strengthened execution constraints fail closed and must be corrected
before use; historical migration checksums and stored audit events are unchanged.

## Verification

`scripts/master-roadmap.test.mjs` uses `FakeAgentAdapter` to prove constrained model output is
strictly parsed, invalid graphs produce actionable failures, Markdown round-trips, readiness gates
run before the agent, exact project intent is preserved, and a multi-phase sample project can be
topologically scheduled. Routine tests do not invoke a live paid agent.
