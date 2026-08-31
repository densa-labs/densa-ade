import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";

import {
  CodexAdapter,
  isTerminalAgentEvent,
  redactAgentText,
  RedactedAgentTextStream,
} from "../packages/agent-sdk/dist/index.js";
import { FakeAgentAdapter } from "../packages/testing/dist/index.js";

const fixedTime = "2026-08-25T12:00:00.000Z";

test("diagnostic redaction preserves secret framing across multiline and oversized chunks", () => {
  assert.equal(redactAgentText("<secret>unterminated-canary"), "[REDACTED]");
  assert.equal(redactAgentText("[secret:unterminated-canary"), "[REDACTED]");
  const output = [];
  const stream = new RedactedAgentTextStream(64, (text) => output.push(text));
  stream.append("<secret>\nexplicit-canary\n</secret>\nsafe\n");
  stream.append(
    "<secret>first</secret><secret>\nreopened-canary\n</secret><secret>\nnext-canary\n</secret>\n",
  );
  stream.append("[secret:\nbracket-canary\n]\n");
  stream.append("-----BEGIN PRIVATE KEY-----" + "x".repeat(100));
  stream.append("\nprivate-canary\n-----END PRIVATE KEY-----\n");
  stream.finish();
  assert.doesNotMatch(output.join(""), /canary/u);
  assert.match(output.join(""), /safe/u);
  assert.match(output.join(""), /Oversized/u);
});

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function iteratorFor(iterable) {
  return iterable[Symbol.asyncIterator]();
}

