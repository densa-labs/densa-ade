// Copyright 2026 Densa Labs
// SPDX-License-Identifier: Apache-2.0

/**
 * Densa ADE first-launch onboarding and resize transition (Phase 12 Milestone 0).
 *
 * The first-launch flow answers: "Is Densa ADE ready for me, and what happens
 * next?" Densa ADE opens in a compact onboarding window, checks the local
 * prerequisites, records the product defaults, and then transitions/resizes
 * into the normal full IDE workspace.
 *
 * This module is pure and protocol-only:
 *
 * - it imports `@densa-ade/protocol` types only, never `@densa-ade/core`,
 *   `@densa-ade/cli`, SQLite, or `vscode` / `vs/workbench`;
 * - environment observations (`codex`, `codexAuth`, `git`, `coreState`) are
 *   caller-supplied facts. This module never spawns processes, never probes
 *   the network, and never invents auth/usage state: anything that was not
 *   reliably observed is reported as `unknown` with an explicit reason;
 * - project truth stays in Densa ADE Core. Completing onboarding persists a
 *   single IDE-local completion record (host storage such as `globalState`)
 *   and returns a resize descriptor. The transition disposes the onboarding
 *   view handle only, issues no Core request, creates no project, and never
 *   becomes a second authoritative app state;
 * - execution-affecting defaults (`executionMode`, `permissionPreset`,
 *   keep-awake battery policy) apply later through the versioned Core v1
 *   operations (`projects.create` / `settings.update`). Telemetry stays off
 *   by default; the "Share optional diagnostics" toggle is IDE-local until
 *   the Phase 12 Milestone 4 telemetry implementation lands (Core v1
 *   `settings` currently pins `telemetryEnabled: false`);
 * - Densa ADE remains usable as an editor even when Codex is unavailable.
 *   Every step reports `blocksEditor: false`; a missing Codex produces
 *   install/setup guidance, never a hard block.
 *
 * Standard VS Code contribution mechanisms only (AGENTS.md §1.3): the compact
 * window is the `densa-ade.onboarding` editor-area view opened via
 * `densa-ade.showOnboarding` (`priority: option`, never a default file
 * association). Window resizing itself is host-driven from the transition
 * descriptor below. Zero workbench patches.
 */

import {
  CORE_V1_METHODS,
  type CoreV1Method,
  type ExecutionMode,
  type PermissionPolicyPreset,
} from "@densa-ade/protocol";

/** Command that opens the compact onboarding window. */
export const ONBOARDING_COMMAND = "densa-ade.showOnboarding" as const;

/** Editor-area viewType hosting onboarding content beside source tabs. */
export const ONBOARDING_EDITOR_VIEW_TYPE = "densa-ade.onboarding" as const;

/** Host-storage key for the IDE-local completion record. */
export const ONBOARDING_STORAGE_KEY = "densa-ade.onboarding.completed.v1" as const;

export const ONBOARDING_VERSION = 1 as const;

/** Product defaults from the Phase 12 Milestone 0 spec. */
export const ONBOARDING_DEFAULT_EXECUTION_MODE: ExecutionMode = "phase";
export const ONBOARDING_DEFAULT_PERMISSION_PRESET: PermissionPolicyPreset = "standard";
export const ONBOARDING_DEFAULT_KEEP_AWAKE_ENABLED = true as const;
export const ONBOARDING_DEFAULT_KEEP_AWAKE_MINIMUM_BATTERY_PERCENT = 20 as const;
export const ONBOARDING_DEFAULT_TELEMETRY_ENABLED = false as const;

/** Window mode driven by the onboarding completion record. */
export type OnboardingWindowMode = "compact-onboarding" | "full-workspace";

export type OnboardingConnectionState =
  "disconnected" | "connecting" | "connected" | "version-mismatch" | "auth-failed";

