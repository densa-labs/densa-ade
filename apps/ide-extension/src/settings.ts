// Copyright 2026 Densa Labs
// SPDX-License-Identifier: Apache-2.0

/**
 * Densa ADE settings and policy UI (Phase 12 Milestone 2).
 *
 * The settings surface answers: "How is Densa ADE configured, and what will
 * change if I change it?" It exposes the v1 configuration from the milestone
 * spec without overwhelming the user: default execution mode, permission
 * preset, retry default, auto-continue after usage, keep-awake preference,
 * battery threshold, preferred agent, validation preferences, optional
 * diagnostics, and advanced per-project overrides.
 *
 * This module is pure and protocol-only:
 *
 * - it imports `@densa-ade/protocol` types only, never `@densa-ade/core`,
 *   `@densa-ade/cli`, SQLite, or `vscode` / `vs/workbench`;
 * - execution-affecting values that Core v1 honors flow through the frozen
 *   Core v1 catalog (`projects.create` for the new-project execution mode,
 *   `settings.get` / `settings.update` for execution mode, permission policy,
 *   and keep-awake battery policy, `permissions.resolve` for individual
 *   permission approvals, `events.replay` / `events.subscribe` for audit).
 *   The IDE never writes execution state to hidden UI storage;
 * - values with no frozen Core v1 field stay explicitly `local-only` and say
 *   so. Core v1 `settings` is frozen (see `docs/core-v1-protocol.md`): adding
 *   a field requires a new protocol major. This module never pretends a
 *   local-only value is Core-honored. In v1 Core enforces a fixed retry
 *   budget of 4 (`MAX_TASK_ATTEMPTS`), supports Codex only (`codex` adapter
 *   id), keeps task-aware validation authoritative, and pins
 *   `telemetryEnabled` to `false` until the Phase 12 Milestone 4 telemetry
 *   implementation lands;
 * - the UI never marks settings applied optimistically. Resolvers return Core
 *   request payloads to send; only Core outcomes and `core.event`
 *   notifications change what is shown (`SETTINGS_LIFECYCLE` below);
 * - dangerous permission changes explain their effect before they can be
 *   applied, including the Autonomous limits from AGENTS.md §12;
 * - project settings override user defaults. Overrides resolve to one
 *   effective value per setting with an explicit per-setting source;
 * - setting changes that affect a running project apply at a safe boundary
 *   where required instead of mutating mid-flight context.
 *
 * Standard VS Code contribution mechanisms only (AGENTS.md §1.3): the surface
 * renders as the `densa-ade.settings` editor-area tab opened via
 * `densa-ade.showSettings` (`priority: option`, never a default file
 * association). Zero workbench patches.
 */

import {
  CORE_V1_METHODS,
  type CoreV1Method,
  type CoreV1Result,
  type ExecutionMode,
  type PermissionPolicyPreset,
  type ProjectState,
} from "@densa-ade/protocol";

/** Command that opens the settings editor-area tab. */
export const SETTINGS_COMMAND = "densa-ade.showSettings" as const;

/** Editor-area viewType hosting settings content beside source tabs. */
export const SETTINGS_EDITOR_VIEW_TYPE = "densa-ade.settings" as const;

/** Host-storage key for IDE-local user defaults (global settings). */
export const SETTINGS_STORAGE_KEY = "densa-ade.settings.user-defaults.v1" as const;

/** Host-storage key for IDE-local per-project overrides. */
export const SETTINGS_PROJECT_OVERRIDES_STORAGE_KEY =
  "densa-ade.settings.project-overrides.v1" as const;

export const SETTINGS_VERSION = 1 as const;

/** Product defaults from the Phase 12 Milestone 2 spec. */
export const SETTINGS_DEFAULT_EXECUTION_MODE: ExecutionMode = "phase";
export const SETTINGS_DEFAULT_PERMISSION_PRESET: PermissionPolicyPreset = "standard";
export const SETTINGS_DEFAULT_RETRY_COUNT = 4 as const;
export const SETTINGS_DEFAULT_AUTO_CONTINUE_AFTER_USAGE = false as const;
export const SETTINGS_DEFAULT_KEEP_AWAKE_ENABLED = true as const;
export const SETTINGS_DEFAULT_KEEP_AWAKE_MINIMUM_BATTERY_PERCENT = 20 as const;
export const SETTINGS_DEFAULT_PREFERRED_AGENT = "codex" as const;
export const SETTINGS_DEFAULT_TELEMETRY_ENABLED = false as const;

/** Fixed v1 retry budget enforced by Core (`MAX_TASK_ATTEMPTS`). */
export const SETTINGS_FIXED_RETRY_COUNT = 4 as const;

/** Only agent adapter honored in v1. The ID is used, not a display name. */
export const SETTINGS_SUPPORTED_AGENTS = Object.freeze(["codex"] as const);
export type SettingsPreferredAgent = (typeof SETTINGS_SUPPORTED_AGENTS)[number];

/** Setting identifiers exposed by this surface. */
export type SettingsSettingId =
  | "execution-mode"
  | "permission-preset"
  | "retry-count"
  | "auto-continue-usage"
  | "keep-awake-enabled"
  | "battery-threshold"
  | "preferred-agent"
  | "validation-preferences"
  | "telemetry";

/** Where an effective value is persisted/honored. */
export type SettingsAppliesVia = CoreV1Method | "local-only";

/** When a change takes effect for a running project. */
export type SettingsEffectiveBoundary = "immediate" | "safe-boundary";

/** Which layer supplied the effective value. */
export type SettingsValueSource = "user-default" | "project-override" | "core-snapshot";

/** Validation preference defaults: task-aware deterministic validation stays authoritative. */
export interface SettingsValidationPreferences {
  readonly deterministicRequired: true;
  readonly browserWhenRelevant: true;
  readonly independentReviewForRiskyAndPhaseFinal: true;
}

export function getDefaultValidationPreferences(): SettingsValidationPreferences {
  return Object.freeze({
    deterministicRequired: true as const,
    browserWhenRelevant: true as const,
    independentReviewForRiskyAndPhaseFinal: true as const,
  });
}

