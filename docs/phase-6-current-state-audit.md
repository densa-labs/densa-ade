# Phase 6 current-state audit

Date: 2026-09-01

Audited current revision: `c29618a428a0c63575572c3dae0b558cdd232252` plus the repairs recorded by this audit

Sealed prompt: `docs/phase-6-current-state-audit-prompt.md`

Prompt SHA-256: `27f8d9460c24eb3c57566a8a46257d8e33eaf10526a1ea321065870c90e0959a`

## Review summary

The audit recovered Phase 6 Milestones 0-4 from `MASTER_ROADMAP.md`, their original milestone
commits (`3817f33`, `606f976`, `3b868ff`, `7fbe0b5`, and `df6a54b`), the phase checkpoint
`densa-phase-6-complete` (`61a2674`), the engineering constitution, and the Phase 6 architecture
documents. It reconstructed the intended contracts for provider-neutral validation, safe command
detection, criterion-level evidence, managed Playwright validation, and fresh-context independent
review.

Those contracts were traced through the current protocol schemas, SQLite migrations and
repositories, validation and acceptance services, task and phase orchestrators, Git/workspace
integrity boundary, browser process lifecycle, agent adapter integration, execution modes, recovery,
phase reporting, and current tests. Historical completion and passing tests were treated as
evidence only. The audit added adversarial current-state checks for realistic task completion,
symlink escapes, cancellation races, sensitive metadata, timestamp offsets, phase mutation,
provider misbehavior, process crash, migration, restart, and recovery paths.

## Recovered guarantees

- Validator plugins are provider-neutral, versioned, deterministic in order, durable, replayable,
  bounded, and fail the aggregate unless explicitly advisory.
- Project command detection never evaluates discovered shell text; configured argv is structured,
  audited, and workspace-confined; unknown projects fail closed.
- Every task acceptance criterion needs durable mapped evidence or an explicit audited manual
  decision. Worker prose and legacy aggregate results cannot authorize completion.
- Browser checks are opt-in for relevant tasks, use a managed local dev server and Playwright,
  retain bounded useful failure evidence, honor timeout/cancellation, and leave no owned orphan.
- Independent review runs through a fresh read-only `AgentAdapter` invocation, is bound to the exact
  task or phase validation boundary, cannot override deterministic failure, persists only bounded
  structured redacted output, and fails closed on malformed, missing, cancelled, or stale evidence.
- Task and phase completion remain centralized Core decisions, preserve workspace integrity, and
  remain recoverable across interrupted validation.

## Confirmed findings and resolutions

1. **Current task lifecycle could bypass criterion evidence.** `SingleTaskOrchestrator` created a
   legacy planless validation run, while both commit gates enforced acceptance only when `planId`
   existed. A newly selected passing aggregate result could therefore authorize a task with no
   criterion evidence. The lifecycle now persists a versioned plan-bound required result mapped to
   every criterion. Fresh review is persisted as a distinct `independent_review` result. Both
   `TaskCommitService` and the final database transaction reject planless runs and independently
   recompute the acceptance report. Legacy history stays readable but requires revalidation before
   a new commit.

2. **Cancellation could accept late success and continue the plan.** An in-flight validator that
   ignored abort could return `passed`, and later validators would still start. The pipeline now
   invalidates any post-abort result and records remaining entries as cancelled errors without
   invoking them.

3. **Final phase validation could certify bytes it changed.** Task validation had a workspace
   fingerprint, but the phase-final validator boundary did not. Phase validation now captures and
   rechecks the Git workspace around the complete deterministic/reviewer composition. Mutation is a
   blocking structured failure and is no longer masked by the subsequent review check.

4. **Configured validation working directories were only lexically confined.** Both project command
   and browser-start configuration accepted an in-workspace symlink whose real target escaped the
   workspace. Both paths now require an existing directory and canonical real-path containment.

