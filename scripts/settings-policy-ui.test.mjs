import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { URL } from "node:url";

import { runCheck } from "./code-oss-dev.mjs";
import { CORE_V1_METHODS } from "../packages/protocol/dist/index.js";
import {
  SETTINGS_CAPABILITY_METHODS,
  SETTINGS_COMMAND,
  SETTINGS_DEFAULT_AUTO_CONTINUE_AFTER_USAGE,
  SETTINGS_DEFAULT_EXECUTION_MODE,
  SETTINGS_DEFAULT_KEEP_AWAKE_ENABLED,
  SETTINGS_DEFAULT_KEEP_AWAKE_MINIMUM_BATTERY_PERCENT,
  SETTINGS_DEFAULT_PERMISSION_PRESET,
  SETTINGS_DEFAULT_PREFERRED_AGENT,
  SETTINGS_DEFAULT_RETRY_COUNT,
  SETTINGS_DEFAULT_TELEMETRY_ENABLED,
  SETTINGS_EDITOR_VIEW_TYPE,
  SETTINGS_FIXED_RETRY_COUNT,
  SETTINGS_LIFECYCLE,
  SETTINGS_AUDIT,
  SETTINGS_OPEN_REFRESH_METHODS,
  SETTINGS_PROJECT_OVERRIDES_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  SETTINGS_VERSION,
  buildSettingsModel,
  describeLocalOnlySetting,
  describePermissionPreset,
  getDefaultValidationPreferences,
  getSettingsAppliesVia,
  getSettingsDefaults,
  getSettingsPrivacyCopy,
  getSettingsSections,
  parseSettingsCoreSnapshot,
  parseSettingsProjectOverrides,
  parseSettingsUserDefaults,
  parseStoredSettingsProjectOverrides,
  parseStoredSettingsUserDefaults,
  resolveSettingsAudit,
  resolveSettingsEffectiveBoundary,
  resolveSettingsUpdatePayload,
  serializeSettingsProjectOverrides,
  serializeSettingsUserDefaults,
} from "../apps/ide-extension/dist/index.js";

