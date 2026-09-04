// Copyright 2026 Densa Labs
// SPDX-License-Identifier: Apache-2.0

/**
 * Densa ADE privacy-conscious telemetry and diagnostics (Phase 12 Milestone 4).
 *
 * The v1 telemetry answers: "What happened in aggregate, without exposing
 * what the user is building?" Optional diagnostic/product telemetry is
 * strictly allowlisted, off by default, and gated by the IDE-local
 * "Share optional diagnostics" toggle. Essential operational traffic required
 * for update delivery, compatibility, or local reliability is minimized,
 * classified separately, and never described as optional telemetry.
 *
 * This module is pure, centralized, and protocol-only:
 *
 * - it imports `@densa-ade/protocol` types only, never `@densa-ade/core`,
 *   `@densa-ade/cli`, SQLite, or `vscode` / `vs/workbench`;
 * - it performs no network I/O, spawns no processes, and never probes Core
 *   by itself. Callers supply validated facts (execution mode, adapter id,
 *   validator category/outcome, structured error code, recovery/updater
 *   outcome, surface id, app/Core version, coarse platform/arch) and an
 *   injected uploader for the actual transport. The module never reads the
 *   workspace, Git remotes, prompts, transcripts, or secrets;
 * - Core v1 protocol stays frozen. Core v1 `settings` still pins
 *   `telemetryEnabled` to `false` (see `docs/core-v1-protocol.md`); the
 *   optional-telemetry gate is the IDE-local `SettingsUserDefaults` /
 *   `OnboardingPreferences` `telemetryEnabled` boolean handled here as
 *   `TelemetryGate`. `appliesVia` stays `local-only`: there is no frozen
 *   `settings.update` field for this toggle;
 * - validation is fail-closed and transmission is fail-open. Unknown event
 *   names, unknown properties, forbidden keys, unsafe string values, corrupt
 *   timestamps, and oversized events throw before they can enter the queue.
 *   Network/upload failures, timeouts, and disabled gates never throw: flush
 *   returns a retained/dropped outcome and Densa ADE execution continues;
 * - data minimization is structural, not advisory. Properties are enums,
 *   bounded integers, and tightly patterned version strings only. There is
 *   no free-form text field for source code, file contents, spec/roadmap
 *   content, filenames, absolute paths, Git remote URLs, repository/project
 *   identity, prompts, conversations, transcripts, environment values,
 *   secrets, credentials, authentication data, account identity, command
 *   output, or raw crash dumps. The anonymous installation identifier is an
 *   optional random UUID with no cross-product identity; it can be rotated
 *   or deleted by clearing host storage.
 *
 * Standard VS Code contribution mechanisms only (AGENTS.md §1.3): this
 * milestone adds the content model, not new workbench patches, new
 * activity-bar entries, or new editor viewTypes. Telemetry surfaces reuse
 * Settings ("Share optional diagnostics") and existing Dashboard/Roadmap/
 * Master tabs for status.
 */

import type { DensaAdeErrorCode, ExecutionMode } from "@densa-ade/protocol";

/** Version of the telemetry event schemas. */
export const TELEMETRY_VERSION = 1 as const;

/** Product default: optional diagnostics sharing is off. */
export const TELEMETRY_DEFAULT_ENABLED = false as const;

/** Host-storage key for the bounded queued batch (host storage such as `globalState`). */
export const TELEMETRY_STORAGE_KEY = "densa-ade.telemetry.queue.v1" as const;

/** Host-storage key for the anonymous random installation identifier. */
export const TELEMETRY_INSTALLATION_ID_STORAGE_KEY =
  "densa-ade.telemetry.installation-id.v1" as const;

/** Bounded local queue: at most this many validated events are retained. */
export const TELEMETRY_MAX_QUEUED_EVENTS = 100 as const;

/** Bounded upload: at most this many events leave in one flush. */
export const TELEMETRY_MAX_BATCH_EVENTS = 25 as const;

/** Bounded event: encoded events larger than this are rejected before queueing. */
export const TELEMETRY_MAX_EVENT_BYTES = 4_096 as const;

/** Reasonable network timeout for one upload attempt. */
export const TELEMETRY_UPLOAD_TIMEOUT_MS = 5_000 as const;

/**
 * Disposable-view lifecycle contract. Telemetry never becomes authoritative
 * project state, never issues a Core request, never marks execution complete
 * optimistically, performs no network I/O by itself, and never blocks
 * execution on upload failure.
 */
export const TELEMETRY_LIFECYCLE = Object.freeze({
  closeDisposes: "view-handle-only",
  coreContinuesAfterClose: true,
  createsNewAuthoritativeState: false,
  issuesCoreRequest: false,
  optimisticComplete: false,
  performsNetworkIo: false,
  failuresNeverBlockExecution: true,
});

/** Optional telemetry event names. Unknown names are rejected, never uploaded. */
export const TELEMETRY_EVENT_NAMES = Object.freeze([
  "project.run.started",
  "project.phase.completed",
  "project.phase.failed",
  "project.milestone.completed",
  "project.milestone.failed",
  "task.retry.occurred",
  "validation.completed",
  "agent.run.finished",
  "core.recovery.completed",
  "updater.check.completed",
  "updater.update.completed",
  "surface.opened",
] as const);

export type TelemetryEventName = (typeof TELEMETRY_EVENT_NAMES)[number];

/** Coarse compatibility context attached to every optional event. */
export interface TelemetryContext {
  readonly appVersion: string;
  readonly coreVersion: string;
  readonly platform: TelemetryPlatform;
  readonly arch: TelemetryArch;
}

export type TelemetryPlatform = "darwin" | "unknown";
export type TelemetryArch = "arm64" | "x64" | "unknown";

