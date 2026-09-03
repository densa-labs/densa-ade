import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { URL } from "node:url";

import { CORE_V1_METHODS } from "../packages/protocol/dist/index.js";
import {
  ONBOARDING_COMMAND,
  ONBOARDING_DEFAULT_EXECUTION_MODE,
  ONBOARDING_DEFAULT_KEEP_AWAKE_ENABLED,
  ONBOARDING_DEFAULT_KEEP_AWAKE_MINIMUM_BATTERY_PERCENT,
  ONBOARDING_DEFAULT_PERMISSION_PRESET,
  ONBOARDING_DEFAULT_TELEMETRY_ENABLED,
  ONBOARDING_EDITOR_VIEW_TYPE,
  ONBOARDING_LIFECYCLE,
  ONBOARDING_STORAGE_KEY,
  ONBOARDING_VERSION,
  buildOnboardingModel,
  getOnboardingDefaults,
  parseOnboardingPreferences,
  parseOnboardingStoredState,
  resetOnboarding,
  resolveOnboardingProjectDefaults,
  resolveOnboardingReopen,
  resolveOnboardingTransition,
  serializeOnboardingCompletion,
  shouldShowOnboarding,
} from "../apps/ide-extension/dist/index.js";

function healthyInput(overrides = {}) {
  return {
    codex: { status: "available", version: "codex-cli 0.30.0", detail: "codex --version" },
    codexAuth: { status: "ready", detail: "stable auth signal" },
    git: { available: true, detail: "git version 2.45.0" },
    coreState: "disconnected",
    ...overrides,
  };
}

test("onboarding defaults match the product spec", () => {
  assert.equal(ONBOARDING_DEFAULT_EXECUTION_MODE, "phase");
  assert.equal(ONBOARDING_DEFAULT_PERMISSION_PRESET, "standard");
  assert.equal(ONBOARDING_DEFAULT_KEEP_AWAKE_ENABLED, true);
  assert.equal(ONBOARDING_DEFAULT_KEEP_AWAKE_MINIMUM_BATTERY_PERCENT, 20);
  assert.equal(ONBOARDING_DEFAULT_TELEMETRY_ENABLED, false);

  const defaults = getOnboardingDefaults();
  assert.deepEqual(
    { ...defaults },
    {
      executionMode: "phase",
      permissionPreset: "standard",
      keepAwakeEnabled: true,
      keepAwakeMinimumBatteryPercent: 20,
      telemetryEnabled: false,
    },
  );
  assert.ok(Object.isFrozen(defaults));
});

test("onboarding covers every first-launch check exactly once", () => {
  const model = buildOnboardingModel(healthyInput());
  assert.equal(model.steps.length, 7);
  assert.deepEqual(
    model.steps.map((step) => step.id),
    ["codex", "codex-auth", "git", "execution-mode", "permissions", "keep-awake", "telemetry"],
  );
  assert.equal(model.windowMode, "compact-onboarding");
  assert.equal(model.completed, false);
  assert.equal(model.editorAvailable, true);
  assert.equal(model.blocksEditor, false);
  assert.equal(model.canComplete, true);
  assert.equal(model.canSkip, true);
  assert.equal(model.storageKey, ONBOARDING_STORAGE_KEY);
  for (const step of model.steps) {
    assert.equal(step.blocksEditor, false, step.id);
    assert.equal(step.blocksCompletion, false, step.id);
    assert.equal(step.skippable, true, step.id);
    assert.ok(step.title.length > 0, step.id);
    assert.ok(step.detail.length > 0, step.id);
  }
});

test("missing Codex gives install guidance without blocking basic editing", () => {
  const model = buildOnboardingModel(
    healthyInput({
      codex: { status: "unavailable", detail: "codex: command not found" },
      codexAuth: { status: "unknown", detail: "no stable signal" },
    }),
  );
  const codex = model.steps.find((step) => step.id === "codex");
  assert.equal(codex.status, "attention");
  assert.match(codex.detail, /usable as an editor/iu);
  assert.ok(typeof codex.guidance === "string" && codex.guidance.length > 0);
  assert.match(codex.guidance, /official Codex CLI/iu);

  const auth = model.steps.find((step) => step.id === "codex-auth");
  assert.equal(auth.status, "unknown");
  assert.match(auth.detail, /unknown/iu);

  assert.equal(model.editorAvailable, true);
  assert.equal(model.blocksEditor, false);
  assert.equal(model.canComplete, true);
  assert.equal(model.canSkip, true);
});