async function createFakeCodex(
  t,
  execProgram,
  loginExitCode = 0,
  version = "0.147.0",
  versionPrefix = "",
) {
  const directory = await mkdtemp(path.join(tmpdir(), "densa-codex-adapter-"));
  t.after(async () => await rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "codex");
  const source = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  ${versionPrefix}
  process.stdout.write(${JSON.stringify(`codex-cli ${version}\n`)});
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  process.stdout.write(${loginExitCode === 0 ? '"Logged in using ChatGPT\\n"' : '"Not logged in\\n"'});
  process.exit(${loginExitCode});
}
if (!args.includes("exec")) process.exit(2);
if (!args.includes("--json") || !args.includes("--skip-git-repo-check")) process.exit(2);
${execProgram}
`;
  await writeFile(executable, source, "utf8");
  await chmod(executable, 0o755);
  return { directory, executable };
}

async function adapterForUsageFixture(t, name) {
  const fixture = await readFile(
    new globalThis.URL(
      `../packages/testing/fixtures/codex-cli/usage-state-contract/${name}`,
      import.meta.url,
    ),
    "utf8",
  );
  const { executable } = await createFakeCodex(
    t,
    `process.stdout.write(${JSON.stringify(fixture)});\nprocess.exit(1);`,
  );
  return new CodexAdapter({ command: executable, now: () => fixedTime });
}

test("FakeAgentAdapter satisfies detection, status, execution, and usage contracts", async () => {
  const adapter = new FakeAgentAdapter({
    now: () => fixedTime,
    events: [
      { type: "progress", stage: "working" },
      { type: "message", text: "finished", truncated: false },
    ],
    finalMessage: "finished",
    exitCode: 0,
  });
  const request = { runId: "fake-run-1", cwd: "/tmp/project", prompt: "Do the task" };

  assert.deepEqual(await adapter.detect(), {
    status: "available",
    adapterId: "fake",
    command: "fake-agent",
    version: "1.0.0",
  });
  assert.deepEqual(await adapter.getStatus(), { status: "available", version: "1.0.0" });
  assert.deepEqual(await adapter.getUsageState(), { status: "available" });

  const events = await collect(adapter.execute(request));
  assert.deepEqual(adapter.requests, [request]);
  assert.deepEqual(
    events.map(({ type }) => type),
    ["run.started", "progress", "message", "run.terminal"],
  );
  assert.deepEqual(events.at(-1), {
    type: "run.terminal",
    runId: "fake-run-1",
    occurredAt: fixedTime,
    outcome: "succeeded",
    exitCode: 0,
    finalMessage: "finished",
  });
});

test("FakeAgentAdapter cancellation emits exactly one deterministic terminal event", async () => {
  const adapter = new FakeAgentAdapter({ holdOpen: true, now: () => fixedTime });
  const iterator = iteratorFor(
    adapter.execute({ runId: "fake-cancel-1", cwd: "/tmp/project", prompt: "Wait" }),
  );

  assert.equal((await iterator.next()).value.type, "run.started");
  const terminalPromise = iterator.next();
  await adapter.cancel("fake-cancel-1");
  assert.deepEqual((await terminalPromise).value, {
    type: "run.terminal",
    runId: "fake-cancel-1",
    occurredAt: fixedTime,
    outcome: "cancelled",
  });
  assert.equal((await iterator.next()).done, true);
  assert.deepEqual(adapter.cancelledRunIds, ["fake-cancel-1"]);
});

test("CodexAdapter detects its version and executes structured JSONL in the requested cwd", async (t) => {
  const { directory, executable } = await createFakeCodex(
    t,
    `let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "fixture-thread" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.started" }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "item.completed",
    item: { type: "command_execution", command: "false", status: "failed", exit_code: 1, aggregated_output: "" }
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "cwd=" + process.cwd() + ";prompt=" + prompt + ";sandbox=" + args[args.indexOf("--sandbox") + 1] }
  }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");
});`,
  );
  const adapter = new CodexAdapter({ command: executable, now: () => fixedTime });

  assert.deepEqual(await adapter.detect(), {
    status: "available",
    adapterId: "codex",
    command: executable,
    version: "0.147.0",
  });
  assert.deepEqual(await adapter.getStatus(), { status: "available", version: "0.147.0" });

  const events = await collect(
    adapter.execute({
      runId: "codex-success-1",
      cwd: directory,
      prompt: "respond exactly",
      accessMode: "read-only",
    }),
  );
  const tool = events.find(({ type }) => type === "tool");
  const terminal = events.find(isTerminalAgentEvent);

  assert.equal(events[0].type, "run.started");
  assert.deepEqual(tool, {
    type: "tool",
    runId: "codex-success-1",
    occurredAt: fixedTime,
    toolType: "command",
    status: "failed",
    command: "false",
    output: "",
    exitCode: 1,
    truncated: false,
  });
  assert.equal(terminal.outcome, "succeeded", "a handled tool failure does not fail the turn");
  assert.equal(terminal.exitCode, 0);
  assert.match(terminal.finalMessage, new RegExp(`cwd=.*${path.basename(directory)}`));
  assert.match(terminal.finalMessage, /prompt=respond exactly/u);
  assert.match(terminal.finalMessage, /sandbox=read-only/u);
});

test("CodexAdapter materializes a constrained output schema and cleans it after the run", async (t) => {
  const { executable } = await createFakeCodex(
    t,
    `const schemaIndex = args.indexOf("--output-schema");
if (schemaIndex < 0) process.exit(2);
const schemaPath = args[schemaIndex + 1];
const { readFileSync } = await import("node:fs");
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
process.stdout.write(JSON.stringify({ type: "turn.started" }) + "\\n");
process.stdout.write(JSON.stringify({
  type: "item.completed",
  item: { type: "agent_message", text: "schemaPath=" + schemaPath + ";type=" + schema.type }
}) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");`,
  );
  const adapter = new CodexAdapter({ command: executable, now: () => fixedTime });

  const events = await collect(
    adapter.execute({
      runId: "codex-schema-1",
      cwd: tmpdir(),
      prompt: "return structured data",
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: { ok: { type: "boolean" } },
      },
    }),
  );
  const terminal = events.find(isTerminalAgentEvent);
  assert.equal(terminal.outcome, "succeeded");
  assert.match(terminal.finalMessage, /;type=object$/u);
  const schemaPath = terminal.finalMessage.match(/^schemaPath=(.*);type=/u)?.[1];
  assert.ok(schemaPath);
  await assert.rejects(stat(schemaPath), (error) => error.code === "ENOENT");
});