export type TelemetryAdapterId = "codex";
export type TelemetryValidatorCategory =
  | "build"
  | "typecheck"
  | "lint"
  | "unit_test"
  | "integration_test"
  | "browser"
  | "acceptance"
  | "review";
export type TelemetryValidationOutcome = "pass" | "fail" | "advisory";
export type TelemetryAgentOutcome =
  "success" | "failure" | "cancelled" | "usage_limited" | "auth_required" | "unknown";
export type TelemetryRecoveryOutcome = "recovered" | "blocked" | "waiting" | "unknown";
export type TelemetryUpdaterCheckOutcome = "up_to_date" | "update_available" | "failed";
export type TelemetryUpdaterUpdateOutcome = "success" | "failure" | "cancelled";
export type TelemetrySurface = "dashboard" | "roadmap" | "master";

/** Strict per-event properties. No free-form text: enums and bounded integers only. */
export type TelemetryProperties =
  | { readonly executionMode: ExecutionMode; readonly adapterId: TelemetryAdapterId }
  | {
      readonly executionMode: ExecutionMode;
      readonly adapterId: TelemetryAdapterId;
      readonly errorCode: DensaAdeErrorCode;
    }
  | { readonly attemptNumber: number; readonly errorCode: DensaAdeErrorCode }
  | {
      readonly validatorCategory: TelemetryValidatorCategory;
      readonly outcome: TelemetryValidationOutcome;
    }
  | {
      readonly adapterId: TelemetryAdapterId;
      readonly outcome: TelemetryAgentOutcome;
      readonly errorCode?: DensaAdeErrorCode;
    }
  | { readonly recoveryOutcome: TelemetryRecoveryOutcome; readonly errorCode?: DensaAdeErrorCode }
  | { readonly outcome: TelemetryUpdaterCheckOutcome }
  | { readonly outcome: TelemetryUpdaterUpdateOutcome }
  | { readonly surface: TelemetrySurface };

/** One validated optional telemetry event. */
export interface TelemetryEvent {
  readonly version: typeof TELEMETRY_VERSION;
  readonly name: TelemetryEventName;
  readonly occurredAt: string;
  readonly installationId?: string;
  readonly context: TelemetryContext;
  readonly properties: TelemetryProperties;
}

/** Bounded local queue of validated events awaiting upload. */
export interface TelemetryQueue {
  readonly version: typeof TELEMETRY_VERSION;
  readonly events: readonly TelemetryEvent[];
  readonly droppedCount: number;
}

/** IDE-local gate for optional telemetry. Off by default; explicit `true` required. */
export interface TelemetryGate {
  readonly enabled: boolean;
}

/** Injected upload transport. Implementations perform the actual network send. */
export type TelemetryUploader = (batch: readonly TelemetryEvent[]) => Promise<void>;

/** Outcome of queueing one validated event. */
export interface TelemetryEnqueueOutcome {
  readonly queue: TelemetryQueue;
  readonly enqueued: boolean;
  readonly dropped: number;
  readonly reason: string;
}

/** Outcome of one flush attempt. Never throws for network/timeout/gate reasons. */
export interface TelemetryFlushOutcome {
  readonly queue: TelemetryQueue;
  readonly flushed: number;
  readonly retained: number;
  readonly dropped: number;
  readonly timedOut: boolean;
  readonly uploaded: boolean;
  readonly uploaderCalled: boolean;
  readonly reason: string;
}

/** Catalog entry backing `docs/TELEMETRY.md`. Optional unless noted essential. */
export interface TelemetryCatalogEntry {
  readonly name: TelemetryEventName;
  readonly purpose: string;
  readonly properties: readonly string[];
  readonly category: "optional";
}

/** Versioned catalog of every v1 optional event. */
export const TELEMETRY_EVENT_CATALOG: readonly TelemetryCatalogEntry[] = Object.freeze([
  Object.freeze({
    name: "project.run.started",
    purpose: "Count project runs by execution mode without identifying the project.",
    properties: Object.freeze(["executionMode", "adapterId"]),
    category: "optional",
  }),
  Object.freeze({
    name: "project.phase.completed",
    purpose: "Count phase completions by execution mode without phase content.",
    properties: Object.freeze(["executionMode", "adapterId"]),
    category: "optional",
  }),
  Object.freeze({
    name: "project.phase.failed",
    purpose: "Count phase failures by execution mode with a structured error code.",
    properties: Object.freeze(["executionMode", "adapterId", "errorCode"]),
    category: "optional",
  }),
  Object.freeze({
    name: "project.milestone.completed",
    purpose: "Count milestone completions by execution mode without milestone content.",
    properties: Object.freeze(["executionMode", "adapterId"]),
    category: "optional",
  }),
  Object.freeze({
    name: "project.milestone.failed",
    purpose: "Count milestone failures by execution mode with a structured error code.",
    properties: Object.freeze(["executionMode", "adapterId", "errorCode"]),
    category: "optional",
  }),
  Object.freeze({
    name: "task.retry.occurred",
    purpose: "Measure retry occurrence with the bounded attempt number and error code.",
    properties: Object.freeze(["attemptNumber", "errorCode"]),
    category: "optional",
  }),
  Object.freeze({
    name: "validation.completed",
    purpose: "Measure validator category pass/fail without commands, output, or paths.",
    properties: Object.freeze(["validatorCategory", "outcome"]),
    category: "optional",
  }),
  Object.freeze({
    name: "agent.run.finished",
    purpose: "Measure worker outcomes by adapter with a structured error code when relevant.",
    properties: Object.freeze(["adapterId", "outcome", "errorCode?"]),
    category: "optional",
  }),
  Object.freeze({
    name: "core.recovery.completed",
    purpose: "Measure crash/restart recovery outcomes without workspace or log content.",
    properties: Object.freeze(["recoveryOutcome", "errorCode?"]),
    category: "optional",
  }),
  Object.freeze({
    name: "updater.check.completed",
    purpose: "Measure update-check outcomes. The Sparkle fetch itself is essential traffic.",
    properties: Object.freeze(["outcome"]),
    category: "optional",
  }),
  Object.freeze({
    name: "updater.update.completed",
    purpose: "Measure update-install outcomes. Installation still needs explicit approval.",
    properties: Object.freeze(["outcome"]),
    category: "optional",
  }),
  Object.freeze({
    name: "surface.opened",
    purpose: "Measure high-level Dashboard/Roadmap/Master usage without content.",
    properties: Object.freeze(["surface"]),
    category: "optional",
  }),
]);

