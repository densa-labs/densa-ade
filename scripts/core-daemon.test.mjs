import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers";
import { URL, fileURLToPath } from "node:url";
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

test("the IPC client rejects duplicate in-flight request IDs without orphaning the first request", async () => {
  await withDaemon(async ({ runtimeDirectory }) => {
    const client = new CoreIpcClient({ runtimeDirectory });
    await client.connect();
    const duplicate = request("request-duplicate", "core.status");
    const first = client.request(duplicate);
    const second = client.request(duplicate);
    await assert.rejects(second, /already pending/u);
    assert.equal((await first).state, "running");
    client.disconnect();
  });
});

test("concurrent first requests share one connection and old socket teardown cannot detach a reconnect", async () => {
  await withDaemon(async ({ runtimeDirectory, daemon }) => {
    const client = new CoreIpcClient({ runtimeDirectory });
    try {
      const statuses = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          client.request(request(`request-concurrent-${index}`, "core.status")),
        ),
      );
      assert.ok(statuses.every((status) => status.instanceId === daemon.status().instanceId));
      assert.equal(daemon.status().connectedClients, 1);
      for (let cycle = 0; cycle < 3; cycle += 1) {
        await client.reconnect();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(
          (await client.request(request(`request-reconnected-${cycle}`, "core.status"))).state,
          "running",
        );
      }
    } finally {
      client.disconnect();
    }
  });
});

test("an unresponsive endpoint times out without claiming a mutation failed or retrying it", async () => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "densa-core-timeout-"));
  const paths = coreRuntimePaths({ runtimeDirectory });
  const sockets = new Set();
  let requestCount = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("data", () => {
      requestCount += 1;
    });
  });
  const client = new CoreIpcClient({ runtimeDirectory, requestTimeoutMs: 50 });
  try {
    await writeFile(paths.token, "test-token".padEnd(43, "x"), { mode: 0o600 });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(paths.socket, resolve);
    });
    await chmod(paths.socket, 0o600);
    await assert.rejects(
      client.request(
        request("request-timeout", "projects.pause", {
          projectId: "project-timeout",
          workspacePath: runtimeDirectory,
          actor: "test",
        }),
      ),
      (error) =>
        error.protocolError?.code === "PROCESS_FAILURE" &&
        /outcome is unknown/u.test(error.message),
    );
    assert.equal(client.connected, false);
    assert.equal(requestCount, 1);
  } finally {
    client.disconnect();
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
});

test("daemon lifecycle error responses release the manager's temporary connection", async () => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "densa-core-manager-error-"));
  const paths = coreRuntimePaths({ runtimeDirectory });
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("data", (chunk) => {
      const { envelope } = JSON.parse(chunk.toString());
      socket.write(
        `${JSON.stringify({ protocolVersion: PROTOCOL_VERSION, kind: "response", requestId: envelope.requestId, ok: false, error: { code: "PROCESS_FAILURE", message: "injected manager response failure" } })}\n`,
      );
    });
  });
  try {
    await writeFile(paths.token, "test-token".padEnd(43, "x"), { mode: 0o600 });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(paths.socket, resolve);
    });
    await chmod(paths.socket, 0o600);
    const manager = new CoreDaemonManager({ runtimeDirectory });
    const connected = once(server, "connection");
    const status = manager.status();
    const [socket] = await connected;
    const closed = once(socket, "close", { signal: globalThis.AbortSignal.timeout(1_000) });
    assert.equal((await status).state, "stopped");
    await closed;
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
});

