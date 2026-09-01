# Validation framework

Phase 6 Milestone 0 makes validation a provider-neutral Core pipeline. A `ValidationPlan` is an
explicit ordered list of versioned `Validator` plugins. Plugins may represent command/build,
typecheck, lint, unit or integration tests, structured acceptance checks, browser/E2E checks, or an
independent reviewer; Core does not depend on any one implementation.

Plan array order is authoritative. Core invokes one validator at a time and persists its immutable
result at that position before starting the next validator. A process interruption can therefore be
recovered as an incomplete `validation_runs` row plus the exact completed prefix in
`validation_results`. `ValidationPipeline.replay()` returns that evidence without rerunning a
plugin.

Each result records the validator ID and version, required/advisory policy, status, start and end
timestamps, optional safe command/config metadata and exit code, bounded structured diagnostics,
the mapped task acceptance criteria, and whether the evidence is relevant to a retry. Validators
must emit only command/config metadata safe for durable state. Core rejects oversized metadata and
bounds diagnostics before persistence.

Only an explicit `passed` result satisfies a required plan entry. `failed`, `error`, and `skipped`
required results fail the aggregate run. Advisory entries are still persisted and replayed but never
change the aggregate verdict. All validators continue in deterministic order after a failure so the
retry path receives the complete available evidence. Cancellation is different: an abort invalidates
an in-flight result even if a nonconforming plugin later returns `passed`, and Core records later
plugins as cancelled errors without invoking them.

## Safe command detection

Phase 6 Milestone 1 adds a read-only `ProjectValidationDetector`. It recognizes initial Node and
TypeScript projects from bounded regular metadata files and proposes deterministic build,
typecheck, lint, and test commands as executable-plus-argument arrays. It never evaluates a
`package.json` script body, concatenates shell text, or starts a process. The Policy/Validation
layer must still decide whether a proposal may run and must spawn approved commands without a
shell.

Only exact, allowlisted script names are inferred. A `tsconfig.json` without a typecheck script can
use `node_modules/.bin/tsc` only when that executable resolves to a regular file inside the
workspace. Unsupported or ambiguous package managers, malformed or symlinked metadata, missing
local TypeScript tooling, and unknown project types fail closed with an explicit unknown/manual
configuration result.

User-configured structured argv replaces all guesses. Overrides require an actor, reason, and
durable audit sink. Detection fails closed unless that sink records the versioned audit fact before
the configured plan is returned. Shell-evaluation forms and working directories outside the
workspace are rejected. Audit facts retain command identity, category, policy, argument count, and
an argv digest rather than potentially secret argument values. Configured working directories must
also exist and their canonical real paths must remain inside the workspace, so a symlink cannot
escape the boundary. Actor and reason text are redacted before the audit fact is persisted.

## Browser validation

Phase 6 Milestone 3 adds browser validation as an explicit `browser_test` plugin. The roadmap/policy
layer must first classify a task as browser-relevant. Irrelevant tasks return `not_applicable`
without inspecting project metadata, so the mere presence of a web framework never opts a task in.

Relevant tasks require an explicit credential-free loopback HTTP URL. Core can detect exact
`dev`, `start`, `serve`, or `preview` package scripts, or consume user-configured structured argv.
Start commands are spawned without a shell and cannot escape the workspace. URL guessing and remote
URLs fail closed to manual configuration.

`BrowserValidationValidator` owns the dev-server process group for the whole validation attempt. It
waits for HTTP readiness, invokes a provider-neutral `PlaywrightRunner`, and terminates the complete
process group after pass, failure, runner crash, timeout, or cancellation. Playwright Chromium is a
pinned Core dependency so browser evidence does not depend on an application installing its own
test runner. A small process-group owner watches its Core-parent pipe and terminates the group when
Core itself crashes, preventing detached launchers or grandchildren from becoming orphan servers.
The dev server receives a minimal process environment rather than inheriting unrelated credentials
from Core.