/** Essential operational traffic: minimized, documented, never optional telemetry. */
export interface TelemetryEssentialTraffic {
  readonly id: string;
  readonly purpose: string;
  readonly minimized: string;
  readonly category: "essential";
}

export const TELEMETRY_ESSENTIAL_TRAFFIC: readonly TelemetryEssentialTraffic[] = Object.freeze([
  Object.freeze({
    id: "sparkle-appcast-fetch",
    purpose: "Deliver secure macOS updates: fetch the HTTPS appcast and signed artifacts.",
    minimized:
      "Only the version check and signed download required by Sparkle. Never carries project, prompt, secret, or authentication data.",
    category: "essential",
  }),
  Object.freeze({
    id: "open-vsx-gallery-fetch",
    purpose: "Search/install compatible extensions from the Open VSX Registry when asked.",
    minimized:
      "Only the gallery query the user triggered. Never carries project, prompt, secret, or authentication data.",
    category: "essential",
  }),
  Object.freeze({
    id: "local-reliability",
    purpose: "Local crash/restart bookkeeping required so recovery can classify the last run.",
    minimized:
      "Stays on this Mac (SQLite, event journal, checkpoints). Nothing is uploaded as telemetry.",
    category: "essential",
  }),
]);

const EXECUTION_MODES: readonly string[] = Object.freeze(["guided", "phase", "continuous"]);
const ADAPTER_IDS: readonly string[] = Object.freeze(["codex"]);
const ERROR_CODES: readonly string[] = Object.freeze([
  "USER_CONFIGURATION_ERROR",
  "AGENT_UNAVAILABLE",
  "AUTHENTICATION_REQUIRED",
  "USAGE_LIMITED",
  "PERMISSION_DENIED",
  "PROCESS_FAILURE",
  "VALIDATION_FAILURE",
  "WORKSPACE_CONFLICT",
  "GIT_FAILURE",
  "PERSISTENCE_FAILURE",
  "PROTOCOL_VERSION_MISMATCH",
  "INVALID_STATE_TRANSITION",
  "INTERNAL_INVARIANT_VIOLATION",
]);
const VALIDATOR_CATEGORIES: readonly string[] = Object.freeze([
  "build",
  "typecheck",
  "lint",
  "unit_test",
  "integration_test",
  "browser",
  "acceptance",
  "review",
]);
const VALIDATION_OUTCOMES: readonly string[] = Object.freeze(["pass", "fail", "advisory"]);
const AGENT_OUTCOMES: readonly string[] = Object.freeze([
  "success",
  "failure",
  "cancelled",
  "usage_limited",
  "auth_required",
  "unknown",
]);
const RECOVERY_OUTCOMES: readonly string[] = Object.freeze([
  "recovered",
  "blocked",
  "waiting",
  "unknown",
]);
const UPDATER_CHECK_OUTCOMES: readonly string[] = Object.freeze([
  "up_to_date",
  "update_available",
  "failed",
]);
const UPDATER_UPDATE_OUTCOMES: readonly string[] = Object.freeze([
  "success",
  "failure",
  "cancelled",
]);
const SURFACES: readonly string[] = Object.freeze(["dashboard", "roadmap", "master"]);
const PLATFORMS: readonly string[] = Object.freeze(["darwin", "unknown"]);
const ARCHES: readonly string[] = Object.freeze(["arm64", "x64", "unknown"]);

/**
 * Property keys that must never appear in an upload. Unknown keys already
 * throw; these throw with an explicit forbidden-data reason so negative
 * tests can prove the allowlist holds.
 */
const FORBIDDEN_TELEMETRY_KEYS: readonly string[] = Object.freeze([
  "sourceCode",
  "fileContents",
  "fileContent",
  "filename",
  "filenames",
  "absolutePath",
  "workspacePath",
  "projectName",
  "projectId",
  "phaseId",
  "taskId",
  "attemptId",
  "validationRunId",
  "repositoryName",
  "repoName",
  "gitRemoteUrl",
  "remoteUrl",
  "prompt",
  "prompts",
  "transcript",
  "conversation",
  "workerTranscript",
  "masterConversation",
  "env",
  "envVars",
  "environmentVariables",
  "secret",
  "secrets",
  "apiKey",
  "credentials",
  "password",
  "token",
  "authToken",
  "cookie",
  "stdout",
  "stderr",
  "logs",
  "rawLogs",
  "crashDump",
  "stackTrace",
  "command",
  "message",
  "detail",
  "content",
  "spec",
  "roadmap",
  "home",
]);

