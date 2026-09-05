# Phase 0 current-state audit — 2026-09-05

## Audit baseline

- Repository: `/Users/ivanuy/Library/Mobile Documents/com~apple~CloudDocs/Projects/densa-ade`.
  The configured Desktop checkout path is a symlink to this location.
- Starting commit: `9ce2476c9c5ec4566b663be9d327cdb89184b4b8`.
- Starting committed tree: `5b16276f801c57cb83f5df473d3fced3ee2f34a9`.
- Branch/upstream: `main` / `origin/main`.
- Authoritative remote: `https://github.com/densa-labs/densa-ade.git`,
  `refs/heads/main` = `9ce2476c9c5ec4566b663be9d327cdb89184b4b8`.
  Read directly with `git ls-remote` at baseline and again at handoff; ahead/behind `0 0`.
- Initial tracked working tree and index were clean. Five untracked user-owned PNGs were present:
  `assets/Densa-ADE-Logo 2.png`, `assets/Densa-Labs-Logo 2.png`,
  `assets/Densa-Letter-Logo 2.png`, `assets/Densa-Logo-Dark 2.png`,
  `assets/Densa-Logo-White 2.png`. They remain untouched and excluded from audit snapshots.
- Ignored residual Code - OSS/IDE build files and extraneous installed IDE workspace dependencies
  were not treated as current tracked implementation. Fresh archive installation was tested separately.
- Runtime: Node `24.14.0`, npm `11.9.0`, Git `2.54.0 (Apple Git-157)`;
  macOS `27.0` build `26A5425a`, Darwin 27, arm64.
  Repository Node minimum is `>=22.13`; that minimum runtime was not separately executed.
- Tooling: TypeScript `6.0.3`, ESLint `10.9.1`, typescript-eslint `8.68.0`,
  Prettier `3.9.6`, Zod `4.4.3`, Playwright `1.62.1`; lockfile unchanged.
- Validation used authorized local process/Unix-socket/browser capability, disposable Git repositories,
  file-backed SQLite fixtures, and fake adapters. No live paid Codex execution was claimed.
  Normal sandbox execution is broken by the symlinked writable root; approved elevated execution
  was used for read-only inspection and test commands.
- The audit skill guided prompt sealing, current-state tracing, red-to-green investigation and
  broad validation. This is an audit checkpoint, not a newly implemented roadmap milestone.
  After PASS, the user explicitly requested ADVANCE and a selective commit/push before progression.

The sealed controlling prompt is `docs/phase-0-current-state-audit-prompt.md`,
SHA256 `b48d4e50c13df69bc64d84b09f07470ee9b71743afaa8983f86a75adebff01cc`.
The user explicitly adopted its rules after clarifying that there is no separate Section 1.
The prompt's original reconstruction is therefore an adopted contract, not purported recovered text.
The user subsequently approved the three narrowly scoped full-file replacements needed to complete
P0-F02. The earlier FAIL and its regression evidence are retained below as intermediate outcomes.

## Phase contract

P0M0 establishes a small Node/TypeScript workspace, strict root build/type/lint/test/format tools,
editor-independent Core, appropriate runtime/build ignore rules, and a root README explaining
clients → local IPC → authoritative Core → replaceable agent adapter → workspace.

P0M1 supplies runtime-validated IDs and records for Project, Phase, Task, Attempt, AgentRun,
ValidationRun, Checkpoint, Decision, RoadmapRevision and Event; canonical states, execution modes,
roadmap-change classifications, honest usage states, stable error taxonomy, versioned request/
response/notification envelopes, lossless JSON values and explicit-offset ISO timestamps.
Contracts must compile independently, remain provider/editor neutral and document compatibility.

P0M2 establishes a testable headless CLI shell with doctor, project init/status/start/pause/resume,
events and version/help; clear nonzero failure exits, human output and stable JSON output,
dependency-injected services, shared protocol and no mutable authoritative singleton.
Placeholders are expressly permitted; full orchestration is not an original acceptance requirement.