export type OnboardingCodexStatus = "available" | "unavailable" | "unknown";
export type OnboardingCodexAuthStatus = "ready" | "required" | "unknown";
export type OnboardingStepStatus = "ready" | "attention" | "unknown";

export type OnboardingStepId =
  "codex" | "codex-auth" | "git" | "execution-mode" | "permissions" | "keep-awake" | "telemetry";

/** Reliably observed Codex CLI presence. `unknown` means not observed, never guessed. */
export interface OnboardingCodexCheck {
  readonly status: OnboardingCodexStatus;
  /** CLI version only when reliably observed (status `available`). */
  readonly version?: string;
  /** Verbatim detail (e.g. CLI output tail or probe error), when available. */
  readonly detail?: string;
}

/**
 * Reliably observed Codex authentication readiness. `unknown` is the honest
 * default when the installed CLI exposes no stable auth signal: Densa ADE
 * never scrapes presentation text to claim `ready` or `required`.
 */
export interface OnboardingCodexAuthCheck {
  readonly status: OnboardingCodexAuthStatus;
  readonly detail?: string;
}

export interface OnboardingGitCheck {
  readonly available: boolean;
  readonly detail: string;
}

export interface OnboardingPreferences {
  readonly executionMode: ExecutionMode;
  readonly permissionPreset: PermissionPolicyPreset;
  readonly keepAwakeEnabled: boolean;
  readonly keepAwakeMinimumBatteryPercent: number;
  /**
   * IDE-local "Share optional diagnostics" toggle. Off by default. Core v1
   * `settings` pins `telemetryEnabled: false` until the Phase 12 Milestone 4
   * telemetry implementation lands, so `true` is recorded locally only and
   * never presented as Core-honored.
   */
  readonly telemetryEnabled: boolean;
}

export interface OnboardingStep {
  readonly id: OnboardingStepId;
  readonly title: string;
  readonly status: OnboardingStepStatus;
  /** Human-readable fact or explicitly-unknown statement. */
  readonly detail: string;
  /** Actionable next step, present when the user should do something. */
  readonly guidance?: string;
  /** True when the user may skip this integration and finish anyway. */
  readonly skippable: boolean;
  /** Always false: onboarding never blocks basic editing. */
  readonly blocksEditor: false;
  /** Always false: every check degrades to guidance, never a hard gate. */
  readonly blocksCompletion: false;
}

export interface OnboardingModelInput {
  readonly codex: OnboardingCodexCheck;
  readonly codexAuth: OnboardingCodexAuthCheck;
  readonly git: OnboardingGitCheck;
  readonly coreState?: OnboardingConnectionState;
  readonly coreDetail?: string;
  readonly preferences?: Partial<OnboardingPreferences>;
  readonly stored?: unknown;
}

export interface OnboardingModel {
  readonly windowMode: OnboardingWindowMode;
  readonly steps: readonly OnboardingStep[];
  readonly preferences: OnboardingPreferences;
  readonly completed: boolean;
  /** Always true: the editor works even when Codex/Core is unavailable. */
  readonly editorAvailable: true;
  /** Always false: onboarding never gates standard editing. */
  readonly blocksEditor: false;
  /** True when the current model may be completed (always true for valid prefs). */
  readonly canComplete: true;
  /** True: nonessential integrations may be skipped. */
  readonly canSkip: true;
  readonly connectionState: OnboardingConnectionState;
  readonly storageKey: typeof ONBOARDING_STORAGE_KEY;
  readonly lifecycle: typeof ONBOARDING_LIFECYCLE;
}

/**
 * Disposable-view lifecycle contract. The onboarding window is a transient
 * view handle: completing or closing it resizes to the full workspace and
 * never creates, moves, or forks authoritative project state.
 */
