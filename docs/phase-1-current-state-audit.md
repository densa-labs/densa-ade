# Phase 1 current-state audit

Audit completed 2026-08-31 against working-tree changes on `main`, based on
`0af532d127a5e964b9ad6d449ddeb9079ffad918`. This is a current-state audit, not a claim that the
historical Phase 1 tag contains these repairs. No commit, tag, or remote was changed.

The self-contained audit prompt was fully constructed before phase inspection and then executed
in the same turn. The original temporary artifact is preserved in
`docs/phase-1-current-state-audit-prompt.md` for this checkpoint.

## Recovered requirements and scope

The audit recovered P1M0, P1M1, and P1M2 from `MASTER_ROADMAP.md`, the engineering constitution,
the original commits (`8e0eca7`, `bf314e9`, `4b71f5c`), the subsequent Phase 1 hardening history,
and `densa-phase-1-complete` (commit `2386177`). Current source, fixtures, callers, and tests were
then traced through later changes, rather than treating the completion tag as present-day proof.

| Original guarantee                                                                                                                                                              | Current implementation and reviewed evidence                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1M0: empirically established official CLI contract, sanitized fixtures, honest unknowns and fallback                                                                           | Integration spike; fixture manifest and JSONL samples; fixture contract tests; installed CLI version/help/login probes; official non-interactive-mode documentation.                                                                                          |
| P1M1: replaceable provider-neutral worker, explicit cwd, structured streaming, bounded capture, classified failures, deterministic cancellation, process cleanup, secret safety | Agent SDK contracts, CodexAdapter, FakeAgentAdapter, local executable contract tests, output schema and environment handling, status probes, event consumers and early iterator termination.                                                                  |
| P1M2: one scoped task in a temporary Git repository, deterministic independent acceptance, inspected changes, retained diagnostics, lying/failing-worker rejection              | Task-proof harness, parent-owned acceptance fixture, Git/workspace snapshots, timeout and termination confirmation, private exclusive diagnostic writes, fake pass/fail/adversarial tests, opt-in live test.                                                  |
| Architecture and later integration: Core remains authoritative; workers cannot certify completion; Master and worker roles remain separate                                      | Interview and roadmap generation, Master and independent-review adapters, task/phase/project orchestration, task packets, usage waiting, SQLite/event persistence, checkpoint/rollback/recovery, CLI and frozen IPC clients, current end-to-end proof suites. |

The original “no SQLite/retry/IDE yet” milestone boundary remains respected by the standalone
temporary proof harness. It is not interpreted as a prohibition on the intentional later Core
persistence and orchestration layers. Provider parsing stays in the adapter; consumers continue to
validate domain responses and require independent acceptance before task completion.

## Confirmed findings and resolutions

All findings below were confirmed through source inspection and executable reproductions; all are
fixed. Regression tests were added or strengthened for each group.

1. **Unrestricted child environment.** Codex execution and version/auth probes inherited arbitrary
   parent credentials, agent sockets, and process-injection options. They now inherit an explicit
   non-secret allowlist. Official CLI authentication locations remain available; Densa ADE does
   not copy or manage the credentials themselves. The compiled adapter still detects the installed
   CLI and authenticated status using this environment.
2. **Unbounded queued events.** Individual output limits did not bound memory for a slow consumer.
   A fixed event-queue limit now drops excess nonterminal evidence with an explicit truncation
   diagnostic, reserves terminal capacity, and preserves the authoritative result.
3. **Incomplete redaction and text bounds.** Credential-shaped tokens, private keys, secret-bearing
   object keys, quoted/escaped values, split stderr, fallback progress fields, and large failure
   messages could leak or exceed bounds. Shared key-aware/text redaction now covers these paths;
   diagnostics retain line/block framing across chunks, and oversized diagnostic streams fail
   closed. Ordered delimiters handle same-line reopened blocks, multiline bracket markers, and
   unterminated explicit secrets. UTF-8 truncation stays within byte limits. Harness evidence
   uses the same redaction.
4. **Cancellation during startup.** A cancel request during detection/authentication could return
   without stopping startup, allowing a worker to launch afterward. Startup is now registered
   before asynchronous work, probes are abortable, schema preparation checks cancellation, and
   cancellation waits for startup settlement and yields one cancelled terminal result.
5. **Surviving process descendants.** Cleanup tied only to parent close missed children that
   outlived the parent or kept inherited output pipes open. Execution, probes, and proof validation
   now clean the owned process group on exit and close, as well as cancellation/timeout. Tests
   exercise normal exit, cancellation, ignored output, inherited pipes, and early consumer exit.
   Final validation also exposed duplicate cleanup signals returning macOS `EPERM` after
   termination. Successful/already-absent SIGKILL cleanup is now idempotent per child identity;
   subsequent signals cannot target a reaped/reused group. First-signal permission errors are
   not suppressed. An explicit duplicate-signal regression and the isolated failure both pass.
6. **Malformed or conflicting structured lifecycle evidence.** Invalid event/item envelopes and
   repeated/conflicting terminal signals could coexist with a successful result. Recognized
   envelopes are checked and terminal ambiguity fails closed; exit zero alone is insufficient.