const VERSION_PATTERN = /^(?:\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,32})?|dev|unknown)$/u;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const KNOWN_TOKEN_PATTERN =
  /(?:AKIA[0-9A-Z]{12,}|github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|glpat-[A-Za-z0-9_-]{12,}|npm_[A-Za-z0-9]{12,}|sk-(?:proj-)?[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{12,})/u;
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/iu;
const PRIVATE_KEY_PATTERN = /-----BEGIN (?:EC |OPENSSH |PGP |RSA )?PRIVATE KEY-----/u;
const EXPLICIT_SECRET_PATTERN = /<secret>|\[secret:/iu;
const REMOTE_IDENTITY_PATTERN = /:\/\/|github\.com|gitlab\.com|\.git\b/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseIsoTimestamp(value: unknown, field: string): string {
  if (isNonEmptyText(value) !== true || Number.isFinite(Date.parse(value.trim())) !== true) {
    throw new Error(`Telemetry ${field} must be an ISO-8601 timestamp.`);
  }
  return value.trim();
}

function assertNoForbiddenKeys(value: Record<string, unknown>, scope: string): void {
  for (const key of Object.keys(value)) {
    if ((FORBIDDEN_TELEMETRY_KEYS as readonly string[]).includes(key)) {
      throw new Error(`Telemetry ${scope} forbids property ${key}; it can never be uploaded.`);
    }
  }
}

/**
 * Reject smuggled paths, code, prompts, transcripts, logs, remotes, and
 * credential shapes. Allowlisted values are short enums and dotted versions,
 * so anything carrying a slash, backslash, newline, remote marker, or known
 * credential shape is rejected rather than uploaded.
 */
function assertTelemetryStringSafe(value: string, path: string): void {
  if (value.length > 128) {
    throw new Error(
      `Telemetry ${path} is too long for an allowlisted value; free-form text can never be uploaded.`,
    );
  }
  if (
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\n") ||
    value.includes("\r") ||
    value.includes("\0")
  ) {
    throw new Error(`Telemetry ${path} must not carry paths, code, prompts, transcripts, or logs.`);
  }
  if (value.includes("@") || REMOTE_IDENTITY_PATTERN.test(value)) {
    throw new Error(
      `Telemetry ${path} must not carry repository identity, remote URLs, or account identity.`,
    );
  }
  if (
    KNOWN_TOKEN_PATTERN.test(value) ||
    JWT_PATTERN.test(value) ||
    BEARER_PATTERN.test(value) ||
    PRIVATE_KEY_PATTERN.test(value) ||
    EXPLICIT_SECRET_PATTERN.test(value)
  ) {
    throw new Error(
      `Telemetry ${path} must not carry secrets, credentials, or authentication data.`,
    );
  }
}

function assertSafeRecordStrings(value: Record<string, unknown>, scope: string): void {
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      assertTelemetryStringSafe(entry, `${scope}.${key}`);
    }
  }
}

function parseVersionField(value: unknown, field: string): string {
  if (typeof value !== "string" || VERSION_PATTERN.test(value.trim()) !== true) {
    throw new Error(`Telemetry ${field} must be a dotted version (x.y.z), dev, or unknown.`);
  }
  const trimmed = value.trim();
  assertTelemetryStringSafe(trimmed, field);
  return trimmed;
}

function parseEnumField(value: unknown, allowed: readonly string[], field: string): string {
  if (typeof value !== "string" || allowed.includes(value) !== true) {
    throw new Error(`Telemetry ${field} must be one of ${allowed.join(", ")}.`);
  }
  assertTelemetryStringSafe(value, field);
  return value;
}

/** Product default: optional telemetry off. */
export function getTelemetryDefaults(): TelemetryGate {
  return Object.freeze({ enabled: TELEMETRY_DEFAULT_ENABLED });
}

/**
 * Parse the IDE-local optional-telemetry gate. Unknown fields throw; missing
 * input means off. Only an explicit `true` enables uploads.
 */
export function parseTelemetryGate(value: unknown): TelemetryGate {
  if (value === undefined || value === null) {
    return getTelemetryDefaults();
  }
  if (isRecord(value) !== true) {
    throw new Error("Telemetry gate must be an object.");
  }
  for (const key of Object.keys(value)) {
    if (key !== "enabled") {
      throw new Error(`Telemetry gate has an unknown field ${key}.`);
    }
  }
  if (value["enabled"] === undefined) {
    return getTelemetryDefaults();
  }
  if (typeof value["enabled"] !== "boolean") {
    throw new Error("Telemetry gate enabled must be a boolean.");
  }
  return Object.freeze({ enabled: value["enabled"] });
}

/** Explicit opt-in only: anything other than `true` means disabled. */
export function isTelemetryEnabled(gate: TelemetryGate | unknown): boolean {
  if (isRecord(gate) !== true) {
    return false;
  }
  return (gate as Record<string, unknown>)["enabled"] === true;
}

/**
 * Create an anonymous random installation identifier for aggregate
 * reliability measurement. No user tracking or cross-product identity: the
 * value is random, carries no project/user/machines facts, and can be
 * rotated or deleted by clearing host storage.
 */
export function createTelemetryInstallationId(): string {
  const random = cryptoRandomUuid();
  if (UUID_V4_PATTERN.test(random) !== true) {
    throw new Error("Telemetry installation identifier must be a UUID v4.");
  }
  return random;
}

