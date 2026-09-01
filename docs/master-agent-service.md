# Master Agent service boundary

`MasterAgentService` is the project-level coordinator boundary. It is deliberately separate from
worker execution and cannot edit a workspace or authoritative records directly.

For each turn, Core reads a same-project snapshot containing the current specification and roadmap
plus project, phase, task, decision, roadmap-revision, and recent event records. Recent history,
the complete serialized context, provider prompt, provider result, and user message are bounded.
Credential-shaped content is redacted at the service boundary before any model-neutral Master
implementation sees the message or snapshot, and provider failures are redacted before surfacing.
`AgentAdapterMasterAgent` executes the turn with read-only workspace access and a Master-specific
logical session/run ID. The final response must satisfy the strict `MasterAgentProposal` protocol
schema.

The service validates every cited project, phase, task, decision, event, and roadmap-revision ID
against the same authoritative project snapshot. Unknown citations fail closed before command
execution.

Structured actions are translated into `MasterCoreCommand` values and sent through
`MasterCoreCommandGateway`. The production gateway delegates to the existing authoritative domain
services:

- roadmap proposals go through `RoadmapMutationService`, including permission policy and audit
  persistence;
- pause and resume requests go through `ProjectExecutionControlService` and centralized state
  transitions;
- execution-mode requests go through `ExecutionModeService` and its atomic event persistence.

Project-constraint actions pass through `ProjectDecisionService`. Adds, replacements, and removals
become durable, audited records and regenerate `.densa-ade/DECISIONS.md`; overlapping contradictory
constraints return a blocked user-decision flow. The Master still receives no repository or state
mutation API and cannot bypass this Core validation boundary.

Worker orchestration has no dependency on `MasterAgentService`, a Master session, or a Master
conversation transcript. Master responses are coordination input, not completion evidence, and the
validation pipeline remains the only authority that can certify worker results.

Project-status, current-phase, blocked/usage-wait, and failure-summary answers do not trust prose
or numeric values supplied by the Master. `MasterAgentService` obtains a current
`ProjectRundownService` snapshot and returns Core-rendered facts. Decision explanations are likewise
rendered from the exact cited persisted records. Mutation/control answers report the actual Core
command outcome rather than an agent prediction. Once execution ownership exists, Phase 8 portable
writes and Git-backed rundowns must use the persisted source workspace; substituted paths fail with
`WORKSPACE_CONFLICT`.