/** User-level defaults (global settings). */
export interface SettingsUserDefaults {
  readonly executionMode: ExecutionMode;
  readonly permissionPreset: PermissionPolicyPreset;
  readonly retryCount: number;
  readonly autoContinueAfterUsage: boolean;
  readonly keepAwakeEnabled: boolean;
  readonly keepAwakeMinimumBatteryPercent: number;
  readonly preferredAgent: SettingsPreferredAgent;
  readonly validationPreferences: SettingsValidationPreferences;
  readonly telemetryEnabled: boolean;
}

/** Per-project overrides layered over the user defaults. */
export interface SettingsProjectOverrides {
  readonly executionMode?: ExecutionMode;
  readonly permissionPreset?: PermissionPolicyPreset;
  readonly retryCount?: number;
  readonly autoContinueAfterUsage?: boolean;
  readonly keepAwakeEnabled?: boolean;
  readonly keepAwakeMinimumBatteryPercent?: number;
  readonly preferredAgent?: SettingsPreferredAgent;
  readonly validationPreferences?: SettingsValidationPreferences;
}

export type SettingsConnectionState =
  "disconnected" | "connecting" | "connected" | "version-mismatch" | "auth-failed";

/** Authoritative Core v1 settings snapshot, when the project was read. */
export type SettingsCoreSnapshot = CoreV1Result<"settings.get">;

export interface SettingsFieldDescriptor {
  readonly id: SettingsSettingId;
  readonly title: string;
  readonly detail: string;
  /** Frozen-catalog method(s) honoring the field, or `local-only`. */
  readonly appliesVia: SettingsAppliesVia;
  /** Effect boundary for a running project. */
  readonly boundary: SettingsEffectiveBoundary;
  /** True when changing the value needs an explicit actor and reason. */
  readonly requiresActorReason: boolean;
  /** Present when the change carries elevated risk. */
  readonly riskExplanation?: string;
}

export interface SettingsEffectiveValue {
  readonly id: SettingsSettingId;
  readonly value: unknown;
  readonly display: string;
  readonly source: SettingsValueSource;
  readonly appliesVia: SettingsAppliesVia;
  readonly boundary: SettingsEffectiveBoundary;
}

export interface SettingsModel {
  readonly version: typeof SETTINGS_VERSION;
  readonly sections: readonly SettingsFieldDescriptor[];
  readonly userDefaults: SettingsUserDefaults;
  readonly projectOverrides: SettingsProjectOverrides;
  readonly effective: Readonly<Record<SettingsSettingId, SettingsEffectiveValue>>;
  readonly connectionState: SettingsConnectionState;
  readonly storageKey: typeof SETTINGS_STORAGE_KEY;
  readonly projectOverridesStorageKey: typeof SETTINGS_PROJECT_OVERRIDES_STORAGE_KEY;
  readonly lifecycle: typeof SETTINGS_LIFECYCLE;
  readonly audit: typeof SETTINGS_AUDIT;
  readonly privacyCopy: string;
}

export interface SettingsModelInput {
  readonly userDefaults?: Partial<SettingsUserDefaultsInput>;
  readonly projectOverrides?: SettingsProjectOverridesInput;
  readonly coreSettings?: unknown;
  readonly projectState?: ProjectState | undefined;
  readonly connectionState?: SettingsConnectionState;
}

/** Lenient caller-supplied shapes; validated strictly before use. */
export interface SettingsUserDefaultsInput {
  readonly executionMode?: unknown;
  readonly permissionPreset?: unknown;
  readonly retryCount?: unknown;
  readonly autoContinueAfterUsage?: unknown;
  readonly keepAwakeEnabled?: unknown;
  readonly keepAwakeMinimumBatteryPercent?: unknown;
  readonly preferredAgent?: unknown;
  readonly validationPreferences?: unknown;
  readonly telemetryEnabled?: unknown;
}

export interface SettingsProjectOverridesInput {
  readonly executionMode?: unknown;
  readonly permissionPreset?: unknown;
  readonly retryCount?: unknown;
  readonly autoContinueAfterUsage?: unknown;
  readonly keepAwakeEnabled?: unknown;
  readonly keepAwakeMinimumBatteryPercent?: unknown;
  readonly preferredAgent?: unknown;
  readonly validationPreferences?: unknown;
}

/**
 * Disposable-view lifecycle contract. Opening settings reads Core snapshots
 * but mutates nothing; applying a change issues an explicit versioned Core
 * request and waits for the Core outcome.
 */
export const SETTINGS_LIFECYCLE = Object.freeze({
  /** Settings close disposes the local view handle only. */
  closeDisposes: "view-handle-only",
  /** Core keeps running while project policy allows it. */
  coreContinuesAfterClose: true,
  /** Settings state never becomes a second authoritative project state. */
  createsNewAuthoritativeState: false,
  /** Opening the surface issues no mutation; applying uses `settings.update`. */
  issuesCoreRequest: false,
  /** The UI never marks a setting applied optimistically. */
  optimisticComplete: false,
});

/** Audit contract: policy-affecting changes are recorded Core facts. */
export const SETTINGS_AUDIT = Object.freeze({
  /** Actor and reason are required for every `settings.update`. */
  requiresActorReason: true,
  /** Frozen-catalog reads backing first render and every reopen. */
  openRefreshMethods: Object.freeze(["settings.get"] as const),
  /** Frozen-catalog operations the surface may use once open. */
  capabilityMethods: Object.freeze([
    "settings.get",
    "settings.update",
    "permissions.resolve",
    "events.replay",
    "events.subscribe",
  ] as const),
  /** Audit trail for an applied change. */
  auditMethods: Object.freeze(["settings.get", "events.replay", "events.subscribe"] as const),
});

/** Snapshot reads backing first render and every reopen. */
export const SETTINGS_OPEN_REFRESH_METHODS: readonly CoreV1Method[] =
  SETTINGS_AUDIT.openRefreshMethods;