function cryptoRandomUuid(): string {
  const globalCrypto = (globalThis as Record<string, unknown>)["crypto"] as
    { randomUUID?: () => string } | undefined;
  if (typeof globalCrypto?.randomUUID === "function") {
    return globalCrypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((entry) => entry.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Validate an anonymous installation identifier. */
export function parseTelemetryInstallationId(value: unknown): string {
  if (typeof value !== "string" || UUID_V4_PATTERN.test(value.trim()) !== true) {
    throw new Error("Telemetry installation identifier must be a UUID v4.");
  }
  return value.trim();
}

/**
 * Parse a stored installation-id record. Missing storage means no identifier
 * yet (upload proceeds without it); corrupt records throw so a damaged
 * identifier is never silently reused.
 */
export function parseStoredTelemetryInstallationId(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (isRecord(value) !== true) {
    throw new Error("Stored telemetry installation identifier must be an object.");
  }
  if (value["version"] !== TELEMETRY_VERSION) {
    throw new Error("Stored telemetry installation identifier version is unsupported.");
  }
  if (value["installationId"] === undefined) {
    return undefined;
  }
  return parseTelemetryInstallationId(value["installationId"]);
}

/** Serialize an installation identifier for host storage. */
export function serializeTelemetryInstallationId(installationId: string): Record<string, unknown> {
  return Object.freeze({
    version: TELEMETRY_VERSION,
    updatedAt: new Date().toISOString(),
    installationId: parseTelemetryInstallationId(installationId),
  });
}

/**
 * Build the coarse compatibility context for every event. Unknown fields
 * throw; versions accept dotted versions, `dev`, or `unknown` only.
 */
export function buildTelemetryContext(value: unknown): TelemetryContext {
  if (isRecord(value) !== true) {
    throw new Error("Telemetry context must be an object.");
  }
  const allowed = new Set(["appVersion", "coreVersion", "platform", "arch"]);
  for (const key of Object.keys(value)) {
    if (allowed.has(key) !== true) {
      throw new Error(`Telemetry context has an unknown field ${key}.`);
    }
  }
  assertNoForbiddenKeys(value, "context");
  const context = Object.freeze({
    appVersion: parseVersionField(value["appVersion"], "context.appVersion"),
    coreVersion: parseVersionField(value["coreVersion"], "context.coreVersion"),
    platform: parseEnumField(value["platform"], PLATFORMS, "context.platform") as TelemetryPlatform,
    arch: parseEnumField(value["arch"], ARCHES, "context.arch") as TelemetryArch,
  });
  assertSafeRecordStrings({ ...context }, "context");
  return context;
}

function parseExecutionModeField(value: unknown): ExecutionMode {
  return parseEnumField(value, EXECUTION_MODES, "properties.executionMode") as ExecutionMode;
}

function parseAdapterIdField(value: unknown): TelemetryAdapterId {
  return parseEnumField(value, ADAPTER_IDS, "properties.adapterId") as TelemetryAdapterId;
}

function parseErrorCodeField(value: unknown, field: string): DensaAdeErrorCode {
  return parseEnumField(value, ERROR_CODES, field) as DensaAdeErrorCode;
}

function parseAttemptNumber(value: unknown): number {
  if (typeof value !== "number" || Number.isInteger(value) !== true || value < 1 || value > 4) {
    throw new Error("Telemetry properties.attemptNumber must be an integer 1-4.");
  }
  return value;
}

/**
 * Validate per-event properties against the allowlist. Unknown or forbidden
 * keys throw; missing required keys throw; unsafe string values throw.
 */
export function parseTelemetryProperties(
  name: TelemetryEventName,
  value: unknown,
): TelemetryProperties {
  if (isRecord(value) !== true) {
    throw new Error(`Telemetry properties for ${name} must be an object.`);
  }
  assertNoForbiddenKeys(value, `properties for ${name}`);
  const keys = new Set(Object.keys(value));
  const requireExact = (expected: readonly string[]): void => {
    if (keys.size !== expected.length || expected.every((key) => keys.has(key)) !== true) {
      throw new Error(`Telemetry properties for ${name} must be exactly ${expected.join(", ")}.`);
    }
  };
  const requireOnly = (allowed: readonly string[], required: readonly string[]): void => {
    for (const key of keys) {
      if (allowed.includes(key) !== true) {
        throw new Error(`Telemetry properties for ${name} has an unknown field ${key}.`);
      }
    }
    for (const key of required) {
      if (keys.has(key) !== true) {
        throw new Error(`Telemetry properties for ${name} requires ${key}.`);
      }
    }
  };

  switch (name) {
    case "project.run.started":
    case "project.phase.completed":
    case "project.milestone.completed": {
      requireExact(["executionMode", "adapterId"]);
      return Object.freeze({
        executionMode: parseExecutionModeField(value["executionMode"]),
        adapterId: parseAdapterIdField(value["adapterId"]),
      });
    }
    case "project.phase.failed":
    case "project.milestone.failed": {
      requireExact(["executionMode", "adapterId", "errorCode"]);
      return Object.freeze({
        executionMode: parseExecutionModeField(value["executionMode"]),
        adapterId: parseAdapterIdField(value["adapterId"]),
        errorCode: parseErrorCodeField(value["errorCode"], "properties.errorCode"),
      });
    }
    case "task.retry.occurred": {
      requireExact(["attemptNumber", "errorCode"]);
      return Object.freeze({
        attemptNumber: parseAttemptNumber(value["attemptNumber"]),
        errorCode: parseErrorCodeField(value["errorCode"], "properties.errorCode"),
      });
    }
    case "validation.completed": {
      requireExact(["validatorCategory", "outcome"]);
      return Object.freeze({
        validatorCategory: parseEnumField(
          value["validatorCategory"],
          VALIDATOR_CATEGORIES,
          "properties.validatorCategory",
        ) as TelemetryValidatorCategory,
        outcome: parseEnumField(
          value["outcome"],
          VALIDATION_OUTCOMES,
          "properties.outcome",
        ) as TelemetryValidationOutcome,
      });
    }
    case "agent.run.finished": {
      requireOnly(["adapterId", "outcome", "errorCode"], ["adapterId", "outcome"]);
      const parsed = {
        adapterId: parseAdapterIdField(value["adapterId"]),
        outcome: parseEnumField(
          value["outcome"],
          AGENT_OUTCOMES,
          "properties.outcome",
        ) as TelemetryAgentOutcome,
        ...(value["errorCode"] === undefined
          ? {}
          : { errorCode: parseErrorCodeField(value["errorCode"], "properties.errorCode") }),
      };
      return Object.freeze(parsed) as TelemetryProperties;
    }
    case "core.recovery.completed": {
      requireOnly(["recoveryOutcome", "errorCode"], ["recoveryOutcome"]);
      const parsed = {
        recoveryOutcome: parseEnumField(
          value["recoveryOutcome"],
          RECOVERY_OUTCOMES,
          "properties.recoveryOutcome",
        ) as TelemetryRecoveryOutcome,
        ...(value["errorCode"] === undefined
          ? {}
          : { errorCode: parseErrorCodeField(value["errorCode"], "properties.errorCode") }),
      };
      return Object.freeze(parsed) as TelemetryProperties;
    }
    case "updater.check.completed": {
      requireExact(["outcome"]);
      return Object.freeze({
        outcome: parseEnumField(
          value["outcome"],
          UPDATER_CHECK_OUTCOMES,
          "properties.outcome",
        ) as TelemetryUpdaterCheckOutcome,
      });
    }
    case "updater.update.completed": {
      requireExact(["outcome"]);
      return Object.freeze({
        outcome: parseEnumField(
          value["outcome"],
          UPDATER_UPDATE_OUTCOMES,
          "properties.outcome",
        ) as TelemetryUpdaterUpdateOutcome,
      });
    }
    case "surface.opened": {
      requireExact(["surface"]);
      return Object.freeze({
        surface: parseEnumField(
          value["surface"],
          SURFACES,
          "properties.surface",
        ) as TelemetrySurface,
      });
    }
  }
}

/**
 * Build one validated optional event. Unknown event names, unknown envelope
 * fields, forbidden content, corrupt timestamps, and oversized encodings
 * throw before anything can be queued or uploaded.
 */
export function buildTelemetryEvent(input: {
  readonly name: unknown;
  readonly occurredAt: unknown;
  readonly context: unknown;
  readonly properties: unknown;
  readonly installationId?: unknown;
}): TelemetryEvent {
  if (isRecord(input) !== true) {
    throw new Error("Telemetry event input must be an object.");
  }
  const allowedEnvelope = new Set([
    "name",
    "occurredAt",
    "context",
    "properties",
    "installationId",
  ]);
  for (const key of Object.keys(input)) {
    if (allowedEnvelope.has(key) !== true) {
      throw new Error(`Telemetry event has an unknown field ${key}.`);
    }
  }
  if (
    typeof input["name"] !== "string" ||
    (TELEMETRY_EVENT_NAMES as readonly string[]).includes(input["name"]) !== true
  ) {
    throw new Error(`Telemetry event name must be one of ${TELEMETRY_EVENT_NAMES.join(", ")}.`);
  }
  const name = input["name"] as TelemetryEventName;
  const occurredAt = parseIsoTimestamp(input["occurredAt"], "occurredAt");
  const context = buildTelemetryContext(input["context"]);
  const properties = parseTelemetryProperties(name, input["properties"]);
  let installationId: string | undefined;
  if (input["installationId"] !== undefined) {
    installationId = parseTelemetryInstallationId(input["installationId"]);
  }
  const event = Object.freeze({
    version: TELEMETRY_VERSION,
    name,
    occurredAt,
    ...(installationId === undefined ? {} : { installationId }),
    context,
    properties,
  }) as TelemetryEvent;
  const encoded = JSON.stringify(event);
  if (encoded.length > TELEMETRY_MAX_EVENT_BYTES) {
    throw new Error(
      `Telemetry event exceeds the ${String(TELEMETRY_MAX_EVENT_BYTES)} byte bound and was rejected.`,
    );
  }
  return event;
}

/** Empty bounded queue. */
export function createTelemetryQueue(): TelemetryQueue {
  return Object.freeze({ version: TELEMETRY_VERSION, events: Object.freeze([]), droppedCount: 0 });
}

/**
 * Queue one validated event when optional telemetry is explicitly enabled.
 * Disabled gates never queue; full queues drop the oldest event first and
 * count the drop so bounded storage stays honest.
 */
export function enqueueTelemetryEvent(
  queue: TelemetryQueue,
  event: TelemetryEvent,
  gate: TelemetryGate | unknown,
): TelemetryEnqueueOutcome {
  const current = parseTelemetryQueue(serializeTelemetryQueue(queue));
  if (isTelemetryEnabled(gate) !== true) {
    return Object.freeze({
      queue: current,
      enqueued: false,
      dropped: 0,
      reason: "Optional telemetry is disabled; the event was not queued and nothing was uploaded.",
    });
  }
  const validated = buildTelemetryEvent({
    name: event.name,
    occurredAt: event.occurredAt,
    context: { ...(event.context as unknown as Record<string, unknown>) },
    properties: { ...(event.properties as unknown as Record<string, unknown>) },
    ...(event.installationId === undefined ? {} : { installationId: event.installationId }),
  });
  const retained = [...current.events, validated];
  let dropped = 0;
  while (retained.length > TELEMETRY_MAX_QUEUED_EVENTS) {
    retained.shift();
    dropped += 1;
  }
  const next: TelemetryQueue = Object.freeze({
    version: TELEMETRY_VERSION,
    events: Object.freeze(retained),
    droppedCount: current.droppedCount + dropped,
  });
  return Object.freeze({
    queue: next,
    enqueued: true,
    dropped,
    reason:
      dropped > 0
        ? "Queue was full; the oldest event was dropped to keep storage bounded."
        : "Queued for the next bounded upload batch.",
  });
}

/** Drop all queued events (for example when the user disables the toggle). */
export function clearTelemetryQueue(queue: TelemetryQueue): TelemetryQueue {
  const current = parseTelemetryQueue(serializeTelemetryQueue(queue));
  return Object.freeze({
    version: TELEMETRY_VERSION,
    events: Object.freeze([]),
    droppedCount: current.droppedCount,
  });
}

/** Serialize the queue for host storage so restart behavior is testable. */
export function serializeTelemetryQueue(queue: TelemetryQueue): Record<string, unknown> {
  if (isRecord(queue) !== true || queue["version"] !== TELEMETRY_VERSION) {
    throw new Error("Telemetry queue version is unsupported.");
  }
  if (Array.isArray(queue["events"]) !== true) {
    throw new Error("Telemetry queue events must be an array.");
  }
  const events = (queue["events"] as unknown[]).map((entry) =>
    buildTelemetryEvent({
      name: (entry as TelemetryEvent).name,
      occurredAt: (entry as TelemetryEvent).occurredAt,
      context: {
        ...((entry as TelemetryEvent).context as unknown as Record<string, unknown>),
      },
      properties: {
        ...((entry as TelemetryEvent).properties as unknown as Record<string, unknown>),
      },
      ...((entry as TelemetryEvent).installationId === undefined
        ? {}
        : { installationId: (entry as TelemetryEvent).installationId }),
    }),
  );
  const droppedCount = queue["droppedCount"];
  if (
    typeof droppedCount !== "number" ||
    Number.isInteger(droppedCount) !== true ||
    droppedCount < 0
  ) {
    throw new Error("Telemetry queue droppedCount must be a non-negative integer.");
  }
  return Object.freeze({
    version: TELEMETRY_VERSION,
    updatedAt: new Date().toISOString(),
    events: Object.freeze(events),
    droppedCount,
  });
}

/**
 * Parse a stored queue. Missing storage means an empty queue; corrupt
 * records throw so damaged batches are never silently uploaded.
 */
export function parseTelemetryQueue(value: unknown): TelemetryQueue {
  if (value === undefined || value === null) {
    return createTelemetryQueue();
  }
  if (isRecord(value) !== true) {
    throw new Error("Stored telemetry queue must be an object.");
  }
  if (value["version"] !== TELEMETRY_VERSION) {
    throw new Error("Stored telemetry queue version is unsupported.");
  }
  const rawEvents = value["events"] === undefined ? [] : value["events"];
  if (Array.isArray(rawEvents) !== true) {
    throw new Error("Stored telemetry queue events must be an array.");
  }
  if (rawEvents.length > TELEMETRY_MAX_QUEUED_EVENTS) {
    throw new Error("Stored telemetry queue exceeds the bounded queue size.");
  }
  const events = rawEvents.map((entry) => {
    if (isRecord(entry) !== true) {
      throw new Error("Stored telemetry queue events must be objects.");
    }
    // Stored envelopes may carry version/updatedAt wrappers; revalidate strictly.
    if (entry["name"] === undefined && isRecord(entry["event"])) {
      const nested = entry["event"] as Record<string, unknown>;
      return buildTelemetryEvent({
        name: nested["name"],
        occurredAt: nested["occurredAt"],
        context: nested["context"],
        properties: nested["properties"],
        installationId: nested["installationId"],
      });
    }
    return buildTelemetryEvent({
      name: entry["name"],
      occurredAt: entry["occurredAt"],
      context: entry["context"],
      properties: entry["properties"],
      installationId: entry["installationId"],
    });
  });
  const droppedCount = value["droppedCount"] === undefined ? 0 : value["droppedCount"];
  if (
    typeof droppedCount !== "number" ||
    Number.isInteger(droppedCount) !== true ||
    droppedCount < 0
  ) {
    throw new Error("Stored telemetry queue droppedCount must be a non-negative integer.");
  }
  return Object.freeze({
    version: TELEMETRY_VERSION,
    events: Object.freeze(events),
    droppedCount,
  });
}

function delay(timeoutMs: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => {
      reject(new Error(`Telemetry upload timed out after ${String(timeoutMs)}ms.`));
    }, timeoutMs);
  });
}