There is no earlier numbered phase dependency. Later phases may rely on these runtime schemas,
stable semantics, editor-neutral process ownership, inspectable architecture and root validation.
Current IPC adds authenticated user-local Unix sockets, strict operation validation and bounded
replay; later SQLite, transitions, journal, redaction, portable projection and recovery must preserve
the underlying Phase 0 contracts. These later integration paths were inspected without granting
whole-phase PASS to Phases 1–9.

Source inventory was established before the gate in `docs/phase-0-requirement-ledger.md`.
Primary sources: current user request/clarification, `AGENTS.md`, `MASTER_ROADMAP.md:98–233`,
current architecture/protocol documents and original milestones
`15463e02d1458dcdaf17bd69d7e8b1ee1f14f5be`, `7fb21b1`,
`da186cd5fc3d8ddb3c7513e70b218d95ea187ea4`.
Historical tags and prior reports were inspection leads, not present-day proof.

Intentional supersessions:

- The early “do not implement DB/agents/daemon/UI yet” limits governed milestone sequencing.
  Later roadmap phases deliberately authorize those components, not editor coupling.
- Naming migration `c16b313eeb78c8b0c32123e9ff5c6ebf29175dc4` and
  `docs/naming-and-compatibility.md` replace `@densa/*`, `densa` and `.densa/`
  with canonical Densa ADE names, subject to documented aliases/historical persistence.
- Protocol freeze `0af532d`, `docs/core-v1-protocol.md` and the protocol README
  deliberately replace 0.1.0 with 1.0.0; unsupported versions fail closed.
- README simplification at `e34d638` does not authorize deleting P0M0's architecture requirement.
  Prior repair `59510fa686ac4d226eddb057c56ae8ae67b0ce7e` establishes its regression history.

## Requirement-to-evidence summary

“Verified” is bounded by the tested macOS/Node environment and the explicit uncertainties below.
All applicable material requirements are satisfied in this final snapshot. P0-R05, P0-R15 and
P0-R24 include repaired current-state regressions; original shell placeholders are not silently
promoted into later-phase capabilities.

