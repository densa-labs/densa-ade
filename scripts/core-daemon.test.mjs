import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { URL } from "node:url";
import { promisify } from "node:util";

import {
  CoreDaemon,
  CoreDaemonManager,
  CoreIpcClient,
  coreRuntimePaths,
} from "../packages/core/dist/index.js";
import { DensaAdeDatabase } from "../packages/core/dist/persistence/index.js";
import {
  CORE_EVENT_NOTIFICATION,
  PROTOCOL_VERSION,
  CoreV1Client,
  requestEnvelopeSchema,
} from "../packages/protocol/dist/index.js";

const timestamp = "2026-08-29T00:00:00.000Z";

function request(requestId, method, payload = {}) {
  return requestEnvelopeSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    kind: "request",
    requestId,
    method,
    payload,
  });
}

async function privateMode(path) {
  return (await lstat(path)).mode & 0o777;
}

async function withDaemon(run) {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "densa-core-test-"));
  const database = DensaAdeDatabase.openInMemory();
  database.repositories.projects.create({
    id: "project-daemon",
    name: "Daemon fixture",
    state: "DRAFT",
    executionMode: "guided",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  database.eventJournal.append({
    id: "event-daemon-1",
    projectId: "project-daemon",
    type: "PROJECT_STARTED",
    eventVersion: 1,
    occurredAt: timestamp,
    actor: "test",
    payload: { fixture: true },
  });
  const daemon = await CoreDaemon.start({ runtimeDirectory, database });
  try {
    await run({ daemon, database, runtimeDirectory });
  } finally {
    await daemon.stop();
    database.close();
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
}

test("clients disconnect and reconnect while the authoritative daemon and a second reader survive", async () => {
  await withDaemon(async ({ daemon, database, runtimeDirectory }) => {
    const paths = coreRuntimePaths({ runtimeDirectory });
    assert.equal(await privateMode(paths.directory), 0o700);
    assert.equal(await privateMode(paths.socket), 0o600);
    assert.equal(await privateMode(paths.pid), 0o600);
    assert.equal(await privateMode(paths.token), 0o600);

    const first = new CoreIpcClient({ runtimeDirectory });
    const second = new CoreIpcClient({ runtimeDirectory });
    const firstStatus = await first.request(request("request-status-1", "core.status"));
    assert.equal(firstStatus.instanceId, daemon.status().instanceId);

    const liveNotification = new Promise((resolve) => {
      second.onNotification((notification) => {
        if (notification.event === CORE_EVENT_NOTIFICATION) resolve(notification);
      });
    });
    const subscription = await second.request(
      request("request-subscribe-1", "events.subscribe", {
        projectId: "project-daemon",
        afterSequence: 0,
      }),
    );
    assert.deepEqual(
      subscription.events.map((event) => event.sequenceNumber),
      [1],
    );
    assert.equal(subscription.latestSequence, 1);
    assert.equal(subscription.hasMore, false);

    database.eventJournal.append({
      id: "event-daemon-2",
      projectId: "project-daemon",
      type: "PROJECT_PAUSED",
      eventVersion: 1,
      occurredAt: "2026-08-29T00:01:00.000Z",
      actor: "test",
      payload: { reason: "fixture" },
    });
    const notification = await liveNotification;
    assert.equal(notification.payload.sequenceNumber, 2);

    first.disconnect();
    await first.reconnect();
    const replay = await first.request(
      request("request-replay-1", "events.replay", {
        projectId: "project-daemon",
        afterSequence: 1,
      }),
    );
    assert.deepEqual(
      replay.events.map((event) => event.sequenceNumber),
      [2],
    );
    assert.equal(replay.latestSequence, 2);
    assert.equal(replay.hasMore, false);

    const v1Client = new CoreV1Client(first, () => "request-v1-events");
    assert.deepEqual(
      (
        await v1Client.request("events.replay", {
          projectId: "project-daemon",
          afterSequence: 0,
          limit: 200,
        })
      ).events.map((event) => event.sequenceNumber),
      [1, 2],
    );

    first.disconnect();
    second.disconnect();
    const clientModuleUrl = new URL("../packages/core/dist/index.js", import.meta.url).href;
    const killedClient = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "const {CoreIpcClient}=await import(process.argv[1]);const c=new CoreIpcClient({runtimeDirectory:process.argv[2]});await c.connect();process.stdout.write('ready\\n');setInterval(()=>{},1000)",
        clientModuleUrl,
        runtimeDirectory,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    assert.equal(await waitForLine(killedClient.stdout), "ready");
    killedClient.kill("SIGKILL");
    await new Promise((resolve) => killedClient.once("exit", resolve));

    const afterClientsExit = new CoreIpcClient({ runtimeDirectory });
    assert.equal(
      (await afterClientsExit.request(request("request-status-2", "core.status"))).state,
      "running",
    );
    afterClientsExit.disconnect();
  });
});

test("v1 and CLI aliases dispatch project controls through authoritative Core", async () => {
  await withDaemon(async ({ runtimeDirectory }) => {
    const client = new CoreIpcClient({ runtimeDirectory });
    const payload = {
      projectId: "project-daemon",
      workspacePath: runtimeDirectory,
      actor: "daemon:test",
    };
    const v1 = await client.request(request("request-control-v1", "projects.pause", payload));
    assert.equal(v1.status, "REJECTED");
    const cliAlias = await client.request(request("request-control-cli", "project.pause", payload));
    assert.equal(cliAlias.status, "REJECTED");
    client.disconnect();
  });
});

test("the real CLI starts, connects to, reports, and stops a detached Core daemon", async () => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "densa-core-cli-"));
  const execute = promisify(execFile);
  const cliPath = new URL("../packages/cli/dist/bin.js", import.meta.url);
  const environment = { ...process.env, DENSA_CORE_RUNTIME_DIR: runtimeDirectory };
  let started = false;
  try {
    const start = JSON.parse(
      (
        await execute(process.execPath, [cliPath.pathname, "core", "start", "--json"], {
          env: environment,
        })
      ).stdout,
    );
    assert.equal(start.ok, true);
    assert.equal(start.data.state, "running");
    started = true;

    const status = JSON.parse(
      (
        await execute(process.execPath, [cliPath.pathname, "core", "status", "--json"], {
          env: environment,
        })
      ).stdout,
    );
    assert.equal(status.data.instanceId, start.data.instanceId);

    const stop = JSON.parse(
      (
        await execute(process.execPath, [cliPath.pathname, "core", "stop", "--json"], {
          env: environment,
        })
      ).stdout,
    );
    assert.deepEqual(stop.data, { state: "stopped" });
    started = false;
  } finally {
    if (started) {
      await execute(process.execPath, [cliPath.pathname, "core", "stop", "--json"], {
        env: environment,
      });
    }
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
});

