import assert from "node:assert/strict";
import { mkdtemp, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { URL } from "node:url";

import { CoreDaemon } from "../packages/core/dist/index.js";
import { DensaAdeDatabase } from "../packages/core/dist/persistence/index.js";
import {
  PROTOCOL_VERSION,
  CORE_V1_METHODS,
  requestEnvelopeSchema,
} from "../packages/protocol/dist/index.js";
import {
  IdeCoreConnection,
  IdeCoreIpcTransport,
  IdeProjectEventCache,
  discoverIdeCoreStatus,
  ideCoreRuntimePaths,
} from "../apps/ide-extension/dist/index.js";

const TIMESTAMP = "2026-09-03T00:00:00.000Z";
const PROJECT_ID = "project-ide-m1";

function createEvent(id, sequenceLabel, extra = {}) {
  return {
    id,
    projectId: PROJECT_ID,
    type: "TASK_STARTED",
    eventVersion: 1,
    occurredAt: TIMESTAMP,
    actor: "test",
    payload: { label: sequenceLabel },
    ...extra,
  };
}

async function withIdeDaemon(runOrOptions, maybeRun) {
  const run = typeof runOrOptions === "function" ? runOrOptions : maybeRun;
  const { eventCount = 2 } = typeof runOrOptions === "function" ? {} : (runOrOptions ?? {});
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "densa-ide-m1-"));
  const database = DensaAdeDatabase.openInMemory();
  database.repositories.projects.create({
    id: PROJECT_ID,
    name: "IDE M1 fixture",
    state: "DRAFT",
    executionMode: "phase",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  });
  for (let index = 1; index <= eventCount; index += 1) {
    database.eventJournal.append(createEvent(`event-ide-${index}`, `event-${index}`));
  }
  const daemon = await CoreDaemon.start({ runtimeDirectory, database });
  let requestNumber = 0;
  const createRequestId = () => `ide-m1-${String((requestNumber += 1))}`;
  try {
    await run({ daemon, database, runtimeDirectory, createRequestId });
  } finally {
    database.close();
    await daemon.stop().catch(() => undefined);
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
}

function ideConnection(runtimeDirectory, createRequestId, extra = {}) {
  return new IdeCoreConnection({
    runtimeDirectory,
    createRequestId,
    ...extra,
  });
}

test("IDE discovers, connects, and disconnects without stopping Core", async () => {
  await withIdeDaemon(async ({ daemon, runtimeDirectory, createRequestId }) => {
    const discovered = await discoverIdeCoreStatus({ runtimeDirectory });
    assert.equal(discovered.state, "running");
    assert.equal(discovered.instanceId, daemon.status().instanceId);
    assert.equal(discovered.protocolVersion, PROTOCOL_VERSION);

    const first = ideConnection(runtimeDirectory, createRequestId);
    try {
      assert.equal(first.connectionStatus.state, "disconnected");
      const status = await first.connect();
      assert.equal(status.instanceId, daemon.status().instanceId);
      assert.equal(first.connectionStatus.state, "connected");
      assert.equal(first.connectionStatus.protocolVersion, PROTOCOL_VERSION);
      assert.ok(first.handshakeCapabilities.length > 0);
      for (const method of ["system.bootstrap", "events.replay", "events.subscribe"]) {
        assert.ok(first.handshakeCapabilities.includes(method), method);
      }

      const bootstrap = await first.request("system.bootstrap", {});
      assert.equal(bootstrap.protocolVersion, PROTOCOL_VERSION);
      assert.equal(bootstrap.serverInstanceId, daemon.status().instanceId);

      first.disconnect();
      assert.equal(first.connectionStatus.state, "disconnected");
      assert.equal(daemon.status().state, "running");

      const second = ideConnection(runtimeDirectory, createRequestId);
      try {
        await second.connect();
        assert.equal(second.connectionStatus.state, "connected");
        const replay = await second.request("events.replay", {
          projectId: PROJECT_ID,
          afterSequence: 0,
        });
        assert.equal(replay.latestSequence, 2);
        assert.equal(replay.events.length, 2);
      } finally {
        second.dispose();
      }
      assert.equal(daemon.status().state, "running");
    } finally {
      first.dispose();
    }
  });
});