| ID     | Material requirement                                                     | Current implementation / boundary / configuration                                                           | Evidence and later integration                                                                              | Status / uncertainty                                                                               |
| ------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| P0-R01 | Node/TypeScript foundation                                               | Root and five package manifests; `tsconfig.base.json`; Node engine and npm version declared.                | Lockfile install, clean build/typecheck; later SQLite requires supported Node.                              | Verified on Node 24.14.0/macOS arm64; minimum Node not separately executed.                        |
| P0-R02 | Workspace supports core/protocol/agent-sdk/cli/testing and later apps    | `package.json` workspaces; package manifests; `apps/README.md`.                                             | `workspace-foundation.test.mjs`; fresh archive install isolates ignored IDE artifacts.                      | Verified.                                                                                          |
| P0-R03 | Core/editor independence                                                 | Core and protocol imports, package dependency graph, protocol-only wire data.                               | Recursive source/dependency guard; direct inspection; v1 fake client imports no Core repositories.          | Verified for tracked packages; future IDE internals are outside this gate.                         |
| P0-R04 | Strict TypeScript, root typecheck/build/lint/test, format tooling        | `tsconfig*.json`, `eslint.config.mjs`, `.prettierrc.json`, root scripts.                                    | `npm run clean`, `typecheck`, `build`, `check`; lockfile-pinned tooling.                                    | Verified; final broad results in report.                                                           |
| P0-R05 | Root architecture README and package boundaries                          | README clients → IPC → Core → AgentAdapter → workspace; five package owners and apps.                       | New `phase-0-foundation-audit.test.mjs`, red then green.                                                    | Repaired P0-F01.                                                                                   |
| P0-R06 | Ignore runtime/build/secrets but retain portable intent                  | `.gitignore` for Node, build, SQLite/WAL, sockets/PIDs, env; no blanket `.densa-ade/` ignore.               | `git check-ignore --no-index -v` sample runtime and portable paths; portable projection tests.              | Verified.                                                                                          |
| P0-R07 | Small stable dependency set; no unapproved cloud infrastructure          | Production deps are local workspace packages, Zod, Playwright; Node SQLite.                                 | Manifests/lockfile inspection; fresh `npm ci`; no added dependency.                                         | Verified for Phase 0 scope, not a public-release license audit.                                    |
| P0-R08 | Runtime schemas and IDs for all ten entities                             | `protocol/src/ids.ts`, `domain.ts`, exports; branded IDs, strict schemas.                                   | Protocol tests and SQLite repository round trips; later attempt/checkpoint/decision extensions reviewed.    | Verified.                                                                                          |
| P0-R09 | Canonical project/phase/task states                                      | `protocol/src/states.ts`; readonly domain snapshots.                                                        | Exact enum tests; transition matrices; atomic persistence/state-event tests.                                | Verified; state authority remains Core.                                                            |
| P0-R10 | guided/phase/continuous execution modes                                  | `states.ts`; Core execution modes and settings.                                                             | Enum tests and complete mode integration suite.                                                             | Verified.                                                                                          |
| P0-R11 | minor/significant/scope classifications                                  | `states.ts`, roadmap mutation contracts; Core audited mutation service.                                     | Enum, policy, explicit scope-approval and stale-approval tests.                                             | Verified at the shared contract boundary.                                                          |
| P0-R12 | available/limited/unknown usage without fabricated reset                 | `usageStateSchema`; bounded ISO reset/reason fields; Core usage/recovery consumers.                         | Protocol tests, adapter usage fixtures and persisted resume tests.                                          | Verified; no current live provider claim.                                                          |
| P0-R13 | Stable machine-readable error taxonomy                                   | `errors.ts`, envelope error schema, Core normalized errors, CLI mapping.                                    | Exact enum, malformed/version/auth errors, responsive Core usage=2/failure=1, unavailable=3 tests.          | Verified; transport timeout preserves unknown-outcome message.                                     |
| P0-R14 | Versioned request/response/notification and correlation/request identity | `envelope.ts`, `ipc.ts`, `core-v1.ts`; daemon frames and pending-request ownership.                         | Four-envelope round trips, malformed/version mismatch, duplicate IDs, client result identity checks.        | Verified; exact current version accepted and unsupported versions fail closed.                     |
| P0-R15 | JSON-only lossless values; explicit-offset ISO timestamps                | `json.ts`, recursive envelope/domain consumers and serialization helpers.                                   | Primitive/class/Date rejection; standard round trips; own `__proto__` edge probe.                           | Repaired P0-F02; wire, redaction, journal reopen, portable settings and rollback regressions pass. |
| P0-R16 | Contracts compile independently; runtime validation is public            | Protocol project has no Core/editor references; exports types and schemas.                                  | `npx tsc -b packages/protocol --force`; protocol and current v1 tests.                                      | Verified.                                                                                          |
| P0-R17 | No UI-specific or Codex-specific project/task state                      | Protocol imports and manifests, typed domain records, provider-neutral adapter references.                  | Direct source search, workspace guard, fake v1 client and schema tests.                                     | Verified.                                                                                          |
| P0-R18 | Document compatibility and reject unsupported versions                   | Protocol README, Core v1 policy, naming policy; `PROTOCOL_VERSION`.                                         | Original 0.1.0 versus explicit 1.0.0 amendment; schema/raw-socket mismatch tests.                           | Verified for current exact-version fail-closed behavior; no new version introduced by audit.       |
| P0-R19 | Headless command shell includes all original commands                    | `cli/src/cli.ts`, `bin.ts`, CLI manifest bin, injected services.                                            | Help/command-routing tests; actual CLI daemon smoke.                                                        | Verified as shell/placeholders; init/start limitations explicitly retained.                        |
| P0-R20 | Clear failure exits; human default; stable JSON option                   | `cli/src/contracts.ts`, `runCli`, output serialization and normalization.                                   | CLI error/output tests, warning-free help/version subprocesses, actual daemon command exits.                | Verified.                                                                                          |
| P0-R21 | No mutable global CLI authority; shared protocol; test without Codex     | Per-run service construction and injected I/O/request IDs/Core clients; lazy Core imports.                  | Injected CLI tests; source inspection; shared protocol request assertions.                                  | Verified; explicit paid proof command is outside routine tests.                                    |
| P0-R22 | Doctor shows Node/Git/platform and honest placeholders                   | `LocalDoctorService`, `inspectGit`, `runDoctor`, help.                                                      | Injected doctor tests; actual runtime versions recorded.                                                    | Verified for original contract; does not assert real Codex readiness.                              |
| P0-R23 | Current clients remain non-authoritative over secure local IPC           | `LocalCoreClient`, daemon authentication/dispatch, Core runtime services.                                   | Real daemon lifecycle, wrong token/version, disconnected and killed clients, replay/subscription tests.     | Verified at Phase 0 integration boundary; not a renewed Phase 7/9 whole-phase PASS.                |
| P0-R24 | Later persistence/recovery preserves foundational facts                  | Core SQLite schemas/migrations/repos, centralized transitions and append-only journal, portable projection. | Migration, round-trip, partial-write rollback, event-version, file-backed restart, interrupted retry tests. | Verified after P0-F02 consumer repair; no audit schema migration.                                  |