async function rawFrame(socketPath, value) {
  const socket = createConnection(socketPath);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return await new Promise((resolve, reject) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const boundary = buffer.indexOf("\n");
      if (boundary >= 0) {
        socket.destroy();
        resolve(JSON.parse(buffer.slice(0, boundary)));
      }
    });
    socket.on("error", reject);
    socket.write(`${JSON.stringify(value)}\n`);
  });
}

test("invalid authentication and protocol versions are rejected with stable errors", async () => {
  await withDaemon(async ({ runtimeDirectory }) => {
    const paths = coreRuntimePaths({ runtimeDirectory });
    const token = (await readFile(paths.token, "utf8")).trim();
    const invalidToken = await rawFrame(paths.socket, {
      authToken: "z".repeat(43),
      envelope: request("request-bad-token", "core.status"),
    });
    assert.equal(invalidToken.ok, false);
    assert.equal(invalidToken.error.code, "AUTHENTICATION_REQUIRED");

    const invalidVersion = await rawFrame(paths.socket, {
      authToken: token,
      envelope: {
        protocolVersion: "99.0.0",
        kind: "request",
        requestId: "request-bad-version",
        method: "core.status",
        payload: {},
      },
    });
    assert.equal(invalidVersion.ok, false);
    assert.equal(invalidVersion.error.code, "PROTOCOL_VERSION_MISMATCH");

    await writeFile(paths.token, "replaced-token".padEnd(43, "x"), { mode: 0o600 });
    await assert.rejects(
      () => new CoreDaemonManager({ runtimeDirectory }).status(),
      /owner process .* is live but its authenticated endpoint is unavailable/u,
    );
  });
});

async function waitForLine(stream) {
  return await new Promise((resolve, reject) => {
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("\n")) resolve(buffer.slice(0, buffer.indexOf("\n")));
    });
    stream.on("error", reject);
  });
}

test("a killed owner leaves stale PID/socket state that the next daemon safely recovers", async () => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "densa-core-stale-"));
  const paths = coreRuntimePaths({ runtimeDirectory });
  await chmod(runtimeDirectory, 0o700);
  const child = spawn(
    process.execPath,
    [
      "-e",
      "const net=require('node:net');const s=net.createServer();s.listen(process.argv[1],()=>process.stdout.write('ready\\n'));setInterval(()=>{},1000)",
      paths.socket,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  try {
    assert.equal(await waitForLine(child.stdout), "ready");
    await writeFile(paths.token, "stale-token".padEnd(43, "x"), { mode: 0o600 });
    await writeFile(
      paths.pid,
      JSON.stringify({
        instanceId: "stale-instance",
        pid: child.pid,
        startedAt: timestamp,
        socketPath: paths.socket,
      }),
      { mode: 0o600 },
    );
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    assert.equal((await lstat(paths.socket)).isSocket(), true);

    const database = DensaAdeDatabase.openInMemory();
    const daemon = await CoreDaemon.start({ runtimeDirectory, database });
    try {
      assert.notEqual(daemon.status().instanceId, "stale-instance");
      assert.equal((await lstat(paths.socket)).isSocket(), true);
    } finally {
      await daemon.stop();
      database.close();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
});