test("Codex auth unknown is reported as unknown, never guessed", () => {
  const model = buildOnboardingModel(
    healthyInput({
      codex: { status: "unknown", detail: "probe skipped" },
      codexAuth: { status: "unknown" },
    }),
  );
  const codex = model.steps.find((step) => step.id === "codex");
  assert.equal(codex.status, "unknown");
  assert.match(codex.detail, /does not guess/iu);
  const auth = model.steps.find((step) => step.id === "codex-auth");
  assert.equal(auth.status, "unknown");
  assert.match(auth.detail, /unknown/iu);
  assert.ok(!/ready/iu.test(auth.detail) || /cannot be ready/iu.test(auth.detail));
});

test("Codex version only accompanies an available Codex", () => {
  assert.throws(
    () => buildOnboardingModel(healthyInput({ codex: { status: "unavailable", version: "x" } })),
    /only accompany an available Codex/iu,
  );
});

test("git availability is checked with guidance when missing", () => {
  const ok = buildOnboardingModel(healthyInput());
  assert.equal(ok.steps.find((step) => step.id === "git").status, "ready");

  const missing = buildOnboardingModel(
    healthyInput({
      git: { available: false, detail: "git: command not found" },
    }),
  );
  const git = missing.steps.find((step) => step.id === "git");
  assert.equal(git.status, "attention");
  assert.ok(typeof git.guidance === "string" && git.guidance.length > 0);
  assert.equal(missing.blocksEditor, false);
  assert.equal(missing.editorAvailable, true);
});

test("onboarding completion persists and reopening skips unless reset", () => {
  assert.equal(shouldShowOnboarding(undefined), true);
  assert.equal(shouldShowOnboarding(null), true);
  assert.equal(shouldShowOnboarding({ version: 1, completed: false }), true);

  const stored = serializeOnboardingCompletion("2026-09-03T00:00:00.000Z");
  assert.equal(stored.version, ONBOARDING_VERSION);
  assert.equal(stored.completed, true);
  assert.equal(stored.completedAt, "2026-09-03T00:00:00.000Z");

  const roundTripped = parseOnboardingStoredState(JSON.parse(JSON.stringify(stored)));
  assert.deepEqual({ ...roundTripped }, { ...stored });
  assert.equal(shouldShowOnboarding(stored), false);
  assert.equal(shouldShowOnboarding(roundTripped), false);

  const completedModel = buildOnboardingModel(healthyInput({ stored }));
  assert.equal(completedModel.completed, true);
  assert.equal(completedModel.windowMode, "full-workspace");

  const skipped = resolveOnboardingReopen(stored);
  assert.equal(skipped.action, "skip-onboarding");
  assert.equal(skipped.windowMode, "full-workspace");

  const fresh = resolveOnboardingReopen(undefined);
  assert.equal(fresh.action, "show-onboarding");
  assert.equal(fresh.windowMode, "compact-onboarding");

  const reset = resetOnboarding();
  assert.equal(reset.completed, false);
  assert.equal(shouldShowOnboarding(reset), true);
  assert.equal(resolveOnboardingReopen(reset).action, "show-onboarding");

  assert.throws(() => parseOnboardingStoredState({ version: 999, completed: true }), /version/iu);
  assert.equal(shouldShowOnboarding({ version: 999, completed: true }), true);
});

test("resize transition creates no second authoritative app state", () => {
  assert.equal(ONBOARDING_LIFECYCLE.createsNewAuthoritativeState, false);
  assert.equal(ONBOARDING_LIFECYCLE.issuesCoreRequest, false);
  assert.equal(ONBOARDING_LIFECYCLE.closeDisposes, "view-handle-only");
  assert.equal(ONBOARDING_LIFECYCLE.coreContinuesAfterClose, true);
  assert.equal(ONBOARDING_LIFECYCLE.optimisticComplete, false);

  const { stored, transition } = resolveOnboardingTransition({
    completedAt: "2026-09-03T00:00:00.000Z",
  });
  assert.equal(stored.completed, true);
  assert.equal(transition.action, "resize-to-full-workspace");
  assert.equal(transition.from, "compact-onboarding");
  assert.equal(transition.to, "full-workspace");
  assert.equal(transition.disposes, "onboarding-view-only");
  assert.equal(transition.createsNewAuthoritativeState, false);
  assert.equal(transition.issuesCoreRequest, false);
  assert.equal(transition.requiresProjectId, false);
  assert.equal(transition.coreContinues, true);
  assert.ok(transition.reason.length > 0);
  assert.equal(shouldShowOnboarding(stored), false);
});