test("IPC errors redact credential-shaped untrusted method and version values", async () => {
  await withDaemon(async ({ runtimeDirectory }) => {
    const client = new CoreIpcClient({ runtimeDirectory });
    const methodSecret = "sk-proj-protocolmethodsecret";
    await assert.rejects(
      client.request(request("request-secret-method", `unsupported.${methodSecret}`)),
      (error) => {
        assert.equal(error.name, "CoreIpcError");
        assert.doesNotMatch(error.protocolError.message, new RegExp(methodSecret, "u"));
        assert.doesNotMatch(
          JSON.stringify(error.protocolError.details),
          new RegExp(methodSecret, "u"),
        );
        assert.match(error.protocolError.message, /\[REDACTED\]/u);
        return true;
      },
    );
    client.disconnect();
    const paths = coreRuntimePaths({ runtimeDirectory });
    const token = (await readFile(paths.token, "utf8")).trim();
    const versionSecret = "sk-proj-protocolversionsecret";
    const response = await rawFrame(paths.socket, {
      authToken: token,
      envelope: {
        ...request("request-secret-version", "core.status"),
        protocolVersion: versionSecret,
      },
    });
    assert.equal(response.error.code, "PROTOCOL_VERSION_MISMATCH");
    assert.doesNotMatch(JSON.stringify(response), new RegExp(versionSecret, "u"));
  });
});

test("large valid event histories paginate within the transport byte limit without losing events", async () => {
  await withDaemon(async ({ runtimeDirectory, database }) => {
    for (let number = 2; number <= 35; number += 1) {
      database.eventJournal.append({
        id: `event-large-${number}`,
        projectId: "project-daemon",
        type: "LARGE_FIXTURE_EVENT",
        eventVersion: 1,
        occurredAt: timestamp,
        actor: "test",
        payload: { content: "x".repeat(60_000) },
      });
    }
    const transport = new CoreIpcClient({ runtimeDirectory });
    let requestNumber = 0;
    const client = new CoreV1Client(transport, () => `request-large-${++requestNumber}`);
    try {
      const sequences = [];
      let afterSequence = 0;
      for (;;) {
        const page = await client.request("events.replay", {
          projectId: "project-daemon",
          afterSequence,
          limit: 200,
        });
        assert.equal(page.latestSequence, 35);
        assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") < 1024 * 1024);
        sequences.push(...page.events.map((event) => event.sequenceNumber));
        if (!page.hasMore) break;
        assert.ok(page.events.length > 0);
        afterSequence = page.events.at(-1).sequenceNumber;
      }
      assert.deepEqual(
        sequences,
        Array.from({ length: 35 }, (_, index) => index + 1),
      );
      const subscribed = await client.request("events.subscribe", {
        projectId: "project-daemon",
        afterSequence: 0,
        limit: 200,
      });
      assert.equal(subscribed.hasMore, true);
      assert.ok(subscribed.events.length < 35);
    } finally {
      transport.disconnect();
    }
  });
});

test("v1 replay requires explicit project scope even for a raw authenticated client", async () => {
  await withDaemon(async ({ runtimeDirectory }) => {
    const client = new CoreIpcClient({ runtimeDirectory });
    try {
      await assert.rejects(
        client.request(request("request-unscoped-v1", "events.replay")),
        (error) => error.protocolError?.code === "USER_CONFIGURATION_ERROR",
      );
      assert.equal(
        (await client.request(request("request-legacy-events", "events.list"))).events.length,
        1,
      );
    } finally {
      client.disconnect();
    }
  });
});

test("subscription replay is written before a committed event at the response boundary", async () => {
  await withDaemon(async ({ runtimeDirectory, database }) => {
    const subscribe = database.eventJournal.subscribe.bind(database.eventJournal);
    database.eventJournal.subscribe = (filter, listener) => {
      const unsubscribe = subscribe(filter, listener);
      globalThis.queueMicrotask(() =>
        database.eventJournal.append({
          id: "event-subscription-boundary",
          projectId: "project-daemon",
          type: "BOUNDARY_FIXTURE_EVENT",
          eventVersion: 1,
          occurredAt: timestamp,
          actor: "test",
          payload: {},
        }),
      );
      return unsubscribe;
    };
    const paths = coreRuntimePaths({ runtimeDirectory });
    const firstFrame = await rawFrame(paths.socket, {
      authToken: (await readFile(paths.token, "utf8")).trim(),
      envelope: request("request-subscription-boundary", "events.subscribe", {
        projectId: "project-daemon",
        afterSequence: 0,
      }),
    });
    assert.equal(firstFrame.kind, "response");
    assert.equal(firstFrame.result.subscribed, true);
    assert.deepEqual(
      firstFrame.result.events.map((event) => event.sequenceNumber),
      [1],
    );
  });
});