function readText(relative) {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

function healthyCoreSnapshot(overrides = {}) {
  return {
    projectId: "project-1",
    executionMode: "phase",
    permissionPolicy: { formatVersion: 1, preset: "standard", overrides: [] },
    keepAwakeBatteryPolicy: { minimumLevelPercent: 20 },
    telemetryEnabled: false,
    updatedAt: "2026-09-03T00:00:00.000Z",
    ...overrides,
  };
}

test("settings defaults match the product spec", () => {
  assert.equal(SETTINGS_DEFAULT_EXECUTION_MODE, "phase");
  assert.equal(SETTINGS_DEFAULT_PERMISSION_PRESET, "standard");
  assert.equal(SETTINGS_DEFAULT_RETRY_COUNT, 4);
  assert.equal(SETTINGS_FIXED_RETRY_COUNT, 4);
  assert.equal(SETTINGS_DEFAULT_AUTO_CONTINUE_AFTER_USAGE, false);
  assert.equal(SETTINGS_DEFAULT_KEEP_AWAKE_ENABLED, true);
  assert.equal(SETTINGS_DEFAULT_KEEP_AWAKE_MINIMUM_BATTERY_PERCENT, 20);
  assert.equal(SETTINGS_DEFAULT_PREFERRED_AGENT, "codex");
  assert.equal(SETTINGS_DEFAULT_TELEMETRY_ENABLED, false);

  const defaults = getSettingsDefaults();
  assert.deepEqual(
    { ...defaults, validationPreferences: { ...defaults.validationPreferences } },
    {
      executionMode: "phase",
      permissionPreset: "standard",
      retryCount: 4,
      autoContinueAfterUsage: false,
      keepAwakeEnabled: true,
      keepAwakeMinimumBatteryPercent: 20,
      preferredAgent: "codex",
      validationPreferences: {
        deterministicRequired: true,
        browserWhenRelevant: true,
        independentReviewForRiskyAndPhaseFinal: true,
      },
      telemetryEnabled: false,
    },
  );
  assert.ok(Object.isFrozen(defaults));
  assert.deepEqual(
    { ...getDefaultValidationPreferences() },
    {
      deterministicRequired: true,
      browserWhenRelevant: true,
      independentReviewForRiskyAndPhaseFinal: true,
    },
  );
});

test("settings surface covers every v1 setting exactly once", () => {
  const sections = getSettingsSections();
  assert.deepEqual(
    sections.map((section) => section.id),
    [
      "execution-mode",
      "permission-preset",
      "retry-count",
      "auto-continue-usage",
      "keep-awake-enabled",
      "battery-threshold",
      "preferred-agent",
      "validation-preferences",
      "telemetry",
    ],
  );
  for (const section of sections) {
    assert.ok(section.title.length > 0, section.id);
    assert.ok(section.detail.length > 0, section.id);
    assert.ok(typeof section.appliesVia === "string", section.id);
    assert.ok(section.boundary === "immediate" || section.boundary === "safe-boundary", section.id);
  }
  const model = buildSettingsModel({});
  assert.equal(model.version, SETTINGS_VERSION);
  assert.equal(model.storageKey, SETTINGS_STORAGE_KEY);
  assert.equal(model.projectOverridesStorageKey, SETTINGS_PROJECT_OVERRIDES_STORAGE_KEY);
  assert.deepEqual(Object.keys(model.effective).sort(), sections.map((s) => s.id).sort());
});

test("Core-covered fields map to the frozen catalog; the rest stay local-only", () => {
  const appliesVia = getSettingsAppliesVia();
  assert.equal(appliesVia["execution-mode"], "settings.update");
  assert.equal(appliesVia["permission-preset"], "settings.update");
  assert.equal(appliesVia["battery-threshold"], "settings.update");
  for (const id of [
    "retry-count",
    "auto-continue-usage",
    "keep-awake-enabled",
    "preferred-agent",
    "validation-preferences",
    "telemetry",
  ]) {
    assert.equal(appliesVia[id], "local-only", id);
    assert.ok(describeLocalOnlySetting(id).length > 20, id);
  }
  for (const method of Object.values(appliesVia)) {
    if (method === "local-only") continue;
    assert.ok(CORE_V1_METHODS.includes(method), method);
  }
  assert.ok(SETTINGS_OPEN_REFRESH_METHODS.includes("settings.get"));
  for (const method of SETTINGS_CAPABILITY_METHODS) {
    assert.ok(CORE_V1_METHODS.includes(method), method);
  }
  assert.ok(SETTINGS_AUDIT.capabilityMethods.includes("settings.update"));
  assert.ok(SETTINGS_AUDIT.capabilityMethods.includes("events.replay"));
});

test("dangerous permission changes clearly explain their effect", () => {
  for (const preset of ["cautious", "standard", "autonomous"]) {
    const described = describePermissionPreset(preset);
    assert.ok(described.title.length > 0);
    assert.ok(described.effect.length > 20);
    assert.match(described.autonomousLimits, /privilege escalation/iu);
    assert.match(described.autonomousLimits, /remote push/iu);
    assert.match(described.autonomousLimits, /scope change/iu);
    assert.match(described.autonomousLimits, /secret export|credential disclosure|secret/iu);
  }
  const autonomous = describePermissionPreset("autonomous");
  assert.match(
    autonomous.effect,
    /significant roadmap changes run without prompting|widens autonomous/iu,
  );
  const sections = getSettingsSections();
  const permission = sections.find((section) => section.id === "permission-preset");
  assert.ok(
    typeof permission.riskExplanation === "string" && permission.riskExplanation.length > 20,
  );
  assert.match(permission.riskExplanation, /Autonomous/iu);
  assert.equal(permission.requiresActorReason, true);
});

test("settings update payloads persist through Core with actor and reason", () => {
  const resolved = resolveSettingsUpdatePayload({
    projectId: "project-1",
    actor: "user:test",
    reason: "Prefer continuous for this project",
    executionMode: "continuous",
    permissionPreset: "cautious",
    keepAwakeMinimumBatteryPercent: 30,
  });
  assert.equal(resolved.method, "settings.update");
  assert.equal(resolved.payload.projectId, "project-1");
  assert.equal(resolved.payload.executionMode, "continuous");
  assert.equal(resolved.payload.permissionPolicy.preset, "cautious");
  assert.equal(resolved.payload.keepAwakeBatteryPolicy.minimumLevelPercent, 30);
  assert.ok(resolved.localOnly.includes("retry-count"));
  assert.ok(resolved.localOnly.includes("telemetry"));

  assert.throws(
    () => resolveSettingsUpdatePayload({ projectId: "project-1", actor: "a", reason: "r" }),
    /at least one Core-honored setting/iu,
  );
  assert.throws(
    () =>
      resolveSettingsUpdatePayload({
        projectId: "",
        actor: "a",
        reason: "r",
        executionMode: "phase",
      }),
    /projectId/iu,
  );
  assert.throws(
    () =>
      resolveSettingsUpdatePayload({
        projectId: "p",
        actor: "",
        reason: "r",
        executionMode: "phase",
      }),
    /actor and reason/iu,
  );
  assert.throws(
    () =>
      resolveSettingsUpdatePayload({
        projectId: "p",
        actor: "a",
        reason: "",
        executionMode: "phase",
      }),
    /actor and reason/iu,
  );
  assert.throws(
    () =>
      resolveSettingsUpdatePayload({
        projectId: "p",
        actor: "a",
        reason: "r",
        executionMode: "turbo",
      }),
    /executionMode/iu,
  );
});

test("project overrides layer over user defaults with explicit sources", () => {
  const model = buildSettingsModel({
    userDefaults: { executionMode: "phase", permissionPreset: "standard" },
    projectOverrides: { executionMode: "continuous", keepAwakeMinimumBatteryPercent: 35 },
  });
  assert.equal(model.effective["execution-mode"].value, "continuous");
  assert.equal(model.effective["execution-mode"].source, "project-override");
  assert.equal(model.effective["battery-threshold"].value, 35);
  assert.equal(model.effective["battery-threshold"].source, "project-override");
  assert.equal(model.effective["permission-preset"].value, "standard");
  assert.equal(model.effective["permission-preset"].source, "user-default");

  const withCore = buildSettingsModel({
    userDefaults: { executionMode: "guided" },
    coreSettings: healthyCoreSnapshot({ executionMode: "phase" }),
  });
  assert.equal(withCore.effective["execution-mode"].value, "phase");
  assert.equal(withCore.effective["execution-mode"].source, "core-snapshot");

  const overrideWinsOverCore = buildSettingsModel({
    coreSettings: healthyCoreSnapshot({ executionMode: "phase" }),
    projectOverrides: { executionMode: "continuous" },
  });
  assert.equal(overrideWinsOverCore.effective["execution-mode"].value, "continuous");
  assert.equal(overrideWinsOverCore.effective["execution-mode"].source, "project-override");

  assert.throws(() => parseSettingsProjectOverrides({ telemetryEnabled: true }), /unknown field/iu);
  assert.throws(() => parseSettingsUserDefaults({ unknownField: 1 }), /unknown field/iu);
  assert.throws(() => parseSettingsUserDefaults({ retryCount: 2 }), /fixed to 4/iu);
  assert.throws(() => parseSettingsUserDefaults({ preferredAgent: "claude" }), /codex/iu);
  assert.throws(
    () => parseSettingsUserDefaults({ validationPreferences: { deterministicRequired: false } }),
    /task-aware defaults|fixed/iu,
  );
});

test("running-project changes wait for a safe boundary where required", () => {
  for (const state of ["RUNNING", "PAUSED", "WAITING_FOR_USER", "WAITING_FOR_USAGE", "BLOCKED"]) {
    assert.equal(resolveSettingsEffectiveBoundary("execution-mode", state), "safe-boundary", state);
    assert.equal(
      resolveSettingsEffectiveBoundary("permission-preset", state),
      "safe-boundary",
      state,
    );
    assert.equal(resolveSettingsEffectiveBoundary("retry-count", state), "safe-boundary", state);
    assert.equal(
      resolveSettingsEffectiveBoundary("preferred-agent", state),
      "safe-boundary",
      state,
    );
    assert.equal(
      resolveSettingsEffectiveBoundary("validation-preferences", state),
      "safe-boundary",
      state,
    );
    assert.equal(resolveSettingsEffectiveBoundary("battery-threshold", state), "immediate", state);
    assert.equal(resolveSettingsEffectiveBoundary("telemetry", state), "immediate", state);
    assert.equal(
      resolveSettingsEffectiveBoundary("auto-continue-usage", state),
      "immediate",
      state,
    );
  }
  for (const state of ["DRAFT", "PLANNING", "READY", "COMPLETED", "FAILED"]) {
    assert.equal(resolveSettingsEffectiveBoundary("execution-mode", state), "immediate", state);
    assert.equal(resolveSettingsEffectiveBoundary("permission-preset", state), "immediate", state);
  }
  assert.equal(resolveSettingsEffectiveBoundary("execution-mode", undefined), "safe-boundary");
  assert.throws(
    () => resolveSettingsEffectiveBoundary("unknown-setting", "RUNNING"),
    /Unknown settings field/iu,
  );
});

test("settings round-trip after restart and reject corrupt records", () => {
  const defaults = getSettingsDefaults();
  const stored = serializeSettingsUserDefaults(defaults);
  assert.equal(stored.version, SETTINGS_VERSION);
  const roundTripped = parseStoredSettingsUserDefaults(JSON.parse(JSON.stringify(stored)));
  assert.deepEqual({ ...roundTripped }, { ...defaults });
  assert.equal(parseStoredSettingsUserDefaults(undefined).executionMode, "phase");
  assert.throws(() => parseStoredSettingsUserDefaults({ version: 999, values: {} }), /version/iu);

  const overrides = { "project-1": { executionMode: "continuous" } };
  const storedOverrides = serializeSettingsProjectOverrides(overrides);
  const roundTrippedOverrides = parseStoredSettingsProjectOverrides(
    JSON.parse(JSON.stringify(storedOverrides)),
  );
  assert.equal(roundTrippedOverrides["project-1"].executionMode, "continuous");
  assert.deepEqual(parseStoredSettingsProjectOverrides(undefined), {});
  assert.throws(
    () => parseStoredSettingsProjectOverrides({ version: 999, values: {} }),
    /version/iu,
  );
});

test("policy changes are auditable through settings reads and the event journal", () => {
  assert.equal(SETTINGS_AUDIT.requiresActorReason, true);
  const audit = resolveSettingsAudit("project-1");
  assert.equal(audit.settingsMethod, "settings.get");
  assert.equal(audit.replayMethod, "events.replay");
  assert.equal(audit.subscribeMethod, "events.subscribe");
  assert.equal(audit.projectId, "project-1");
  assert.ok(audit.reason.length > 0);
  assert.throws(() => resolveSettingsAudit(""), /projectId/iu);

  const snapshot = parseSettingsCoreSnapshot(healthyCoreSnapshot());
  assert.equal(snapshot.executionMode, "phase");
  assert.throws(
    () => parseSettingsCoreSnapshot({ ...healthyCoreSnapshot(), telemetryEnabled: true }),
    /telemetryEnabled must be false/iu,
  );
  assert.throws(() => parseSettingsCoreSnapshot({}), /projectId/iu);
});

test("settings never invents usage, token, cost, or reset state", () => {
  const model = buildSettingsModel({ connectionState: "connected" });
  const combined = [
    model.privacyCopy,
    ...model.sections.map((section) => `${section.title} ${section.detail}`),
    ...Object.values(model.effective).map((entry) => entry.display),
  ].join("\n");
  assert.ok(!/token|cost/iu.test(combined));
  assert.ok(!/resetAt|countdown/iu.test(combined));
  assert.match(combined, /never invents an observed reset time|unknown/iu);
  assert.equal(model.privacyCopy, getSettingsPrivacyCopy());
  assert.match(model.privacyCopy, /off by default/iu);
  assert.match(model.privacyCopy, /never uploads source code/iu);
  assert.match(
    model.privacyCopy,
    /Sparkle update traffic is not described as optional telemetry/iu,
  );
});

test("settings lifecycle creates no second authoritative state", () => {
  assert.equal(SETTINGS_LIFECYCLE.createsNewAuthoritativeState, false);
  assert.equal(SETTINGS_LIFECYCLE.issuesCoreRequest, false);
  assert.equal(SETTINGS_LIFECYCLE.optimisticComplete, false);
  assert.equal(SETTINGS_LIFECYCLE.closeDisposes, "view-handle-only");
  assert.equal(SETTINGS_LIFECYCLE.coreContinuesAfterClose, true);
});

test("extension manifest wires the settings command and editor-area tab", () => {
  assert.equal(SETTINGS_COMMAND, "densa-ade.showSettings");
  assert.equal(SETTINGS_EDITOR_VIEW_TYPE, "densa-ade.settings");
  assert.equal(SETTINGS_STORAGE_KEY, "densa-ade.settings.user-defaults.v1");
  assert.equal(SETTINGS_PROJECT_OVERRIDES_STORAGE_KEY, "densa-ade.settings.project-overrides.v1");

  const manifest = JSON.parse(readText("../apps/ide-extension/package.json"));
  const command = manifest.contributes.commands.find(
    (entry) => entry.command === "densa-ade.showSettings",
  );
  assert.ok(command, "showSettings contributed");
  assert.equal(command.category, "Densa ADE");
  const editor = manifest.contributes.customEditors.find(
    (entry) => entry.viewType === "densa-ade.settings",
  );
  assert.ok(editor, "settings editor-area tab contributed");
  assert.equal(editor.priority, "option");
  assert.ok(Array.isArray(editor.selector) && editor.selector.length > 0);
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), ["@densa-ade/protocol"]);
});

