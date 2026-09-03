# Densa ADE onboarding (Phase 12 Milestone 0)

First-launch flow: Densa ADE opens in a compact onboarding window, checks local
prerequisites and product defaults, then transitions/resizes into the normal
full IDE workspace.

## Prerequisite

Phases 10–11 are complete: the thin downstream, the protocol-only IDE↔Core
connection, Home/Welcome actions, navigation shells, and Dashboard/Roadmap/
Master/phase-rundown/live-run content models. This milestone adds no
orchestration, scheduling, validation, Master, or roadmap-content changes.

## Requirement mapping

| Milestone item                                 | Implementation                                                                                                                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compact onboarding window                      | `densa-ade.showOnboarding` + `densa-ade.onboarding` editor-area view (`apps/ide-extension/src/onboarding.ts`, manifest `commands`/`customEditors` with `priority: option`) |
| Codex detected/version                         | `codex` step from the caller-observed `OnboardingCodexCheck`; version shown only when reliably observed                                                                    |
| Codex auth readiness where reliably detectable | `codex-auth` step from `OnboardingCodexAuthCheck`; defaults to `unknown`, never scrapes presentation text                                                                  |
| Git availability                               | `git` step from `OnboardingGitCheck`                                                                                                                                       |
| Default execution mode                         | `execution-mode` step; default Phase-by-phase (`phase`) via `getOnboardingDefaults()`                                                                                      |
| Default permissions preset                     | `permissions` step; default Standard (`standard`); Autonomous limits documented in-step                                                                                    |
| Keep-awake preference                          | `keep-awake` step; default enabled for active autonomous/waiting projects subject to battery policy (minimum 20%)                                                          |
| Share optional diagnostics                     | `telemetry` step; default off; `true` is local-only until the P12M4 telemetry implementation (Core v1 `settings` pins `telemetryEnabled: false`)                           |
| Transition/resize to full workspace            | `resolveOnboardingTransition()` returns `resize-to-full-workspace` (`compact-onboarding` → `full-workspace`); host resizes, the extension disposes the view handle only    |
| Skip nonessential integrations                 | Every step is `skippable: true`, `blocksCompletion: false`; `canSkip: true`                                                                                                |
| Usable as editor when Codex unavailable        | Every step is `blocksEditor: false`; `editorAvailable: true` always; missing Codex yields install/setup guidance                                                           |

## Architecture notes

- **Core stays authoritative and editor-independent.** `onboarding.ts` imports
  `@densa-ade/protocol` types only — never `@densa-ade/core`, `@densa-ade/cli`,
  SQLite, or `vscode` / `vs/workbench`. `npm run ide:check` greps the source
  (including `onboarding.ts`) for those imports.
- **No invented state.** Environment facts are caller-supplied. Codex auth and
  Codex presence report `unknown` when not reliably observed. Usage/reset,
  token, and cost values do not appear in this milestone at all.
- **No second authoritative app state (`ONBOARDING_LIFECYCLE`).**
  `createsNewAuthoritativeState: false`, `issuesCoreRequest: false`.
  Completing onboarding persists one IDE-local record under
  `ONBOARDING_STORAGE_KEY` (host storage such as `globalState`) and resizes
  the host window. `projects.create` / `settings.update` apply the recorded
  defaults later for a persisted project; the transition itself creates no
  project and needs no `projectId`.
- **Completion persists, reopening skips unless reset.**
  `serializeOnboardingCompletion()` / `parseOnboardingStoredState()` round-trip
  the record; `shouldShowOnboarding()` drives the window mode;
  `resolveOnboardingReopen()` documents skip-vs-show; `resetOnboarding()`
  clears explicitly.
- **Thin-fork ordering (AGENTS.md §1.3)** is unchanged: zero workbench patches.
  Onboarding lives in the built-in extension via standard contribution
  mechanisms (`commands`, `customEditors`). Window resizing is host-driven
  from the transition descriptor.

## Acceptance mapping

| Acceptance criterion                                                      | Evidence                                                                                                                                                   |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Onboarding completion persists                                            | `scripts/onboarding.test.mjs`: serialize → parse → `shouldShowOnboarding() === false` round-trip                                                           |
| Resizing/transition does not create a second authoritative app state      | Same suite: transition has `createsNewAuthoritativeState: false`, `issuesCoreRequest: false`, `requiresProjectId: false`, `disposes: onboarding-view-only` |
| Reopening skips onboarding unless reset                                   | Same suite: `resolveOnboardingReopen()` skips when completed, shows when absent, shows again after `resetOnboarding()`                                     |
| Missing Codex gives install/setup guidance without blocking basic editing | Same suite: unavailable Codex yields guidance, `blocksEditor: false`, `editorAvailable: true`, `canComplete: true`                                         |

## Deferred (not in M0)

Open VSX gallery (M1), settings/policy UI (M2), recovery/waiting UX (M3),
privacy-conscious telemetry upload (M4), Sparkle updater and packaging
(Phase 13). The `*.densa-onboarding` filename pattern is a non-default
selector reserving the viewType; it claims no file ownership.
