import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers";
import { promisify } from "node:util";

import { runTemporaryRepoTaskProof } from "../packages/core/dist/index.js";
import { FakeAgentAdapter } from "../packages/testing/dist/index.js";

const execFileAsync = promisify(execFile);

async function cleanupResult(result) {
  await Promise.all([
    rm(result.temporaryRoot, { recursive: true, force: true }),
    rm(result.diagnosticsRoot, { recursive: true, force: true }),
  ]);
}

test("temporary-repo proof reports PASS only after deterministic validation", async (t) => {
  const adapter = new FakeAgentAdapter({
    finalMessage: "The task is complete.",
    exitCode: 0,
    onExecute: async ({ cwd }) => {
      await writeFile(
        path.join(cwd, "src", "sum.js"),
        "export function sum(a, b) {\n  return a + b;\n}\n",
        "utf8",
      );
    },
  });

  const result = await runTemporaryRepoTaskProof({ adapter, runId: "proof-pass" });
  t.after(async () => await cleanupResult(result));

  assert.equal(result.verdict, "PASS");
  assert.deepEqual(result.failureReasons, []);
  assert.deepEqual(result.changes.modified, ["src/sum.js"]);
  assert.equal(result.acceptanceResults[0].passed, true);
  assert.equal(adapter.requests[0].cwd, result.workspacePath);
  assert.match(adapter.requests[0].prompt, /You may edit only: src\/sum\.js/u);

  const diagnostic = JSON.parse(await readFile(result.diagnosticsPath, "utf8"));
  assert.equal(diagnostic.schemaVersion, 1);
  assert.equal(diagnostic.verdict, "PASS");
  assert.equal(diagnostic.agentEvents.at(-1).finalMessage, "The task is complete.");
  assert.equal(diagnostic.acceptanceResults[0].command.exitCode, 0);
  assert.equal((await lstat(result.diagnosticsPath)).mode & 0o777, 0o600);
});

test("a lying fake agent that says done but breaks acceptance is independently FAIL", async (t) => {
  const adapter = new FakeAgentAdapter({
    finalMessage: "Done — all acceptance criteria pass.",
    exitCode: 0,
    onExecute: async ({ cwd }) => {
      await writeFile(
        path.join(cwd, "src", "sum.js"),
        "export function sum(a, b) {\n  return a - b;\n}\n",
        "utf8",
      );
    },
  });

  const result = await runTemporaryRepoTaskProof({ adapter, runId: "proof-lying-fail" });
  t.after(async () => await cleanupResult(result));

  assert.equal(result.verdict, "FAIL");
  assert.deepEqual(result.failureReasons, ["Acceptance criterion failed: PROOF-001-AC1"]);
  assert.equal(result.agentEvents.at(-1).outcome, "succeeded");
  assert.equal(result.agentEvents.at(-1).finalMessage, "Done — all acceptance criteria pass.");
  assert.equal(result.acceptanceResults[0].passed, false);
  assert.notEqual(result.acceptanceResults[0].command.exitCode, 0);
});

test("agent process failure cannot PASS even if its file change validates", async (t) => {
  const adapter = new FakeAgentAdapter({
    outcome: "failed",
    finalMessage: "done",
    exitCode: 1,
    onExecute: async ({ cwd }) => {
      await writeFile(
        path.join(cwd, "src", "sum.js"),
        "export function sum(a, b) {\n  return a + b;\n}\n",
        "utf8",
      );
    },
  });

  const result = await runTemporaryRepoTaskProof({ adapter, runId: "proof-agent-fail" });
  t.after(async () => await cleanupResult(result));

  assert.equal(result.verdict, "FAIL");
  assert.deepEqual(result.failureReasons, ["Agent run ended failed"]);
  assert.equal(result.acceptanceResults[0].passed, true);
});

test("changing acceptance tests cannot manufacture PASS", async (t) => {
  const adapter = new FakeAgentAdapter({
    finalMessage: "done",
    exitCode: 0,
    onExecute: async ({ cwd }) => {
      await writeFile(path.join(cwd, "test.mjs"), "// acceptance check removed\n", "utf8");
    },
  });

  const result = await runTemporaryRepoTaskProof({ adapter, runId: "proof-test-tamper" });
  t.after(async () => await cleanupResult(result));

  assert.equal(result.acceptanceResults[0].passed, true);
  assert.deepEqual(result.changes.outOfScope, ["test.mjs"]);
  assert.equal(result.verdict, "FAIL");
  assert.deepEqual(result.failureReasons, ["Out-of-scope workspace changes: test.mjs"]);
});

