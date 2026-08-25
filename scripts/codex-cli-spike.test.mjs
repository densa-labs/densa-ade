import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath, URL } from "node:url";

const fixtureRoot = fileURLToPath(
  new URL("../packages/testing/fixtures/codex-cli/0.147.0/", import.meta.url),
);

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readJsonLines(path) {
  const contents = await readFile(path, "utf8");
  return contents
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test("Codex spike manifest records version-scoped observed outcomes", async () => {
  const manifest = await readJson(`${fixtureRoot}/manifest.json`);

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.codexVersion, "0.147.0");
  assert.equal(manifest.fixturePolicy, "minimal-sanitized-observed-signals");
  assert.deepEqual(manifest.probes, {
    version: { exitCode: 0, stdoutFixture: "version.txt" },
    loginAuthenticated: { exitCode: 0, stdoutFixture: "login-status-authenticated.txt" },
    loginUnauthenticated: { exitCode: 1, stdoutFixture: "login-status-unauthenticated.txt" },
  });
  assert.equal(await readFile(`${fixtureRoot}/version.txt`, "utf8"), "codex-cli 0.147.0\n");
  assert.equal(
    await readFile(`${fixtureRoot}/login-status-unauthenticated.txt`, "utf8"),
    "Not logged in\n",
  );
  assert.deepEqual(
    manifest.cases.map(({ name, exitCode, terminalEvent }) => ({
      name,
      exitCode,
      terminalEvent,
    })),
    [
      { name: "success", exitCode: 0, terminalEvent: "turn.completed" },
      { name: "command-failure-handled", exitCode: 0, terminalEvent: "turn.completed" },
      { name: "unsupported-model", exitCode: 1, terminalEvent: "turn.failed" },
      { name: "authentication-required", exitCode: 1, terminalEvent: "turn.failed" },
      { name: "parent-sigint", exitCode: 1, terminalEvent: null },
      { name: "invalid-argument-placement", exitCode: 2, terminalEvent: null },
    ],
  );
});

test("success and terminal failure fixtures expose structured run signals", async () => {
  const success = await readJsonLines(`${fixtureRoot}/success.jsonl`);
  const modelFailure = await readJsonLines(`${fixtureRoot}/unsupported-model.jsonl`);
  const authFailure = await readJsonLines(`${fixtureRoot}/authentication-required.jsonl`);

  assert.equal(success.at(-1).type, "turn.completed");
  assert.equal(modelFailure.at(-1).type, "turn.failed");
  assert.equal(authFailure.at(-1).type, "turn.failed");
  assert.match(authFailure.at(-1).error.message, /401 Unauthorized/u);
});

test("a failed tool command can occur inside a successful Codex turn", async () => {
  const events = await readJsonLines(`${fixtureRoot}/command-failure-handled.jsonl`);
  const failedCommand = events.find(
    (event) => event.type === "item.completed" && event.item?.type === "command_execution",
  );

  assert.equal(failedCommand.item.status, "failed");
  assert.equal(failedCommand.item.exit_code, 1);
  assert.equal(events.at(-1).type, "turn.completed");
});

test("parent cancellation fixture does not invent a CLI terminal event", async () => {
  const events = await readJsonLines(`${fixtureRoot}/parent-sigint.jsonl`);
  const manifest = await readJson(`${fixtureRoot}/manifest.json`);
  const cancellation = manifest.cases.find(({ name }) => name === "parent-sigint");

  assert.equal(cancellation.terminalEvent, null);
  assert.equal(cancellation.childProcessObservedAfterExit, false);
  assert.equal(
    events.some(({ type }) => type === "turn.completed" || type === "turn.failed"),
    false,
  );
});

test("fixtures are sanitized and contain no credential-shaped material", async () => {
  const fixtureNames = [
    "manifest.json",
    "success.jsonl",
    "command-failure-handled.jsonl",
    "unsupported-model.jsonl",
    "authentication-required.jsonl",
    "parent-sigint.jsonl",
    "invalid-argument-placement.txt",
    "version.txt",
    "login-status-authenticated.txt",
    "login-status-unauthenticated.txt",
  ];
  const forbiddenPatterns = [
    /\/Users\//u,
    /(?:^|[^A-Za-z])sk-[A-Za-z0-9_-]{20,}/u,
    /Bearer\s+(?:eyJ|[A-Za-z0-9_-]{20,}\.)/u,
    /req_[a-f0-9]{16,}/iu,
    /cf-ray:\s*[a-f0-9-]{8,}/iu,
    /01[a-z0-9]{24,}/iu,
  ];

  for (const fixtureName of fixtureNames) {
    const fixture = await readFile(`${fixtureRoot}/${fixtureName}`, "utf8");
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(fixture, pattern, `${fixtureName} must stay sanitized`);
    }
  }
});
