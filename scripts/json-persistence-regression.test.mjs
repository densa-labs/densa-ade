import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DensaAdeDatabase, PortableProjectSynchronizer } from "@densa-ade/core/persistence";
import { SecretRedactor } from "../packages/core/dist/secret-redaction.js";

const at = "2026-09-04T00:00:00.000Z";
const input = () =>
  JSON.parse(
    '{"__proto__":{"auditValue":7,"password":"fixture-private"},"nested":[{"__proto__":null}]}',
  );
const expected = () =>
  JSON.parse(
    '{"__proto__":{"auditValue":7,"password":"[REDACTED]"},"nested":[{"__proto__":null}]}',
  );

test("Core redaction preserves own JSON keys without altering prototypes or leaking secrets", () => {
  const value = new SecretRedactor().json(input());
  assert.deepEqual(value, expected());
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal(Object.prototype.auditValue, undefined);
});

test("redacted event keys survive durable journal close/reopen and replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "densa-json-journal-"));
  let database;
  try {
    database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
    database.repositories.projects.create({
      id: "project-json",
      name: "JSON",
      state: "DRAFT",
      executionMode: "guided",
      createdAt: at,
      updatedAt: at,
    });
    database.eventJournal.append(
      new SecretRedactor().event({
        id: "event-json",
        projectId: "project-json",
        type: "PROJECT_STARTED",
        eventVersion: 1,
        occurredAt: at,
        actor: "fixture",
        payload: input(),
      }),
    );
    database.close();
    database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
    assert.deepEqual(
      database.eventJournal.replay({ projectId: "project-json" })[0].payload,
      expected(),
    );
  } finally {
    database?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("portable settings retain own JSON keys while redacting nested secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "densa-json-portable-"));
  const database = DensaAdeDatabase.openInMemory();
  try {
    database.repositories.projects.create({
      id: "project-json",
      name: "JSON",
      state: "DRAFT",
      executionMode: "guided",
      createdAt: at,
      updatedAt: at,
    });
    database.repositories.projectSettings.set({
      projectId: "project-json",
      values: input(),
      updatedAt: at,
    });
    const result = await new PortableProjectSynchronizer(database.repositories).synchronize(
      root,
      "project-json",
    );
    assert.equal(result.status, "synchronized");
    const config = JSON.parse(await readFile(join(root, ".densa-ade", "config.json"), "utf8"));
    assert.deepEqual(config.settings, expected());
    assert.equal(Object.prototype.auditValue, undefined);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