export const ONBOARDING_LIFECYCLE = Object.freeze({
  /** The compact window renders as a transient onboarding view. */
  windowMode: "compact-onboarding",
  /** Completion resizes into the normal full IDE workspace. */
  completionMode: "full-workspace",
  /** Closing/completing disposes the local onboarding view handle only. */
  closeDisposes: "view-handle-only",
  /** Core keeps running while project policy allows it. */
  coreContinuesAfterClose: true,
  /** Onboarding never creates a second authoritative app state. */
  createsNewAuthoritativeState: false,
  /** Completing onboarding issues no Core request by itself. */
  issuesCoreRequest: false,
  /** The UI never marks work complete optimistically. */
  optimisticComplete: false,
});

export interface OnboardingStoredState {
  readonly version: typeof ONBOARDING_VERSION;
  readonly completed: boolean;
  readonly completedAt?: string;
}

export interface OnboardingTransition {
  readonly action: "resize-to-full-workspace";
  readonly from: "compact-onboarding";
  readonly to: "full-workspace";
  /** Closing/completing disposes the local onboarding view handle only. */
  readonly disposes: "onboarding-view-only";
  /** Never true: the transition is view-only, Core stays authoritative. */
  readonly createsNewAuthoritativeState: false;
  /** Never true: completion persists locally and resizes; no Core mutation. */
  readonly issuesCoreRequest: false;
  /** Never true: onboarding completion needs no persisted project. */
  readonly requiresProjectId: false;
  readonly coreContinues: true;
  readonly reason: string;
}

export interface OnboardingProjectDefaults {
  readonly executionMode: ExecutionMode;
  readonly permissionPreset: PermissionPolicyPreset;
  readonly keepAwakeEnabled: boolean;
  readonly keepAwakeMinimumBatteryPercent: number;
  readonly telemetryEnabled: boolean;
  /**
   * Where each default applies. Execution-affecting defaults flow through
   * the frozen Core v1 catalog; telemetry is local-only until the P12M4
   * telemetry implementation lands.
   */
  readonly appliesVia: Readonly<Record<string, CoreV1Method | "local-only">>;
  readonly reason: string;
}

const EXECUTION_MODES: readonly ExecutionMode[] = Object.freeze(["guided", "phase", "continuous"]);

const PERMISSION_PRESETS: readonly PermissionPolicyPreset[] = Object.freeze([
  "cautious",
  "standard",
  "autonomous",
]);

const CONNECTION_STATES: readonly OnboardingConnectionState[] = Object.freeze([
  "disconnected",
  "connecting",
  "connected",
  "version-mismatch",
  "auth-failed",
]);

const STEP_IDS: readonly OnboardingStepId[] = Object.freeze([
  "codex",
  "codex-auth",
  "git",
  "execution-mode",
  "permissions",
  "keep-awake",
  "telemetry",
]);

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKnownMethod(method: string): asserts method is CoreV1Method {
  if ((CORE_V1_METHODS as readonly string[]).includes(method) !== true) {
    throw new Error(`Onboarding surface maps to unknown Core method ${method}.`);
  }
}

function parseBatteryPercent(value: unknown, field: string): number {
  if (typeof value !== "number" || Number.isInteger(value) !== true || value < 0 || value > 100) {
    throw new Error(`Onboarding ${field} must be an integer 0-100.`);
  }
  return value;
}

function parseIsoTimestamp(value: unknown, field: string): string {
  if (isNonEmptyText(value) !== true || Number.isFinite(Date.parse(value.trim())) !== true) {
    throw new Error(`Onboarding ${field} must be an ISO-8601 timestamp.`);
  }
  return value.trim();
}

/** Product defaults: Phase-by-phase, Standard, keep-awake on, telemetry off. */
export function getOnboardingDefaults(): OnboardingPreferences {
  return Object.freeze({
    executionMode: ONBOARDING_DEFAULT_EXECUTION_MODE,
    permissionPreset: ONBOARDING_DEFAULT_PERMISSION_PRESET,
    keepAwakeEnabled: ONBOARDING_DEFAULT_KEEP_AWAKE_ENABLED,
    keepAwakeMinimumBatteryPercent: ONBOARDING_DEFAULT_KEEP_AWAKE_MINIMUM_BATTERY_PERCENT,
    telemetryEnabled: ONBOARDING_DEFAULT_TELEMETRY_ENABLED,
  });
}

