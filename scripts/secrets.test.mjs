import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  MacOsKeychainSecretStore,
  PermissionPolicyService,
  SecretRedactor,
  SecretService,
  assertAuthorizedOperation,
  createSecretRef,
  redactEvent,
  redactLog,
  redactPrompt,
} from "@densa-ade/core";
import { DensaAdeDatabase } from "@densa-ade/core/persistence";
import { secretRefSchema } from "@densa-ade/protocol";

const createdAt = "2026-08-29T05:00:00.000Z";
const projectId = "project-secret-proof";
const secretValue = "opaque-fixture-value-93471";

function project() {
  return {
    id: projectId,
    name: "Secret proof",
    state: "DRAFT",
    executionMode: "guided",
    createdAt,
    updatedAt: createdAt,
  };
}

function idFactory(prefix) {
  let index = 0;
  return () => `${prefix}-${String(++index)}`;
}

function approvedDatabase() {
  const database = DensaAdeDatabase.openInMemory();
  database.repositories.projects.create(project());
  database.repositories.decisions.create({
    id: "decision-secret-use-approved",
    projectId,
    kind: "decision",
    statement: "Approve one bounded secret operation.",
    title: "Approve one bounded secret operation",
    rationale: "The user approved the credential operation for this proof.",
    category: "approval.secret-access",
    source: "user",
    scope: "project",
    status: "active",
    affectedPhaseIds: [],
    affectedTaskIds: [],
    createdAt,
  });
  return database;
}

function policy(database, prefix = "permission-secret") {
  return new PermissionPolicyService(database, {
    decisionIdFactory: idFactory(`${prefix}-decision`),
    eventIdFactory: idFactory(`${prefix}-event`),
  });
}

class FakeSecretStore {
  values = new Map();
  reads = 0;
  writes = 0;
  deletions = 0;

  async put(reference, value, authorization) {
    assertAuthorizedOperation(authorization, reference.projectId, "secret_access");
    this.writes += 1;
    this.values.set(reference.id, value);
  }

  async get(reference, authorization) {
    assertAuthorizedOperation(authorization, reference.projectId, "secret_access");
    this.reads += 1;
    return this.values.get(reference.id);
  }

  async delete(reference, authorization) {
    assertAuthorizedOperation(authorization, reference.projectId, "secret_access");
    this.deletions += 1;
    return this.values.delete(reference.id);
  }
}

function permissionRequest(overrides = {}) {
  return {
    projectId,
    actor: "user:test",
    reason: "Use the bounded project credential",
    occurredAt: "2026-08-29T05:01:00.000Z",
    approvalDecisionId: "decision-secret-use-approved",
    ...overrides,
  };
}

test("SecretRef is an opaque persistable locator and rejects embedded values", () => {
  const reference = createSecretRef(projectId, "secret.api.production");
  assert.deepEqual(reference, {
    formatVersion: 1,
    id: "secret.api.production",
    projectId,
    store: "macos_keychain",
  });
  assert.equal(JSON.stringify(reference).includes(secretValue), false);
  assert.equal(secretRefSchema.safeParse({ ...reference, value: secretValue }).success, false);
});

test("denied secret access is structured and never touches the fake store", async () => {
  const database = approvedDatabase();
  const store = new FakeSecretStore();
  const permissionPolicy = policy(database, "permission-denied");
  permissionPolicy.setPreset({
    projectId,
    preset: "cautious",
    actor: "user:test",
    reason: "Deny unattended credential access",
    occurredAt: "2026-08-29T05:01:00.000Z",
  });
  const service = new SecretService(database, store, {
    permissionPolicy,
    eventIdFactory: idFactory("secret-denied-event"),
  });
  try {
    const result = await service.put({
      ...permissionRequest({ approvalDecisionId: undefined }),
      reference: createSecretRef(projectId, "secret.denied"),
      value: secretValue,
      reason: `Do not persist ${secretValue} in the denial audit`,
    });
    assert.equal(result.status, "denied");
    assert.equal(result.code, "PERMISSION_DENIED");
    assert.equal(result.disposition, "deny");
    assert.equal(store.writes, 0);
    assert.equal(
      JSON.stringify(database.repositories.events.replay({ projectId })).includes(secretValue),
      false,
    );
  } finally {
    database.close();
  }
});

