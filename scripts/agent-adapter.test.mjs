import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";

import { CodexAdapter, isTerminalAgentEvent } from "../packages/agent-sdk/dist/index.js";
import { FakeAgentAdapter } from "../packages/testing/dist/index.js";

const fixedTime = "2026-08-25T12:00:00.000Z";

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function iteratorFor(iterable) {
  return iterable[Symbol.asyncIterator]();
}

async function createFakeCodex(t, execProgram, loginExitCode = 0, version = "0.147.0") {
  const directory = await mkdtemp(path.join(tmpdir(), "densa-codex-adapter-"));
  t.after(async () => await rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "codex");
  const source = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
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

test("CodexAdapter reports usage as unknown without fabricating a reset", async () => {
  const adapter = new CodexAdapter({ command: "unused" });
  const usage = await adapter.getUsageState();

  assert.equal(usage.status, "unknown");
  assert.match(usage.reason, /no supported machine-readable usage\/reset status/u);
  assert.equal("resetAt" in usage, false);
});
