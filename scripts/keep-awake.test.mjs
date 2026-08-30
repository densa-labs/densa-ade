import assert from "node:assert/strict";
import { test } from "node:test";

import { KeepAwakeManager, MacOsKeepAwakePlatform, StateTransitionService } from "@densa-ade/core";
import { DensaAdeDatabase } from "@densa-ade/core/persistence";
import { keepAwakeStatusSchema } from "@densa-ade/protocol";

const projectId = "project-keep-awake-proof";
const startedAt = Date.parse("2026-08-29T08:00:00.000Z");

class FakeClock {
  current = startedAt;
  nextTimer = 0;
  intervals = new Map();

  now() {
    return this.current++;
  }

  setInterval(callback, intervalMs) {
    const id = ++this.nextTimer;
    this.intervals.set(id, { callback, intervalMs });
    return id;
  }

  clearInterval(id) {
    this.intervals.delete(id);
  }
}

class FakeKeepAwakePlatform {
  supported = true;
  battery = { powerSource: "external_power" };
  acquisitions = [];
  releases = [];
  activeHandles = new Set();
  nextPid = 100;

  isSupported() {
    return this.supported;
  }

  isActive(handle) {
    return this.activeHandles.has(handle.id);
  }

  async acquire(acquiredProjectId) {
    const handle = {
      id: `fake:${String(++this.nextPid)}`,
      platform: "fake",
      pid: this.nextPid,
    };
    this.acquisitions.push({ projectId: acquiredProjectId, handle });
    this.activeHandles.add(handle.id);
    return handle;
  }

  async release(handle) {
    this.releases.push(handle);
    this.activeHandles.delete(handle.id);
  }

  async readBatteryState(observedAt) {
    return { ...this.battery, observedAt };
  }
}

function idFactory(prefix) {
  let index = 0;
  return () => `${prefix}-${String(++index)}`;
}

function setup(platform = new FakeKeepAwakePlatform()) {
  const database = DensaAdeDatabase.openInMemory();
  const project = database.repositories.projects.create({
    id: projectId,
    name: "Keep-awake proof",
    state: "DRAFT",
    executionMode: "continuous",
    createdAt: new Date(startedAt).toISOString(),
    updatedAt: new Date(startedAt).toISOString(),
  });
  const transitions = new StateTransitionService();
  for (const [index, state] of ["PLANNING", "READY", "RUNNING"].entries()) {
    const current = database.repositories.projects.findById(project.id);
    const occurredAt = new Date(startedAt + (index + 1) * 1_000).toISOString();
    database.persistStateTransition(
      transitions.transitionProject(current, state, {
        actor: "keep-awake:test",
        occurredAt,
      }),
      `keep-awake-project-${state.toLowerCase()}`,
    );
  }
  const clock = new FakeClock();
  const manager = new KeepAwakeManager(database, {
    platform,
    clock,
    monitorIntervalMs: 1_000,
    eventIdFactory: idFactory("keep-awake-event"),
  });
  return { database, manager, platform, clock };
}

function acquire(manager, reasonId, reason = "Run a long validation") {
  return manager.acquire({
    projectId,
    reasonId,
    reason,
    actor: "keep-awake:test",
  });
}

test("fake platform proves repeated acquire and release are idempotent", async (t) => {
  const { database, manager, platform } = setup();
  t.after(async () => {
    await manager.dispose();
    database.close();
  });

  const first = await acquire(manager, "validation.long");
  const repeated = await acquire(manager, "validation.long");
  await acquire(manager, "worker.long", "Run the implementation worker");

  assert.equal(first.outcome, "acquired");
  assert.equal(repeated.outcome, "unchanged");
  assert.equal(platform.acquisitions.length, 1);
  assert.equal(manager.status(projectId).reasons.length, 2);
  assert.equal(manager.status(projectId).displaySleepAllowed, true);

  await manager.release({
    projectId,
    reasonId: "validation.long",
    actor: "keep-awake:test",
  });
  assert.equal(platform.releases.length, 0);
  assert.equal(manager.status(projectId).state, "active");

  await manager.release({
    projectId,
    reasonId: "worker.long",
    actor: "keep-awake:test",
  });
  assert.equal(platform.releases.length, 1);
  assert.deepEqual(manager.status(projectId), {
    formatVersion: 1,
    projectId,
    state: "inactive",
    systemSleepPrevented: false,
    displaySleepAllowed: true,
    reasons: [],
    batteryPolicy: { minimumLevelPercent: 20 },
    updatedAt: manager.status(projectId).updatedAt,
    message: "No active keep-awake reasons",
  });

  const repeatedRelease = await manager.release({
    projectId,
    reasonId: "worker.long",
    actor: "keep-awake:test",
  });
  assert.equal(repeatedRelease.outcome, "unchanged");
  assert.equal(platform.releases.length, 1);
});