test("fake-store secret is scoped to one child and all captured output and events are redacted", async () => {
  const database = approvedDatabase();
  const store = new FakeSecretStore();
  const service = new SecretService(database, store, {
    permissionPolicy: policy(database, "permission-scoped"),
    eventIdFactory: idFactory("secret-scoped-event"),
  });
  const reference = createSecretRef(projectId, "secret.scoped-child");
  const environmentName = "DENSA_P7M3_SCOPED_SECRET";
  assert.equal(process.env[environmentName], undefined);
  try {
    const stored = await service.put({
      ...permissionRequest(),
      reference,
      value: secretValue,
      reason: `Store ${secretValue} without recording its value`,
    });
    assert.equal(stored.status, "stored");

    await assert.rejects(
      service.runChild({
        ...permissionRequest({ occurredAt: "2026-08-29T05:01:30.000Z" }),
        command: process.execPath,
        arguments: ["-e", "process.exit(0)", secretValue],
        cwd: process.cwd(),
        bindings: [{ name: environmentName, reference }],
        baseEnvironment: {},
      }),
      /only through scoped environment bindings/u,
    );
    assert.equal(process.env[environmentName], undefined);

    const expectedDigest = createHash("sha256").update(secretValue).digest("hex");
    const script = [
      'const { createHash } = require("node:crypto");',
      `const value = process.env.${environmentName};`,
      'const digest = createHash("sha256").update(value ?? "").digest("hex");',
      'process.stdout.write(digest === process.argv[1] ? `seen:${value}` : "missing");',
      "process.stderr.write(` password=${value}`);",
      "process.exitCode = digest === process.argv[1] ? 0 : 9;",
    ].join("\n");
    const executed = await service.runChild({
      ...permissionRequest({ occurredAt: "2026-08-29T05:02:00.000Z" }),
      command: process.execPath,
      arguments: ["-e", script, expectedDigest],
      cwd: process.cwd(),
      bindings: [{ name: environmentName, reference }],
      baseEnvironment: {},
    });
    assert.equal(executed.status, "executed");
    assert.equal(executed.exitCode, 0);
    assert.equal(executed.stdout, "seen:[REDACTED]");
    assert.equal(executed.stderr, " password=[REDACTED]");
    assert.equal(JSON.stringify(executed).includes(secretValue), false);
    assert.equal(process.env[environmentName], undefined);

    const revoked = await service.revoke({
      ...permissionRequest({ occurredAt: "2026-08-29T05:03:00.000Z" }),
      reference,
    });
    assert.equal(revoked.status, "revoked");
    assert.equal(revoked.existed, true);
    assert.equal(store.values.has(reference.id), false);
    assert.equal(
      JSON.stringify(database.repositories.events.replay({ projectId })).includes(secretValue),
      false,
    );
  } finally {
    database.close();
  }
});

test("Keychain store uses stdin for writes and never places the secret in argv", async () => {
  const database = approvedDatabase();
  const authorizationResult = policy(database, "permission-keychain").authorize({
    ...permissionRequest(),
    operation: "secret_access",
    approvalCategory: "approval.secret-access",
  });
  assert.notEqual(authorizationResult.authorization, undefined);
  const calls = [];
  const runner = async (arguments_, standardInput) => {
    calls.push({ arguments_: [...arguments_], standardInput });
    if (arguments_[0] === "find-generic-password") {
      return { exitCode: 0, stdout: `${secretValue}\n`, stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const store = new MacOsKeychainSecretStore({ platform: "darwin", commandRunner: runner });
  const reference = createSecretRef(projectId, "secret.keychain-contract");
  try {
    await store.put(reference, secretValue, authorizationResult.authorization);
    assert.equal(await store.get(reference, authorizationResult.authorization), secretValue);
    assert.equal(await store.delete(reference, authorizationResult.authorization), true);
    assert.equal(calls[0].standardInput, secretValue);
    assert.equal(calls[0].arguments_.at(-1), "-w");
    assert.equal(
      calls.some((call) => call.arguments_.includes(secretValue)),
      false,
    );
  } finally {
    database.close();
  }
});

test("redaction utilities sanitize exact values in prompts, logs, events, and packet-shaped JSON", () => {
  const redactor = new SecretRedactor([secretValue]);
  const prompt = redactPrompt(`Use ${secretValue} only at execution time`, [secretValue]);
  const log = redactLog(`stderr password=${secretValue}`, [secretValue]);
  const event = redactEvent(
    {
      id: "event-redaction-proof",
      projectId,
      type: "SECRET_REDACTION_PROOF",
      eventVersion: 1,
      occurredAt: createdAt,
      actor: "densa-core:test",
      payload: { message: `Observed ${secretValue}`, authToken: secretValue },
    },
    [secretValue],
  );
  const packet = redactor.json({
    formatVersion: 1,
    task: { goal: `Call the API with ${secretValue}` },
    permissionEnvelope: { credential: secretValue },
  });
  for (const serialized of [prompt, log, JSON.stringify(event), JSON.stringify(packet)]) {
    assert.equal(serialized.includes(secretValue), false);
    assert.match(serialized, /REDACTED/u);
  }
});

test("redaction fails closed for quoted assignments and unterminated explicit secret blocks", () => {
  const privateKey = "-----BEGIN PRIVATE KEY-----\nopaque-tail-without-an-end-marker";
  for (const value of [
    'payload={"password":"quoted-secret-value"}',
    "<secret>unterminated-angle-secret",
    "[secret:unterminated-bracket-secret",
    privateKey,
  ]) {
    const redacted = redactLog(value);
    assert.match(redacted, /\[REDACTED/u);
    assert.doesNotMatch(
      redacted,
      /quoted-secret-value|unterminated-angle-secret|unterminated-bracket-secret|opaque-tail/u,
    );
  }
});