/**
 * Validate caller-supplied preferences over the product defaults. Unknown or
 * malformed fields throw instead of being silently coerced.
 */
export function parseOnboardingPreferences(value: unknown): OnboardingPreferences {
  const defaults = getOnboardingDefaults();
  if (value === undefined) {
    return defaults;
  }
  if (isRecord(value) !== true) {
    throw new Error("Onboarding preferences must be an object.");
  }
  const executionMode =
    value["executionMode"] === undefined ? defaults.executionMode : value["executionMode"];
  if ((EXECUTION_MODES as readonly string[]).includes(executionMode as string) !== true) {
    throw new Error("Onboarding executionMode must be guided, phase, or continuous.");
  }
  const permissionPreset =
    value["permissionPreset"] === undefined ? defaults.permissionPreset : value["permissionPreset"];
  if ((PERMISSION_PRESETS as readonly string[]).includes(permissionPreset as string) !== true) {
    throw new Error("Onboarding permissionPreset must be cautious, standard, or autonomous.");
  }
  const keepAwakeEnabled =
    value["keepAwakeEnabled"] === undefined ? defaults.keepAwakeEnabled : value["keepAwakeEnabled"];
  if (typeof keepAwakeEnabled !== "boolean") {
    throw new Error("Onboarding keepAwakeEnabled must be a boolean.");
  }
  const keepAwakeMinimumBatteryPercent =
    value["keepAwakeMinimumBatteryPercent"] === undefined
      ? defaults.keepAwakeMinimumBatteryPercent
      : value["keepAwakeMinimumBatteryPercent"];
  const telemetryEnabled =
    value["telemetryEnabled"] === undefined ? defaults.telemetryEnabled : value["telemetryEnabled"];
  if (typeof telemetryEnabled !== "boolean") {
    throw new Error("Onboarding telemetryEnabled must be a boolean.");
  }
  return Object.freeze({
    executionMode: executionMode as ExecutionMode,
    permissionPreset: permissionPreset as PermissionPolicyPreset,
    keepAwakeEnabled,
    keepAwakeMinimumBatteryPercent: parseBatteryPercent(
      keepAwakeMinimumBatteryPercent,
      "keepAwakeMinimumBatteryPercent",
    ),
    telemetryEnabled,
  });
}

function parseCodexCheck(value: unknown): OnboardingCodexCheck {
  if (isRecord(value) !== true) {
    throw new Error("Onboarding codex check must be an object.");
  }
  const status = value["status"];
  if (status !== "available" && status !== "unavailable" && status !== "unknown") {
    throw new Error("Onboarding codex status must be available, unavailable, or unknown.");
  }
  const version = value["version"];
  if (version !== undefined && isNonEmptyText(version) !== true) {
    throw new Error("Onboarding codex version must be non-empty text when present.");
  }
  const detail = value["detail"];
  if (detail !== undefined && typeof detail !== "string") {
    throw new Error("Onboarding codex detail must be text when present.");
  }
  if (status !== "available" && version !== undefined) {
    throw new Error("Onboarding codex version must only accompany an available Codex.");
  }
  return Object.freeze({
    status,
    ...(version === undefined ? {} : { version: (version as string).trim() }),
    ...(detail === undefined ? {} : { detail: detail as string }),
  });
}

function parseCodexAuthCheck(value: unknown): OnboardingCodexAuthCheck {
  if (isRecord(value) !== true) {
    throw new Error("Onboarding codex auth check must be an object.");
  }
  const status = value["status"];
  if (status !== "ready" && status !== "required" && status !== "unknown") {
    throw new Error("Onboarding codex auth status must be ready, required, or unknown.");
  }
  const detail = value["detail"];
  if (detail !== undefined && typeof detail !== "string") {
    throw new Error("Onboarding codex auth detail must be text when present.");
  }
  return Object.freeze({
    status,
    ...(detail === undefined ? {} : { detail: detail as string }),
  });
}

