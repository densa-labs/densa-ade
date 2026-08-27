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

The framework deliberately does not discover or execute project commands yet. Safe command
detection belongs to P6M1.
