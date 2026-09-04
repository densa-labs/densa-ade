# Densa ADE telemetry and diagnostics (Phase 12 Milestone 4)

Small, privacy-conscious telemetry for the Densa ADE v1 public release.
Data minimization is structural: the allowlist below is the upload contract,
not guidance. Unknown or forbidden fields are rejected before anything is
queued, and the Settings copy in this file matches
`getTelemetryPrivacyCopy()` / `getSettingsPrivacyCopy()` verbatim in intent.

## Prerequisite

Phases 10–11 and Phase 12 Milestones 0–3 are complete: the thin downstream,
the protocol-only IDE↔Core connection, Home/Welcome actions, navigation
shells, Dashboard/Roadmap/Master/phase-rundown/live-run content models,
first-launch onboarding, the Open VSX gallery, the settings/policy UI, and
recovery/waiting UX. This milestone adds no orchestration, scheduling,
validation, Master, roadmap-content, onboarding-flow, gallery, Sparkle, or
packaging changes. Core v1 protocol stays frozen.

## Gate and defaults

- Setting: IDE-local **Share optional diagnostics** (`telemetryEnabled` in
  `SettingsUserDefaults` / `OnboardingPreferences`).
- Default: **off**. Only an explicit `true` enables optional uploads.
- `appliesVia` stays `local-only`: there is no frozen `settings.update`
  field for this toggle. Core v1 `settings.get` / `settings.update` stay
  `telemetryEnabled: false` (see `docs/core-v1-protocol.md`); changing that
  field requires a new protocol major and is out of scope for v1.
- Disabling stops optional transmission **immediately**, including queued
  batches, including after restart. Flush with a disabled gate drops queued
  batches without calling the uploader.
- Uploads are bounded: at most **100** queued events, **25** per batch,
  **4,096** bytes per encoded event, **5 second** network timeout.
- Failures never block Densa ADE execution. Failed or timed-out batches stay
  queued (bounded) for a later flush; the flush outcome reports the failure
  and the run continues.
- The model performs no network I/O by itself. The host supplies an injected
  `TelemetryUploader(batch)`; tests use `createFakeTelemetryUploader()`.
- Implementation: `apps/ide-extension/src/telemetry.ts` (centralized,
  protocol-only, no `@densa-ade/core` / `@densa-ade/cli` / SQLite / `vscode`
  imports, no `fetch` / `XMLHttpRequest`).

## Settings copy (rendered verbatim)

> Share optional diagnostics is off by default. When on, Densa ADE uploads
> only allowlisted optional events (app/Core version with coarse macOS and
> CPU architecture, execution mode, project run started and phase/milestone
> completed or failed, retry occurrence with attempt number, validator
> category with pass/fail/advisory, adapter identifier with structured error
> code, recovery outcome, updater check/update outcome, and high-level
> Dashboard/Roadmap/Master surface usage).
>
> Densa ADE never uploads source code, file contents,
> project/specification/roadmap content, filenames, absolute paths, Git
> remote URLs, repository or project names, prompts, Master conversations,
> worker transcripts, environment variables, secrets, credentials, or Codex
> authentication data as ordinary telemetry. Optional events carry no
> free-form text, no identifiers, and no output; unknown or forbidden fields
> are rejected before anything is queued.
>
> Disabling stops optional transmission immediately, including queued batches
> even after restart. Uploads are bounded (at most 100 queued events, 25 per
> batch, 5 second timeout) and failures never block Densa ADE execution. The
> anonymous installation identifier is an optional random value with no user
> tracking; clearing it rotates the identity. Essential operational traffic
> required for update delivery, compatibility, or local reliability is
> minimized and documented separately; Sparkle update traffic is not
> described as optional telemetry.

## Optional events (v1 allowlist)

Every event: `{ version: 1, name, occurredAt (ISO-8601), installationId?
(UUID v4, optional), context, properties }`. Context is identical for all
events. Properties are per-event allowlists below; any other key throws.

Common context:

| Field         | Values                              | Purpose                                         |
| ------------- | ----------------------------------- | ----------------------------------------------- |
| `appVersion`  | dotted `x.y.z`, `dev`, or `unknown` | Coarse compatibility without build identity     |
| `coreVersion` | dotted `x.y.z`, `dev`, or `unknown` | Core/IDE compatibility check                    |
| `platform`    | `darwin`, `unknown`                 | v1 is macOS-only; unknown means unobserved      |
| `arch`        | `arm64`, `x64`, `unknown`           | Coarse CPU compatibility without fingerprinting |