test("open/close/reopen continues a long-running project via event replay", async () => {
  await withIdeDaemon(async ({ database, runtimeDirectory, createRequestId }) => {
    const first = ideConnection(runtimeDirectory, createRequestId);
    try {
      await first.connect();
      const subscribed = await first.subscribe(PROJECT_ID);
      assert.equal(subscribed.applied.length, 2);
      assert.equal(subscribed.duplicates, 0);
      assert.equal(first.lastAppliedSequence(PROJECT_ID), 2);
      first.disconnect();
    } finally {
      first.dispose();
    }

    database.eventJournal.append(createEvent("event-ide-3", "event-3"));

    const reopened = ideConnection(runtimeDirectory, createRequestId);
    try {
      await reopened.connect();
      assert.equal(reopened.lastAppliedSequence(PROJECT_ID), 0);
      const replayed = await reopened.replay(PROJECT_ID);
      assert.equal(replayed.applied.length, 3);
      assert.equal(reopened.lastAppliedSequence(PROJECT_ID), 3);
      const replayedAgain = await reopened.replay(PROJECT_ID);
      assert.equal(replayedAgain.applied.length, 0);
      assert.equal(replayedAgain.duplicates, 0);

      const subscribed = await reopened.subscribe(PROJECT_ID);
      assert.equal(subscribed.applied.length, 0);
      assert.equal(subscribed.duplicates, 0);
    } finally {
      reopened.dispose();
    }
  });
});

test("reconnect on one IDE object catches up without duplicate application", async () => {
  await withIdeDaemon(async ({ daemon, database, runtimeDirectory, createRequestId }) => {
    const connection = ideConnection(runtimeDirectory, createRequestId);
    try {
      await connection.connect();
      await connection.subscribe(PROJECT_ID);
      assert.equal(connection.lastAppliedSequence(PROJECT_ID), 2);

      database.eventJournal.append(createEvent("event-ide-3", "event-3"));
      database.eventJournal.append(createEvent("event-ide-4", "event-4"));

      connection.disconnect();
      assert.equal(daemon.status().state, "running");

      await connection.reconnect();
      assert.equal(connection.connectionStatus.state, "connected");
      assert.ok(connection.subscribedProjects.includes(PROJECT_ID));
      assert.equal(connection.lastAppliedSequence(PROJECT_ID), 4);

      const snapshot = await connection.request("projects.get", { projectId: PROJECT_ID });
      assert.equal(snapshot.summary.project.id, PROJECT_ID);

      const replayed = await connection.replay(PROJECT_ID);
      assert.equal(replayed.applied.length, 0);
    } finally {
      connection.dispose();
    }
  });
});

test("protocol mismatch fails closed without corrupting cached truth", async () => {
  await withIdeDaemon(async ({ runtimeDirectory, createRequestId }) => {
    const connection = ideConnection(runtimeDirectory, createRequestId);
    try {
      await connection.connect();
      await connection.subscribe(PROJECT_ID);
      assert.equal(connection.lastAppliedSequence(PROJECT_ID), 2);
      const before = connection.lastAppliedSequence(PROJECT_ID);

      const mismatched = new IdeCoreIpcTransport({ runtimeDirectory });
      const badEnvelope = {
        protocolVersion: "99.0.0",
        kind: "request",
        requestId: "ide-m1-bad-version",
        method: "core.status",
        payload: {},
      };
      await assert.rejects(mismatched.request(badEnvelope), (error) => {
        assert.equal(error.name, "IdeCoreIpcError");
        assert.equal(error.protocolError.code, "PROTOCOL_VERSION_MISMATCH");
        return true;
      });
      mismatched.disconnect();

      const { assertCompatibleProtocol } = await import("../apps/ide-extension/dist/index.js");
      assert.throws(() => assertCompatibleProtocol("0.0.0"), /protocol mismatch/iu);

      assert.equal(connection.lastAppliedSequence(PROJECT_ID), before);
      assert.equal(connection.connectionStatus.state, "connected");
      const replay = await connection.request("events.replay", {
        projectId: PROJECT_ID,
        afterSequence: 0,
      });
      assert.equal(replay.events.length, 2);
    } finally {
      connection.dispose();
    }
  });
});

test("event cache dedups replays and surfaces gaps", () => {
  const cache = new IdeProjectEventCache(PROJECT_ID);
  const events = [1, 2, 3].map((sequence) => ({
    id: `event-cache-${sequence}`,
    projectId: PROJECT_ID,
    phaseId: "phase-ide",
    taskId: "task-ide",
    type: "TASK_STARTED",
    eventVersion: 1,
    sequenceNumber: sequence,
    occurredAt: TIMESTAMP,
    actor: "test",
    payload: {},
  }));
  const first = cache.applyReplayPage(events);
  assert.equal(first.applied.length, 3);
  assert.equal(first.duplicates, 0);
  assert.equal(first.hasGap, false);

  const second = cache.applyReplayPage(events);
  assert.equal(second.applied.length, 0);
  assert.equal(second.duplicates, 3);

  assert.equal(cache.applyNotification(events[2]), "duplicate");

  const gap = cache.applyNotification({
    ...events[2],
    id: "event-cache-5",
    sequenceNumber: 5,
  });
  assert.equal(gap, "gap");
  assert.equal(cache.lastAppliedSequence, 3);
});