P0-R04's root-suite acceptance now passes in both the primary checkout and a fresh source archive.
The wire, persistence and rollback guarantees are verified together; targeted results alone were
not used to clear this gate.

## Confirmed findings

### P0-F01 — Missing required architecture documentation

- Violated requirement: P0-R05 / P0M0 requirement 5 and repository-boundary acceptance.
- Severity: Low.
- Root cause: a later README rewrite removed the required process and package ownership explanation.
- Affected component: root `README.md`.
- Fix applied: restored a concise architecture section, authoritative Core/editor independence,
  replaceable adapter boundary and the five package responsibilities.
- Regression: `scripts/phase-0-foundation-audit.test.mjs` failed against the prior README, then
  passed with the repair; combined README/workspace checks passed 4/4.
- Final verification: README guard passes in the complete current suite. No runtime or UI behavior
  changed and no user asset was edited.

### P0-F02 — Reserved JSON data keys lost or mishandled across current consumers

- Violated requirements: P0-R15/P0M1 lossless validated JSON; P0-R24 foundational facts must survive
  later persistence, redaction and recovery integrations.
- Severity: Medium; bounded data-integrity and failure-path defect. No global prototype pollution
  or credential disclosure exploit is claimed.
- Root causes:
  1. Zod's record parser skips an own `__proto__` entry. Valid data silently disappears;
     invalid non-JSON values under that key can evade validation.
  2. Three later generic-object redactors assign untrusted keys into ordinary `{}` objects.
     Assigning `__proto__` changes that result object's prototype instead of defining own data.
     This lost values and, during partial remediation, caused the strict wire parser to reject the malformed result.
- Affected production files:
  `packages/protocol/src/json.ts`,
  `packages/protocol/src/master-agent.ts`,
  `packages/core/src/secret-redaction.ts:70`,
  `packages/core/src/persistence/portable-project.ts:137`,
  `packages/core/src/attempt-rollback.ts:237`.
- Protocol fix applied: validate plain-object entries recursively, reject enumerable symbol keys,
  and reconstruct using `Object.fromEntries`, preserving reserved keys and clone independence.
  Master schema construction shares one builder between runtime validation and a wire-shape-only
  schema export; exported APIs and the generated provider JSON Schema remain unchanged.
- Provider schema SHA256 before/after:
  `5d07207b93aa1a9c6db0ec7edbcdb069274113a53396aa64e07ccf5295d9a73e`.
  The shape-only surrogate is not used to validate untrusted runtime values.
- Consumer fix applied: replaced exactly the three unsafe assignments with `Object.defineProperty`,
  retaining enumerable/writable/configurable ordinary-data descriptors and all existing secret
  patterns, recursive calls, traversal order and redaction counts. Current diffs contain no other
  edits in these three Core modules. The protocol README documents the restored key-preservation rule.

- Regression coverage:
  `scripts/json-wire-regression.test.mjs` covers all four envelope variants, nested reserved
  keys, constructor/prototype-shaped ordinary data, clone independence, null-prototype dictionaries,
  invalid hidden values and unchanged provider schema.
  `scripts/json-persistence-regression.test.mjs` covers Core redaction, durable journal close/reopen
  and replay, and portable settings with nested secrets.
  `scripts/attempt-rollback.test.mjs` strengthens failure-diagnostics persistence coverage.