/**
 * Flush one bounded batch through the injected uploader. Failures never
 * throw and never affect project execution: failed batches stay queued
 * (bounded), disabled gates drop queued batches without calling the
 * uploader, and timeouts retain the batch for a later flush.
 */
export async function flushTelemetryQueue(
  queue: TelemetryQueue,
  uploader: TelemetryUploader,
  gate: TelemetryGate | unknown,
  options: { readonly timeoutMs?: number; readonly batchSize?: number } = {},
): Promise<TelemetryFlushOutcome> {
  const current = parseTelemetryQueue(serializeTelemetryQueue(queue));
  if (isTelemetryEnabled(gate) !== true) {
    const dropped = current.events.length;
    return Object.freeze({
      queue: Object.freeze({
        version: TELEMETRY_VERSION,
        events: Object.freeze([]),
        droppedCount: current.droppedCount + dropped,
      }),
      flushed: 0,
      retained: 0,
      dropped,
      timedOut: false,
      uploaded: false,
      uploaderCalled: false,
      reason:
        "Optional telemetry is disabled; queued batches were dropped without upload, including after restart.",
    });
  }
  const timeoutMs = options.timeoutMs ?? TELEMETRY_UPLOAD_TIMEOUT_MS;
  if (typeof timeoutMs !== "number" || Number.isFinite(timeoutMs) !== true || timeoutMs <= 0) {
    throw new Error("Telemetry flush timeoutMs must be a positive number.");
  }
  const batchSize = options.batchSize ?? TELEMETRY_MAX_BATCH_EVENTS;
  if (
    typeof batchSize !== "number" ||
    Number.isInteger(batchSize) !== true ||
    batchSize < 1 ||
    batchSize > TELEMETRY_MAX_BATCH_EVENTS
  ) {
    throw new Error(
      `Telemetry flush batchSize must be an integer 1-${String(TELEMETRY_MAX_BATCH_EVENTS)}.`,
    );
  }
  if (typeof uploader !== "function") {
    throw new Error("Telemetry flush requires an uploader function.");
  }
  if (current.events.length === 0) {
    return Object.freeze({
      queue: current,
      flushed: 0,
      retained: 0,
      dropped: 0,
      timedOut: false,
      uploaded: false,
      uploaderCalled: false,
      reason: "Queue is empty; nothing was uploaded.",
    });
  }
  const batch = current.events.slice(0, batchSize);
  const uploadPromise = Promise.resolve().then(() => uploader(batch));
  // Suppress a later rejection after a timeout win so a hanging uploader
  // cannot surface as an unhandled rejection.
  uploadPromise.catch(() => undefined);
  try {
    await Promise.race([uploadPromise, delay(timeoutMs)]);
  } catch (error) {
    const timedOut = error instanceof Error && /timed out/u.test(error.message);
    return Object.freeze({
      queue: current,
      flushed: 0,
      retained: batch.length,
      dropped: 0,
      timedOut,
      uploaded: false,
      uploaderCalled: true,
      reason: timedOut
        ? `Upload timed out after ${String(timeoutMs)}ms; the bounded batch was retained without blocking execution.`
        : `Upload failed (${error instanceof Error ? error.message : String(error)}); the bounded batch was retained without blocking execution.`,
    });
  }
  const remaining = current.events.slice(batch.length);
  return Object.freeze({
    queue: Object.freeze({
      version: TELEMETRY_VERSION,
      events: Object.freeze(remaining),
      droppedCount: current.droppedCount,
    }),
    flushed: batch.length,
    retained: remaining.length,
    dropped: 0,
    timedOut: false,
    uploaded: true,
    uploaderCalled: true,
    reason: "Uploaded one bounded batch; failures never block Densa ADE execution.",
  });
}