test("commands travel through protocol only and connection loss keeps truth", async () => {
  await withIdeDaemon(async ({ database, runtimeDirectory, createRequestId }) => {
    const connection = ideConnection(runtimeDirectory, createRequestId);
    try {
      await connection.connect();
      const dashboard = await connection.request("dashboard.get", { projectId: PROJECT_ID });
      assert.equal(dashboard.project.project.id, PROJECT_ID);
      const stateBefore = database.repositories.projects.findById(PROJECT_ID)?.state;

      connection.disconnect();
      assert.equal(database.repositories.projects.findById(PROJECT_ID)?.state, stateBefore);

      await connection.connect();
      const after = await connection.request("dashboard.get", { projectId: PROJECT_ID });
      assert.equal(after.project.project.id, PROJECT_ID);
    } finally {
      connection.dispose();
    }
  });
});

test("discovery reports stopped with no daemon and ensureRunning needs a starter", async () => {
  const empty = await mkdtemp(join(tmpdir(), "densa-ide-empty-"));
  await chmod(empty, 0o700);
  try {
    const discovered = await discoverIdeCoreStatus({ runtimeDirectory: empty });
    assert.equal(discovered.state, "stopped");

    const connection = ideConnection(empty, () => "ide-m1-empty-1");
    try {
      await assert.rejects(connection.ensureRunning(), /not running.*densa-ade core start/iu);
    } finally {
      connection.dispose();
    }
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test("ensureRunning starts Core through the injected starter", async () => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "densa-ide-starter-"));
  const database = DensaAdeDatabase.openInMemory();
  database.repositories.projects.create({
    id: PROJECT_ID,
    name: "Starter fixture",
    state: "DRAFT",
    executionMode: "guided",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  });
  let daemon;
  const starter = {
    async start() {
      daemon = await CoreDaemon.start({ runtimeDirectory, database });
    },
  };
  const connection = ideConnection(runtimeDirectory, () => "ide-m1-starter-1", { starter });
  try {
    const status = await connection.ensureRunning();
    assert.equal(status.state, "running");
    assert.equal(connection.connectionStatus.state, "connected");
  } finally {
    connection.dispose();
    await daemon?.stop().catch(() => undefined);
    database.close();
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
});

test("IDE transport rejects duplicate in-flight request IDs", async () => {
  await withIdeDaemon(async ({ runtimeDirectory }) => {
    const transport = new IdeCoreIpcTransport({ runtimeDirectory });
    try {
      await transport.connect();
      const envelope = requestEnvelopeSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        kind: "request",
        requestId: "ide-m1-duplicate",
        method: "core.status",
        payload: {},
      });
      const first = transport.request(envelope);
      const second = transport.request(envelope);
      await assert.rejects(second, /already pending/iu);
      assert.equal((await first).state, "running");
    } finally {
      transport.disconnect();
    }
  });
});

test("IDE extension sources stay protocol-only", () => {
  const extensionDir = new URL("../apps/ide-extension/src/", import.meta.url);
  const sources = [
    "index.ts",
    "connection.ts",
    "runtime-paths.ts",
    "ide-transport.ts",
    "event-cache.ts",
    "ide-connection.ts",
  ]
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
  const manifest = JSON.parse(
    readFileSync(new URL("../apps/ide-extension/package.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), ["@densa-ade/protocol"]);
});

test("Core runtime paths resolve the IDE/CLI shared socket location", () => {
  const custom = ideCoreRuntimePaths({ runtimeDirectory: "/tmp/densa-ide-paths" });
  assert.equal(custom.socket, "/tmp/densa-ide-paths/core.sock");
  assert.equal(custom.token, "/tmp/densa-ide-paths/core.token");
  assert.equal(custom.pid, "/tmp/densa-ide-paths/core.pid");
  assert.ok(CORE_V1_METHODS.includes("events.replay"));
  assert.ok(CORE_V1_METHODS.includes("events.subscribe"));
});