- Red-to-green evidence: wire tests initially failed 2/3, then passed 3/3. Protocol/v1 selection
  passed 20/20. Before consumer repair, three JSON persistence tests failed and rollback returned
  STOPPED rather than RECORDED. After explicit approval and repair, all 43 focused tests pass,
  including journal close/reopen/replay, portable settings and failure-diagnostics persistence.
- Final verification: a read-only independent review inspected each exact consumer delta and ran
  22 wire/persistence/rollback tests: all passed. Both complete final suites pass 467 tests with
  3 opt-in skips and zero failures. The restart regression now reaches and passes its reopen
  assertion, with sensitive values redacted and reserved data preserved.
- Repair tooling concern P0-C10: normal Update File patches still encounter the symlinked writable-root
  sandbox limitation. Earlier full-file replacements were rejected by auto-review. The user then
  explicitly approved the three exact-content replacements; they were applied through the patch
  tool and the resulting diffs were verified. The repair blocker is resolved without an unauthorized
  alternate write path.

Cross-gate review traced the JSON change into envelopes, v1 clients, event repositories, portable
settings, failed-attempt diagnostics and Master schema export. No earlier numbered gate exists.
No state enums, transition rules, migrations, secret patterns, authorization rules, protocol version,
dependency versions or public command names changed. All three consumers were repaired and the
complete suite rerun from fresh dependencies. This is a Phase 0 gate only, not renewed approval
of entire later phases.

## Disproven concerns

- P0-C01: absent legacy init/start daemon implementations violate original CLI acceptance.
  Disproven for Phase 0: placeholders are explicit. Actual init/start exit 2 with
  USER_CONFIGURATION_ERROR; status reports no selected project. This does not certify later CLI scope.
- P0-C02: ordinary Date/class/bigint/undefined/nonfinite payloads bypass validation.
  Ordinary cases are rejected; the special own-key exception was confirmed and retained as P0-F02.
- P0-C03: nested Core files escape the editor-independence guard. Recursive inspection is present
  and passes; tracked package dependencies do not import editor APIs.
- P0-C04: naming/protocol version differences are unauthorized drift. Deliberate migration and
  freeze documentation provide the supersession evidence above.
- P0-C05: help/version initialize Core/SQLite and emit warnings. Subprocess tests show no such warning.
- P0-C06: responsive Core errors are incorrectly treated as unavailable transport.
  Current mapping preserves configuration/usage exit 2, general failure 1, transport unavailable 3.
- P0-C07: old installed IDE dependencies are required for clean validation.
  Fresh lockfile installation and the earlier clean complete suite succeed without them.
- P0-C09: an unavailable separate Section 1 leaves the rules unresolved.
  Resolved by explicit user adoption of the saved prompt.

P0-C08 (one earlier browser process failure) is not claimed conclusively disproven; see uncertainty.
P0-C10 was a confirmed tooling blocker, not a product defect; the approved repair is now complete.

## Confirmed out-of-scope defects

P0-O01: the current README links to `LICENSE` and `THIRD_PARTY_NOTICES.md`, but those files are
absent from the tracked tree/current checkout. Confirmed documentation/release-artifact gap.
Disposition: left unchanged; inventing legal contents or restoring later distribution phases is
outside this Phase 0 repair. A later release review must resolve it. This is not presented as legal advice.

## Remaining uncertainty

1. P0-C08: an earlier clean run had one browser fixture `kill EPERM` failure. Its cause was not
   established. Isolated rerun passed 6/6 and subsequent full runs, including both final repaired
   runs, passed browser validation. This is retained as a non-reproduced tooling risk, not claimed
   to have a proven root cause. No test was weakened.
2. Live Codex Master interview, authenticated adapter smoke and live task proof remain opt-in/skipped.
   Fake-adapter production lifecycle tests are not represented as real paid-agent evidence.
   Live paid-agent acceptance is not an original Phase 0 shell requirement.
