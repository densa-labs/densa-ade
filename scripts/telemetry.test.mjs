import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { URL } from "node:url";

import { CORE_V1_METHODS } from "../packages/protocol/dist/index.js";
import {
  TELEMETRY_DEFAULT_ENABLED,
  TELEMETRY_EVENT_CATALOG,
  TELEMETRY_EVENT_NAMES,
  TELEMETRY_ESSENTIAL_TRAFFIC,
  TELEMETRY_INSTALLATION_ID_STORAGE_KEY,
  TELEMETRY_LIFECYCLE,
  TELEMETRY_MAX_BATCH_EVENTS,
  TELEMETRY_MAX_EVENT_BYTES,
  TELEMETRY_MAX_QUEUED_EVENTS,
  TELEMETRY_STORAGE_KEY,
  TELEMETRY_UPLOAD_TIMEOUT_MS,
  TELEMETRY_VERSION,
  buildTelemetryContext,
  buildTelemetryEvent,
  clearTelemetryQueue,
  createFakeTelemetryUploader,
  createTelemetryInstallationId,
  createTelemetryQueue,
  describeTelemetryEvent,
  enqueueTelemetryEvent,
  flushTelemetryQueue,
  getSettingsAppliesVia,
  getSettingsPrivacyCopy,
  getTelemetryDefaults,
  getTelemetryEssentialTraffic,
  getTelemetryEventCatalog,
  getTelemetryPrivacyCopy,
  isTelemetryEnabled,
  parseSettingsCoreSnapshot,
  parseStoredTelemetryInstallationId,
  parseTelemetryGate,
  parseTelemetryInstallationId,
  parseTelemetryProperties,
  parseTelemetryQueue,
  serializeTelemetryInstallationId,
  serializeTelemetryQueue,
} from "../apps/ide-extension/dist/index.js";

