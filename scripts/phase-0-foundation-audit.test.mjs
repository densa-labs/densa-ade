import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath, URL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const packageNames = ["agent-sdk", "cli", "core", "protocol", "testing"];

test("the root README documents authoritative process and repository boundaries", async () => {
  const readme = await readFile(`${repositoryRoot}/README.md`, "utf8");

  assert.match(readme, /^## Architecture and repository boundaries$/mu);
  assert.match(readme, /clients[\s\S]*versioned local IPC[\s\S]*Densa ADE Core/iu);
  assert.match(readme, /Densa ADE Core[\s\S]*AgentAdapter[\s\S]*user workspace/iu);
  for (const packageName of packageNames) {
    assert.match(readme, new RegExp(`packages/${packageName}`, "u"));
  }
  assert.match(readme, /Core remains independent of Code - OSS and VS Code APIs/u);
});