3. Node's declared minimum and macOS versions/architectures other than this host were not executed.
   Compatibility outside the recorded environment is not certified; no Windows/Linux product
   guarantee is inferred. Fresh lockfile installation and supported Node 24 execution pass.
4. Legacy CLI placeholders remain limitations authorized by the original Phase 0 contract; no
   public CLI shipping readiness or renewed whole-phase approval for Phases 1–9 is claimed.
5. Existing prior audit reports do not certify this new shared-schema state. Their affected
   integrations need current evidence before any separate whole-Core progression decision.
6. One intermediate clean session lost final output; it is not counted as a completed gate.
   Logged complete reruns, including the repaired fresh-source run, provide the final evidence.
7. The ordinary patch sandbox configuration remains defective because of its symlinked writable
   root. It no longer blocks this repair after explicit user approval of the verified replacements.
8. P0-O01 remains an out-of-scope documentation/release-artifact gap. There is no unresolved
   requirement-source conflict, confirmed in-scope defect or skipped deterministic Phase 0 gate.

## Validation

All commands ran in this repository unless an archive directory is specified. Test totals count
the three explicitly opt-in tests as skips, not passes. SQLite emits Node's ExperimentalWarning
in Core/persistence tests; lightweight help/version remain warning-free.

| Validation                                                                                                                                                                                                                      | Exit / evidence                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run pretest`; `node --test scripts/workspace-foundation.test.mjs scripts/protocol-contracts.test.mjs scripts/cli.test.mjs scripts/core-daemon.test.mjs scripts/core-v1-protocol.test.mjs`                                  | 0; initial focused 47 passed, 0 failed/skipped.                                                                                                                                                                            |
| New README guard before repair                                                                                                                                                                                                  | 1; one expected assertion failure.                                                                                                                                                                                         |
| README guard plus workspace tests after repair                                                                                                                                                                                  | 0; 4 passed.                                                                                                                                                                                                               |
| Actual disposable CLI daemon lifecycle                                                                                                                                                                                          | Start/status/events/stop succeed; unsupported legacy init/start exit 2; no paid worker.                                                                                                                                    |
| `npm run clean`; `npm run typecheck`; `npm run build`; `npm run check` before JSON edits                                                                                                                                        | 0; 464 total, 461 passed, 3 skips, 0 failures; complete suite 49428.858791 ms.                                                                                                                                             |
| Fresh archive `npm ci` in `/private/tmp/densa-p0-clean.rJiDwN`                                                                                                                                                                  | 0; 100 installed, 106 audited, 0 vulnerabilities.                                                                                                                                                                          |
| Earlier clean archive `npm run clean`; `npm run check`                                                                                                                                                                          | Check 1; 464 total, 460 passed, 3 skips, one browser kill EPERM failure.                                                                                                                                                   |
| `node --test scripts/browser-validation.test.mjs` in that archive                                                                                                                                                               | 0; 6 passed.                                                                                                                                                                                                               |
| Logged complete archive `npm run check` before JSON edits                                                                                                                                                                       | 0; 464 total, 461 passed, 3 skips, 0 failures; 43114.85925 ms. Log `/private/tmp/densa-p0-clean-final-check.log`.                                                                                                          |
| `npx tsc -b packages/protocol --force`                                                                                                                                                                                          | 0; independently compiled protocol.                                                                                                                                                                                        |
| New JSON wire tests before repair                                                                                                                                                                                               | 1; 2 failed, schema fingerprint test passed.                                                                                                                                                                               |
| `npm run pretest`; `node --test scripts/json-wire-regression.test.mjs scripts/protocol-contracts.test.mjs scripts/core-v1-protocol.test.mjs` after protocol repair                                                              | 0; 20 passed, 0 failed/skipped.                                                                                                                                                                                            |
| Consumer regressions before blocked repair                                                                                                                                                                                      | JSON persistence 3 failed; focused rollback 1 failed, STOPPED versus RECORDED. An initial rollback test-edit syntax error was corrected before this genuine red result.                                                    |
| Intermediate blocked primary `set -o pipefail; npm run check 2>&1 \| tee /private/tmp/densa-p0-blocked-final-check.log`                                                                                                         | **1; 470 total, 463 passed, 4 failed, 3 skipped, 0 cancelled; 54849.002083 ms.** Format/build/typecheck/lint all passed; four failures are P0-F02 regressions.                                                             |
| `git diff --check`, temporary-index `git diff --cached --check`                                                                                                                                                                 | 0; only audit paths included in the temporary-index review.                                                                                                                                                                |
| `git check-ignore --no-index -v` runtime/portable samples                                                                                                                                                                       | SQLite/WAL/socket/PID/build paths ignored; portable project/spec/report intent is not blanket ignored.                                                                                                                     |
| Intermediate blocked snapshot `a488bb3e97334f89c5d5e366b69f753882efc635` in `/private/tmp/densa-p0-blocked-clean.bwWRf5`: `npm ci`; `npm run clean`; `npm run check` (full log `/private/tmp/densa-p0-blocked-clean-check.log`) | Install/clean 0; 100 packages installed, 106 audited, 0 vulnerabilities. Check **1; 470 total, 463 passed, 4 failed, 3 skipped, 0 cancelled; 51721.2765 ms**. Format/build/typecheck/lint pass. Same four P0-F02 failures. |

### Final repaired-state validation

| Command / environment                                                                                                                                                                                                  | Result                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run pretest`; `node --test scripts/json-wire-regression.test.mjs scripts/json-persistence-regression.test.mjs scripts/attempt-rollback.test.mjs scripts/portable-project.test.mjs scripts/event-journal.test.mjs` | Exit 0; 43 passed, 0 failed/skipped; 11787.078 ms.                                                                                                                                      |
| Independent read-only review: `node --test scripts/json-wire-regression.test.mjs scripts/json-persistence-regression.test.mjs scripts/attempt-rollback.test.mjs`                                                       | Exit 0; 22 passed, 0 failed/skipped. Exact three-consumer diff and unchanged redaction policies verified.                                                                               |
| Primary `npm run check`, logged with `set -o pipefail` and `tee /private/tmp/densa-p0-approved-final-check.log`                                                                                                        | **Exit 0; 470 total, 467 passed, 0 failed, 3 skipped, 0 cancelled; 50467.766542 ms.** Formatting, build, typecheck, lint and complete tests pass.                                       |
| Fresh source tree `81e83b6ab6ca86495109fb13731df42435b71dd2` at `/private/tmp/densa-p0-approved-clean.sNo5Sy`: `npm ci`; `npm run clean`; `npm run check`                                                              | **All exit 0; 470 total, 467 passed, 0 failed, 3 skipped, 0 cancelled; 51138.738208 ms.** Install: 100 packages, 106 audited, 0 vulnerabilities. All build/type/lint/format gates pass. |
| Final report formatting and scoped diff checks                                                                                                                                                                         | `npm run format:check`, `git diff --check`, temporary-index `git diff --cached --check`: exit 0.                                                                                        |