function readText(relative) {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

function healthyContext(overrides = {}) {
  return {
    appVersion: "1.0.0",
    coreVersion: "1.0.0",
    platform: "darwin",
    arch: "arm64",
    ...overrides,
  };
}

function healthyProperties(name) {
  switch (name) {
    case "project.run.started":
    case "project.phase.completed":
    case "project.milestone.completed":
      return { executionMode: "phase", adapterId: "codex" };
    case "project.phase.failed":
    case "project.milestone.failed":
      return { executionMode: "phase", adapterId: "codex", errorCode: "VALIDATION_FAILURE" };
    case "task.retry.occurred":
      return { attemptNumber: 2, errorCode: "PROCESS_FAILURE" };
    case "validation.completed":
      return { validatorCategory: "unit_test", outcome: "pass" };
    case "agent.run.finished":
      return { adapterId: "codex", outcome: "success" };
    case "core.recovery.completed":
      return { recoveryOutcome: "recovered" };
    case "updater.check.completed":
      return { outcome: "up_to_date" };
    case "updater.update.completed":
      return { outcome: "success" };
    case "surface.opened":
      return { surface: "dashboard" };
    default:
      throw new Error(`unknown fixture event ${name}`);
  }
}

function healthyEvent(name, overrides = {}) {
  return buildTelemetryEvent({
    name,
    occurredAt: "2026-09-04T00:00:00.000Z",
    context: healthyContext(),
    properties: healthyProperties(name),
    ...overrides,
  });
}

const TIMESTAMP = "2026-09-04T00:00:00.000Z";

test("telemetry defaults off and gate requires explicit opt-in", () => {
  assert.equal(TELEMETRY_DEFAULT_ENABLED, false);
  assert.deepEqual({ ...getTelemetryDefaults() }, { enabled: false });
  assert.equal(isTelemetryEnabled(getTelemetryDefaults()), false);
  assert.equal(isTelemetryEnabled({ enabled: true }), true);
  assert.equal(isTelemetryEnabled({ enabled: false }), false);
  assert.equal(isTelemetryEnabled(undefined), false);
  assert.equal(isTelemetryEnabled(null), false);
  assert.equal(isTelemetryEnabled({}), false);

  assert.deepEqual({ ...parseTelemetryGate(undefined) }, { enabled: false });
  assert.deepEqual({ ...parseTelemetryGate(null) }, { enabled: false });
  assert.deepEqual({ ...parseTelemetryGate({}) }, { enabled: false });
  assert.deepEqual({ ...parseTelemetryGate({ enabled: true }) }, { enabled: true });
  assert.throws(() => parseTelemetryGate({ enabled: "yes" }), /boolean/iu);
  assert.throws(() => parseTelemetryGate({ enabled: true, extra: 1 }), /unknown field/iu);
  assert.throws(() => parseTelemetryGate("on"), /object/iu);
});

test("telemetry context is coarse compatibility only", () => {
  const context = buildTelemetryContext(healthyContext());
  assert.equal(context.platform, "darwin");
  assert.equal(context.arch, "arm64");
  assert.throws(
    () => buildTelemetryContext({ ...healthyContext(), platform: "linux" }),
    /platform/iu,
  );
  assert.throws(() => buildTelemetryContext({ ...healthyContext(), arch: "riscv" }), /arch/iu);
  assert.throws(
    () => buildTelemetryContext({ ...healthyContext(), appVersion: "/tmp/densa-ade" }),
    /version/iu,
  );
  assert.throws(
    () => buildTelemetryContext({ ...healthyContext(), extra: "nope" }),
    /unknown field/iu,
  );
  assert.throws(() => buildTelemetryContext("darwin"), /object/iu);
});

test("every catalog event builds through the allowlist", () => {
  assert.equal(TELEMETRY_VERSION, 1);
  assert.equal(TELEMETRY_EVENT_NAMES.length, 12);
  assert.equal(getTelemetryEventCatalog().length, 12);
  for (const name of TELEMETRY_EVENT_NAMES) {
    const described = describeTelemetryEvent(name);
    assert.equal(described.name, name);
    assert.equal(described.category, "optional");
    assert.ok(described.purpose.length > 20, name);
    assert.ok(described.properties.length > 0, name);
    const event = healthyEvent(name);
    assert.equal(event.version, TELEMETRY_VERSION);
    assert.equal(event.name, name);
    assert.equal(event.occurredAt, TIMESTAMP);
    assert.ok(Object.isFrozen(event));
  }
  assert.throws(() => describeTelemetryEvent("project.deleted"), /Unknown telemetry event/iu);
});

test("unknown event names and envelope fields are rejected, never uploaded", () => {
  assert.throws(
    () =>
      buildTelemetryEvent({
        name: "project.deleted",
        occurredAt: TIMESTAMP,
        context: healthyContext(),
        properties: {},
      }),
    /must be one of/iu,
  );
  assert.throws(
    () =>
      buildTelemetryEvent({
        name: "project.run.started",
        occurredAt: TIMESTAMP,
        context: healthyContext(),
        properties: healthyProperties("project.run.started"),
        unknownField: 1,
      }),
    /unknown field/iu,
  );
  assert.throws(
    () =>
      buildTelemetryEvent({
        name: "project.run.started",
        occurredAt: "not-a-time",
        context: healthyContext(),
        properties: healthyProperties("project.run.started"),
      }),
    /ISO-8601/iu,
  );
});

test("unknown properties are rejected rather than uploaded", () => {
  assert.throws(
    () => parseTelemetryProperties("project.run.started", { executionMode: "phase" }),
    /exactly/iu,
  );
  assert.throws(
    () =>
      parseTelemetryProperties("project.run.started", {
        executionMode: "phase",
        adapterId: "codex",
        extra: "nope",
      }),
    /exactly/iu,
  );
  assert.throws(
    () => parseTelemetryProperties("validation.completed", { validatorCategory: "unit_test" }),
    /exactly|requires/iu,
  );
  assert.throws(
    () =>
      parseTelemetryProperties("task.retry.occurred", {
        attemptNumber: 9,
        errorCode: "PROCESS_FAILURE",
      }),
    /1-4/iu,
  );
  assert.throws(
    () =>
      parseTelemetryProperties("project.run.started", {
        executionMode: "turbo",
        adapterId: "codex",
      }),
    /executionMode/iu,
  );
  assert.throws(
    () =>
      parseTelemetryProperties("project.run.started", {
        executionMode: "phase",
        adapterId: "claude",
      }),
    /adapterId/iu,
  );
  assert.throws(
    () =>
      parseTelemetryProperties("project.phase.failed", {
        executionMode: "phase",
        adapterId: "codex",
        errorCode: "MADE_UP_CODE",
      }),
    /errorCode/iu,
  );
});

test("forbidden keys can never enter an upload", () => {
  const forbidden = [
    "sourceCode",
    "fileContents",
    "filename",
    "absolutePath",
    "workspacePath",
    "projectName",
    "projectId",
    "phaseId",
    "taskId",
    "repositoryName",
    "repoName",
    "gitRemoteUrl",
    "prompt",
    "transcript",
    "conversation",
    "secret",
    "token",
    "password",
    "cookie",
    "stdout",
    "stderr",
    "crashDump",
    "stackTrace",
    "env",
    "logs",
    "content",
    "spec",
    "roadmap",
  ];
  for (const key of forbidden) {
    assert.throws(
      () =>
        buildTelemetryEvent({
          name: "project.run.started",
          occurredAt: TIMESTAMP,
          context: healthyContext(),
          properties: { executionMode: "phase", adapterId: "codex", [key]: "x" },
        }),
      /forbids|exactly|unknown field/iu,
      key,
    );
  }
});

test("forbidden values cannot enter an upload", () => {
  const smuggled = [
    "const x = 1;\nconsole.log(x)",
    "/Users/alice/secret-project/src/index.ts",
    "/tmp/densa-ade/workspace",
    "C:\\Users\\alice\\project",
    "https://github.com/alice/secret-repo.git",
    "git@github.com:alice/secret-repo.git",
    "alice@example.com",
    "sk-proj-abcdefghijklmnop1234",
    "AKIAIOSFODNN7EXAMPLE",
    "ghp_abcdefghijklmnop123456",
    "-----BEGIN PRIVATE KEY-----\nMIIE...",
    "Bearer abcdefghijklmnop1234",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c",
    "<secret>hunter2</secret>",
    "[secret:hunter2]",
    "_multiline\ncrash\ndump\nwith\nstack\n",
  ];
  for (const value of smuggled) {
    assert.throws(
      () =>
        buildTelemetryEvent({
          name: "project.run.started",
          occurredAt: TIMESTAMP,
          context: healthyContext(),
          properties: { executionMode: value, adapterId: "codex" },
        }),
      /must be one of|must not carry|too long|version/iu,
      value.slice(0, 32),
    );
  }
  // Representative per-category smuggling through the correct envelope shape.
  assert.throws(
    () =>
      buildTelemetryEvent({
        name: "validation.completed",
        occurredAt: TIMESTAMP,
        context: healthyContext(),
        properties: { validatorCategory: "console.log('source')\n", outcome: "pass" },
      }),
    /validatorCategory|must not carry/iu,
  );
  assert.throws(
    () =>
      buildTelemetryEvent({
        name: "surface.opened",
        occurredAt: TIMESTAMP,
        context: healthyContext(),
        properties: { surface: "/tmp/dashboard" },
      }),
    /surface|must not carry/iu,
  );
});

test("optional queue is bounded and gated by the toggle", () => {
  assert.equal(TELEMETRY_MAX_QUEUED_EVENTS, 100);
  assert.equal(TELEMETRY_MAX_BATCH_EVENTS, 25);
  assert.equal(TELEMETRY_MAX_EVENT_BYTES, 4_096);
  assert.equal(TELEMETRY_UPLOAD_TIMEOUT_MS, 5_000);
  assert.equal(TELEMETRY_STORAGE_KEY, "densa-ade.telemetry.queue.v1");

  const off = enqueueTelemetryEvent(createTelemetryQueue(), healthyEvent("surface.opened"), {
    enabled: false,
  });
  assert.equal(off.enqueued, false);
  assert.equal(off.queue.events.length, 0);
  assert.match(off.reason, /disabled/iu);

  let queue = createTelemetryQueue();
  for (let index = 0; index < TELEMETRY_MAX_QUEUED_EVENTS + 5; index += 1) {
    const outcome = enqueueTelemetryEvent(queue, healthyEvent("surface.opened"), {
      enabled: true,
    });
    queue = outcome.queue;
    if (index < TELEMETRY_MAX_QUEUED_EVENTS) {
      assert.equal(outcome.enqueued, true);
      assert.equal(outcome.dropped, 0);
    }
  }
  assert.equal(queue.events.length, TELEMETRY_MAX_QUEUED_EVENTS);
  assert.equal(queue.droppedCount, 5);

  const cleared = clearTelemetryQueue(queue);
  assert.equal(cleared.events.length, 0);
  assert.equal(cleared.droppedCount, 5);

  const valid = healthyEvent("project.run.started");
  assert.ok(JSON.stringify(valid).length < TELEMETRY_MAX_EVENT_BYTES);
});

test("queues round-trip for restart and reject corrupt records", () => {
  const queued = enqueueTelemetryEvent(createTelemetryQueue(), healthyEvent("surface.opened"), {
    enabled: true,
  }).queue;
  const stored = serializeTelemetryQueue(queued);
  assert.equal(stored.version, TELEMETRY_VERSION);
  const roundTripped = parseTelemetryQueue(JSON.parse(JSON.stringify(stored)));
  assert.equal(roundTripped.events.length, 1);
  assert.equal(roundTripped.events[0].name, "surface.opened");
  assert.deepEqual(parseTelemetryQueue(undefined).events, []);
  assert.deepEqual(parseTelemetryQueue(null).events, []);
  assert.throws(() => parseTelemetryQueue({ version: 999, events: [] }), /version/iu);
  assert.throws(() => parseTelemetryQueue({ version: 1, events: "nope" }), /array/iu);
  assert.throws(
    () => parseTelemetryQueue({ version: 1, events: [{ name: "nope" }] }),
    /must be one of|occurredAt|context|properties/iu,
  );
});

test("installation identifiers are anonymous, random, and rotatable", () => {
  assert.equal(TELEMETRY_INSTALLATION_ID_STORAGE_KEY, "densa-ade.telemetry.installation-id.v1");
  const first = createTelemetryInstallationId();
  const second = createTelemetryInstallationId();
  assert.match(first, /^[0-9a-f-]{36}$/iu);
  assert.notEqual(first, second);
  assert.equal(parseTelemetryInstallationId(first), first);
  assert.throws(() => parseTelemetryInstallationId("not-a-uuid"), /UUID/iu);
  assert.throws(() => parseTelemetryInstallationId("alice@example.com"), /UUID/iu);

  const stored = serializeTelemetryInstallationId(first);
  assert.equal(stored.version, TELEMETRY_VERSION);
  assert.equal(parseStoredTelemetryInstallationId(JSON.parse(JSON.stringify(stored))), first);
  assert.equal(parseStoredTelemetryInstallationId(undefined), undefined);
  assert.equal(parseStoredTelemetryInstallationId(null), undefined);
  assert.throws(() => parseStoredTelemetryInstallationId({ version: 999 }), /version/iu);

  const withId = healthyEvent("surface.opened", { installationId: first });
  assert.equal(withId.installationId, first);
});

test("disabling stops transmission, including queued batches after restart", async () => {
  const fake = createFakeTelemetryUploader();
  let queue = createTelemetryQueue();
  queue = enqueueTelemetryEvent(queue, healthyEvent("project.run.started"), {
    enabled: true,
  }).queue;
  queue = enqueueTelemetryEvent(queue, healthyEvent("surface.opened"), { enabled: true }).queue;
  assert.equal(queue.events.length, 2);

  // Simulate restart: serialize then parse, then flush while disabled.
  const afterRestart = parseTelemetryQueue(
    JSON.parse(JSON.stringify(serializeTelemetryQueue(queue))),
  );
  assert.equal(afterRestart.events.length, 2);
  const dropped = await flushTelemetryQueue(afterRestart, fake.uploader, { enabled: false });
  assert.equal(dropped.flushed, 0);
  assert.equal(dropped.uploaded, false);
  assert.equal(dropped.uploaderCalled, false);
  assert.equal(dropped.queue.events.length, 0);
  assert.equal(dropped.dropped, 2);
  assert.equal(fake.calls, 0);
  assert.match(dropped.reason, /disabled/iu);
});

test("enabled flush uploads one bounded batch and retains the rest", async () => {
  const fake = createFakeTelemetryUploader();
  let queue = createTelemetryQueue();
  for (let index = 0; index < TELEMETRY_MAX_BATCH_EVENTS + 5; index += 1) {
    queue = enqueueTelemetryEvent(queue, healthyEvent("surface.opened"), { enabled: true }).queue;
  }
  const first = await flushTelemetryQueue(queue, fake.uploader, { enabled: true });
  assert.equal(first.uploaderCalled, true);
  assert.equal(first.uploaded, true);
  assert.equal(first.flushed, TELEMETRY_MAX_BATCH_EVENTS);
  assert.equal(first.queue.events.length, 5);
  assert.equal(fake.calls, 1);
  assert.equal(fake.batches[0].length, TELEMETRY_MAX_BATCH_EVENTS);

  const second = await flushTelemetryQueue(first.queue, fake.uploader, { enabled: true });
  assert.equal(second.flushed, 5);
  assert.equal(second.queue.events.length, 0);
});

test("bounded retry survives network failure without blocking execution", async () => {
  const failing = createFakeTelemetryUploader({ mode: "fail" });
  let queue = createTelemetryQueue();
  queue = enqueueTelemetryEvent(queue, healthyEvent("task.retry.occurred"), {
    enabled: true,
  }).queue;
  const failed = await flushTelemetryQueue(queue, failing.uploader, { enabled: true });
  assert.equal(failed.flushed, 0);
  assert.equal(failed.uploaded, false);
  assert.equal(failed.uploaderCalled, true);
  assert.equal(failed.retained, 1);
  assert.equal(failed.queue.events.length, 1);
  assert.equal(failed.timedOut, false);
  assert.match(failed.reason, /retained without blocking/iu);

  // The same batch succeeds on the next flush: no loss, no duplicate side effect in Core.
  failing.mode = "succeed";
  const retried = await flushTelemetryQueue(failed.queue, failing.uploader, { enabled: true });
  assert.equal(retried.flushed, 1);
  assert.equal(retried.queue.events.length, 0);

  const hanging = createFakeTelemetryUploader({ mode: "hang" });
  let hangingQueue = createTelemetryQueue();
  hangingQueue = enqueueTelemetryEvent(hangingQueue, healthyEvent("surface.opened"), {
    enabled: true,
  }).queue;
  const timedOut = await flushTelemetryQueue(
    hangingQueue,
    hanging.uploader,
    { enabled: true },
    {
      timeoutMs: 10,
    },
  );
  assert.equal(timedOut.flushed, 0);
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.retained, 1);
  assert.equal(timedOut.queue.events.length, 1);
  assert.match(timedOut.reason, /timed out|retained/iu);

  const empty = await flushTelemetryQueue(createTelemetryQueue(), failing.uploader, {
    enabled: true,
  });
  assert.equal(empty.flushed, 0);
  assert.equal(empty.uploaderCalled, false);

  await assert.rejects(
    flushTelemetryQueue(
      createTelemetryQueue(),
      failing.uploader,
      { enabled: true },
      {
        batchSize: 999,
      },
    ),
    /batchSize/iu,
  );
  await assert.rejects(
    flushTelemetryQueue(
      createTelemetryQueue(),
      failing.uploader,
      { enabled: true },
      {
        timeoutMs: -1,
      },
    ),
    /timeoutMs/iu,
  );
});