test("CodexAdapter returns classified terminal errors for missing and unauthenticated Codex", async (t) => {
  const missing = new CodexAdapter({
    command: path.join(tmpdir(), "densa-definitely-missing-codex"),
    now: () => fixedTime,
  });
  const missingEvents = await collect(
    missing.execute({ runId: "missing-1", cwd: tmpdir(), prompt: "task" }),
  );
  assert.equal(missingEvents.at(-1).error.code, "AGENT_UNAVAILABLE");

  const { executable } = await createFakeCodex(t, "process.exit(99);", 1);
  const unauthenticated = new CodexAdapter({ command: executable, now: () => fixedTime });
  assert.deepEqual(await unauthenticated.getStatus(), {
    status: "authentication-required",
    version: "0.147.0",
  });
  const authEvents = await collect(
    unauthenticated.execute({ runId: "auth-1", cwd: tmpdir(), prompt: "task" }),
  );
  assert.equal(authEvents.at(-1).outcome, "failed");
  assert.equal(authEvents.at(-1).error.code, "AUTHENTICATION_REQUIRED");
});

test("CodexAdapter classifies an invalid cwd and keeps unverified version signals unknown", async (t) => {
  const missingCwd = path.join(tmpdir(), "densa-definitely-missing-cwd");
  const adapter = new CodexAdapter({ command: "unused", now: () => fixedTime });
  const cwdEvents = await collect(
    adapter.execute({ runId: "bad-cwd-1", cwd: missingCwd, prompt: "task" }),
  );
  assert.equal(cwdEvents.at(-1).error.code, "USER_CONFIGURATION_ERROR");

  const { executable } = await createFakeCodex(t, "process.exit(99);", 1, "99.0.0");
  const futureVersion = new CodexAdapter({ command: executable });
  assert.deepEqual(await futureVersion.getStatus(), {
    status: "unknown",
    version: "99.0.0",
    reason: "Codex authentication signals are not verified for version 99.0.0",
  });
  const futureEvents = await collect(
    futureVersion.execute({ runId: "future-version-1", cwd: tmpdir(), prompt: "task" }),
  );
  assert.equal(futureEvents.at(-1).error.code, "PROTOCOL_VERSION_MISMATCH");
});

test("CodexAdapter bounds and redacts streamed and terminal text", async (t) => {
  const { executable } = await createFakeCodex(
    t,
    `process.stderr.write("password=hunter2\\n");
process.stdout.write(JSON.stringify({ type: "turn.started" }) + "\\n");
process.stdout.write(JSON.stringify({
  type: "item.completed",
  item: { type: "agent_message", text: "secret=sk-abcdefghijklmnop " + "x".repeat(200) }
}) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");`,
  );
  const adapter = new CodexAdapter({
    command: executable,
    eventTextLimitBytes: 32,
    captureLimitBytes: 48,
    now: () => fixedTime,
  });
  const events = await collect(
    adapter.execute({ runId: "bounded-1", cwd: tmpdir(), prompt: "task" }),
  );
  const diagnostic = events.find(({ type }) => type === "diagnostic");
  const message = events.find(({ type }) => type === "message");
  const terminal = events.find(isTerminalAgentEvent);

  assert.doesNotMatch(diagnostic.text, /hunter2/u);
  assert.match(diagnostic.text, /\[REDACTED\]/u);
  assert.equal(message.truncated, true);
  assert.doesNotMatch(message.text, /sk-/u);
  assert.ok(Buffer.byteLength(message.text) <= 32);
  assert.doesNotMatch(terminal.finalMessage, /sk-/u);
  assert.ok(Buffer.byteLength(terminal.finalMessage) <= 48);
});