test("an agent commit cannot replace the harness checkpoint", async (t) => {
  const adapter = new FakeAgentAdapter({
    finalMessage: "done",
    exitCode: 0,
    onExecute: async ({ cwd }) => {
      await writeFile(
        path.join(cwd, "src", "sum.js"),
        "export function sum(a, b) {\n  return a + b;\n}\n",
        "utf8",
      );
      await execFileAsync("git", ["add", "src/sum.js"], { cwd });
      await execFileAsync(
        "git",
        [
          "-c",
          "user.name=Fake Agent",
          "-c",
          "user.email=fake-agent@localhost",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "--quiet",
          "-m",
          "agent-owned commit",
        ],
        { cwd },
      );
    },
  });

  const result = await runTemporaryRepoTaskProof({ adapter, runId: "proof-agent-commit" });
  t.after(async () => await cleanupResult(result));

  assert.equal(result.acceptanceResults[0].passed, true);
  assert.notEqual(result.changes.head, result.checkpoint.head);
  assert.match(result.changes.gitDiff, /return a \+ b/u);
  assert.equal(result.verdict, "FAIL");
  assert.deepEqual(result.failureReasons, ["Agent run changed the fixture checkpoint"]);
});

test("external symlinks cannot satisfy task acceptance", async (t) => {
  const adapter = new FakeAgentAdapter({
    onExecute: async ({ cwd }) => {
      const external = path.join(cwd, "..", "external-sum.js");
      await writeFile(external, "export function sum(a, b) { return a + b; }\n", "utf8");
      await unlink(path.join(cwd, "src", "sum.js"));
      await symlink(external, path.join(cwd, "src", "sum.js"));
    },
  });

  const result = await runTemporaryRepoTaskProof({ adapter, runId: "proof-external-symlink" });
  t.after(async () => await cleanupResult(result));

  assert.equal(result.acceptanceResults[0].passed, true);
  assert.deepEqual(result.changes.unsafeSymlinks, ["src/sum.js"]);
  assert.equal(result.verdict, "FAIL");
  assert.ok(
    result.failureReasons.includes("Symbolic links are not valid task changes: src/sum.js"),
  );
});

test("a stalled adapter is cancelled and produces retained FAIL diagnostics", async (t) => {
  const adapter = new FakeAgentAdapter({ holdOpen: true });
  const result = await runTemporaryRepoTaskProof({
    adapter,
    runId: "proof-timeout",
    agentTimeoutMs: 25,
    cancellationTimeoutMs: 100,
  });
  t.after(async () => await cleanupResult(result));

  assert.equal(result.verdict, "FAIL");
  assert.equal(result.workerTerminationConfirmed, true);
  assert.deepEqual(adapter.cancelledRunIds, ["proof-timeout"]);
  assert.ok(result.failureReasons.includes("Agent run timed out and cancellation was requested"));
  assert.equal(JSON.parse(await readFile(result.diagnosticsPath, "utf8")).verdict, "FAIL");
});

test("workspace destruction still returns inspectable failure evidence", async (t) => {
  const adapter = new FakeAgentAdapter({
    onExecute: async ({ cwd }) => await rm(cwd, { recursive: true, force: true }),
  });
  const result = await runTemporaryRepoTaskProof({ adapter, runId: "proof-workspace-destroyed" });
  t.after(async () => await cleanupResult(result));

  assert.equal(result.verdict, "FAIL");
  assert.match(result.changes.workspaceObservationError, /ENOENT|no such file/iu);
  assert.ok(
    result.failureReasons.some((reason) => reason.startsWith("Workspace observation failed:")),
  );
  assert.equal(JSON.parse(await readFile(result.diagnosticsPath, "utf8")).verdict, "FAIL");
});

test("attempt diagnostics redact secrets from events and diffs", async (t) => {
  const adapter = new FakeAgentAdapter({
    events: [
      {
        type: "message",
        text: "Bearer secret-token-value sk-abcdefghijklmnop",
        truncated: false,
      },
    ],
    onExecute: async ({ cwd }) => {
      await writeFile(
        path.join(cwd, "src", "sum.js"),
        "// password=hunter2\nexport function sum(a, b) { return a + b; }\n",
        "utf8",
      );
    },
  });
  const result = await runTemporaryRepoTaskProof({ adapter, runId: "proof-redaction" });
  t.after(async () => await cleanupResult(result));

  const diagnostic = await readFile(result.diagnosticsPath, "utf8");
  assert.equal(result.verdict, "PASS");
  assert.doesNotMatch(diagnostic, /secret-token-value|sk-abcdefghijklmnop|hunter2/u);
  assert.match(diagnostic, /\[REDACTED\]/u);
});