function parseGitCheck(value: unknown): OnboardingGitCheck {
  if (isRecord(value) !== true) {
    throw new Error("Onboarding git check must be an object.");
  }
  if (typeof value["available"] !== "boolean") {
    throw new Error("Onboarding git available must be a boolean.");
  }
  if (typeof value["detail"] !== "string" || (value["detail"] as string).trim().length === 0) {
    throw new Error("Onboarding git detail must be non-empty text.");
  }
  return Object.freeze({
    available: value["available"] as boolean,
    detail: (value["detail"] as string).trim(),
  });
}

/**
 * Parse the IDE-local completion record. Malformed records are rejected so a
 * corrupt flag can never skip onboarding silently; callers treat a throw as
 * "show onboarding".
 */
export function parseOnboardingStoredState(value: unknown): OnboardingStoredState {
  if (value === undefined || value === null) {
    return Object.freeze({ version: ONBOARDING_VERSION, completed: false });
  }
  if (isRecord(value) !== true) {
    throw new Error("Onboarding stored state must be an object.");
  }
  if (value["version"] !== ONBOARDING_VERSION) {
    throw new Error("Onboarding stored state version is unsupported.");
  }
  if (typeof value["completed"] !== "boolean") {
    throw new Error("Onboarding stored completed must be a boolean.");
  }
  const completed = value["completed"] as boolean;
  if (value["completedAt"] === undefined) {
    return Object.freeze({ version: ONBOARDING_VERSION, completed });
  }
  return Object.freeze({
    version: ONBOARDING_VERSION,
    completed,
    completedAt: parseIsoTimestamp(value["completedAt"], "completedAt"),
  });
}

/** Serialize a completion record for host storage (e.g. `globalState`). */
export function serializeOnboardingCompletion(completedAt: string): OnboardingStoredState {
  return Object.freeze({
    version: ONBOARDING_VERSION,
    completed: true,
    completedAt: parseIsoTimestamp(completedAt, "completedAt"),
  });
}

/** True when the compact onboarding window must be shown. */
export function shouldShowOnboarding(stored: unknown): boolean {
  let parsed: OnboardingStoredState;
  try {
    parsed = parseOnboardingStoredState(stored);
  } catch {
    return true;
  }
  return parsed.completed !== true;
}

function codexStep(check: OnboardingCodexCheck): OnboardingStep {
  if (check.status === "available") {
    const versionSuffix =
      check.version === undefined ? "" : ` Detected version: ${check.version.trim()}.`;
    return Object.freeze({
      id: "codex",
      title: "Codex detected",
      status: "ready",
      detail: `Codex CLI is available.${versionSuffix} Worker execution can use the authenticated Codex CLI.`,
      skippable: true,
      blocksEditor: false,
      blocksCompletion: false,
    });
  }
  if (check.status === "unavailable") {
    return Object.freeze({
      id: "codex",
      title: "Codex not detected",
      status: "attention",
      detail:
        "Codex was not detected on PATH. Densa ADE remains usable as an editor; worker execution waits until Codex is installed.",
      guidance:
        "Install the official Codex CLI, authenticate with the official Codex client/CLI, then re-run onboarding checks. Standard editor actions (Open Folder, Open File, Dashboard/Roadmap viewing of persisted projects) remain available.",
      skippable: true,
      blocksEditor: false,
      blocksCompletion: false,
    });
  }
  return Object.freeze({
    id: "codex",
    title: "Codex status unknown",
    status: "unknown",
    detail:
      "Codex presence could not be reliably observed. Densa ADE does not guess; basic editing remains available.",
    guidance:
      "Optionally install the official Codex CLI and re-run onboarding checks, or skip and continue editing.",
    skippable: true,
    blocksEditor: false,
    blocksCompletion: false,
  });
}