test("essential traffic is separately classified and minimized", () => {
  const essential = getTelemetryEssentialTraffic();
  assert.ok(essential.some((entry) => entry.id === "sparkle-appcast-fetch"));
  assert.ok(essential.some((entry) => entry.id === "open-vsx-gallery-fetch"));
  for (const entry of essential) {
    assert.equal(entry.category, "essential");
    assert.ok(entry.purpose.length > 20);
    assert.ok(entry.minimized.length > 20);
  }
  assert.ok(
    TELEMETRY_EVENT_CATALOG.every((entry) => entry.category === "optional"),
    "optional catalog carries no essential traffic",
  );
  assert.ok(
    TELEMETRY_EVENT_CATALOG.every((entry) => entry.name !== "sparkle-appcast-fetch"),
    "Sparkle fetch is not an optional event",
  );
  assert.equal(TELEMETRY_ESSENTIAL_TRAFFIC, essential);
});

test("settings state, privacy language, and docs match actual behavior", () => {
  assert.equal(getTelemetryPrivacyCopy(), getSettingsPrivacyCopy());
  const copy = getTelemetryPrivacyCopy();
  assert.match(copy, /off by default/iu);
  assert.match(copy, /never uploads source code/iu);
  assert.match(copy, /Sparkle update traffic is not described as optional telemetry/iu);
  assert.match(copy, /including queued batches even after restart/iu);
  assert.match(copy, /failures never block/iu);
  assert.match(copy, /at most 100 queued events, 25 per batch, 5 second timeout/iu);
  assert.match(copy, /no user tracking|anonymous installation identifier/iu);

  // Frozen Core v1 settings still pin telemetryEnabled false; the IDE gate is local-only.
  assert.equal(getSettingsAppliesVia()["telemetry"], "local-only");
  assert.ok(CORE_V1_METHODS.includes("settings.get"));
  assert.ok(CORE_V1_METHODS.includes("settings.update"));
  assert.throws(
    () =>
      parseSettingsCoreSnapshot({
        projectId: "project-1",
        executionMode: "phase",
        permissionPolicy: { formatVersion: 1, preset: "standard", overrides: [] },
        keepAwakeBatteryPolicy: { minimumLevelPercent: 20 },
        telemetryEnabled: true,
        updatedAt: "2026-09-04T00:00:00.000Z",
      }),
    /telemetryEnabled must be false/iu,
  );

  const doc = readText("../docs/TELEMETRY.md");
  for (const entry of TELEMETRY_EVENT_CATALOG) {
    assert.ok(doc.includes(entry.name), entry.name);
    for (const property of entry.properties) {
      assert.ok(doc.includes(property.replace("?", "")), `${entry.name}.${property}`);
    }
    assert.ok(doc.includes(entry.purpose.slice(0, 24)), entry.name);
  }
  assert.match(doc, /optional/iu);
  assert.match(doc, /essential/iu);
  assert.match(doc, /retention/iu);
  assert.match(doc, /never collected|never uploads|explicitly never/iu);
  assert.match(doc, /100 queued events/iu);
  assert.match(doc, /Sparkle update traffic is not/iu);
  assert.match(doc, /Share optional diagnostics is off by default/iu);
});

test("telemetry lifecycle never blocks execution or creates state", () => {
  assert.equal(TELEMETRY_LIFECYCLE.createsNewAuthoritativeState, false);
  assert.equal(TELEMETRY_LIFECYCLE.issuesCoreRequest, false);
  assert.equal(TELEMETRY_LIFECYCLE.optimisticComplete, false);
  assert.equal(TELEMETRY_LIFECYCLE.performsNetworkIo, false);
  assert.equal(TELEMETRY_LIFECYCLE.failuresNeverBlockExecution, true);
});

test("telemetry extension sources stay protocol-only with no network I/O", () => {
  const extensionDir = new URL("../apps/ide-extension/src/", import.meta.url);
  const sources = ["index.ts", "telemetry.ts"]
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
  assert.ok(
    !/\bfetch\s*\(|\bXMLHttpRequest\b|\bhttps?\.get\s*\(/u.test(sources),
    "telemetry model performs no network I/O",
  );
});