/** Deterministic fake upload transport for development and tests. */
export interface FakeTelemetryUploader {
  readonly uploader: TelemetryUploader;
  readonly batches: unknown[][];
  calls: number;
  mode: "succeed" | "fail" | "hang";
  failureMessage: string;
}

/** Create a fake uploader that records batches without network access. */
export function createFakeTelemetryUploader(
  initial: { readonly mode?: FakeTelemetryUploader["mode"]; readonly failureMessage?: string } = {},
): FakeTelemetryUploader {
  const fake: FakeTelemetryUploader = {
    batches: [],
    calls: 0,
    mode: initial.mode ?? "succeed",
    failureMessage: initial.failureMessage ?? "fake telemetry upload failed",
    uploader: async (batch: readonly TelemetryEvent[]) => {
      fake.calls += 1;
      fake.batches.push(JSON.parse(JSON.stringify(batch)) as unknown[]);
      if (fake.mode === "fail") {
        throw new Error(fake.failureMessage);
      }
      if (fake.mode === "hang") {
        await new Promise<never>(() => undefined);
      }
    },
  };
  return fake;
}

/** Essential traffic descriptors for Settings copy and docs. */
export function getTelemetryEssentialTraffic(): readonly TelemetryEssentialTraffic[] {
  return TELEMETRY_ESSENTIAL_TRAFFIC;
}