7. **Intermediate prose corrupted final responses.** Every agent message was concatenated into
   the final response, breaking later strict JSON consumers. Intermediate messages still stream,
   while the terminal response contains only the latest completed agent message.
8. **Stale usage availability.** A previously successful run could leave usage marked available
   after a later malformed, cancelled, or preflight-failed execution. Each execution starts with
   unknown availability; only fresh reliable evidence changes it. Structured usage-limited
   semantics and honest unknown reset times remain intact.
9. **Planning roles inherited write access.** Later interview and roadmap generation requests
   used the adapter's workspace-write default despite their planning-only role. They now explicitly
   request read-only access, matching the existing Master/review boundary. Worker implementation
   access remains unchanged.
10. **Unsafe workspace/Git controls escaped the proof gate.** Git configuration/control changes,
    a symlinked Git directory, and special filesystem entries were not adequately inspected.
    The harness now snapshots Git control files, rejects unsafe roots/entries, and checks scope and
    integrity before running any post-worker Git or acceptance command. A malicious Git fsmonitor
    reproduction is rejected without executing its marker command. Volatile object/log/index
    data remains excluded from control comparisons; the original checkpoint stays authoritative.
11. **Exit zero could bypass acceptance.** Submitted code could terminate before same-process
    assertions, manufacturing a passing command. The fixture evaluates submitted code in a Worker
    and keeps assertions in the parent. Early exit without trusted results fails. A follow-up
    forged-Worker-message bypass is also fixed: results require a private per-run nonce and a
    prebound trusted sender. Forged messages fail; legitimate results still pass.
12. **Validation-time mutations escaped inspection.** The pre-validation snapshot alone missed
    changes made while loading submitted code. A second workspace/Git-control snapshot now rejects
    validation-time changes, even when the deterministic command exits successfully.

## Validation and post-fix reinspection

- Baseline Phase 1 fixture/adapter/proof suite: 37 passed before repairs.
- Final targeted command: `npm run pretest`, then Node tests for CLI spike, adapter, task proof,
  adaptive interview, and Master roadmap: **72 passed, zero failures or skips**.
- Final `npm run check`: **passed** formatting, build, typecheck, lint, and the complete routine
  suite: **335 tests, 332 passed, zero failed, three opt-in live tests skipped**.
- The complete suite includes real temporary Git repositories, SQLite migration/persistence,
  cancellation/recovery, CLI/Unix-socket authentication and reconnect, Playwright browser fixtures,
  task/phase validation, and later continuous-mode/restart workflows.
- The initial sandbox-wide attempt failed browser checks and stalled on local socket testing; only
  that audit run was stopped. An authorized rerun with required local process/socket access passed.
- Read-only installed CLI checks confirmed `/opt/homebrew/bin/codex`, version `0.147.0`, current
  help flags, and ChatGPT authentication presence. Compiled adapter detection/status checks passed
  after environment filtering. Authentication presence is not a claim of remaining usage quota.
- `git diff --check` passed. The four pre-existing user-modified files were preserved; the audit
  did not edit the root README, CLI services, CLI tests, or workspace-foundation tests.
- A fresh-context read-only review independently reproduced the lifecycle, redaction, structured
  event, workspace-integrity, and acceptance-oracle defects and verified their repairs. After
  validation, affected code and downstream consumers were reinspected for underlying guarantees,
  including final-message parsing, read-only planning, terminal retention, cancellation races,
  control-file gating, and the parent-owned assertion path.

The OpenAI Docs skill was used to cross-check the local CLI boundary against the official
[non-interactive-mode documentation](https://learn.chatgpt.com/docs/non-interactive-mode).
Local installed-version evidence and versioned fixtures remain the compatibility authority.

## Remaining uncertainty and limits

- No paid live agent was invoked during this audit. Live smoke, live fixture modification, and
  live interview tests remain explicitly opt-in. Their current remote-provider execution is not
  re-demonstrated; installed-version/auth checks, recorded empirical fixtures, and rebuilt local
  executable workflows support the scoped gate without claiming a new live run.
- Real usage exhaustion and remote transient failure cases were not induced. Usage fixtures that
  are synthetic remain labelled synthetic; unsupported versions/signals remain unknown or blocked.
- The fixture proof is deterministic evidence for its stated acceptance criteria, not exhaustive
  mathematical proof of arbitrary submitted code or a hostile-code security sandbox. The Worker
  isolates the assertion path, not the operating system. Process-group cleanup targets the macOS
  lifecycle; deliberately escaped sessions and other platforms are not certified by this audit.
- Redaction is defense in depth for known credential shapes and sensitive fields, not detection of
  every possible secret. Prompts/workspaces must still avoid unauthorized secret disclosure.
- No unresolved confirmed in-scope release-blocking finding remains. Broader platform certification,
  arbitrary-code containment, and paid provider revalidation were not silently added to Phase 1.

## Final gate

PASS — Cleared for release.
