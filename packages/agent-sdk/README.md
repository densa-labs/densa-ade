# Agent SDK

`@densa-ade/agent-sdk` owns the editor-independent, provider-neutral `AgentAdapter` boundary. Densa ADE
Core consumes `AgentEvent` values and stable Densa ADE error codes; it does not inspect Codex JSONL,
stderr wording, or process details.

The initial `CodexAdapter` uses the Phase 1 spike's version-scoped `codex exec --json` contract. It
passes prompts over stdin, runs in an explicit working directory, keeps only bounded diagnostics,
redacts credential-shaped text, and emits one Densa ADE-owned terminal event after the process exits.
Adapter-initiated cancellation signals the process group and escalates after a bounded grace period
so descendant tool processes do not survive the run. The tested exec template includes
`--skip-git-repo-check` because Densa ADE owns workspace/checkpoint validation and adapter smoke tests
must also work in isolated non-Git temporary directories. Authentication status is classified only
for the fixture-backed CLI version; unverified versions return `unknown`.

The Codex child and its status/version probes inherit only an explicit non-secret environment
allowlist (`PATH`, authentication-location paths such as `HOME`/`CODEX_HOME`, locale, temporary
directory, terminal, and certificate-location variables). Arbitrary parent variables, credential
variables, agent sockets, and process-injection options do not cross the adapter boundary. Streamed
events are individually bounded and the in-memory event queue has a fixed limit; slow consumers
receive an explicit truncated diagnostic if nonterminal events must be dropped, while the terminal
event remains authoritative and retained.

Diagnostic redaction frames whole lines and private-key/explicit-secret blocks, including when
credentials span input chunks. If an oversized line makes framing unsafe, the remaining diagnostic
stream is omitted with an explicit truncation notice. This is defense in depth, not a general secret
discovery system: callers must still avoid injecting secrets or requesting credential disclosure.

Cancellation also covers startup/version/authentication probes, so cancelling before worker launch
cannot start a worker later. Normal process exit cleans up remaining process-group descendants,
including children retaining stdout/stderr pipes. Cleanup is idempotent across lifecycle callbacks;
an already-terminated process-group identity is never signalled again. Success requires an unambiguous structured terminal
signal and exit code zero; malformed or contradictory lifecycle data cannot certify success. The
terminal `finalMessage` is the latest completed agent message, not a concatenation of intermediate
commentary. Each new execution resets prior usage availability until fresh evidence is obtained.

An `AgentRunRequest` may include a provider-neutral JSON Schema for its final response. The Codex
adapter materializes that schema in a user-only temporary file, passes it through the version-scoped
`--output-schema` flag, and removes the file after success, failure, cancellation, or early consumer
termination. Callers still validate the returned data at their own domain boundary; constrained
generation is not treated as proof that a response is safe or semantically correct.

Routine tests use `FakeAgentAdapter` from `@densa-ade/testing` and local fake executables. A real,
authenticated Codex smoke test is deliberately opt-in:

```sh
npm run test:live:codex
```

The installed CLI exposes no standalone supported subscription usage/reset endpoint. P7M0 therefore
keeps usage `unknown` until an execution supplies the exact machine-readable
`codex_error_info: "usage_limit_exceeded"` discriminator. That signal maps to provider-neutral
`USAGE_LIMITED`; an optional structured `reset_at` Unix timestamp is converted to `resetAt`, while
missing or invalid reset data is omitted. Authentication and arbitrary provider failures remain
distinct, and message/stderr prose never changes usage state.
