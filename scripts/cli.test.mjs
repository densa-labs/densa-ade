import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { URL } from "node:url";
import { promisify } from "node:util";

import {
  CLI_OUTPUT_SCHEMA_VERSION,
  CliCommandError,
  EXIT_FAILURE,
  EXIT_SUCCESS,
  EXIT_UNAVAILABLE,
  EXIT_USAGE,
  LocalCoreClient,
  cliHelpText,
  runCli,
} from "../packages/cli/dist/index.js";
import { CoreIpcError } from "../packages/core/dist/index.js";
import { PROTOCOL_VERSION } from "../packages/protocol/dist/index.js";

function captureIo() {
  const output = { stdout: "", stderr: "" };
  return {
    output,
    io: {
      stdout(value) {
        output.stdout += value;
      },
      stderr(value) {
        output.stderr += value;
      },
    },
  };
}

function createServices(overrides = {}) {
  return {
    coreClient: {
      async request(request) {
        return { method: request.method, accepted: true };
      },
    },
    coreLifecycle: {
      async start() {
        return {
          state: "running",
          instanceId: "instance-test",
          pid: 123,
          startedAt: "2026-08-29T00:00:00.000Z",
          socketPath: "/tmp/densa-test/core.sock",
          connectedClients: 0,
          protocolVersion: PROTOCOL_VERSION,
        };
      },
      async status() {
        return { state: "stopped" };
      },
      async stop() {
        return { state: "stopped" };
      },
    },
    doctorService: {
      async inspect() {
        return [
          { name: "node", status: "available", detail: "v22.13.0" },
          { name: "git", status: "available", detail: "git version 2.50.0" },
          { name: "platform", status: "available", detail: "darwin (arm64)" },
          { name: "agent", status: "placeholder", detail: "Phase 1" },
          { name: "core", status: "placeholder", detail: "Phase 2" },
        ];
      },
    },
    phaseOneProofService: {
      async run() {
        return { verdict: "PASS", finalPhaseState: "AWAITING_APPROVAL" };
      },
    },
    createRequestId() {
      return "request-test-1";
    },
    ...overrides,
  };
}

test("top-level help coherently lists every milestone command", async () => {
  const { io, output } = captureIo();
  const exitCode = await runCli(["--help"], { io, services: createServices() });

  assert.equal(exitCode, EXIT_SUCCESS);
  assert.equal(output.stderr, "");
  assert.equal(output.stdout, `${cliHelpText}\n`);
  for (const command of [
    "core start",
    "core status",
    "core stop",
    "doctor",
    "proof phase-one",
    "project init",
    "project status",
    "project start",
    "project pause",
    "project cancel",
    "project resume",
    "project stop",
    "events",
    "version",
  ]) {
    assert.match(output.stdout, new RegExp(command));
  }
});

test("the phase-one proof command uses the dedicated real-loop service", async () => {
  const { io, output } = captureIo();
  let calls = 0;
  const exitCode = await runCli(["proof", "phase-one", "--json"], {
    io,
    services: createServices({
      phaseOneProofService: {
        async run() {
          calls += 1;
          return { verdict: "PASS", finalPhaseState: "AWAITING_APPROVAL" };
        },
      },
    }),
  });

  assert.equal(exitCode, EXIT_SUCCESS);
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(output.stdout).data, {
    verdict: "PASS",
    finalPhaseState: "AWAITING_APPROVAL",
  });
});

test("Core lifecycle commands use the daemon lifecycle boundary", async () => {
  for (const expected of [
    { arguments: ["core", "start"], command: "core start", state: "running" },
    { arguments: ["core", "status"], command: "core status", state: "stopped" },
    { arguments: ["core", "stop"], command: "core stop", state: "stopped" },
  ]) {
    const { io, output } = captureIo();
    const exitCode = await runCli(["--json", ...expected.arguments], {
      io,
      services: createServices(),
    });
    assert.equal(exitCode, EXIT_SUCCESS);
    const parsed = JSON.parse(output.stdout);
    assert.equal(parsed.command, expected.command);
    assert.equal(parsed.data.state, expected.state);
  }
});

test("doctor reports host checks and labels agent and Core placeholders", async () => {
  const { io, output } = captureIo();
  const exitCode = await runCli(["doctor"], { io, services: createServices() });

  assert.equal(exitCode, EXIT_SUCCESS);
  assert.equal(output.stderr, "");
  assert.match(output.stdout, /node\s+ok\s+v22\.13\.0/u);
  assert.match(output.stdout, /git\s+ok\s+git version 2\.50\.0/u);
  assert.match(output.stdout, /platform\s+ok\s+darwin \(arm64\)/u);
  assert.match(output.stdout, /agent\s+placeholder\s+Phase 1/u);
  assert.match(output.stdout, /core\s+placeholder\s+Phase 2/u);
});

test("JSON mode has a stable versioned shape", async () => {
  const { io, output } = captureIo();
  const exitCode = await runCli(["version", "--json"], { io, services: createServices() });

  assert.equal(exitCode, EXIT_SUCCESS);
  assert.equal(output.stderr, "");
  assert.deepEqual(JSON.parse(output.stdout), {
    schemaVersion: CLI_OUTPUT_SCHEMA_VERSION,
    command: "version",
    ok: true,
    data: {
      cliVersion: "0.0.0",
      protocolVersion: PROTOCOL_VERSION,
    },
  });
});