function codexAuthStep(
  check: OnboardingCodexAuthCheck,
  codex: OnboardingCodexCheck,
): OnboardingStep {
  if (check.status === "ready") {
    return Object.freeze({
      id: "codex-auth",
      title: "Codex authentication ready",
      status: "ready",
      detail: "Codex authentication looks ready from a reliable signal.",
      skippable: true,
      blocksEditor: false,
      blocksCompletion: false,
    });
  }
  if (check.status === "required") {
    return Object.freeze({
      id: "codex-auth",
      title: "Codex authentication required",
      status: "attention",
      detail:
        "Codex authentication is required before worker execution. Basic editing remains available.",
      guidance:
        "Authenticate with the official Codex client/CLI. Densa ADE never scrapes browser cookies or stores ChatGPT passwords.",
      skippable: true,
      blocksEditor: false,
      blocksCompletion: false,
    });
  }
  const codexSuffix =
    codex.status === "unavailable"
      ? " Codex itself was not detected, so authentication cannot be ready yet."
      : " Only stable CLI signals count; presentation text is never scraped.";
  return Object.freeze({
    id: "codex-auth",
    title: "Codex authentication unknown",
    status: "unknown",
    detail: `Codex authentication readiness is unknown and is reported as unknown.${codexSuffix} Basic editing remains available.`,
    guidance:
      "Optionally authenticate with the official Codex client/CLI and re-run onboarding checks, or skip and continue editing.",
    skippable: true,
    blocksEditor: false,
    blocksCompletion: false,
  });
}

function gitStep(check: OnboardingGitCheck): OnboardingStep {
  if (check.available === true) {
    return Object.freeze({
      id: "git",
      title: "Git available",
      status: "ready",
      detail: `Git is available (${check.detail}). Checkpoints and task commits can be created.`,
      skippable: true,
      blocksEditor: false,
      blocksCompletion: false,
    });
  }
  return Object.freeze({
    id: "git",
    title: "Git unavailable",
    status: "attention",
    detail: `Git was not found (${check.detail}). Checkpoints and task commits wait until Git is installed; basic editing remains available.`,
    guidance:
      "Install Git, then re-run onboarding checks. Standard editor actions remain available.",
    skippable: true,
    blocksEditor: false,
    blocksCompletion: false,
  });
}

function executionModeStep(preferences: OnboardingPreferences): OnboardingStep {
  const label =
    preferences.executionMode === "phase"
      ? "Phase-by-phase"
      : preferences.executionMode === "guided"
        ? "Guided"
        : "Continuous";
  return Object.freeze({
    id: "execution-mode",
    title: `Default execution mode: ${label}`,
    status: "ready",
    detail: `New projects default to ${label} (${preferences.executionMode}). The mode can be switched at a safe boundary and persists through Core.`,
    skippable: true,
    blocksEditor: false,
    blocksCompletion: false,
  });
}

function permissionsStep(preferences: OnboardingPreferences): OnboardingStep {
  const label =
    preferences.permissionPreset === "standard"
      ? "Standard"
      : preferences.permissionPreset === "cautious"
        ? "Cautious"
        : "Autonomous";
  return Object.freeze({
    id: "permissions",
    title: `Default permissions: ${label}`,
    status: "ready",
    detail: `New projects default to the ${label} preset (${preferences.permissionPreset}). Even Autonomous never silently authorizes privilege escalation, destructive operations outside the workspace, unrelated file access, credential disclosure, secret export, remote pushes, or major scope changes.`,
    skippable: true,
    blocksEditor: false,
    blocksCompletion: false,
  });
}

