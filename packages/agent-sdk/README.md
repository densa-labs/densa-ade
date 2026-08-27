# Agent SDK

`@densa/agent-sdk` owns the editor-independent, provider-neutral `AgentAdapter` boundary. Densa
Core consumes `AgentEvent` values and stable Densa error codes; it does not inspect Codex JSONL,
stderr wording, or process details.

The initial `CodexAdapter` uses the Phase 1 spike's version-scoped `codex exec --json` contract. It
passes prompts over stdin, runs in an explicit working directory, keeps only bounded diagnostics,
redacts credential-shaped text, and emits one Densa-owned terminal event after the process exits.
Adapter-initiated cancellation signals the process group and escalates after a bounded grace period
so descendant tool processes do not survive the run. The tested exec template includes
`--skip-git-repo-check` because Densa owns workspace/checkpoint validation and adapter smoke tests
must also work in isolated non-Git temporary directories. Authentication status is classified only
for the fixture-backed CLI version; unverified versions return `unknown`.

An `AgentRunRequest` may include a provider-neutral JSON Schema for its final response. The Codex
adapter materializes that schema in a user-only temporary file, passes it through the version-scoped
`--output-schema` flag, and removes the file after success, failure, cancellation, or early consumer
termination. Callers still validate the returned data at their own domain boundary; constrained
generation is not treated as proof that a response is safe or semantically correct.

Routine tests use `FakeAgentAdapter` from `@densa/testing` and local fake executables. A real,
authenticated Codex smoke test is deliberately opt-in:

```sh
npm run test:live:codex
```

The installed CLI exposes no supported machine-readable subscription usage/reset endpoint, so the
adapter returns `unknown` rather than deriving availability from presentation text.
