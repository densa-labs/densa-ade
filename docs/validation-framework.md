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
retry path receives the complete available evidence.

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
an argv digest rather than potentially secret argument values.

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
test runner. The dev server receives a minimal process environment rather than inheriting unrelated
credentials from Core.

The built-in runner supports page-load, visible-text, and visible-selector checks. It bounds and
redacts server/browser logs, and strips URL query/fragment data from request-failure diagnostics. A
failed check records a full-page screenshot and Playwright trace in private local runtime storage,
never the portable `.densa/` tree; callers may supply an application-support artifact root and Core
persists its absolute local path. A required plan entry maps that result to task criteria with
evidence source `browser_test`, so a passing browser check can satisfy acceptance while failed,
cancelled, or missing evidence continues to block completion. Playwright 1.62.1 is pinned under its
Apache-2.0 license; `npm run playwright:install` provisions Chromium as a local build/runtime step.
