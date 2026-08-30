# P9M0 headless one-phase proof postmortem

Date: 2026-08-30

Status: passed. Both the deterministic composition proof and the real `CodexAdapter` proof reach
the independently validated phase boundary and persist `AWAITING_APPROVAL` across restart.

## Experiment

The new `densa-ade proof phase-one` command creates a disposable Git project with a deliberately failing
`normalizeName` fixture. Densa ADE Core records a complete structured specification and one-phase
roadmap, selects phase-by-phase mode, writes the portable `.densa-ade/` projection, and commits the
fixture baseline. It then closes and reopens the SQLite database before execution.

After restart, the normal serial lifecycle creates the owned run branch and task checkpoint, runs
the implementation adapter, validates with `node --test`, creates the task commit, runs the full
phase test plus a fresh read-only independent review, writes the phase report, and should stop at
`AWAITING_APPROVAL`. The proof closes and reopens SQLite a second time before checking the final
state, report, event journal, and Git history.

## Evidence collected

- Deterministic end-to-end proof: passed. A controlled adapter changed only
  `src/normalize-name.js`; Core independently ran the tests, created the task commit, persisted the
  phase review and report, survived two database reopen cycles, and stopped at
  `AWAITING_APPROVAL`.
- Restricted live run artifact:
  `/var/folders/46/_x1cjbss6kd5mkcdvkg00m940000gn/T/densa-p9m0-FfPjFP`. The nested Codex process
  produced no valid terminal JSONL in the sandbox. Core classified the outcome as
  `PROTOCOL_VERSION_MISMATCH`, restored the clean checkpoint, created no task commit, and blocked
  the phase.
- Elevated live run artifact:
  `/var/folders/46/_x1cjbss6kd5mkcdvkg00m940000gn/T/densa-p9m0-jHMz5D`. Codex returned that its
  access token could not be refreshed because the refresh token had already been used. Core
  classified the terminal outcome as a process failure, restored the clean checkpoint, created no
  task commit, and blocked the phase.
- First reauthenticated run artifact:
  `/var/folders/46/_x1cjbss6kd5mkcdvkg00m940000gn/T/densa-p9m0-Y9ZkTd`. The real worker succeeded,
  deterministic validation passed, and Core created task commit
  `957dc3384bb7b419b97f2952fb80e5673ed854d9`. The fresh review then failed closed because the
  strict output schema omitted `criterionPosition` from the finding object's required keys. Core
  accurately blocked the phase and persisted the failed review and phase report.
- Passing real run artifact:
  `/var/folders/46/_x1cjbss6kd5mkcdvkg00m940000gn/T/densa-p9m0-CCNkIA`. A real Codex worker changed
  only `src/normalize-name.js`; `node --test` passed; Core created task commit
  `99945764dd10e6d1db1a53c898791d5433367618`; and a distinct, read-only Codex review passed. After
  two SQLite reopen cycles, the task is `COMPLETED`, the phase is `AWAITING_APPROVAL`, the project
  remains `RUNNING`, and `proof-result.json` reports `PASS` with no failure reasons.

The failed runs remain part of the experiment record and are not presented as success evidence.
Only the final real run satisfies the live P9M0 gate.

## Reliability issues and dispositions

1. The product CLI did not expose a real composed headless lifecycle. P9M0 adds the narrowly scoped
   `proof phase-one` command. It is an experiment boundary, not the protocol freeze planned for
   P9M2.
2. The first failing CLI version hid the retained artifact path behind a generic error. The proof
   now writes `proof-result.json` for both pass and lifecycle-failure outcomes and includes the
   diagnostics, workspace, and database paths in structured CLI error details.
3. Adapter contract, authentication, configuration, permission, and availability failures must not
   consume all four attempts. Core now treats reliably classified non-retryable agent errors as a
   one-attempt blocked outcome after scoped rollback. Ambiguous `PROCESS_FAILURE` remains retryable;
   Densa ADE does not classify authentication from presentation text.
4. SQLite and Git evidence behaved correctly in both live failures: every attempt had a durable
   checkpoint and failure record, rollback left the source unchanged, no validation ran after agent
   failure, no task commit was created, and the phase report accurately recorded `blocked`.
5. The full suite requires local socket and loopback-listen permission for Core daemon and
   Playwright cases. Restricted execution reports `listen EPERM`; the acceptance run must use the
   repository's established local-network allowance.
6. The independent-review JSON Schema was structurally valid for local fakes but invalid for the
   Codex API's strict structured-output contract because a declared finding property was optional.
   The protocol now requires `criterionPosition` for every finding, fail-closed fallback findings
   use position zero, and a regression assertion pins the complete required-key list.

## Acceptance result

The live gate passed with:

```sh
npm run proof:p9m0
```

The retained report matches authoritative SQLite and Git facts after restart, the task commit maps
to `task.normalize-name`, and the phase is `AWAITING_APPROVAL`. P9M1 and Code - OSS work remain out
of scope for this milestone.
