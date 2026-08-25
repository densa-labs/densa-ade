import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { runTemporaryRepoTaskProof } from "../packages/core/dist/index.js";
import { FakeAgentAdapter } from "../packages/testing/dist/index.js";

const execFileAsync = promisify(execFile);

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
  t.after(async () => await rm(result.temporaryRoot, { recursive: true, force: true }));

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
  t.after(async () => await rm(result.temporaryRoot, { recursive: true, force: true }));

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
  t.after(async () => await rm(result.temporaryRoot, { recursive: true, force: true }));

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
  t.after(async () => await rm(result.temporaryRoot, { recursive: true, force: true }));

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
  t.after(async () => await rm(result.temporaryRoot, { recursive: true, force: true }));

  assert.equal(result.acceptanceResults[0].passed, true);
  assert.notEqual(result.changes.head, result.checkpoint.head);
  assert.match(result.changes.gitDiff, /return a \+ b/u);
  assert.equal(result.verdict, "FAIL");
  assert.deepEqual(result.failureReasons, ["Agent run changed the fixture checkpoint"]);
});