function keepAwakeStep(preferences: OnboardingPreferences): OnboardingStep {
  if (preferences.keepAwakeEnabled !== true) {
    return Object.freeze({
      id: "keep-awake",
      title: "Keep-awake disabled",
      status: "ready",
      detail:
        "Built-in macOS keep-awake is disabled by preference. Long autonomous runs may sleep with the system.",
      guidance:
        "Enable keep-awake to let opted-in runs prevent idle system sleep (display sleep still allowed).",
      skippable: true,
      blocksEditor: false,
      blocksCompletion: false,
    });
  }
  return Object.freeze({
    id: "keep-awake",
    title: "Keep-awake enabled",
    status: "ready",
    detail: `Built-in macOS keep-awake is enabled for active autonomous/waiting projects, subject to the battery policy (minimum ${String(preferences.keepAwakeMinimumBatteryPercent)}%). Idle system sleep is prevented while active; display sleep stays allowed and the assertion releases immediately when no longer needed.`,
    skippable: true,
    blocksEditor: false,
    blocksCompletion: false,
  });
}

function telemetryStep(preferences: OnboardingPreferences): OnboardingStep {
  if (preferences.telemetryEnabled !== true) {
    return Object.freeze({
      id: "telemetry",
      title: "Share optional diagnostics: off",
      status: "ready",
      detail:
        "Optional diagnostics sharing is off. Only essential operational data required for update delivery, compatibility, or local reliability may exist; Sparkle update traffic is not described as optional telemetry.",
      skippable: true,
      blocksEditor: false,
      blocksCompletion: false,
    });
  }
  return Object.freeze({
    id: "telemetry",
    title: "Share optional diagnostics: on (local-only until telemetry lands)",
    status: "unknown",
    detail:
      "Optional diagnostics was toggled on locally, but Core v1 settings pin telemetryEnabled to false until the Phase 12 Milestone 4 telemetry implementation lands. Nothing is uploaded by this milestone; the toggle is recorded locally only.",
    guidance:
      "Leave this off unless testing the future telemetry milestone. Disabling stops local recording immediately.",
    skippable: true,
    blocksEditor: false,
    blocksCompletion: false,
  });
}

/**
 * Build the first-launch model from reliably observed environment facts plus
 * validated preferences. Nothing here blocks the editor: every step reports
 * `blocksEditor: false`, and `canComplete`/`canSkip` are always true for
 * valid preferences so optional integrations can be skipped.
 */
export function buildOnboardingModel(input: OnboardingModelInput): OnboardingModel {
  const codex = parseCodexCheck(input.codex);
  const codexAuth = parseCodexAuthCheck(input.codexAuth);
  const git = parseGitCheck(input.git);
  const connectionState =
    input.coreState === undefined ? ("disconnected" as const) : input.coreState;
  if ((CONNECTION_STATES as readonly string[]).includes(connectionState) !== true) {
    throw new Error("Onboarding coreState must be a known connection state.");
  }
  const preferences = parseOnboardingPreferences(input.preferences ?? getOnboardingDefaults());
  const stored = parseOnboardingStoredState(input.stored);
  const completed = stored.completed === true;
  const steps = Object.freeze([
    codexStep(codex),
    codexAuthStep(codexAuth, codex),
    gitStep(git),
    executionModeStep(preferences),
    permissionsStep(preferences),
    keepAwakeStep(preferences),
    telemetryStep(preferences),
  ]);
  const ids = steps.map((step) => step.id);
  if (new Set(ids).size !== STEP_IDS.length || STEP_IDS.every((id) => ids.includes(id)) !== true) {
    throw new Error("Onboarding model must cover every first-launch check exactly once.");
  }
  for (const step of steps) {
    if (step.blocksEditor !== false || step.blocksCompletion !== false) {
      throw new Error("Onboarding steps must never block the editor or completion.");
    }
  }
  return Object.freeze({
    windowMode: (completed === true
      ? "full-workspace"
      : "compact-onboarding") as OnboardingWindowMode,
    steps,
    preferences,
    completed,
    editorAvailable: true as const,
    blocksEditor: false as const,
    canComplete: true as const,
    canSkip: true as const,
    connectionState,
    storageKey: ONBOARDING_STORAGE_KEY,
    lifecycle: ONBOARDING_LIFECYCLE,
  });
}

