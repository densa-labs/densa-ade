# Codex CLI integration spike

Phase 1 Milestone 0 maps the locally installed official Codex CLI before Densa builds an
adapter around it. The observations below were recorded on 2026-08-25 on macOS arm64.

## Tested installation

- PATH resolution: `/opt/homebrew/bin/codex`
- Reported version: `codex-cli 0.147.0`
- Install channel reported by `codex doctor --json`: Homebrew cask
- Authentication probe: `codex login status`
- Auth mode during authenticated probes: ChatGPT login

The checked-in fixtures are versioned under
`packages/testing/fixtures/codex-cli/0.147.0/`. They are minimal sanitized excerpts, not complete
transcripts. Thread, item, request, network-trace, timestamp, user-path, and token-usage values are
replaced or omitted. No credentials or tokens are stored.

## Commands tested

The following commands were run locally. Prompts and temporary paths are represented literally;
runtime identifiers are sanitized only in the saved fixtures.

```sh
command -v codex
codex --version
codex --help
codex exec --help
codex login --help
codex login status
codex doctor --help
codex doctor --json
```

Non-interactive probes used an ephemeral session, ignored user config and exec-policy rules, used
a read-only sandbox, and disabled approvals:

```sh
codex --ask-for-approval never --sandbox read-only exec \
  --json --ephemeral --ignore-user-config --ignore-rules --color never \
  "Respond with exactly DENSA_CODEX_SPIKE_OK and do not use tools."

codex --ask-for-approval never --sandbox read-only exec \
  --json --ephemeral --ignore-user-config --ignore-rules --color never \
  --model densa-invalid-model-p1m0 \
  "Respond with exactly DENSA_SHOULD_NOT_RUN."

codex --ask-for-approval never --sandbox read-only exec \
  --json --ephemeral --ignore-user-config --ignore-rules --color never \
  "Run the shell command false exactly once. Do not retry it. Then respond with exactly DENSA_COMMAND_FAILURE_OBSERVED."
```

Authentication-required behavior was tested without modifying the user's credentials by setting
`CODEX_HOME` to an empty temporary directory. `codex login status` returned exit code `1` and
`Not logged in`. An `exec --json` probe then ended with an HTTP 401 error event and `turn.failed`,
also with exit code `1`.

Cancellation was tested by starting a run whose tool command was `sleep 120`, waiting until its
`command_execution` item reported `in_progress`, and sending SIGINT from the parent terminal. The
CLI exited promptly with code `1`; the child sleep process was no longer present. No structured
terminal JSON event was observed before exit.

## Observed contract

| Scenario                       |                     Process exit | JSONL signal                                                                                     | Important interpretation                                                                      |
| ------------------------------ | -------------------------------: | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Success                        |                              `0` | `thread.started`, `turn.started`, `item.*`, `turn.completed`                                     | Require both clean process exit and a completed turn.                                         |
| Agent tool command fails       | `0` in the observed handled case | `command_execution` item has `status: "failed"` and nonzero `exit_code`; turn may still complete | A failed command item is evidence, not necessarily a failed Codex process.                    |
| Unsupported model              |                              `1` | `error`, then `turn.failed`                                                                      | Structured terminal failure is available.                                                     |
| Authentication missing         |                              `1` | terminal 401 `error`, then `turn.failed`                                                         | Prefer the cheaper `codex login status` probe before execution.                               |
| Invalid CLI argument placement |                              `2` | presentation-text usage error, no JSONL stream                                                   | Treat as adapter/configuration error, not model failure.                                      |
| Parent SIGINT                  |                              `1` | no terminal JSON event observed                                                                  | The adapter must synthesize its own cancelled terminal event after it initiated cancellation. |

Global flags are position-sensitive in this installed version. In particular,
`codex exec --ask-for-approval never ...` was rejected with exit code `2`, while
`codex --ask-for-approval never ... exec ...` worked. Densa must construct arguments from a tested
template instead of assuming every global option can follow the subcommand.

### Supported non-interactive mechanism

