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