The three skipped tests are explicitly gated by `DENSA_LIVE_CODEX_INTERVIEW`,
`DENSA_LIVE_CODEX` and `DENSA_LIVE_CODEX_TASK_PROOF`; they are not deterministic Phase 0 requirements.

Final repaired-state log SHA256 fingerprints:

- `/private/tmp/densa-p0-approved-final-check.log`:
  `dd04dba01254b9955bcf1ed7462578e0bbe2df9fde557e3023032234694e6d75`.
- `/private/tmp/densa-p0-approved-clean-check.log`:
  `921e37d781fc4677ec7efbc2718f0d1c28ec54ba61600ae4c50bd3b63f0e73ec`.
- `/private/tmp/densa-p0-approved-clean-install.log`:
  `753cda60605ab50544baa624c244e465584d6724190f4c281615726426110f26`.

Intermediate blocked-run log SHA256 fingerprints:

- Primary check: `bb40b013828a6d739171e00a46cdb59ccd2903b78f846fb027196cf64efaefee`.
- Fresh-source check: `c42033c108b7b59bf8bd4ad9f676c96f502f9e2c54697f94571b3541548fd3eb`.
- Fresh-source install (`/private/tmp/densa-p0-blocked-clean-install.log`):
  `efa34a2c3361350f13d52235ccc22778890fcfaf1070e38bb8f36e1a6d5feaf8`.

