# Recovery and waiting UX (Phase 12 Milestone 3)

Recoverable product states for the thin Code-OSS downstream. Crashes, usage
waits, and blocked states render as explicit cards with persisted evidence
and next actions instead of mysterious failures.

## Prerequisite

Phases 10–11 and Phase 12 Milestones 0–2 are complete: the thin downstream,
the protocol-only IDE↔Core connection, Home/Welcome actions, navigation
shells, Dashboard/Roadmap/Master/phase-rundown/live-run content models,
first-launch onboarding, the Open VSX gallery, and the settings/policy UI.
This milestone adds no orchestration, scheduling, validation, Master,
roadmap-content, onboarding, gallery, telemetry-upload, Sparkle, or packaging
changes. Core v1 protocol stays frozen.

## Requirement mapping

| Milestone item                           | Implementation (`apps/ide-extension/src/recovery.ts`)                                                                                                                                                                                        |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core disconnected/reconnecting           | `core-disconnected` / `core-reconnecting` cards from `connectionState`; last known `projects.get` sequence is labeled stale, not fresh; `resolveRecoveryReconnect()` is transport-only and appends no fact                                   |
| Interrupted task recovered after restart | `interrupted-recovered` card whenever the snapshot holds `INTERRUPTED` tasks; `restartObserved` adds the restart sentence, otherwise the card says interruption without claiming a restart; drill-downs to `attempts.list` + `logs.list`     |
| Workspace divergence requiring review    | `workspace-divergence` card when `git.status` shows changes while the project is `PAUSED`/`WAITING_*`/`BLOCKED`; resume needs `acknowledgeIntervention`, otherwise Core returns `INTERVENTION_REQUIRED`; manual edits are never overwritten  |
| `WAITING_FOR_USAGE` with known `resetAt` | `waiting-for-usage-known-reset` card only when the effective usage (`usage.get` wins over `dashboard`/`snapshot`) is `limited` with a carried `resetAt`; the timestamp renders verbatim with no countdown math                               |
| `WAITING_FOR_USAGE` with unknown reset   | `waiting-for-usage-unknown` card when usage is `limited` without `resetAt` or `unknown`; the card says unknown, shows no countdown, and explains conservative probing                                                                        |
| Auto-resume enabled/disabled             | Local-only `autoResumeEnabled` intent on both waiting cards plus `resolveRecoveryAutoResumeIntent()`; no frozen `settings.update` field is fabricated                                                                                        |
| `BLOCKED` after retries                  | `blocked-after-retries` card when the project or any task is `BLOCKED`; retry/failure counts, blocked IDs, and preserved diagnostics; retries need new evidence                                                                              |
| Authentication required                  | `codex-auth-required` card only when the reliably observed Codex check is `required`; `unknown` renders as unknown and never guesses                                                                                                         |
| Permission/user decision required        | `permission-required` card for `permission` approvals and `user-decision-required` card for task/phase/revision approvals or `WAITING_FOR_USER`; resolvers map to `permissions.resolve`, `tasks.approve`, `phases.approve` with actor/reason |
| Never show a fake countdown              | Waiting cards carry `resetAt` only when observed; unknown cards assert no countdown language in tests                                                                                                                                        |
| Show what was safely persisted           | Every card carries `persisted[]`: project state + sequence, event journal, Git HEAD when observed, attempt/validation counts, usage observation                                                                                              |
| Clear next actions                       | Every card carries `nextActions[]` naming the Core-backed step (replay, usage inspect, checkpoint verify, resume/approve with audit)                                                                                                         |
| Diagnostics accessible but not dumped    | Every card carries `drilldowns[]` to frozen-catalog reads plus `diagnosticsHint`; raw logs and transcripts are never inlined                                                                                                                 |

## Architecture notes

- **Thin-fork ordering (AGENTS.md §1.3)** is unchanged: zero workbench
  patches. Recovery content lives in the built-in extension and reuses the
  M3 `densa-ade.dashboard` editor-area tab (`RECOVERY_HOST_VIEW_TYPE`).
  No new commands, activity-bar entries, or `customEditors` viewTypes.
- **Core stays authoritative and editor-independent.**
  `recovery.ts` imports `@densa-ade/protocol` types only — never
  `@densa-ade/core`, `@densa-ade/cli`, SQLite, or `vscode` /
  `vs/workbench`. The module performs no network I/O, spawns no processes,
  and never probes Core by itself; callers supply the `projects.get`,
  `dashboard.get`, `usage.get`, `git.status`, and `events.replay` facts plus
  the observed connection/Codex-auth state.
- **No invented state.** Project-boundary disagreements, missing runtime
  rows, and unknown states throw with a "refresh … before rendering" hint.
  Usage reset, token, and cost values do not appear unless observed.
  `autoResumeEnabled` is explicitly local-only.
- **No second authoritative app state (`RECOVERY_LIFECYCLE`).**
  Opening the surface issues no mutation (`issuesCoreRequest: false`,
  `createsNewAuthoritativeState: false`, `optimisticComplete: false`).
  Resolvers return Core payloads or local-only recipes; only Core outcomes
  and `core.event` refresh hints change what is shown.
  `applyRecoveryControlOutcome()` maps `UNCHANGED` to an idempotent no-op.
- **Frozen protocol honored.** `RECOVERY_OPEN_REFRESH_METHODS` and
  `RECOVERY_CAPABILITY_METHODS` assert every method against
  `CORE_V1_METHODS`. No new Core v1 method is added; reconnect and
  auto-resume intent are intentionally non-Core recipes.
- **Waiting vs broken is explicit.** Card tones are `waiting`, `attention`,
  `broken`, `offline`, or `ok`; the model `summary` derives the overall tone
  with broken > offline > attention > waiting > ok and titles it
  ("Waiting, not broken", "Needs intervention", "Core unreachable",
  "Needs review", "Steady") so the user can tell waiting from broken.

## Acceptance mapping

| Acceptance criterion                                | Evidence                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Each state can be reproduced with fixtures          | `scripts/recovery-waiting-ux.test.mjs`: one fixture per `RECOVERY_KINDS` entry (offline, reconnecting, version-mismatch, auth-failed, Codex-auth-required, interrupted, divergence, waiting-known, waiting-unknown × auto-resume on/off, blocked, permission, user-decision, steady)                     |
| Reconnect/restart does not create duplicate actions | Same suite: `resolveRecoveryReopenRefresh()` names the replay-then-subscribe recipe; `recoveryEventIsRefreshHint()` keeps notifications as hints; `applyRecoveryControlOutcome()` maps `UNCHANGED` to idempotent; live-Core round-trip repeats pause and asserts `UNCHANGED` plus preserved manual edits |
| User can distinguish waiting from broken            | Same suite: waiting cards assert tone `waiting` with "not broken" copy and no countdown; blocked cards assert tone `broken` with "not waiting" copy; offline cards assert tone `offline` with stale-truth copy; the summary derives the overall tone in priority order                                   |

## Deferred (not in M3)

Privacy-conscious telemetry upload (M4), Sparkle updater and packaging
(Phase 13). Waiting cards expose the `usage.get` observation and the
local-only auto-resume intent those milestones need but upload nothing.