test("CodexAdapter inherits only an explicit non-secret environment allowlist", async (t) => {
  const { executable } = await createFakeCodex(
    t,
    `process.stdout.write(JSON.stringify({ type: "turn.started" }) + "\\n");
process.stdout.write(JSON.stringify({
  type: "item.completed",
  item: {
    type: "agent_message",
    text: JSON.stringify({
      home: process.env.HOME,
      codexHome: process.env.CODEX_HOME,
      hasUnexpectedSecret: process.env.DENSA_PHASE1_SECRET !== undefined
    })
  }
}) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");`,
  );
  const adapter = new CodexAdapter({
    command: executable,
    environment: {
      PATH: process.env.PATH,
      HOME: "/tmp/densa-safe-home",
      CODEX_HOME: "/tmp/densa-safe-codex-home",
      DENSA_PHASE1_SECRET: "opaque-unstructured-secret",
    },
    now: () => fixedTime,
  });

  const events = await collect(
    adapter.execute({ runId: "safe-environment-1", cwd: tmpdir(), prompt: "task" }),
  );
  const terminal = events.find(isTerminalAgentEvent);
  assert.equal(terminal.outcome, "succeeded");
  assert.deepEqual(JSON.parse(terminal.finalMessage), {
    home: "/tmp/densa-safe-home",
    codexHome: "/tmp/densa-safe-codex-home",
    hasUnexpectedSecret: false,
  });
});

test("CodexAdapter bounds queued events for a slow consumer and reports dropped evidence", async (t) => {
  const { executable } = await createFakeCodex(
    t,
    `process.stdout.write(JSON.stringify({ type: "turn.started" }) + "\\n");
for (let index = 0; index < 200; index += 1) {
  process.stdout.write(JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "event-" + index }
  }) + "\\n");
}
process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");`,
  );
  const adapter = new CodexAdapter({
    command: executable,
    eventBufferLimit: 8,
    now: () => fixedTime,
  });

  const iterator = iteratorFor(
    adapter.execute({ runId: "bounded-queue-1", cwd: tmpdir(), prompt: "task" }),
  );
  const first = await iterator.next();
  assert.equal(first.done, false);
  await new Promise((resolve) => globalThis.setTimeout(resolve, 150));
  const events = [first.value];
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    events.push(next.value);
  }
  const terminal = events.find(isTerminalAgentEvent);
  const dropped = events.find(
    (event) => event.type === "diagnostic" && /event buffer dropped/u.test(event.text),
  );

  assert.equal(events[0].type, "run.started");
  assert.equal(terminal.outcome, "succeeded");
  assert.ok(dropped, "buffer truncation must be externally visible");
  assert.equal(dropped.truncated, true);
  assert.ok(events.length <= 9, `expected a bounded stream, received ${events.length} events`);
});

test("CodexAdapter redacts current credential shapes and private keys", async (t) => {
  const { executable } = await createFakeCodex(
    t,
    `process.stderr.write("github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ\\n");
process.stdout.write(JSON.stringify({ type: "turn.started" }) + "\\n");
process.stdout.write(JSON.stringify({
  type: "item.completed",
  item: {
    type: "agent_message",
    text: "-----BEGIN PRIVATE KEY-----\\nopaque-material\\n-----END PRIVATE KEY-----"
  }
}) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");`,
  );
  const adapter = new CodexAdapter({ command: executable, now: () => fixedTime });

  const events = await collect(
    adapter.execute({ runId: "expanded-redaction-1", cwd: tmpdir(), prompt: "task" }),
  );
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /github_pat_|opaque-material/u);
  assert.match(serialized, /REDACTED/u);
});

test("CodexAdapter fails closed when the JSONL terminal contract is malformed", async (t) => {
  const { executable } = await createFakeCodex(
    t,
    `process.stdout.write("not-json\\n");
process.exit(0);`,
  );
  const adapter = new CodexAdapter({ command: executable, now: () => fixedTime });
  const events = await collect(
    adapter.execute({ runId: "malformed-1", cwd: tmpdir(), prompt: "task" }),
  );

  assert.equal(events.at(-1).outcome, "failed");
  assert.equal(events.at(-1).error.code, "PROTOCOL_VERSION_MISMATCH");
});

test("CodexAdapter rejects invalid envelopes and contradictory terminal signals", async (t) => {
  for (const prefix of [
    "null",
    "[]",
    '{"type":"item.completed"}',
    '{"type":"turn.failed","error":{"message":"failed"}}',
  ]) {
    const { executable } = await createFakeCodex(
      t,
      `process.stdout.write(${JSON.stringify(`${prefix}\n{"type":"turn.completed"}\n`)});`,
    );
    const events = await collect(
      new CodexAdapter({ command: executable }).execute({
        runId: "invalid-envelope",
        cwd: tmpdir(),
        prompt: "task",
      }),
    );
    assert.equal(events.at(-1).outcome, "failed", prefix);
    assert.equal(events.at(-1).error.code, "PROTOCOL_VERSION_MISMATCH", prefix);
  }
});