The final broad gate—not earlier green results—is authoritative. No completion is claimed from a
targeted test. No live secrets, real user project mutations, provider calls, pushes or weakened tests
were needed for the fixtures. Read-only independent review confirmed the completed consumer repairs.

## Final diff and side-effect review

Audit-owned paths:

- `README.md`: architecture boundary restored.
- `packages/protocol/README.md`: documented lossless own-key preservation through redaction/persistence.
- `packages/core/src/secret-redaction.ts`: own-data-property copy only.
- `packages/core/src/persistence/portable-project.ts`: own-data-property copy only.
- `packages/core/src/attempt-rollback.ts`: own-data-property copy only.
- `packages/protocol/src/json.ts`: recursive lossless JSON parsing and validation.
- `packages/protocol/src/master-agent.ts`: shared schema builder and unchanged provider wire shape.
- `scripts/phase-0-foundation-audit.test.mjs`: README regression.
- `scripts/json-wire-regression.test.mjs`: wire regression and provider schema fingerprint.
- `scripts/json-persistence-regression.test.mjs`: passing consumer/restart/projection regressions, previously red.
- `scripts/attempt-rollback.test.mjs`: passing reserved-key diagnostics regression, previously red.
- `docs/phase-0-current-state-audit-prompt.md`: sealed adopted rules.
- `docs/phase-0-requirement-ledger.md`: source inventory and all concern dispositions.
- `docs/phase-0-current-state-audit.md`: this report.

Each of the three Core redaction files changes exactly one unsafe assignment to an own-property
definition with unchanged recursive redaction. No redaction regex or export was changed.
No package manifest, lockfile, DB migration, authentication policy, redaction pattern, user asset,
existing phase tag or branch history was rewritten. Initial audit snapshots used a separate temporary
index; the user subsequently authorized staging only these audit-owned files for the checkpoint. Five unrelated untracked PNGs and ignored IDE
leftovers remain preserved. Test builds regenerated ignored outputs; fresh installations occurred
in audit-owned temporary archives. Logs and temporary snapshots remain under `/private/tmp`.
No material user data was deleted. Completed repairs and green regressions are approved for one
selective audit checkpoint; no unrelated user work or new milestone is included.

## Exact final audited state

- Pre-checkpoint HEAD: `9ce2476c9c5ec4566b663be9d327cdb89184b4b8`.
  The resulting audit commit SHA and verified remote SHA are recorded in the publication handoff;
  this report is contained in that commit and cannot embed its own future commit identity.
- Exact final source/evidence tree excluding this self-referential report:
  `81e83b6ab6ca86495109fb13731df42435b71dd2`.
  It is HEAD plus the thirteen explicitly listed audit-owned paths other than this report, and is
  the precise tree exported for the final fresh-install/full-suite validation.
  Five user-owned untracked PNGs and ignored runtime/build artifacts are excluded and preserved.
- The report-inclusive Git tree is computed after this report is finalized and recorded in the
  final handoff. This avoids falsely embedding a report's own hash inside itself. The source Git tree
  is the content-addressed validation snapshot; the publication commit also contains this report.
- Only this report is updated after the clean-source snapshot, with final formatting/diff checks.
  No executable source or regression test changes after final validation.
- At checkpoint preparation, branch/upstream and authoritative remote match the baseline with
  ahead/behind `0 0`. Only the report's authorization/progression metadata changes after PASS;
  executable source and regression tests remain identical to the clean-tested tree.

## Final gate

**PASS — Cleared for this gate.**

Progression status: **ADVANCE — explicitly authorized by the user**, contingent on completing
and verifying the requested commit/push first. The next authorized gate is the Phase 1 current-state
audit. This does not authorize Phase 2, a whole-Core audit, Phase 10, or automatic subsequent gates.

Publication status: **AUTHORIZED — selective audit commit and normal push to origin/main requested**.
Remote SHA/equality are verified after creating the commit and recorded in the publication handoff.
No historical phase tag is moved or recreated.
