# Task packets

Phase 5 Milestone 1 adds the editor- and model-independent `TaskPacketBuilder` in Densa Core. A
task packet is focused worker context, not a transcript or project-history dump. The builder reads
the authoritative project, specification, roadmap, phase, task, dependency, decision, attempt, and
failed-attempt records through Core repositories. It never reads the event journal or Master
conversation history.

## Relevance and auditability

The orchestration/policy caller supplies explicit references to the global constraints and
architectural decisions relevant to the task. It may also supply workspace-relative file paths with
focused summaries; raw file contents are not accepted by this boundary. The builder rejects missing
references and stale roadmap/runtime mappings instead of guessing. Every included source is listed
in `contextSources` by kind and stable source identifier.

The packet always includes the roadmap project summary, current phase and exact task goals,
acceptance criteria, direct dependencies with their persisted state, the permission envelope, and a
scope guard forbidding unrelated changes. For a retry, it includes only the latest relevant prior
failed attempt's durable diagnostics. Earlier failures and unrelated attempts are omitted.

## Bounds and secret handling

Packets have deterministic ordering, hard entry/text limits, and an overall 192 KiB serialized
limit. `bounds` records the maximum, actual byte length, and whether any source was truncated.
Oversized input is clipped at Unicode boundaries; a packet that still cannot meet the overall limit
is rejected.

All included text passes through secret filtering. Explicit `<secret>...</secret>` and
`[secret:...]` markers, common token/key shapes, bearer values, credential assignments, private-key
blocks, and secret-bearing diagnostic object keys are redacted. File summaries marked `sensitive`
are omitted entirely. The same sanitized packet is used by `renderTaskPacketPrompt`, so rendering
cannot reintroduce unfiltered source data.

P5M1 does not schedule tasks, create attempts, invoke an agent, validate work, or implement retry
lifecycle transitions. Those side effects remain in later orchestrator milestones.