test("CodexAdapter preserves only the final completed message as the final response", async (t) => {
  const { executable } = await createFakeCodex(
    t,
    `
for (const text of ["Working on this.", '{"ok":true}']) {
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }) + "\\n");
}
process.stdout.write('{"type":"turn.completed"}\\n');`,
  );
  const events = await collect(
    new CodexAdapter({ command: executable }).execute({
      runId: "final-message",
      cwd: tmpdir(),
      prompt: "task",
    }),
  );
  assert.equal(events.filter((event) => event.type === "message").length, 2);
  assert.deepEqual(JSON.parse(events.at(-1).finalMessage), { ok: true });
});

test("CodexAdapter does not retain stale available usage after an unclassified failure", async (t) => {
  const { executable } = await createFakeCodex(
    t,
    `
let prompt = "";
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => process.stdout.write(prompt === "success" ? '{"type":"turn.completed"}\\n' : 'not-json\\n'));`,
  );
  const adapter = new CodexAdapter({ command: executable });
  await collect(adapter.execute({ runId: "usage-success", cwd: tmpdir(), prompt: "success" }));
  assert.equal((await adapter.getUsageState()).status, "available");
  await collect(adapter.execute({ runId: "usage-malformed", cwd: tmpdir(), prompt: "failure" }));
  assert.equal((await adapter.getUsageState()).status, "unknown");
});

test("CodexAdapter redacts split stderr, quoted JSON secrets, and all bounded text fields", async (t) => {
  const quotedSecret = JSON.stringify({
    password: 'prefix"suffix',
    accessToken: "opaque-json-canary",
  });
  const { executable } = await createFakeCodex(
    t,
    `
process.stderr.write("pass");
await new Promise((resolve) => setTimeout(resolve, 30));
process.stderr.write("word=split-canary\\n-----BEGIN PRIVATE KEY-----\\n");
await new Promise((resolve) => setTimeout(resolve, 30));
process.stderr.write("split-private-material\\n-----END PRIVATE KEY-----\\n");
process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: ${JSON.stringify(quotedSecret)} } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "password=stage-canary" } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.failed", error: { message: "🙂".repeat(100) } }) + "\\n");
process.exitCode = 1;`,
  );
  const events = await collect(
    new CodexAdapter({ command: executable, eventTextLimitBytes: 65 }).execute({
      runId: "stream-redaction",
      cwd: tmpdir(),
      prompt: "task",
    }),
  );
  assert.doesNotMatch(
    JSON.stringify(events),
    /split-canary|split-private-material|prefix|suffix|opaque-json-canary|stage-canary/u,
  );
  const message = events.find((event) => event.type === "message");
  assert.deepEqual(JSON.parse(message.text), { password: "[REDACTED]", accessToken: "[REDACTED]" });
  assert.ok(Buffer.byteLength(events.at(-1).error.message) <= 65);
});

test(
  "CodexAdapter cancellation during a status probe cannot start the worker later",
  { timeout: 5_000 },
  async (t) => {
    const markerDirectory = await mkdtemp(path.join(tmpdir(), "densa-probe-cancel-"));
    t.after(() => rm(markerDirectory, { recursive: true, force: true }));
    const probeMarker = path.join(markerDirectory, "probe");
    const workerMarker = path.join(markerDirectory, "worker");
    const { executable } = await createFakeCodex(
      t,
      `const { writeFileSync } = await import("node:fs"); writeFileSync(${JSON.stringify(workerMarker)}, "started");`,
      0,
      "0.147.0",
      `const { writeFileSync } = await import("node:fs"); writeFileSync(${JSON.stringify(probeMarker)}, "started"); await new Promise(() => { setInterval(() => {}, 1000); });`,
    );
    const adapter = new CodexAdapter({ command: executable });
    const iterator = iteratorFor(
      adapter.execute({ runId: "cancel-probe", cwd: tmpdir(), prompt: "task" }),
    );
    const first = iterator.next();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        await stat(probeMarker).then(
          () => true,
          () => false,
        )
      )
        break;
      await new Promise((resolve) => globalThis.setTimeout(resolve, 10));
    }
    await stat(probeMarker);
    await adapter.cancel("cancel-probe");
    assert.equal((await first).value.type, "run.started");
    assert.equal((await iterator.next()).value.outcome, "cancelled");
    assert.equal((await iterator.next()).done, true);
    await assert.rejects(stat(workerMarker), { code: "ENOENT" });
  },
);