| Event                         | Properties                                                                                                                      | Purpose                                                                        | Category |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------- |
| `project.run.started`         | `executionMode` (guided/phase/continuous), `adapterId` (codex)                                                                  | Count project runs by execution mode without identifying the project.          | optional |
| `project.phase.completed`     | `executionMode`, `adapterId`                                                                                                    | Count phase completions by execution mode without phase content.               | optional |
| `project.phase.failed`        | `executionMode`, `adapterId`, `errorCode` (structured code below)                                                               | Count phase failures by execution mode with a structured error code.           | optional |
| `project.milestone.completed` | `executionMode`, `adapterId`                                                                                                    | Count milestone completions by execution mode without milestone content.       | optional |
| `project.milestone.failed`    | `executionMode`, `adapterId`, `errorCode`                                                                                       | Count milestone failures by execution mode with a structured error code.       | optional |
| `task.retry.occurred`         | `attemptNumber` (1–4), `errorCode`                                                                                              | Measure retry occurrence with the bounded attempt number and error code.       | optional |
| `validation.completed`        | `validatorCategory` (build/typecheck/lint/unit_test/integration_test/browser/acceptance/review), `outcome` (pass/fail/advisory) | Measure validator category pass/fail without commands, output, or paths.       | optional |
| `agent.run.finished`          | `adapterId`, `outcome` (success/failure/cancelled/usage_limited/auth_required/unknown), `errorCode?`                            | Measure worker outcomes by adapter with a structured error code when relevant. | optional |
| `core.recovery.completed`     | `recoveryOutcome` (recovered/blocked/waiting/unknown), `errorCode?`                                                             | Measure crash/restart recovery outcomes without workspace or log content.      | optional |
| `updater.check.completed`     | `outcome` (up_to_date/update_available/failed)                                                                                  | Measure update-check outcomes. The Sparkle fetch itself is essential traffic.  | optional |
| `updater.update.completed`    | `outcome` (success/failure/cancelled)                                                                                           | Measure update-install outcomes. Installation still needs explicit approval.   | optional |
| `surface.opened`              | `surface` (dashboard/roadmap/master)                                                                                            | Measure high-level Dashboard/Roadmap/Master usage without content.             | optional |

Structured `errorCode` values (from `@densa-ade/protocol`):

`USER_CONFIGURATION_ERROR`, `AGENT_UNAVAILABLE`,
`AUTHENTICATION_REQUIRED`, `USAGE_LIMITED`, `PERMISSION_DENIED`,
`PROCESS_FAILURE`, `VALIDATION_FAILURE`, `WORKSPACE_CONFLICT`,
`GIT_FAILURE`, `PERSISTENCE_FAILURE`, `PROTOCOL_VERSION_MISMATCH`,
`INVALID_STATE_TRANSITION`, `INTERNAL_INVARIANT_VIOLATION`.

## Essential operational traffic (separately classified, minimized)

Not optional telemetry. Never gated by the toggle, never counted as
diagnostics sharing, and documented here so update traffic is not
mislabeled.

| Traffic                  | Purpose                                                               | Minimized to                                                             |
| ------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `sparkle-appcast-fetch`  | Secure macOS updates: fetch the HTTPS appcast and signed artifacts    | Only the version check and signed download Sparkle requires              |
| `open-vsx-gallery-fetch` | Search/install compatible extensions when the user asks               | Only the gallery query the user triggered                                |
| `local-reliability`      | Local crash/restart bookkeeping so recovery can classify the last run | Stays on this Mac (SQLite, event journal, checkpoints); nothing uploaded |

## Retention assumptions

- Optional queue: in-memory plus host-storage serialization for restart
  tests; bounded to 100 events. Oldest drops first when full; `droppedCount`
  records the drops.
- Upload batches: at most 25 events per flush; timed-out or failed batches
  are retained (bounded) for a later flush, never retried in a tight loop.
- Installation identifier: host storage under
  `densa-ade.telemetry.installation-id.v1`; random UUID v4, deletable and
  rotatable by clearing that key. Uploads proceed without it when absent.
- No server retention is promised here: v1 defines the client allowlist,
  bounds, and disablement. Any future backend must retain only these
  allowlisted fields in aggregate.

## Explicitly never collected as ordinary telemetry

Source code, file contents, project/specification/roadmap content,
filenames, absolute paths, Git remote URLs, repository names, project
names, other repository identity, project/phase/task/attempt/validation
identifiers, prompts, user-entered natural language, Master Agent
conversations, worker transcripts, environment variables, secrets, API
keys, credentials, cookies/tokens, Codex authentication data,
personal/account identity, arbitrary command stdout/stderr, unsanitized raw
crash dumps, stack traces, raw log bodies, and any free-form text. There is
no free-form string field in any v1 event: values are enums, bounded
integers 1–4, dotted versions, or UUIDs. Strings carrying `/`, `\`,
newlines, `@`, `://`, remote markers, or known credential shapes
(`sk-…`, `AKIA…`, `gh…`, `glpat-…`, `xox…`, JWT, `Bearer …`, private-key
blocks, `<secret>` / `[secret:`) are rejected before queueing.

## Acceptance mapping

| Acceptance criterion                                                     | Evidence                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Optional events transmit only when enabled                               | `scripts/telemetry.test.mjs`: disabled enqueue drops; disabled flush drops queued batches without calling the uploader                                                                                                               |
| Disabling stops transmission including after restart with queued batches | Same suite: serialize → parse → flush disabled drops, uploader not called                                                                                                                                                            |
| Essential traffic separately classified, minimized, documented           | Same suite: `TELEMETRY_ESSENTIAL_TRAFFIC` lists Sparkle/Open VSX/local-only; Sparkle never appears in the optional catalog; privacy copy says Sparkle traffic is not optional telemetry                                              |
| Schema/allowlist rejects unknown or forbidden properties                 | Same suite: unknown event, unknown property, and every forbidden key throws; oversized events throw                                                                                                                                  |
| Forbidden data cannot enter an upload                                    | Same suite: source code, prompts, project/repository identity, paths, Git remotes, secrets, auth data, command output, and crash dumps all throw via key or value checks                                                             |
| Bounded retry/storage survives network failure without affecting a run   | Same suite: failing and hanging uploaders retain the bounded batch, flush never throws, batch size capped at 25, queue capped at 100                                                                                                 |
| Settings state, privacy language, and docs match behavior                | Same suite: defaults off, gate parsing, `local-only` appliesVia, Core snapshot stays `false`, settings privacy copy equals telemetry privacy copy, docs list every event/properties/purpose/category/retention/NOT-collected section |