5. **Browser artifact boundaries were incomplete.** A configured artifact root could be placed in
   portable `.densa-ade/` state, and a runtime provider could return an unsupported artifact kind.
   Core now rejects canonical artifact roots in `.densa-ade/` or transitional `.densa/`, rejects
   symlink escapes, and accepts only regular screenshot or trace artifacts from its owned directory.

6. **Configured browser argv was persisted raw.** User-configured start arguments may contain
   secrets. Durable browser evidence now omits configured argv and stores only source, argument
   count, and a SHA-256 digest. Safely detected package-manager argv remains inspectable.

7. **Audit identity fields could persist secret material.** Manual acceptance-review actors and
   validation-command override actors/reasons were not redacted. They are now redacted before the
   SQLite/event boundary, with regressions proving secret-shaped fixtures do not survive.

8. **Validation chronology compared timestamp text instead of instants.** Valid ISO timestamps with
   different offsets could be rejected or misordered, while run completion lacked a chronology
   invariant entirely. Protocol validation now uses parsed instants. Migration 17 rebuilds
   `validation_results` with `julianday()` chronology and adds defensive run insert/update triggers;
   repositories reject reversed run completion before mutation. A populated version-16 database is
   migrated without losing validation evidence.

9. **A nonconforming Reviewer could strand Core after cancellation.** Calling adapter `cancel()` did
   not unblock a provider stream whose next event never settled. Review iteration now races each
   event against the lifecycle signal and persists a fail-closed cancelled review even when the
   adapter ignores cancellation.

10. **A Core crash could orphan an owned browser process group.** The browser server was detached and
    cleaned in `finally`, which cannot run after `SIGKILL`. A minimal process-group owner now watches
    a parent pipe; EOF caused by Core death terminates the server, launcher, and descendants with a
    bounded TERM/KILL sequence. A regression starts validation in a separate Core process, kills
    that process, and proves the real loopback server PID exits.

All confirmed findings are resolved. No speculative concern was represented as a defect.

## Validation

- The sealed prompt remained unchanged after construction: 136 lines, SHA-256
  `27f8d9460c24eb3c57566a8a46257d8e33eaf10526a1ea321065870c90e0959a`.
- Focused protocol, migration, persistence, task-commit, task-lifecycle, phase-lifecycle,
  acceptance, detector, pipeline, reviewer, and browser regressions passed after repair.
- Real Playwright validation passed against a fixture web server, including failure screenshot and
  trace evidence, cancellation, provider failure, invalid artifacts, process-group cleanup, and
  Core-process crash cleanup.
- `npm run check` passed formatting, build, TypeScript checking, ESLint, pretest compilation, and the
  complete repository test corpus: 428 tests, 425 passed, 3 skipped, 0 failed, exit code 0.
- A separate compact execution of `node --test --test-reporter=dot scripts/*.test.mjs` also completed
  with exit code 0. The three opt-in live Codex/provider checks remain intentionally skipped by the
  default gate; no Phase 6 guarantee depends solely on them.
- `git diff --check` passed. A post-validation reinspection covered each changed authoritative gate,
  migration, protocol schema, process lifecycle, redaction boundary, and its regression.

## Remaining uncertainty

- Live paid/authenticated Codex behavior is not exercised by the default deterministic release gate.
  The adapter contract, malformed-stream handling, cancellation, fresh-run identity, and structured
  review behavior are covered by local fixtures and fakes; this is not a Phase 6 release blocker.
- The crash-cleanup proof is host-process and real-loopback evidence on the supported macOS v0.1
  platform. It does not claim behavior on unsupported operating systems.

## Densa Core integration-audit prerequisite

The whole-Core integration audit was not started. Current-state PASS reports exist for Phases 1-6,
but the repository does not yet contain equivalent current-state PASS evidence for Phases 7-9.
Historical phase tags do not satisfy the user's prerequisite. The sealed whole-Core prompt must be
constructed and executed only after those remaining phase audits pass.

## Final gate

PASS — Cleared for release.