/**
 * Resolve completing (or skipping) onboarding to the resize transition. The
 * transition is view-only: it disposes the onboarding handle, resizes the
 * host window to the full workspace, and creates no Core/project state.
 */
export function resolveOnboardingTransition(
  input: {
    readonly completedAt?: string;
    readonly reason?: string;
  } = {},
): { readonly stored: OnboardingStoredState; readonly transition: OnboardingTransition } {
  const completedAt =
    input.completedAt === undefined ? new Date().toISOString() : input.completedAt;
  const stored = serializeOnboardingCompletion(parseIsoTimestamp(completedAt, "completedAt"));
  const reason = isNonEmptyText(input.reason)
    ? (input.reason as string).trim()
    : "Onboarding completed. Resizing from the compact onboarding window into the normal full IDE workspace.";
  return Object.freeze({
    stored,
    transition: Object.freeze({
      action: "resize-to-full-workspace",
      from: "compact-onboarding",
      to: "full-workspace",
      disposes: "onboarding-view-only",
      createsNewAuthoritativeState: false,
      issuesCoreRequest: false,
      requiresProjectId: false,
      coreContinues: true,
      reason,
    }),
  });
}

/** Reopening recipe: completed records skip onboarding unless explicitly reset. */
export function resolveOnboardingReopen(stored: unknown): {
  readonly action: "skip-onboarding" | "show-onboarding";
  readonly windowMode: OnboardingWindowMode;
  readonly reason: string;
} {
  if (shouldShowOnboarding(stored) !== true) {
    return Object.freeze({
      action: "skip-onboarding",
      windowMode: "full-workspace",
      reason: "Onboarding already completed. Reopening skips onboarding unless reset.",
    });
  }
  return Object.freeze({
    action: "show-onboarding",
    windowMode: "compact-onboarding",
    reason: "Onboarding not yet completed. Opening the compact onboarding window.",
  });
}

/** Clear the completion record so onboarding shows again (explicit reset only). */
export function resetOnboarding(): OnboardingStoredState {
  return Object.freeze({ version: ONBOARDING_VERSION, completed: false });
}

/**
 * Resolve validated onboarding preferences to the Core operations that will
 * honor them. Execution-affecting defaults flow through the frozen Core v1
 * catalog (`projects.create` for the new-project execution mode,
 * `settings.update` for permission/keep-awake policy); telemetry is
 * local-only until the P12M4 telemetry implementation lands. The IDE never
 * fabricates IDs: callers supply the persisted projectId at apply time.
 */
export function resolveOnboardingProjectDefaults(
  preferencesInput: Partial<OnboardingPreferences> = {},
): OnboardingProjectDefaults {
  const preferences = parseOnboardingPreferences({
    ...getOnboardingDefaults(),
    ...preferencesInput,
  });
  assertKnownMethod("projects.create");
  assertKnownMethod("settings.update");
  return Object.freeze({
    executionMode: preferences.executionMode,
    permissionPreset: preferences.permissionPreset,
    keepAwakeEnabled: preferences.keepAwakeEnabled,
    keepAwakeMinimumBatteryPercent: preferences.keepAwakeMinimumBatteryPercent,
    telemetryEnabled: preferences.telemetryEnabled,
    appliesVia: Object.freeze({
      executionMode: "projects.create",
      permissionPreset: "settings.update",
      keepAwake: "settings.update",
      telemetry: "local-only",
    }) as Readonly<Record<string, CoreV1Method | "local-only">>,
    reason:
      "Apply executionMode at projects.create time and permission/keep-awake policy through settings.update for the persisted project. Telemetry stays local-only until the Phase 12 Milestone 4 telemetry implementation lands (Core v1 settings pin telemetryEnabled to false).",
  });
}