test(
  "CodexAdapter normal exit cleans descendants holding inherited output pipes",
  { timeout: 5_000 },
  async (t) => {
    const { executable } = await createFakeCodex(
      t,
      `
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
process.stdout.write(JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "child:" + child.pid } }) + "\\n");
process.stdout.write('{"type":"turn.completed"}\\n');
process.exit(0);`,
    );
    const events = await collect(
      new CodexAdapter({ command: executable }).execute({
        runId: "normal-orphan",
        cwd: tmpdir(),
        prompt: "task",
      }),
    );
    const childPid = Number(
      events
        .find((event) => event.type === "tool")
        .command.split(":")
        .at(-1),
    );
    t.after(() => {
      try {
        process.kill(childPid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    });
    assert.equal(events.at(-1).outcome, "succeeded");
    await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
    assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
  },
);

test("CodexAdapter process-group cleanup is idempotent across exit and close", async (t) => {
  const { executable } = await createFakeCodex(
    t,
    `process.stdout.write('{"type":"turn.completed"}\\n');`,
  );
  const kill = process.kill;
  const signalled = new Set();
  t.after(() => {
    process.kill = kill;
  });
  process.kill = function (pid, signal) {
    if (pid < 0 && signal === "SIGKILL") {
      assert.equal(signalled.has(pid), false, "do not signal a terminated group identity twice");
      signalled.add(pid);
    }
    return kill.call(process, pid, signal);
  };
  const events = await collect(
    new CodexAdapter({ command: executable }).execute({
      runId: "idempotent-cleanup",
      cwd: tmpdir(),
      prompt: "task",
    }),
  );
  assert.equal(events.at(-1).outcome, "succeeded");
  assert.equal(signalled.size, 3, "version, status, and execution each own one cleanup");
});

test("CodexAdapter cancellation kills descendants after the parent has closed", async (t) => {
  const { executable } = await createFakeCodex(
    t,
    `
const child = spawn(process.execPath, ["-e", "process.on('SIGINT', () => {}); process.send('ready'); setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
child.once("message", () => process.stdout.write(JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "child:" + child.pid, status: "in_progress" } }) + "\\n"));
setInterval(() => {}, 1000);`,
  );
  const adapter = new CodexAdapter({ command: executable, cancellationGraceMs: 100 });
  const iterator = iteratorFor(
    adapter.execute({ runId: "cancel-orphan", cwd: tmpdir(), prompt: "task" }),
  );
  let childPid;
  for (;;) {
    const next = await iterator.next();
    if (next.value.type === "tool") {
      childPid = Number(next.value.command.split(":").at(-1));
      break;
    }
  }
  t.after(() => {
    try {
      process.kill(childPid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  });
  await adapter.cancel("cancel-orphan");
  const terminal = await iterator.next();
  assert.equal(terminal.value.outcome, "cancelled");
  await iterator.next();
  await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
  assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
});

test("CodexAdapter cancellation terminates the process group and emits one terminal event", async (t) => {
  const { executable } = await createFakeCodex(
    t,
    `const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
process.on("SIGINT", () => {});
process.stdout.write(JSON.stringify({ type: "turn.started" }) + "\\n");
process.stdout.write(JSON.stringify({
  type: "item.started",
  item: { type: "command_execution", command: "fixture-child:" + child.pid, status: "in_progress" }
}) + "\\n");
setInterval(() => {}, 1000);`,
  );
  const adapter = new CodexAdapter({
    command: executable,
    cancellationGraceMs: 50,
    now: () => fixedTime,
  });
  const iterator = iteratorFor(
    adapter.execute({ runId: "cancel-1", cwd: tmpdir(), prompt: "wait" }),
  );
  let childPid;

  for (;;) {
    const next = await iterator.next();
    assert.equal(next.done, false);
    if (next.value.type === "tool") {
      childPid = Number(next.value.command.split(":").at(-1));
      break;
    }
  }

  const pending = iterator.next();
  await adapter.cancel("cancel-1");
  const remaining = [(await pending).value];
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    remaining.push(next.value);
  }
  const terminals = remaining.filter(isTerminalAgentEvent);
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].outcome, "cancelled");
  assert.equal(terminals[0].exitCode, undefined, "signal exits omit a numeric process exit code");
  assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
});

test("CodexAdapter cleans up a run when its event consumer stops early", async (t) => {
  const { executable } = await createFakeCodex(
    t,
    `process.on("SIGINT", () => {});
process.stdout.write(JSON.stringify({ type: "turn.started" }) + "\\n");
process.stdout.write(JSON.stringify({
  type: "item.started",
  item: { type: "command_execution", command: "fixture-parent:" + process.pid, status: "in_progress" }
}) + "\\n");
setInterval(() => {}, 1000);`,
  );
  const adapter = new CodexAdapter({ command: executable, cancellationGraceMs: 50 });
  const iterator = iteratorFor(
    adapter.execute({ runId: "abandoned-1", cwd: tmpdir(), prompt: "wait" }),
  );
  let parentPid;

  for (;;) {
    const next = await iterator.next();
    if (next.value.type === "tool") {
      parentPid = Number(next.value.command.split(":").at(-1));
      break;
    }
  }

  assert.equal((await iterator.return()).done, true);
  assert.throws(() => process.kill(parentPid, 0), { code: "ESRCH" });
});

test("CodexAdapter starts with unknown usage and does not fabricate a reset", async () => {
  const adapter = new CodexAdapter({ command: "unused" });
  const usage = await adapter.getUsageState();

  assert.equal(usage.status, "unknown");
  assert.match(usage.reason, /No reliable Codex usage signal/u);
  assert.equal("resetAt" in usage, false);
});

test("CodexAdapter maps only structured usage-limit signals and preserves observed reset time", async (t) => {
  const withReset = await adapterForUsageFixture(t, "limited-with-reset.jsonl");
  const withResetEvents = await collect(
    withReset.execute({ runId: "usage-reset-1", cwd: tmpdir(), prompt: "task" }),
  );
  assert.equal(withResetEvents.at(-1).error.code, "USAGE_LIMITED");
  assert.deepEqual(await withReset.getUsageState(), {
    status: "limited",
    resetAt: "2026-08-25T17:00:00.000Z",
  });

  const withoutReset = await adapterForUsageFixture(t, "limited-without-reset.jsonl");
  const withoutResetEvents = await collect(
    withoutReset.execute({ runId: "usage-no-reset-1", cwd: tmpdir(), prompt: "task" }),
  );
  assert.equal(withoutResetEvents.at(-1).error.code, "USAGE_LIMITED");
  assert.deepEqual(await withoutReset.getUsageState(), { status: "limited" });
  assert.equal("resetAt" in (await withoutReset.getUsageState()), false);
});

test("CodexAdapter leaves prose-like unknown failures unknown and keeps auth distinct", async (t) => {
  const unknown = await adapterForUsageFixture(t, "unknown-failure.jsonl");
  const unknownEvents = await collect(
    unknown.execute({ runId: "usage-unknown-1", cwd: tmpdir(), prompt: "task" }),
  );
  assert.equal(unknownEvents.at(-1).error.code, "PROCESS_FAILURE");
  assert.equal((await unknown.getUsageState()).status, "unknown");
  assert.equal("resetAt" in (await unknown.getUsageState()), false);

  const auth = await adapterForUsageFixture(t, "authentication-failure.jsonl");
  const authEvents = await collect(
    auth.execute({ runId: "usage-auth-1", cwd: tmpdir(), prompt: "task" }),
  );
  assert.equal(authEvents.at(-1).error.code, "AUTHENTICATION_REQUIRED");
  assert.equal((await auth.getUsageState()).status, "unknown");
  assert.equal("resetAt" in (await auth.getUsageState()), false);
});