test("settings extension sources stay protocol-only", () => {
  const extensionDir = new URL("../apps/ide-extension/src/", import.meta.url);
  const sources = ["index.ts", "settings.ts"]
    .map((file) => readText(new URL(file, extensionDir).toString().replace("file://", "file://")))
    .join("\n");
  const forbidden = [
    /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']@densa-ade\/core(?:\/[^"']*)?["']/u,
    /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*vs\/workbench[^"']*["']/u,
    /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']vscode["']/u,
    /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*sqlite[^"']*["']/iu,
    /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']@densa-ade\/cli(?:\/[^"']*)?["']/u,
  ];
  for (const pattern of forbidden) {
    assert.ok(!pattern.test(sources), String(pattern));
  }
  assert.ok(
    !/\bfetch\s*\(|\bXMLHttpRequest\b|\bhttps?\.get\s*\(/u.test(sources),
    "settings model performs no network I/O",
  );
});

test("settings docs explain Core persistence and local-only honesty", () => {
  const doc = readText("../docs/settings-policy-ui.md");
  assert.match(doc, /settings\.update/iu);
  assert.match(doc, /local-only/iu);
  assert.match(doc, /safe-boundar/iu);
  assert.match(doc, /Autonomous/iu);
  assert.match(doc, /frozen Core v1/iu);
});

test("ide:check settings validation passes on this checkout", () => {
  const checked = runCheck();
  assert.equal(checked.ok, true, JSON.stringify(checked.checks.filter((entry) => !entry.ok)));
});