The built-in runner supports page-load, visible-text, and visible-selector checks. It bounds and
redacts server/browser logs, and strips URL query/fragment data from request-failure diagnostics. A
failed check records a full-page screenshot and Playwright trace in private local runtime storage,
never the portable `.densa-ade/` tree; callers may supply an application-support artifact root and Core
persists its absolute local path. A required plan entry maps that result to task criteria with
evidence source `browser_test`, so a passing browser check can satisfy acceptance while failed,
cancelled, or missing evidence continues to block completion. Playwright 1.62.1 is pinned under its
Apache-2.0 license; `npm run playwright:install` provisions Chromium as a local build/runtime step.
Configured start argv is never copied into durable validation evidence; Core stores only its
argument count and SHA-256 digest. Artifact roots are canonicalized and rejected if they resolve
inside `.densa-ade/` or the transitional `.densa/` portable tree.

## Fresh-context independent review

Phase 6 Milestone 4 adds `IndependentReviewService` and a validation-plugin adapter for a logically
separate Reviewer role. Every validation invocation generates a new review identity and reviewer run
ID distinct from the implementing worker, starts a new `AgentAdapter.execute()` invocation, and
builds its goal, criteria, diff, and constraints from the current task or phase request. It supplies
only the task or phase goal, acceptance criteria, bounded relevant diff, deterministic results, and
relevant architecture constraints. Task-plan review receives the already persisted result prefix
from that exact validation run. The prompt asks the reviewer to assess rather than defend or
continue the worker. Providers that support constrained output receive a strict JSON Schema,
reviewer runs request read-only workspace access, and Core compares bounded Git workspace
fingerprints before and after the run. The fingerprint includes HEAD, index state, tracked/untracked
content, and ignored-file metadata so staging, commits, and ignored workspace writes invalidate the
result. Lifecycle cancellation is propagated to the reviewer adapter, and an aborted result remains
failed even if a nonconforming adapter later emits success. Core also races the provider stream
against cancellation, so an adapter that ignores `cancel()` and never settles cannot strand the
authoritative lifecycle.

Reviewer output is validated as `pass`, `advisory`, or `fail`, with bounded severity findings,
position-based criterion mapping, confidence, and unknowns. Positions remain unambiguous when
criterion text is duplicated or bounded for the model; persisted display text remains readable.
Mismatched, multiple, late-failing, invalid, missing, or failed provider streams are persisted as a
structured fail-closed review; raw transcripts are not stored. Migration 12 records
the review intent before the external call and its immutable structured outcome afterward. A review
is bound to the exact task validation run or phase-validation-start event that requested it. Core
atomically appends `INDEPENDENT_REVIEW_STARTED` and `INDEPENDENT_REVIEW_COMPLETED` facts around the
external call; authoritative completion verifies the matching completion fact and context hash.
Core redacts every provider-owned output string before SQLite or phase-report persistence. A review
can contribute `independent_review` evidence, but `ValidationPipeline` still computes the final
verdict: reviewer prose can never override a required deterministic failure. A review supports
completion only when its aggregate verdict is not `fail`, every mapped criterion is `satisfied`, and
no error or critical finding remains.

`withDefaultIndependentReview()` adds required review to task validation plans, while
`FreshContextTaskLifecycleValidator` composes the task-level deterministic result and Reviewer. The
authoritative task lifecycle independently refuses high/critical-risk completion without the exact
current task-review record and stops before worker execution when review infrastructure is absent,
so callers cannot bypass the default policy or consume retries on a configuration error. Likewise,
`FreshContextPhaseValidator` composes deterministic phase checks and the Reviewer conjunctively.
`PhaseLifecycleOrchestrator` verifies the exact review ID returned by the current final validation
invocation and requires its request timestamp to follow the durable `PHASE_VALIDATION_STARTED`
boundary. Timestamp comparisons use parsed instants rather than ISO text ordering. Completed
findings, severities, criterion mappings, and unknowns are included in authoritative and portable
phase reports. Final phase validation fingerprints the workspace around the complete validator and
review composition; a validator that mutates the state it certifies fails closed.