test("retained agent events are bounded while preserving the terminal event", async (t) => {
  const adapter = new FakeAgentAdapter({
    events: Array.from({ length: 5 }, (_, index) => ({
      type: "message",
      text: `event-${index}`,
      truncated: false,
    })),
    onExecute: async ({ cwd }) => {
      await writeFile(
        path.join(cwd, "src", "sum.js"),
        "export function sum(a, b) { return a + b; }\n",
        "utf8",
      );
    },
  });
  const result = await runTemporaryRepoTaskProof({
    adapter,
    runId: "proof-event-bound",
    retainedAgentEventLimit: 2,
  });
  t.after(async () => await cleanupResult(result));

  assert.equal(result.verdict, "PASS");
  assert.equal(result.agentEvents.length, 2);
  assert.equal(result.agentEvents.at(-1).type, "run.terminal");
  assert.equal(result.agentEventsTruncated, true);
  assert.ok(result.droppedAgentEventCount > 0);
});

test("oversized terminal evidence is explicitly reported as truncated", async (t) => {
  const adapter = new FakeAgentAdapter({
    finalMessage: "x".repeat(70 * 1024),
    onExecute: async ({ cwd }) => {
      await writeFile(
        path.join(cwd, "src", "sum.js"),
        "export function sum(a, b) { return a + b; }\n",
        "utf8",
      );
    },
  });
  const result = await runTemporaryRepoTaskProof({
    adapter,
    runId: "proof-oversized-terminal",
  });
  t.after(async () => await cleanupResult(result));

  assert.equal(result.verdict, "PASS");
  assert.equal(result.agentEventsTruncated, true);
  assert.equal(result.droppedAgentEventCount, 0);
  assert.ok(result.agentEvents.at(-1).finalMessage.length < 70 * 1024);
});

test("invalid options are rejected before a temporary fixture is allocated", async (t) => {
  const temporaryBaseDirectory = await mkdtemp(
    path.join(tmpdir(), "densa-task-proof-invalid-options-"),
  );
  t.after(async () => await rm(temporaryBaseDirectory, { recursive: true, force: true }));

  await assert.rejects(
    runTemporaryRepoTaskProof({
      adapter: new FakeAgentAdapter(),
      temporaryBaseDirectory,
      agentTimeoutMs: 0,
    }),
    /agentTimeoutMs must be positive/u,
  );
  assert.deepEqual(await readdir(temporaryBaseDirectory), []);
});

test("unconfirmed cancellation quarantines the workspace from post-run inspection", async (t) => {
  let delayedMutation;
  const adapter = {
    adapterId: "non-terminating-fake",
    async detect() {
      throw new Error("not used");
    },
    async getStatus() {
      throw new Error("not used");
    },
    execute({ cwd }) {
      delayedMutation = new Promise((resolve, reject) => {
        setTimeout(() => {
          writeFile(
            path.join(cwd, "src", "sum.js"),
            "export function sum(a, b) { return a + b; }\n",
            "utf8",
          ).then(resolve, reject);
        }, 30);
      });
      return {
        [Symbol.asyncIterator]() {
          return {
            next: async () => await new Promise(() => undefined),
            return: async () => await new Promise(() => undefined),
          };
        },
      };
    },
    async cancel() {
      await new Promise(() => undefined);
    },
    async getUsageState() {
      throw new Error("not used");
    },
  };

  const result = await runTemporaryRepoTaskProof({
    adapter,
    runId: "proof-unconfirmed-cancellation",
    agentTimeoutMs: 10,
    cancellationTimeoutMs: 20,
  });
  await delayedMutation;
  t.after(async () => await cleanupResult(result));

  assert.equal(result.verdict, "FAIL");
  assert.equal(result.workerTerminationConfirmed, false);
  assert.deepEqual(result.changes.modified, []);
  assert.equal(result.acceptanceResults[0].passed, false);
  assert.equal(result.acceptanceResults[0].command.error.code, "AGENT_TERMINATION_UNCONFIRMED");
  assert.match(result.changes.workspaceObservationError, /observation skipped/iu);
  assert.ok(
    result.failureReasons.includes(
      "Agent termination was not confirmed; inspection requires escalation",
    ),
  );
});

test("worker-planted diagnostic paths cannot redirect the secure attempt write", async (t) => {
  let victimPath;
  const adapter = new FakeAgentAdapter({
    onExecute: async ({ cwd }) => {
      const plantedDirectory = path.join(cwd, "..", "diagnostics");
      victimPath = path.join(cwd, "..", "victim.txt");
      await writeFile(victimPath, "unchanged\n", "utf8");
      await mkdir(plantedDirectory);
      await symlink(victimPath, path.join(plantedDirectory, "attempt.json"));
      await writeFile(
        path.join(cwd, "src", "sum.js"),
        "export function sum(a, b) { return a + b; }\n",
        "utf8",
      );
    },
  });
  const result = await runTemporaryRepoTaskProof({ adapter, runId: "proof-diagnostic-symlink" });
  t.after(async () => await cleanupResult(result));

  assert.equal(result.verdict, "PASS");
  assert.equal(await readFile(victimPath, "utf8"), "unchanged\n");
  assert.notEqual(
    result.diagnosticsPath,
    path.join(result.temporaryRoot, "diagnostics", "attempt.json"),
  );
});