test("the real CLI starts, connects to, reports, and stops a detached Core daemon", async () => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "densa-core-cli-"));
  const execute = promisify(execFile);
  const cliPath = fileURLToPath(new URL("../packages/cli/dist/bin.js", import.meta.url));
  const environment = { ...process.env, DENSA_CORE_RUNTIME_DIR: runtimeDirectory };
  let started = false;
  try {
    const start = JSON.parse(
      (
        await execute(process.execPath, [cliPath, "core", "start", "--json"], {
          env: environment,
        })
      ).stdout,
    );
    assert.equal(start.ok, true);
    assert.equal(start.data.state, "running");
    started = true;

    const status = JSON.parse(
      (
        await execute(process.execPath, [cliPath, "core", "status", "--json"], {
          env: environment,
        })
      ).stdout,
    );
    assert.equal(status.data.instanceId, start.data.instanceId);

    const stop = JSON.parse(
      (
        await execute(process.execPath, [cliPath, "core", "stop", "--json"], {
          env: environment,
        })
      ).stdout,
    );
    assert.deepEqual(stop.data, { state: "stopped" });
    started = false;
  } finally {
    if (started) {
      await execute(process.execPath, [cliPath, "core", "stop", "--json"], {
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

test("daemon startup recovers malformed keep-awake state and exposes authoritative status", async () => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "densa-core-keep-awake-recovery-"));
  const database = DensaAdeDatabase.openInMemory();
  database.repositories.projects.create({
    id: "project-keep-awake-recovery",
    name: "Keep-awake recovery",
    state: "DRAFT",
    executionMode: "guided",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  database.repositories.projectSettings.set({
    projectId: "project-keep-awake-recovery",
    values: { keepAwake: { formatVersion: 1, malformed: true } },
    updatedAt: timestamp,
  });
  const daemon = await CoreDaemon.start({ runtimeDirectory, database });
  try {
    const client = new CoreIpcClient({ runtimeDirectory });
    const status = await client.request(
      request("request-keep-awake-status", "keep-awake.status", {
        projectId: "project-keep-awake-recovery",
      }),
    );
    assert.equal(status.state, "inactive");
    assert.equal(status.systemSleepPrevented, false);
    assert.equal(
      database.repositories.events
        .replay({ projectId: "project-keep-awake-recovery", limit: 1_000 })
        .at(-1).type,
      "KEEP_AWAKE_RECOVERY_COMPLETED",
    );
    client.disconnect();
  } finally {
    await daemon.stop();
    database.close();
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
});

test("concurrent daemon starters leave exactly one authenticated owner", async () => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "densa-core-concurrent-start-"));
  const database = DensaAdeDatabase.openInMemory();
  const attempts = await Promise.allSettled([
    CoreDaemon.start({ runtimeDirectory, database }),
    CoreDaemon.start({ runtimeDirectory, database }),
  ]);
  const daemons = attempts
    .filter((attempt) => attempt.status === "fulfilled")
    .map((attempt) => attempt.value);
  try {
    assert.equal(daemons.length, 1);
    const client = new CoreIpcClient({ runtimeDirectory });
    assert.equal(
      (await client.request(request("request-concurrent-status", "core.status"))).state,
      "running",
    );
    client.disconnect();
  } finally {
    await Promise.allSettled(daemons.map(async (daemon) => await daemon.stop()));
    database.close();
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
});
