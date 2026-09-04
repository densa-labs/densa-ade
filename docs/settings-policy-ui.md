# Densa ADE settings and policy UI (Phase 12 Milestone 2)

Coherent settings surface for the thin Code-OSS downstream. The surface
exposes the v1 configuration from the milestone spec without overwhelming
the user, persists execution-affecting values through the frozen Core v1
contract, and never invents Core behavior for values the protocol does not
cover yet.

## Prerequisite

Phases 10–11 and Phase 12 Milestones 0–1 are complete: the thin
downstream, the protocol-only IDE↔Core connection, Home/Welcome actions,
navigation shells, Dashboard/Roadmap/Master/phase-rundown/live-run content
models, first-launch onboarding, and the Open VSX gallery. This milestone
adds no orchestration, scheduling, validation, Master, roadmap-content,
onboarding, gallery, recovery, telemetry-upload, Sparkle, or packaging
changes. Core v1 protocol stays frozen.

## Requirement mapping

| Milestone item                              | Implementation (`apps/ide-extension/src/settings.ts`)                                                                                                                                                                                                                                     |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default execution mode                      | `execution-mode` section; default Phase-by-phase (`phase`); `projects.create` for new projects, `settings.update` for existing ones; safe-boundary for live projects                                                                                                                      |
| Cautious/Standard/Autonomous preset         | `permission-preset` section; default Standard (`standard`); `describePermissionPreset()` explains each preset plus the Autonomous limits; persists via `settings.update permissionPolicy` with actor/reason                                                                               |
| Retry count default (4)                     | `retry-count` section; fixed to `4` (`SETTINGS_FIXED_RETRY_COUNT`, Core `MAX_TASK_ATTEMPTS`); `local-only` display because the frozen Core v1 `settings` schema has no retry field; any other value is rejected, not coerced                                                              |
| Auto-continue after usage returns           | `auto-continue-usage` section; opt-in boolean, default off; `local-only` intent in v1 (Core tracks usage waits internally but exposes no frozen `settings.update` field); never fabricates a reset countdown                                                                              |
| Keep-awake preference                       | `keep-awake-enabled` section; default on for active autonomous/waiting projects; `local-only` intent (acquire/release stays lifecycle-driven)                                                                                                                                             |
| Battery threshold                           | `battery-threshold` section; default 20%, integer 0-100; persists via `settings.update keepAwakeBatteryPolicy`; applies immediately                                                                                                                                                       |
| Preferred agent (Codex only, adapter ID)    | `preferred-agent` section; fixed `"codex"` (`SETTINGS_SUPPORTED_AGENTS`); `local-only` display; any other value rejected                                                                                                                                                                  |
| Validation preferences                      | `validation-preferences` section; fixed task-aware defaults (deterministic required, browser when relevant, independent review for risky/phase-final); Core validation stays authoritative; `local-only` display                                                                          |
| Share optional diagnostics + privacy        | `telemetry` section; default off; `getSettingsPrivacyCopy()` rendered verbatim; Core v1 pins `telemetryEnabled: false` until the P12M4 telemetry implementation, so `true` is local-only and uploads nothing                                                                              |
| Advanced project-specific overrides         | `parseSettingsProjectOverrides()` + `buildSettingsModel()` effective resolution: per-project partial overrides layer over user defaults with an explicit per-setting `user-default` / `project-override` / `core-snapshot` source; telemetry is intentionally not overridable per project |
| Dangerous permission changes explain effect | `riskExplanation` on the permission section plus `describePermissionPreset()` Autonomous limits (AGENTS.md §12 non-overridables); `resolveSettingsUpdatePayload()` requires actor/reason                                                                                                  |
| Project overrides for user defaults         | Effective resolution above; `serialize/parseStoredSettings*` round-trip both layers through host storage                                                                                                                                                                                  |
| Safe boundaries for running projects        | `resolveSettingsEffectiveBoundary(settingId, projectState)`: execution/permission/retry/agent/validation/keep-awake-enable wait for a safe boundary when the project is RUNNING/PAUSED/WAITING_*/BLOCKED; battery/telemetry/auto-continue apply immediately; unknown state waits          |
| Persist through Core/client contracts       | Core-covered fields resolve to a `settings.update` payload (`resolveSettingsUpdatePayload()`); local-only fields resolve to `describeLocalOnlySetting()` reasons and are never sent as Core settings                                                                                      |