test("battery policy declines acquisition, releases an active assertion, and can reacquire", async (t) => {
  const { database, manager, platform } = setup();
  t.after(async () => {
    await manager.dispose();
    database.close();
  });

  platform.battery = { powerSource: "battery", levelPercent: 80 };
  await acquire(manager, "phase.long");
  assert.equal(manager.status(projectId).state, "active");

  platform.battery = { powerSource: "battery", levelPercent: 19 };
  const declined = await manager.reevaluateBatteryPolicy(projectId);
  assert.equal(declined.outcome, "declined");
  assert.equal(declined.status.systemSleepPrevented, false);
  assert.equal(declined.status.reasons.length, 1);
  assert.equal(platform.releases.length, 1);

  platform.battery = { powerSource: "external_power" };
  const reacquired = await manager.reevaluateBatteryPolicy(projectId);
  assert.equal(reacquired.outcome, "acquired");
  assert.equal(reacquired.status.state, "active");
  assert.equal(platform.acquisitions.length, 2);
});

test("unknown power fails closed before creating an assertion", async (t) => {
  const { database, manager, platform } = setup();
  t.after(async () => {
    await manager.dispose();
    database.close();
  });
  platform.battery = { powerSource: "unknown" };

  const result = await acquire(manager, "worker.unknown-power");

  assert.equal(result.outcome, "declined");
  assert.equal(result.status.state, "declined");
  assert.equal(platform.acquisitions.length, 0);
});

test("an unexpectedly exited platform assertion is never reported active and is replaced", async (t) => {
  const { database, manager, platform } = setup();
  t.after(async () => {
    await manager.dispose();
    database.close();
  });
  await acquire(manager, "worker.exited");
  platform.activeHandles.clear();

  assert.equal(manager.status(projectId).state, "recovery_required");
  assert.equal(manager.status(projectId).systemSleepPrevented, false);

  const result = await manager.reevaluateBatteryPolicy(projectId);
  assert.equal(result.status.state, "active");
  assert.equal(platform.acquisitions.length, 2);
});

test("restart status is honest and recovery cleans stale assertions and demand", async (t) => {
  const { database, manager, platform, clock } = setup();
  t.after(() => database.close());
  await acquire(manager, "phase.restart");

  const restarted = new KeepAwakeManager(database, {
    platform,
    clock,
    monitorIntervalMs: 1_000,
    eventIdFactory: idFactory("keep-awake-recovery-event"),
  });
  assert.equal(restarted.status(projectId).state, "recovery_required");
  assert.equal(restarted.status(projectId).systemSleepPrevented, false);

  const recovered = await restarted.recover();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].state, "inactive");
  assert.equal(recovered[0].reasons.length, 0);
  assert.equal(platform.releases.length, 1);
  assert.equal(
    database.repositories.events.replay({ projectId }).at(-1).type,
    "KEEP_AWAKE_RECOVERY_COMPLETED",
  );
});

test("malformed persisted keep-awake state fails closed and recovery discards stale state", async (t) => {
  const { database, manager } = setup();
  t.after(() => database.close());
  database.repositories.projectSettings.set({
    projectId,
    values: { keepAwake: { formatVersion: 1, malformed: true } },
    updatedAt: new Date(startedAt + 10_000).toISOString(),
  });

  assert.equal(manager.status(projectId).state, "recovery_required");
  assert.equal(manager.status(projectId).systemSleepPrevented, false);

  const recovered = await manager.recover();
  assert.equal(recovered[0].state, "inactive");
  assert.equal(
    database.repositories.events.replay({ projectId }).at(-1).payload.malformedStateDiscarded,
    true,
  );
});

test("macOS platform invokes only the idle-system assertion and ties it to Core", async () => {
  const calls = [];
  let terminated = 0;
  const platform = new MacOsKeepAwakePlatform({
    platform: "darwin",
    ownerPid: 4321,
    processFactory: async (command, arguments_) => {
      calls.push({ command, arguments: [...arguments_] });
      return {
        pid: 9876,
        isActive() {
          return terminated === 0;
        },
        async terminate() {
          terminated += 1;
        },
      };
    },
    batteryStateReader: async (observedAt) => ({
      powerSource: "external_power",
      observedAt,
    }),
  });

  const handle = await platform.acquire(projectId);
  await platform.release(handle);

  assert.deepEqual(calls, [{ command: "/usr/bin/caffeinate", arguments: ["-i", "-w", "4321"] }]);
  assert.equal(calls[0].arguments.includes("-d"), false);
  assert.equal(terminated, 1);
});

test("protocol status cannot optimistically claim an assertion", () => {
  const base = {
    formatVersion: 1,
    projectId,
    state: "declined",
    displaySleepAllowed: true,
    reasons: [],
    batteryPolicy: { minimumLevelPercent: 20 },
    updatedAt: new Date(startedAt).toISOString(),
  };
  assert.equal(
    keepAwakeStatusSchema.safeParse({ ...base, systemSleepPrevented: true }).success,
    false,
  );
});