`codex exec` is the best supported process boundary. `--json` changes stdout to a JSON Lines event
stream, while diagnostics remain on stderr. `--ephemeral` avoids persisting the exec session,
`--cd`/`-C` supplies the workspace, and `--output-last-message` can capture final prose when needed.
Prompts can be passed as an argument or read from stdin by using `-`; stdin is preferable for a
future adapter because it avoids argument-length and quoting problems.

The official references corroborating these supported surfaces are:

- [Developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
- [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)

### Stable signals to rely on

- PATH lookup plus `codex --version` for detection and version capture.
- `codex login status`: exit `0` means credentials are present; exit `1` with the tested empty
  `CODEX_HOME` means not logged in.
- `codex exec --json` JSONL event `type` values and structured item payloads.
- `turn.completed` versus `turn.failed` as the run-level terminal event when one is emitted.
- Process exit code as an independent terminal signal.
- `command_execution.status` and its numeric `exit_code` for tool-command outcomes.

These signals are version-scoped to `0.147.0`. A future adapter must retain version detection and
fixtures so a changed CLI is not silently treated as compatible.

### Signals not safe to parse

- Human-readable stderr diagnostics, retry prose, warnings, and Rust module names.
- Exact error message wording, including nested JSON encoded inside a message string.
- Thread/item/request IDs, timestamps, Cloudflare trace IDs, and local paths.
- The authenticated `codex login status` sentence beyond its exit-code contract.
- Token counts as a success criterion or subscription-availability signal.
- `codex doctor --json` check inventory as a stable substitute for an adapter contract; it is useful
  diagnostics but includes machine-specific paths and its schema may evolve.

## Usage and reset status

No supported non-interactive command exposing ChatGPT Codex usage availability or a reset time was
found in `codex --help`, relevant subcommand help, `codex login status`, `codex doctor --json`, or
the successful exec event stream. `turn.completed.usage` reports tokens consumed by that turn; it
does not report remaining subscription usage or a reset timestamp.

Interactive `/status` may present account information to a user, but no supported machine-readable
equivalent was established by this spike. Densa must therefore report usage state as `unknown`
unless a future supported CLI version or an actual structured execution error supplies a reliable
limited/reset signal. It must not scrape interactive presentation text or invent a countdown.

## Unknowns and deliberately unforced cases

- A real account usage-limit exhaustion was not induced; doing so would consume or disrupt the
  user's account. The exact structured error for that condition remains unknown.
- Transient provider failures other than the tested unsupported-model 400 were not forced.
- SIGTERM and escalation to SIGKILL were not separately measured. SIGINT stopped this version and
  its active child command, but process-tree cleanup must be tested again in the adapter milestone.
- Compatibility of the JSONL schema across later Codex versions is not guaranteed.
- The warning stream contained local installation/configuration diagnostics even when the run
  succeeded, so warning-free stderr cannot be required for success.

## Recommended adapter strategy

1. Resolve `codex` from PATH and capture `codex --version`.
2. Run `codex login status` as the supported low-cost auth-presence probe; preserve `unknown` for
   unexpected output/exit combinations.
3. Spawn `codex` with global policy flags before `exec`, pass the task through stdin, set the target
   cwd explicitly, and request `--json --ephemeral`.
4. Parse stdout line-by-line as JSONL and keep stderr as bounded diagnostic text only.
5. Classify the run from structured terminal events plus process exit. Never infer completion from
   final agent prose, and never treat one failed command item as automatically equivalent to a
   failed turn.
6. On adapter-initiated cancellation, signal the process group, enforce a bounded grace period,
   escalate if required, and emit a Densa-owned cancelled terminal event because the CLI may exit
   without one.
7. Return `unknown` for auth, usage, or failure categories when the version-scoped evidence is
   insufficient.

## Fallback strategy

If JSONL is unavailable or malformed for an unrecognized CLI version, Densa should fail closed for
automation: retain bounded stdout/stderr and the exit code, report a protocol/version mismatch or
unknown agent result, and require an adapter/fixture update. A quarantined presentation-text parser
may be added only if a later milestone supplies versioned fixtures and tests; it must never certify
task completion or usage availability. Experimental app-server or private agent interfaces are not
the fallback for v0.1.