test("help and version do not eagerly load Core or emit runtime warnings", async () => {
  const execute = promisify(execFile);
  const cliPath = new URL("../packages/cli/dist/bin.js", import.meta.url);

  const help = await execute(process.execPath, [cliPath.pathname, "--help"]);
  assert.equal(help.stderr, "");
  assert.match(help.stdout, /Headless client shell for Densa ADE Core/u);

  const version = await execute(process.execPath, [cliPath.pathname, "version", "--json"]);
  assert.equal(version.stderr, "");
  assert.equal(JSON.parse(version.stdout).data.protocolVersion, PROTOCOL_VERSION);
});

test("every Core command uses a versioned shared-protocol request", async () => {
  const commands = [
    { arguments: ["project", "init"], command: "project init", method: "project.init" },
    { arguments: ["project", "status"], command: "project status", method: "project.status" },
    { arguments: ["project", "start"], command: "project start", method: "project.start" },
    { arguments: ["project", "pause"], command: "project pause", method: "project.pause" },
    { arguments: ["project", "cancel"], command: "project cancel", method: "project.cancel" },
    { arguments: ["project", "resume"], command: "project resume", method: "project.resume" },
    { arguments: ["project", "stop"], command: "project stop", method: "project.stop" },
    { arguments: ["events"], command: "events", method: "events.list" },
  ];

  for (const expected of commands) {
    const { io, output } = captureIo();
    let receivedRequest;
    const services = createServices({
      coreClient: {
        async request(request) {
          receivedRequest = request;
          return { accepted: true };
        },
      },
    });

    const exitCode = await runCli(["--json", ...expected.arguments], { io, services });

    assert.equal(exitCode, EXIT_SUCCESS);
    assert.deepEqual(receivedRequest, {
      protocolVersion: PROTOCOL_VERSION,
      kind: "request",
      requestId: "request-test-1",
      method: expected.method,
      payload: {},
    });
    assert.deepEqual(JSON.parse(output.stdout), {
      schemaVersion: CLI_OUTPUT_SCHEMA_VERSION,
      command: expected.command,
      ok: true,
      data: { accepted: true },
    });
  }
});

test("an unavailable Core client fails clearly without starting an agent", async () => {
  const { io, output } = captureIo();
  const exitCode = await runCli(["events", "--json"], {
    io,
    services: createServices({
      coreClient: {
        async request() {
          throw new CliCommandError(
            "PROCESS_FAILURE",
            "Densa ADE Core is unavailable",
            EXIT_UNAVAILABLE,
          );
        },
      },
    }),
  });
  const json = JSON.parse(output.stdout);

  assert.equal(exitCode, EXIT_UNAVAILABLE);
  assert.equal(output.stderr, "");
  assert.equal(json.ok, false);
  assert.equal(json.error.code, "PROCESS_FAILURE");
  assert.match(json.error.message, /Core is unavailable/u);
});

test("a responsive Core error is not misclassified as Core unavailability", async () => {
  let disconnects = 0;
  const coreClient = new LocalCoreClient({
    async request() {
      throw new CoreIpcError({
        code: "USER_CONFIGURATION_ERROR",
        message: "Unsupported Core method: project.init",
        details: { method: "project.init" },
      });
    },
    disconnect() {
      disconnects += 1;
    },
  });

  await assert.rejects(
    () =>
      coreClient.request({
        protocolVersion: PROTOCOL_VERSION,
        kind: "request",
        requestId: "request-responsive-error",
        method: "project.init",
        payload: {},
      }),
    (error) => {
      assert.ok(error instanceof CliCommandError);
      assert.equal(error.code, "USER_CONFIGURATION_ERROR");
      assert.equal(error.exitCode, EXIT_USAGE);
      return true;
    },
  );
  assert.equal(disconnects, 1);

  const failingClient = new LocalCoreClient({
    async request() {
      throw new CoreIpcError({
        code: "PERSISTENCE_FAILURE",
        message: "Core persistence failed",
      });
    },
    disconnect() {},
  });
  await assert.rejects(
    () =>
      failingClient.request({
        protocolVersion: PROTOCOL_VERSION,
        kind: "request",
        requestId: "request-responsive-failure",
        method: "project.status",
        payload: {},
      }),
    (error) => {
      assert.ok(error instanceof CliCommandError);
      assert.equal(error.exitCode, EXIT_FAILURE);
      return true;
    },
  );
});

test("invalid commands use a stable usage error and nonzero exit", async () => {
  const { io, output } = captureIo();
  const exitCode = await runCli(["project", "launch", "--json"], {
    io,
    services: createServices(),
  });
  const json = JSON.parse(output.stdout);

  assert.equal(exitCode, EXIT_USAGE);
  assert.equal(output.stderr, "");
  assert.equal(json.ok, false);
  assert.equal(json.error.code, "USER_CONFIGURATION_ERROR");
  assert.match(json.error.message, /Unknown project command/u);
});