test("project defaults resolve through the frozen Core v1 catalog", () => {
  const defaults = resolveOnboardingProjectDefaults();
  assert.equal(defaults.executionMode, "phase");
  assert.equal(defaults.permissionPreset, "standard");
  assert.equal(defaults.keepAwakeEnabled, true);
  assert.equal(defaults.keepAwakeMinimumBatteryPercent, 20);
  assert.equal(defaults.telemetryEnabled, false);
  assert.equal(defaults.appliesVia.executionMode, "projects.create");
  assert.equal(defaults.appliesVia.permissionPreset, "settings.update");
  assert.equal(defaults.appliesVia.keepAwake, "settings.update");
  assert.equal(defaults.appliesVia.telemetry, "local-only");
  for (const method of Object.values(defaults.appliesVia)) {
    if (method === "local-only") continue;
    assert.ok(CORE_V1_METHODS.includes(method), method);
  }

  const custom = resolveOnboardingProjectDefaults({
    executionMode: "continuous",
    permissionPreset: "cautious",
    keepAwakeEnabled: false,
    telemetryEnabled: false,
  });
  assert.equal(custom.executionMode, "continuous");
  assert.equal(custom.permissionPreset, "cautious");
  assert.equal(custom.keepAwakeEnabled, false);

  assert.throws(() => parseOnboardingPreferences({ executionMode: "turbo" }), /executionMode/iu);
  assert.throws(
    () => parseOnboardingPreferences({ permissionPreset: "yolo" }),
    /permissionPreset/iu,
  );
  assert.throws(
    () => parseOnboardingPreferences({ keepAwakeMinimumBatteryPercent: 101 }),
    /keepAwakeMinimumBatteryPercent/iu,
  );
});

test("onboarding works while Core is disconnected and never invents usage state", () => {
  for (const coreState of [
    "disconnected",
    "connecting",
    "version-mismatch",
    "auth-failed",
    "connected",
  ]) {
    const model = buildOnboardingModel(healthyInput({ coreState }));
    assert.equal(model.connectionState, coreState);
    assert.equal(model.editorAvailable, true);
    assert.equal(model.blocksEditor, false);
    const combined = model.steps.map((step) => `${step.title} ${step.detail}`).join("\n");
    assert.ok(!/resetAt|countdown|token|cost/iu.test(combined), coreState);
  }
});

test("telemetry toggle defaults off and stays local-only", () => {
  const off = buildOnboardingModel(healthyInput());
  assert.equal(off.preferences.telemetryEnabled, false);
  assert.equal(off.steps.find((step) => step.id === "telemetry").status, "ready");

  const on = buildOnboardingModel(healthyInput({ preferences: { telemetryEnabled: true } }));
  const telemetry = on.steps.find((step) => step.id === "telemetry");
  assert.equal(telemetry.status, "unknown");
  assert.match(telemetry.detail, /local-only|pin telemetryEnabled/iu);
  assert.equal(on.blocksEditor, false);
  assert.equal(on.canComplete, true);
});

test("extension manifest wires the onboarding command and editor-area tab", () => {
  assert.equal(ONBOARDING_COMMAND, "densa-ade.showOnboarding");
  assert.equal(ONBOARDING_EDITOR_VIEW_TYPE, "densa-ade.onboarding");
  assert.equal(ONBOARDING_STORAGE_KEY, "densa-ade.onboarding.completed.v1");

  const manifest = JSON.parse(
    readFileSync(new URL("../apps/ide-extension/package.json", import.meta.url), "utf8"),
  );
  const command = manifest.contributes.commands.find(
    (entry) => entry.command === "densa-ade.showOnboarding",
  );
  assert.ok(command, "showOnboarding contributed");
  assert.equal(command.category, "Densa ADE");
  const editor = manifest.contributes.customEditors.find(
    (entry) => entry.viewType === "densa-ade.onboarding",
  );
  assert.ok(editor, "onboarding editor-area tab contributed");
  assert.equal(editor.priority, "option");
  assert.ok(Array.isArray(editor.selector) && editor.selector.length > 0);
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), ["@densa-ade/protocol"]);
});

test("onboarding extension sources stay protocol-only", () => {
  const extensionDir = new URL("../apps/ide-extension/src/", import.meta.url);
  const sources = ["index.ts", "onboarding.ts"]
    .map((file) => readFileSync(new URL(file, extensionDir), "utf8"))
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
});
