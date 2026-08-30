# Adaptive interview planning

Phase 4 Milestone 1 implements the Master-role interview as a validated proposal flow. The Master
agent analyzes the supplied idea and answer batches through `MasterInterviewAgent`; it does not own
the specification or decide that planning may begin. `AgentAdapterMasterInterviewAgent` lets the
same model-neutral flow use `FakeAgentAdapter` in deterministic tests and `CodexAdapter` in an
explicitly enabled live smoke test.

## Trust boundary

The agent returns one strict version 1 JSON proposal containing sourced specification additions and
adaptive questions. Core supplies the provider-neutral response schema through `AgentAdapter`; the
Codex adapter materializes it for the installed CLI's `--output-schema` contract and removes the
temporary schema after the run. Densa ADE Core still rejects malformed data, duplicate question IDs,
and additions that are not exact substrings of the initial idea or a named answer. Initial
project-goal text is preserved verbatim. Later answer batches are appended verbatim as explicit
user decisions, and only additive sourced facts may update the specification; the agent cannot
delete or rewrite an existing constraint.

Unanswered questions also remain Core-owned. A new agent proposal may add follow-up questions, but
it cannot replace, resolve, or silently drop an existing question. Only an exact answer to the
current highest-priority batch resolves its questions.

## Ranking, batching, and stop condition

Core ranks by impact first and then puts architecture, security/privacy, data/storage, and
integration questions ahead of cosmetic UX questions at the same impact. The agent supplies a
`batchKey` so closely related questions are shown together; Core orders the batches from the ranked
questions rather than using a fixed questionnaire.

Roadmap planning is permitted only when:

- no high-impact question remains;
- every remaining medium-impact question has an explicit proposed default marked safe to use
  without an answer;
- no structural specification contradiction remains.

Low-impact questions do not block planning. A high-impact question may show a conservative proposed
default, but schema validation forbids treating that default as an answer. This keeps critical
ambiguity from producing an optimistic READY signal.

Every interview snapshot includes freshly rendered `SPEC.md` content. After an answer batch it
contains the new exact decisions, sourced structured facts, retained/open questions, defaults, and
readiness evidence. The existing persistence and portable-project layers remain responsible for
storing the structured specification in SQLite and synchronizing the returned rendering to
`.densa-ade/SPEC.md`. The structured specification also retains each open question's batch key, so
`resume()` can reconstruct ordering, related-question batches, defaults, and readiness after Core
restart. A caller must persist each returned snapshot before presenting the next batch; raw Master
transcripts are not required for recovery.

## Verification

`scripts/adaptive-interview.test.mjs` uses fake adapters to cover idea-dependent question sets,
risk ordering, related-question batches, defaults, critical blockers, exact answer ingestion,
question retention, and fail-closed source validation. The optional Codex boundary can be exercised
with `npm run test:live:interview`; routine checks do not consume a live agent.