/** Frozen-catalog operations the settings surface may use once open. */
export const SETTINGS_CAPABILITY_METHODS: readonly CoreV1Method[] =
  SETTINGS_AUDIT.capabilityMethods;

const EXECUTION_MODES: readonly ExecutionMode[] = Object.freeze(["guided", "phase", "continuous"]);

const PERMISSION_PRESETS: readonly PermissionPolicyPreset[] = Object.freeze([
  "cautious",
  "standard",
  "autonomous",
]);

const CONNECTION_STATES: readonly SettingsConnectionState[] = Object.freeze([
  "disconnected",
  "connecting",
  "connected",
  "version-mismatch",
  "auth-failed",
]);

const SETTING_IDS: readonly SettingsSettingId[] = Object.freeze([
  "execution-mode",
  "permission-preset",
  "retry-count",
  "auto-continue-usage",
  "keep-awake-enabled",
  "battery-threshold",
  "preferred-agent",
  "validation-preferences",
  "telemetry",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function assertKnownMethod(method: string): asserts method is CoreV1Method {
  if ((CORE_V1_METHODS as readonly string[]).includes(method) !== true) {
    throw new Error(`Settings surface maps to unknown Core method ${method}.`);
  }
}

function parseBatteryPercent(value: unknown, field: string): number {
  if (typeof value !== "number" || Number.isInteger(value) !== true || value < 0 || value > 100) {
    throw new Error(`Settings ${field} must be an integer 0-100.`);
  }
  return value;
}

function parseIsoTimestamp(value: unknown, field: string): string {
  if (isNonEmptyText(value) !== true || Number.isFinite(Date.parse(value.trim())) !== true) {
    throw new Error(`Settings ${field} must be an ISO-8601 timestamp.`);
  }
  return value.trim();
}

/** Product defaults: Phase-by-phase, Standard, retry 4, opt-in resume off, keep-awake on. */
export function getSettingsDefaults(): SettingsUserDefaults {
  return Object.freeze({
    executionMode: SETTINGS_DEFAULT_EXECUTION_MODE,
    permissionPreset: SETTINGS_DEFAULT_PERMISSION_PRESET,
    retryCount: SETTINGS_DEFAULT_RETRY_COUNT,
    autoContinueAfterUsage: SETTINGS_DEFAULT_AUTO_CONTINUE_AFTER_USAGE,
    keepAwakeEnabled: SETTINGS_DEFAULT_KEEP_AWAKE_ENABLED,
    keepAwakeMinimumBatteryPercent: SETTINGS_DEFAULT_KEEP_AWAKE_MINIMUM_BATTERY_PERCENT,
    preferredAgent: SETTINGS_DEFAULT_PREFERRED_AGENT,
    validationPreferences: getDefaultValidationPreferences(),
    telemetryEnabled: SETTINGS_DEFAULT_TELEMETRY_ENABLED,
  });
}

function parseExecutionMode(value: unknown): ExecutionMode {
  if ((EXECUTION_MODES as readonly string[]).includes(value as string) !== true) {
    throw new Error("Settings executionMode must be guided, phase, or continuous.");
  }
  return value as ExecutionMode;
}

function parsePermissionPreset(value: unknown): PermissionPolicyPreset {
  if ((PERMISSION_PRESETS as readonly string[]).includes(value as string) !== true) {
    throw new Error("Settings permissionPreset must be cautious, standard, or autonomous.");
  }
  return value as PermissionPolicyPreset;
}

function parseRetryCount(value: unknown): number {
  if (typeof value !== "number" || Number.isInteger(value) !== true) {
    throw new Error("Settings retryCount must be an integer.");
  }
  // Core v1 enforces a fixed budget of 4 attempts (AGENTS.md §9). The frozen
  // Core v1 `settings` schema has no retry field, so only 4 is honest in v1.
  if (value !== SETTINGS_FIXED_RETRY_COUNT) {
    throw new Error(
      `Settings retryCount is fixed to ${String(SETTINGS_FIXED_RETRY_COUNT)} in v1; Core enforces 4 attempts with no protocol field to change it.`,
    );
  }
  return value;
}

function parsePreferredAgent(value: unknown): SettingsPreferredAgent {
  if ((SETTINGS_SUPPORTED_AGENTS as readonly string[]).includes(value as string) !== true) {
    throw new Error(
      'Settings preferredAgent must be "codex" in v1; only the Codex adapter exists.',
    );
  }
  return value as SettingsPreferredAgent;
}

function parseValidationPreferences(value: unknown): SettingsValidationPreferences {
  if (value === undefined) {
    return getDefaultValidationPreferences();
  }
  if (isRecord(value) !== true) {
    throw new Error("Settings validationPreferences must be an object.");
  }
  // Task-aware deterministic defaults are the only honest v1 value: Core
  // validation stays authoritative and the frozen protocol exposes no
  // validation-preference field. Unknown keys are rejected, not ignored.
  const allowed = new Set([
    "deterministicRequired",
    "browserWhenRelevant",
    "independentReviewForRiskyAndPhaseFinal",
  ]);
  for (const key of Object.keys(value)) {
    if (allowed.has(key) !== true) {
      throw new Error(`Settings validationPreferences has an unknown field ${key}.`);
    }
  }
  const defaults = getDefaultValidationPreferences();
  const deterministicRequired =
    value["deterministicRequired"] === undefined
      ? defaults.deterministicRequired
      : value["deterministicRequired"];
  const browserWhenRelevant =
    value["browserWhenRelevant"] === undefined
      ? defaults.browserWhenRelevant
      : value["browserWhenRelevant"];
  const independentReviewForRiskyAndPhaseFinal =
    value["independentReviewForRiskyAndPhaseFinal"] === undefined
      ? defaults.independentReviewForRiskyAndPhaseFinal
      : value["independentReviewForRiskyAndPhaseFinal"];
  if (
    deterministicRequired !== true ||
    browserWhenRelevant !== true ||
    independentReviewForRiskyAndPhaseFinal !== true
  ) {
    throw new Error(
      "Settings validationPreferences are fixed to task-aware defaults in v1; Core validation stays authoritative with no protocol field to weaken it.",
    );
  }
  return getDefaultValidationPreferences();
}

function parseBooleanField(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Settings ${field} must be a boolean.`);
  }
  return value;
}

/**
 * Validate caller-supplied user defaults over the product defaults. Unknown
 * or malformed fields throw instead of being silently coerced.
 */
export function parseSettingsUserDefaults(value: unknown): SettingsUserDefaults {
  const defaults = getSettingsDefaults();
  if (value === undefined) {
    return defaults;
  }
  if (isRecord(value) !== true) {
    throw new Error("Settings user defaults must be an object.");
  }
  const allowed = new Set([
    "executionMode",
    "permissionPreset",
    "retryCount",
    "autoContinueAfterUsage",
    "keepAwakeEnabled",
    "keepAwakeMinimumBatteryPercent",
    "preferredAgent",
    "validationPreferences",
    "telemetryEnabled",
  ]);
  for (const key of Object.keys(value)) {
    if (allowed.has(key) !== true) {
      throw new Error(`Settings user defaults has an unknown field ${key}.`);
    }
  }
  return Object.freeze({
    executionMode:
      value["executionMode"] === undefined
        ? defaults.executionMode
        : parseExecutionMode(value["executionMode"]),
    permissionPreset:
      value["permissionPreset"] === undefined
        ? defaults.permissionPreset
        : parsePermissionPreset(value["permissionPreset"]),
    retryCount:
      value["retryCount"] === undefined
        ? defaults.retryCount
        : parseRetryCount(value["retryCount"]),
    autoContinueAfterUsage:
      value["autoContinueAfterUsage"] === undefined
        ? defaults.autoContinueAfterUsage
        : parseBooleanField(value["autoContinueAfterUsage"], "autoContinueAfterUsage"),
    keepAwakeEnabled:
      value["keepAwakeEnabled"] === undefined
        ? defaults.keepAwakeEnabled
        : parseBooleanField(value["keepAwakeEnabled"], "keepAwakeEnabled"),
    keepAwakeMinimumBatteryPercent:
      value["keepAwakeMinimumBatteryPercent"] === undefined
        ? defaults.keepAwakeMinimumBatteryPercent
        : parseBatteryPercent(
            value["keepAwakeMinimumBatteryPercent"],
            "keepAwakeMinimumBatteryPercent",
          ),
    preferredAgent:
      value["preferredAgent"] === undefined
        ? defaults.preferredAgent
        : parsePreferredAgent(value["preferredAgent"]),
    validationPreferences: parseValidationPreferences(value["validationPreferences"]),
    telemetryEnabled:
      value["telemetryEnabled"] === undefined
        ? defaults.telemetryEnabled
        : parseBooleanField(value["telemetryEnabled"], "telemetryEnabled"),
  });
}

/**
 * Validate per-project overrides. Every field is optional; present fields
 * obey the same strict rules as user defaults. Telemetry is intentionally
 * absent: optional diagnostics are a global privacy choice, not a per-project
 * override.
 */
export function parseSettingsProjectOverrides(value: unknown): SettingsProjectOverrides {
  if (value === undefined || value === null) {
    return Object.freeze({});
  }
  if (isRecord(value) !== true) {
    throw new Error("Settings project overrides must be an object.");
  }
  const allowed = new Set([
    "executionMode",
    "permissionPreset",
    "retryCount",
    "autoContinueAfterUsage",
    "keepAwakeEnabled",
    "keepAwakeMinimumBatteryPercent",
    "preferredAgent",
    "validationPreferences",
  ]);
  for (const key of Object.keys(value)) {
    if (allowed.has(key) !== true) {
      throw new Error(`Settings project overrides has an unknown field ${key}.`);
    }
  }
  const result: Record<string, unknown> = {};
  if (value["executionMode"] !== undefined) {
    result["executionMode"] = parseExecutionMode(value["executionMode"]);
  }
  if (value["permissionPreset"] !== undefined) {
    result["permissionPreset"] = parsePermissionPreset(value["permissionPreset"]);
  }
  if (value["retryCount"] !== undefined) {
    result["retryCount"] = parseRetryCount(value["retryCount"]);
  }
  if (value["autoContinueAfterUsage"] !== undefined) {
    result["autoContinueAfterUsage"] = parseBooleanField(
      value["autoContinueAfterUsage"],
      "autoContinueAfterUsage",
    );
  }
  if (value["keepAwakeEnabled"] !== undefined) {
    result["keepAwakeEnabled"] = parseBooleanField(value["keepAwakeEnabled"], "keepAwakeEnabled");
  }
  if (value["keepAwakeMinimumBatteryPercent"] !== undefined) {
    result["keepAwakeMinimumBatteryPercent"] = parseBatteryPercent(
      value["keepAwakeMinimumBatteryPercent"],
      "keepAwakeMinimumBatteryPercent",
    );
  }
  if (value["preferredAgent"] !== undefined) {
    result["preferredAgent"] = parsePreferredAgent(value["preferredAgent"]);
  }
  if (value["validationPreferences"] !== undefined) {
    result["validationPreferences"] = parseValidationPreferences(value["validationPreferences"]);
  }
  return Object.freeze(result) as SettingsProjectOverrides;
}

/** Serialize user defaults for host storage (e.g. `globalState`). */
export function serializeSettingsUserDefaults(
  defaults: SettingsUserDefaults,
): Record<string, unknown> {
  const parsed = parseSettingsUserDefaults({ ...defaults });
  return Object.freeze({
    version: SETTINGS_VERSION,
    updatedAt: new Date().toISOString(),
    values: { ...parsed },
  });
}

/** Parse a stored user-defaults record. Malformed records throw. */
export function parseStoredSettingsUserDefaults(value: unknown): SettingsUserDefaults {
  if (value === undefined || value === null) {
    return getSettingsDefaults();
  }
  if (isRecord(value) !== true) {
    throw new Error("Stored settings must be an object.");
  }
  if (value["version"] !== SETTINGS_VERSION) {
    throw new Error("Stored settings version is unsupported.");
  }
  if (value["values"] === undefined) {
    return getSettingsDefaults();
  }
  return parseSettingsUserDefaults(value["values"]);
}

/** Serialize per-project overrides for host storage. */
export function serializeSettingsProjectOverrides(
  overridesByProject: Readonly<Record<string, SettingsProjectOverrides>>,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [projectId, overrides] of Object.entries(overridesByProject)) {
    if (isNonEmptyText(projectId) !== true) {
      throw new Error("Project override keys must be non-empty project IDs.");
    }
    values[projectId.trim()] = { ...parseSettingsProjectOverrides(overrides) };
  }
  return Object.freeze({
    version: SETTINGS_VERSION,
    updatedAt: new Date().toISOString(),
    values: Object.freeze(values),
  });
}

/** Parse a stored per-project overrides record. Malformed records throw. */
export function parseStoredSettingsProjectOverrides(
  value: unknown,
): Record<string, SettingsProjectOverrides> {
  if (value === undefined || value === null) {
    return Object.freeze({});
  }
  if (isRecord(value) !== true) {
    throw new Error("Stored project overrides must be an object.");
  }
  if (value["version"] !== SETTINGS_VERSION) {
    throw new Error("Stored project overrides version is unsupported.");
  }
  if (value["values"] === undefined) {
    return Object.freeze({});
  }
  if (isRecord(value["values"]) !== true) {
    throw new Error("Stored project overrides values must be an object.");
  }
  const result: Record<string, SettingsProjectOverrides> = {};
  for (const [projectId, overrides] of Object.entries(value["values"])) {
    result[projectId] = parseSettingsProjectOverrides(overrides);
  }
  return Object.freeze(result);
}

/**
 * Where each setting is honored. Core-covered fields name the frozen method;
 * everything else is honestly `local-only` because the frozen Core v1
 * `settings` schema has no such field (a new protocol major is required to
 * add one).
 */
export function getSettingsAppliesVia(): Readonly<Record<SettingsSettingId, SettingsAppliesVia>> {
  assertKnownMethod("projects.create");
  assertKnownMethod("settings.update");
  assertKnownMethod("settings.get");
  return Object.freeze({
    "execution-mode": "settings.update",
    "permission-preset": "settings.update",
    "retry-count": "local-only",
    "auto-continue-usage": "local-only",
    "keep-awake-enabled": "local-only",
    "battery-threshold": "settings.update",
    "preferred-agent": "local-only",
    "validation-preferences": "local-only",
    telemetry: "local-only",
  });
}

/**
 * Resolve the effect boundary for one setting given the observed project
 * state. Execution-affecting changes to a live project wait for a safe
 * boundary (between tasks/phases); reads, battery policy, privacy, and
 * waiting-state toggles apply immediately. Unknown project state waits.
 */
export function resolveSettingsEffectiveBoundary(
  settingId: SettingsSettingId,
  projectState: ProjectState | undefined,
): SettingsEffectiveBoundary {
  if ((SETTING_IDS as readonly string[]).includes(settingId) !== true) {
    throw new Error(`Unknown settings field ${String(settingId)}.`);
  }
  switch (settingId) {
    case "battery-threshold":
    case "telemetry":
    case "auto-continue-usage":
      return "immediate";
    case "execution-mode":
    case "permission-preset":
    case "retry-count":
    case "keep-awake-enabled":
    case "preferred-agent":
    case "validation-preferences":
      break;
  }
  if (projectState === undefined) {
    return "safe-boundary";
  }
  switch (projectState) {
    case "DRAFT":
    case "PLANNING":
    case "READY":
    case "COMPLETED":
    case "FAILED":
      return "immediate";
    case "RUNNING":
    case "PAUSED":
    case "WAITING_FOR_USER":
    case "WAITING_FOR_USAGE":
    case "BLOCKED":
      return "safe-boundary";
  }
}

/** Human-readable effect explanation for each permission preset. */
export function describePermissionPreset(preset: PermissionPolicyPreset): {
  readonly title: string;
  readonly summary: string;
  readonly effect: string;
  readonly autonomousLimits: string;
} {
  const parsed = parsePermissionPreset(preset);
  const autonomousLimits =
    "Even Autonomous never silently authorizes privilege escalation (sudo), destructive operations outside the workspace, access to unrelated user files, credential disclosure, secret export, remote pushes, or major scope changes. Those stay ask_user or deny and need an explicit per-operation approval.";
  switch (parsed) {
    case "cautious":
      return Object.freeze({
        title: "Cautious",
        summary: "Ask before almost every side effect. Slowest, most explicit.",
        effect:
          "Workspace writes, dependency installs, network use, Git mutations, destructive file operations, and roadmap changes ask before running. Outside-workspace access, secrets, privilege escalation, and remote pushes are denied or ask. Choose Cautious when exploring an unfamiliar project.",
        autonomousLimits,
      });
    case "standard":
      return Object.freeze({
        title: "Standard (default)",
        summary: "Workspace writes and Git mutations allowed; sensitive operations ask.",
        effect:
          "Reads, workspace writes, and Git task commits run without prompting. Dependency installs, network use, secrets, outside-workspace access, destructive operations beyond the attempt scope, significant/scope roadmap changes, and remote pushes ask or stay denied. This is the v1 default.",
        autonomousLimits,
      });
    case "autonomous":
      return Object.freeze({
        title: "Autonomous",
        summary: "Fewest prompts. Still bounded: dangerous categories always ask or deny.",
        effect:
          "Workspace writes, dependency installs, network use, Git mutations, destructive operations inside the attempt scope, and significant roadmap changes run without prompting. Switching to Autonomous widens autonomous file, dependency, network, and Git behavior: review recent task commits and keep a clean checkpoint before enabling it.",
        autonomousLimits,
      });
  }
}

/** Privacy copy rendered verbatim by the settings surface. */
export function getSettingsPrivacyCopy(): string {
  return [
    "Share optional diagnostics is off by default. Optional telemetry (when implemented in Phase 12 Milestone 4) uploads only allowlisted fields such as app/Core version, execution mode, phase/milestone outcomes, retry occurrence, validator category results, adapter identifier, structured error codes, and recovery outcomes.",
    "Densa ADE never uploads source code, file contents, project/specification/roadmap content, filenames, absolute paths, Git remote URLs, repository or project names, prompts, Master conversations, worker transcripts, environment variables, secrets, credentials, or Codex authentication data as ordinary telemetry.",
    "Essential operational traffic required for update delivery, compatibility, or local reliability is minimized and documented separately; Sparkle update traffic is not described as optional telemetry.",
  ].join(" ");
}

/** Section descriptors rendered by the settings surface. */
export function getSettingsSections(): readonly SettingsFieldDescriptor[] {
  const appliesVia = getSettingsAppliesVia();
  const autonomous = describePermissionPreset("autonomous");
  return Object.freeze([
    Object.freeze({
      id: "execution-mode",
      title: "Default execution mode",
      detail:
        "Guided stops after each validated task, Phase-by-phase stops at AWAITING_APPROVAL, Continuous continues automatically. New projects use this default at projects.create time; existing projects change through settings.update at a safe boundary.",
      appliesVia: appliesVia["execution-mode"],
      boundary: "safe-boundary",
      requiresActorReason: true,
    }),
    Object.freeze({
      id: "permission-preset",
      title: "Permission preset",
      detail: `Cautious, Standard (default), or Autonomous. ${autonomous.autonomousLimits}`,
      appliesVia: appliesVia["permission-preset"],
      boundary: "safe-boundary",
      requiresActorReason: true,
      riskExplanation:
        "Switching to Autonomous widens autonomous writes, installs, network, and Git behavior. Significant roadmap changes auto-apply; scope changes still require explicit approval. Review recent commits and keep a checkpoint before enabling it.",
    }),
    Object.freeze({
      id: "retry-count",
      title: "Retry budget",
      detail: `Fixed to ${String(SETTINGS_FIXED_RETRY_COUNT)} attempts per task in v1 (AGENTS.md §9). Core enforces this budget; the frozen Core v1 settings schema has no retry field, so this value is displayed, not configured. After the budget, Core transitions to BLOCKED or WAITING_FOR_USER with preserved diagnostics.`,
      appliesVia: appliesVia["retry-count"],
      boundary: "safe-boundary",
      requiresActorReason: false,
    }),
    Object.freeze({
      id: "auto-continue-usage",
      title: "Auto-continue after usage returns",
      detail:
        "Opt-in per-project intent to resume automatically when agent usage becomes available again (WAITING_FOR_USAGE). Off by default. Core revalidates workspace, project state, pending decisions, and backend availability before resuming; workspace divergence blocks resume. No v1 settings.update field exists, so this intent is stored locally until a future protocol addition; it never invents an observed reset time.",
      appliesVia: appliesVia["auto-continue-usage"],
      boundary: "immediate",
      requiresActorReason: false,
    }),
    Object.freeze({
      id: "keep-awake-enabled",
      title: "Keep-awake preference",
      detail:
        "Built-in macOS keep-awake prevents idle system sleep only while an opted-in project is active or waiting, subject to the battery policy. Display sleep stays allowed and the assertion releases immediately when no longer needed. On by default for active autonomous/waiting projects.",
      appliesVia: appliesVia["keep-awake-enabled"],
      boundary: "safe-boundary",
      requiresActorReason: false,
    }),
    Object.freeze({
      id: "battery-threshold",
      title: "Battery threshold",
      detail:
        "Minimum battery percent (0-100, default 20) for keep-awake. Persisted through settings.update keepAwakeBatteryPolicy and applied immediately.",
      appliesVia: appliesVia["battery-threshold"],
      boundary: "immediate",
      requiresActorReason: true,
    }),
    Object.freeze({
      id: "preferred-agent",
      title: "Preferred agent",
      detail:
        'Codex only in v1. The adapter ID "codex" is used so future adapters slot behind the same boundary. No Core v1 settings field selects an agent; any other value is rejected rather than guessed.',
      appliesVia: appliesVia["preferred-agent"],
      boundary: "safe-boundary",
      requiresActorReason: false,
    }),
    Object.freeze({
      id: "validation-preferences",
      title: "Validation preferences",
      detail:
        "Task-aware deterministic validation stays authoritative: build/typecheck/lint/tests first, browser tests for user-visible web behavior, structured acceptance checks, and fresh-context independent review for risky or phase-final claims. AI review supplements deterministic evidence and never overrides a deterministic failure. No v1 settings field weakens validation.",
      appliesVia: appliesVia["validation-preferences"],
      boundary: "safe-boundary",
      requiresActorReason: false,
    }),
    Object.freeze({
      id: "telemetry",
      title: "Share optional diagnostics",
      detail: `${getSettingsPrivacyCopy()} Core v1 settings pin telemetryEnabled to false until the Phase 12 Milestone 4 telemetry implementation lands; toggling on is recorded locally only and uploads nothing in this milestone.`,
      appliesVia: appliesVia["telemetry"],
      boundary: "immediate",
      requiresActorReason: false,
    }),
  ]);
}

function displayForSetting(id: SettingsSettingId, value: unknown): string {
  switch (id) {
    case "execution-mode":
      return value === "phase" ? "Phase-by-phase (phase)" : `${String(value)}`;
    case "permission-preset":
      return value === "standard" ? "Standard (default)" : `${String(value)}`;
    case "retry-count":
      return `${String(value)} attempts per task (fixed in v1)`;
    case "auto-continue-usage":
      return value === true
        ? "On (opt-in resume when usage returns)"
        : "Off (wait without auto-resume)";
    case "keep-awake-enabled":
      return value === true ? "Enabled for active autonomous/waiting projects" : "Disabled";
    case "battery-threshold":
      return `Minimum ${String(value)}% battery for keep-awake`;
    case "preferred-agent":
      return `Codex adapter (${String(value)})`;
    case "validation-preferences":
      return "Task-aware defaults (deterministic first, browser when relevant, review for risky/phase-final)";
    case "telemetry":
      return value === true
        ? "On (local-only until telemetry lands; uploads nothing in this milestone)"
        : "Off (default)";
  }
}

function valueForSetting(id: SettingsSettingId, userDefaults: SettingsUserDefaults): unknown {
  switch (id) {
    case "execution-mode":
      return userDefaults.executionMode;
    case "permission-preset":
      return userDefaults.permissionPreset;
    case "retry-count":
      return userDefaults.retryCount;
    case "auto-continue-usage":
      return userDefaults.autoContinueAfterUsage;
    case "keep-awake-enabled":
      return userDefaults.keepAwakeEnabled;
    case "battery-threshold":
      return userDefaults.keepAwakeMinimumBatteryPercent;
    case "preferred-agent":
      return userDefaults.preferredAgent;
    case "validation-preferences":
      return userDefaults.validationPreferences;
    case "telemetry":
      return userDefaults.telemetryEnabled;
  }
}

function overrideForSetting(id: SettingsSettingId, overrides: SettingsProjectOverrides): unknown {
  switch (id) {
    case "execution-mode":
      return overrides.executionMode;
    case "permission-preset":
      return overrides.permissionPreset;
    case "retry-count":
      return overrides.retryCount;
    case "auto-continue-usage":
      return overrides.autoContinueAfterUsage;
    case "keep-awake-enabled":
      return overrides.keepAwakeEnabled;
    case "battery-threshold":
      return overrides.keepAwakeMinimumBatteryPercent;
    case "preferred-agent":
      return overrides.preferredAgent;
    case "validation-preferences":
      return overrides.validationPreferences;
    case "telemetry":
      return undefined;
  }
}

/**
 * Build the settings model from validated user defaults, optional project
 * overrides, an optional authoritative Core snapshot, and the observed
 * connection/project state. Effective values prefer project overrides, then
 * the Core snapshot for Core-covered fields, then user defaults. Nothing is
 * invented: Core-covered effective values cite the snapshot when present,
 * local-only values never claim Core persistence.
 */
export function buildSettingsModel(input: SettingsModelInput): SettingsModel {
  const userDefaults = parseSettingsUserDefaults({
    ...getSettingsDefaults(),
    ...(input.userDefaults ?? {}),
  });
  const projectOverrides = parseSettingsProjectOverrides(input.projectOverrides);
  const connectionState =
    input.connectionState === undefined ? ("disconnected" as const) : input.connectionState;
  if ((CONNECTION_STATES as readonly string[]).includes(connectionState) !== true) {
    throw new Error("Settings connectionState must be a known connection state.");
  }
  const sections = getSettingsSections();
  if (
    new Set(sections.map((section) => section.id)).size !== SETTING_IDS.length ||
    SETTING_IDS.every((id) => sections.some((section) => section.id === id)) !== true
  ) {
    throw new Error("Settings model must cover every v1 setting exactly once.");
  }
  const coreSnapshot =
    input.coreSettings === undefined ? undefined : parseSettingsCoreSnapshot(input.coreSettings);
  const appliesVia = getSettingsAppliesVia();
  const effective = Object.freeze(
    Object.fromEntries(
      SETTING_IDS.map((id) => {
        const override = overrideForSetting(id, projectOverrides);
        const coreValue = coreValueForSetting(id, coreSnapshot);
        const hasOverride = override !== undefined;
        const hasCore = coreValue !== undefined && hasOverride !== true;
        const value =
          hasOverride === true
            ? override
            : hasCore === true
              ? coreValue
              : valueForSetting(id, userDefaults);
        const source: SettingsValueSource =
          hasOverride === true
            ? "project-override"
            : hasCore === true
              ? "core-snapshot"
              : "user-default";
        return [
          id,
          Object.freeze({
            id,
            value,
            display: displayForSetting(id, value),
            source,
            appliesVia: appliesVia[id],
            boundary: resolveSettingsEffectiveBoundary(id, input.projectState),
          }),
        ];
      }),
    ) as Readonly<Record<SettingsSettingId, SettingsEffectiveValue>>,
  );
  return Object.freeze({
    version: SETTINGS_VERSION,
    sections,
    userDefaults,
    projectOverrides,
    effective,
    connectionState,
    storageKey: SETTINGS_STORAGE_KEY,
    projectOverridesStorageKey: SETTINGS_PROJECT_OVERRIDES_STORAGE_KEY,
    lifecycle: SETTINGS_LIFECYCLE,
    audit: SETTINGS_AUDIT,
    privacyCopy: getSettingsPrivacyCopy(),
  });
}

function coreValueForSetting(
  id: SettingsSettingId,
  snapshot: SettingsCoreSnapshot | undefined,
): unknown {
  if (snapshot === undefined) {
    return undefined;
  }
  switch (id) {
    case "execution-mode":
      return snapshot.executionMode;
    case "permission-preset":
      return snapshot.permissionPolicy.preset;
    case "battery-threshold":
      return snapshot.keepAwakeBatteryPolicy.minimumLevelPercent;
    case "retry-count":
    case "auto-continue-usage":
    case "keep-awake-enabled":
    case "preferred-agent":
    case "validation-preferences":
    case "telemetry":
      return undefined;
  }
}

/**
 * Parse an authoritative Core v1 `settings.get` result without inventing
 * values. Malformed snapshots throw so corrupt Core reads can never render
 * as applied settings.
 */
export function parseSettingsCoreSnapshot(value: unknown): SettingsCoreSnapshot {
  if (isRecord(value) !== true) {
    throw new Error("Core settings snapshot must be an object.");
  }
  const projectId = value["projectId"];
  const executionMode = value["executionMode"];
  const permissionPolicy = value["permissionPolicy"];
  const keepAwakeBatteryPolicy = value["keepAwakeBatteryPolicy"];
  const telemetryEnabled = value["telemetryEnabled"];
  const updatedAt = value["updatedAt"];
  if (isNonEmptyText(projectId) !== true) {
    throw new Error("Core settings snapshot requires a projectId.");
  }
  parseExecutionMode(executionMode);
  if (isRecord(permissionPolicy) !== true) {
    throw new Error("Core settings snapshot requires a permissionPolicy object.");
  }
  parsePermissionPreset(permissionPolicy["preset"]);
  if (isRecord(keepAwakeBatteryPolicy) !== true) {
    throw new Error("Core settings snapshot requires a keepAwakeBatteryPolicy object.");
  }
  parseBatteryPercent(
    keepAwakeBatteryPolicy["minimumLevelPercent"],
    "keepAwakeBatteryPolicy.minimumLevelPercent",
  );
  if (telemetryEnabled !== false) {
    throw new Error("Core settings snapshot telemetryEnabled must be false in v1.");
  }
  parseIsoTimestamp(updatedAt, "updatedAt");
  return value as SettingsCoreSnapshot;
}

/**
 * Resolve validated settings edits to the Core v1 `settings.update` payload
 * for the persisted project. Only Core-covered fields are included; local-only
 * edits resolve to no Core payload with an explicit reason. The caller
 * supplies the persisted projectId at apply time; the IDE never fabricates
 * IDs. Actor and reason are required so policy changes stay auditable.
 */
export function resolveSettingsUpdatePayload(input: {
  readonly projectId: string;
  readonly actor: string;
  readonly reason: string;
  readonly executionMode?: ExecutionMode;
  readonly permissionPreset?: PermissionPolicyPreset;
  readonly keepAwakeMinimumBatteryPercent?: number;
}): {
  readonly method: "settings.update";
  readonly payload: Record<string, unknown>;
  readonly localOnly: readonly string[];
} {
  if (isNonEmptyText(input.projectId) !== true) {
    throw new Error("Settings update requires a persisted projectId.");
  }
  if (isNonEmptyText(input.actor) !== true || isNonEmptyText(input.reason) !== true) {
    throw new Error("Settings updates require a non-empty actor and reason for audit.");
  }
  assertKnownMethod("settings.update");
  const payload: Record<string, unknown> = {
    projectId: input.projectId.trim(),
    actor: input.actor.trim(),
    reason: input.reason.trim(),
  };
  if (input.executionMode !== undefined) {
    payload["executionMode"] = parseExecutionMode(input.executionMode);
  }
  if (input.permissionPreset !== undefined) {
    const preset = parsePermissionPreset(input.permissionPreset);
    payload["permissionPolicy"] = {
      formatVersion: 1,
      preset,
      overrides: [],
    };
  }
  if (input.keepAwakeMinimumBatteryPercent !== undefined) {
    payload["keepAwakeBatteryPolicy"] = {
      minimumLevelPercent: parseBatteryPercent(
        input.keepAwakeMinimumBatteryPercent,
        "keepAwakeMinimumBatteryPercent",
      ),
    };
  }
  if (Object.keys(payload).length <= 3) {
    throw new Error("A settings update must change at least one Core-honored setting.");
  }
  return Object.freeze({
    method: "settings.update" as const,
    payload: Object.freeze(payload),
    localOnly: Object.freeze([
      "retry-count",
      "auto-continue-usage",
      "keep-awake-enabled",
      "preferred-agent",
      "validation-preferences",
      "telemetry",
    ]),
  });
}

/**
 * Explain why a local-only value has no Core payload. The IDE must render
 * this reason instead of pretending the value was persisted to Core.
 */
export function describeLocalOnlySetting(settingId: SettingsSettingId): string {
  switch (settingId) {
    case "retry-count":
      return `Retry budget is fixed to ${String(SETTINGS_FIXED_RETRY_COUNT)} attempts per task in v1; Core enforces it with no frozen settings field, so the value is displayed locally and never sent to Core.`;
    case "auto-continue-usage":
      return "Auto-continue intent is stored locally in v1; Core tracks usage waits internally but exposes no frozen settings.update field for this toggle, so enabling it records local intent and never fabricates a Core setting.";
    case "keep-awake-enabled":
      return "Keep-awake enablement is local intent in v1; only the battery threshold persists through settings.update keepAwakeBatteryPolicy, while acquire/release stays lifecycle-driven.";
    case "preferred-agent":
      return 'Preferred agent is "codex" in v1; the frozen protocol exposes no agent-selection field, so the value is displayed as the v1 adapter ID and never sent as a Core setting.';
    case "validation-preferences":
      return "Validation preferences are task-aware Core behavior in v1 with no frozen settings field; the surface displays the authoritative defaults and never sends a weakened preference to Core.";
    case "telemetry":
      return "Share optional diagnostics stays local-only in this milestone; Core v1 settings pin telemetryEnabled to false until the Phase 12 Milestone 4 telemetry implementation lands, so toggling on uploads nothing.";
    case "execution-mode":
    case "permission-preset":
    case "battery-threshold":
      return "This setting is Core-honored through settings.update with an actor and reason.";
  }
}

/**
 * Resolve the audit recipe for an applied settings change. Policy changes are
 * auditable through the persisted settings snapshot plus the append-only
 * event journal; the caller replays from the last applied sequence.
 */
export function resolveSettingsAudit(projectId: string): {
  readonly settingsMethod: "settings.get";
  readonly replayMethod: "events.replay";
  readonly subscribeMethod: "events.subscribe";
  readonly projectId: string;
  readonly reason: string;
} {
  if (isNonEmptyText(projectId) !== true) {
    throw new Error("Settings audit requires a persisted projectId.");
  }
  assertKnownMethod("settings.get");
  assertKnownMethod("events.replay");
  assertKnownMethod("events.subscribe");
  return Object.freeze({
    settingsMethod: "settings.get" as const,
    replayMethod: "events.replay" as const,
    subscribeMethod: "events.subscribe" as const,
    projectId: projectId.trim(),
    reason:
      "Re-read settings.get after settings.update, then replay events from the last applied sequence to surface the auditable policy change.",
  });
}