## Architecture notes

- **Thin-fork ordering (AGENTS.md §1.3)** is unchanged: zero workbench
  patches. Settings lives in the built-in extension via standard
  contribution mechanisms (`densa-ade.showSettings` command,
  `densa-ade.settings` editor-area `customEditor` with `priority: option`
  and a `*.densa-settings` selector that claims no file ownership).
- **Core stays authoritative and editor-independent.**
  `settings.ts` imports `@densa-ade/protocol` types only — never
  `@densa-ade/core`, `@densa-ade/cli`, SQLite, or `vscode` /
  `vs/workbench`. `npm run ide:check` greps the source (including
  `settings.ts`) for those imports. The module performs no network I/O,
  spawns no processes, and never probes Core by itself; callers supply the
  `settings.get` snapshot and connection/project state.
- **No invented state.** Core-covered effective values cite the
  `settings.get` snapshot when present. Local-only values display their
  `local-only` reason. Usage `resetAt`, token, and cost values do not
  appear. Unknown connection state renders as-is.
- **No second authoritative app state (`SETTINGS_LIFECYCLE`).**
  Opening the surface issues no mutation (`issuesCoreRequest: false`,
  `createsNewAuthoritativeState: false`, `optimisticComplete: false`).
  Applying a change issues one explicit `settings.update` with actor/reason
  and waits for the Core outcome; the caller then rebuilds via
  `buildSettingsModel()` from a fresh `settings.get`.
- **Frozen protocol honored.** `docs/core-v1-protocol.md` freezes existing
  `settings` fields: adding a field requires a new protocol major. This
  milestone therefore does not extend `coreV1SettingsSchema`; the six
  local-only settings stay local with explicit reasons until a future
  protocol addition. `getSettingsAppliesVia()` asserts every Core method
  against `CORE_V1_METHODS`.
- **Auditability.** `SETTINGS_AUDIT` names the open-refresh
  (`settings.get`), capability (`settings.get`, `settings.update`,
  `permissions.resolve`, `events.replay`, `events.subscribe`), and audit
  (`settings.get` + `events.replay`/`subscribe`) methods.
  `resolveSettingsUpdatePayload()` requires actor/reason;
  `resolveSettingsAudit()` returns the replay recipe so a policy change can
  be inspected after it is applied.

## Acceptance mapping

| Acceptance criterion                                            | Evidence                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Defaults match product spec                                     | `scripts/settings-policy-ui.test.mjs`: Phase-by-phase, Standard, retry 4, auto-continue off, keep-awake on, battery 20%, Codex adapter, task-aware validation defaults, telemetry off                                                                                        |
| Settings round-trip after restart                               | Same suite: `serialize/parseStoredSettingsUserDefaults` and `serialize/parseStoredSettingsProjectOverrides` round-trip; malformed/unknown fields throw; version mismatch throws                                                                                              |
| Policy changes are auditable when they affect an active project | Same suite: `resolveSettingsUpdatePayload()` requires actor/reason and emits only Core-covered fields; `resolveSettingsAudit()` names the `settings.get` + `events.replay` recipe; safe-boundary classification forces execution/permission changes on live projects to wait |

## Deferred (not in M2)

Recovery/waiting UX (M3), privacy-conscious telemetry upload (M4),
Sparkle updater and packaging (Phase 13). No protocol-major change, no
retry-budget configurability, no additional agent providers, no validation
weakening, no cloud dependency.