/** Catalog of every v1 optional event for Settings copy, tests, and docs. */
export function getTelemetryEventCatalog(): readonly TelemetryCatalogEntry[] {
  return TELEMETRY_EVENT_CATALOG;
}

/** Describe one optional event for Settings/docs/tests. Unknown names throw. */
export function describeTelemetryEvent(name: TelemetryEventName): TelemetryCatalogEntry {
  const entry = TELEMETRY_EVENT_CATALOG.find((candidate) => candidate.name === name);
  if (entry === undefined) {
    throw new Error(`Unknown telemetry event ${String(name)}.`);
  }
  return entry;
}

/**
 * Settings/privacy copy rendered verbatim by the Settings surface. It
 * concisely explains what is and is not collected, that sharing is off by
 * default, that disabling stops transmission including queued batches even
 * after restart, that failures never block execution, and that essential
 * update traffic is separate from optional telemetry.
 */
export function getTelemetryPrivacyCopy(): string {
  return [
    "Share optional diagnostics is off by default. When on, Densa ADE uploads only allowlisted optional events (app/Core version with coarse macOS and CPU architecture, execution mode, project run started and phase/milestone completed or failed, retry occurrence with attempt number, validator category with pass/fail/advisory, adapter identifier with structured error code, recovery outcome, updater check/update outcome, and high-level Dashboard/Roadmap/Master surface usage).",
    "Densa ADE never uploads source code, file contents, project/specification/roadmap content, filenames, absolute paths, Git remote URLs, repository or project names, prompts, Master conversations, worker transcripts, environment variables, secrets, credentials, or Codex authentication data as ordinary telemetry. Optional events carry no free-form text, no identifiers, and no output; unknown or forbidden fields are rejected before anything is queued.",
    "Disabling stops optional transmission immediately, including queued batches even after restart. Uploads are bounded (at most 100 queued events, 25 per batch, 5 second timeout) and failures never block Densa ADE execution. The anonymous installation identifier is an optional random value with no user tracking; clearing it rotates the identity. Essential operational traffic required for update delivery, compatibility, or local reliability is minimized and documented separately; Sparkle update traffic is not described as optional telemetry.",
  ].join(" ");
}
