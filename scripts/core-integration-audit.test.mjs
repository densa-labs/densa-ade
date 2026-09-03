import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CoreDaemon, CoreIpcClient } from "../packages/core/dist/index.js";
import { DensaAdeDatabase } from "../packages/core/dist/persistence/index.js";
import {
  CoreV1Client,
  PROTOCOL_VERSION,
  requestEnvelopeSchema,
} from "../packages/protocol/dist/index.js";

const timestamp = "2026-09-03T00:00:00.000Z";

function rawRequest(requestId, method, payload = {}) {
  return requestEnvelopeSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    kind: "request",
    requestId,
    method,
    payload,
  });
}

async function withDaemon(dbSetup, run) {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "densa-integration-audit-"));
  const database = DensaAdeDatabase.openInMemory();
  dbSetup(database);
  const daemon = await CoreDaemon.start({ runtimeDirectory, database });
  try {
    await run({ daemon, database, runtimeDirectory });
  } finally {
    await daemon.stop();
    database.close();
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
}

async function withWorkflowDaemon(run) {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "densa-integration-workflow-"));
  const workspace = await mkdtemp(join(tmpdir(), "densa-integration-ws-"));
  const database = DensaAdeDatabase.openInMemory();
  const daemon = await CoreDaemon.start({ runtimeDirectory, database });
  const transport = new CoreIpcClient({ runtimeDirectory });
  let n = 0;
  const client = new CoreV1Client(transport, () => `integration-${String(++n)}`);
  try {
    await run({ client, transport, database, daemon, runtimeDirectory, workspace });
  } finally {
    transport.disconnect();
    await daemon.stop();
    database.close();
    await rm(runtimeDirectory, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
}

test("integration: control operations fail closed when the Core workspace binding is missing", async () => {
  await withDaemon(
    (database) => {
      database.repositories.projects.create({
        id: "project-unbound",
        name: "Unbound fixture",
        state: "DRAFT",
        executionMode: "phase",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    },
    async ({ runtimeDirectory }) => {
      const client = new CoreIpcClient({ runtimeDirectory });
      try {
        await assert.rejects(
          client.request(
            rawRequest("integration-unbound-pause", "projects.pause", {
              projectId: "project-unbound",
              workspacePath: tmpdir(),
              actor: "test",
            }),
          ),
          (error) => error?.protocolError?.code === "PERSISTENCE_FAILURE",
        );
        await assert.rejects(
          client.request(
            rawRequest("integration-unbound-resume", "projects.resume", {
              projectId: "project-unbound",
              workspacePath: tmpdir(),
              actor: "test",
            }),
          ),
          (error) => error?.protocolError?.code === "PERSISTENCE_FAILURE",
        );
      } finally {
        client.disconnect();
      }
    },
  );
});

test("integration: keep-awake battery policy update preserves live reasons instead of deactivating", async () => {
  await withWorkflowDaemon(async ({ client, database, workspace }) => {
    const created = await client.request("projects.create", {
      name: "Keep-awake fixture",
      workspacePath: workspace,
      idea: "Battery policy must not drop live assertions",
      executionMode: "phase",
      actor: "test",
    });
    const projectId = created.project.id;
    const stored = database.repositories.projectSettings.findByProjectId(projectId);
    database.repositories.projectSettings.set({
      projectId,
      values: {
        ...stored?.values,
        keepAwake: {
          formatVersion: 1,
          projectId,
          state: "declined",
          reasons: [
            {
              id: "reason-live",
              projectId,
              reason: "integration fixture",
              actor: "test",
              acquiredAt: timestamp,
            },
          ],
          batteryPolicy: { minimumLevelPercent: 20 },
          updatedAt: timestamp,
          message: "fixture",
        },
      },
      updatedAt: timestamp,
    });

    await client.request("settings.update", {
      projectId,
      actor: "test",
      reason: "tighten battery threshold",
      keepAwakeBatteryPolicy: { minimumLevelPercent: 42 },
    });

    const raw =
      database.repositories.projectSettings.findByProjectId(projectId)?.values["keepAwake"];
    assert.equal(raw.minimumLevelPercent ?? raw.batteryPolicy?.minimumLevelPercent, 42);
    assert.equal(raw.state, "declined");
    assert.equal(raw.reasons.length, 1);
    assert.equal(raw.reasons[0].id, "reason-live");
  });
});

test("integration: permission resolution aliases cannot double-resolve the same request", async () => {
  await withWorkflowDaemon(async ({ client, database, workspace }) => {
    const created = await client.request("projects.create", {
      name: "Permission fixture",
      workspacePath: workspace,
      idea: "Permission aliases must resolve once",
      executionMode: "phase",
      actor: "test",
    });
    const projectId = created.project.id;
    const requestEvent = database.repositories.events.append({
      id: "permission-request-1",
      projectId,
      type: "PERMISSION_DECISION_RECORDED",
      eventVersion: 1,
      occurredAt: timestamp,
      actor: "test",
      payload: {
        decisionId: "decision-alias-1",
        preset: "standard",
        operation: "shell.exec",
        disposition: "ask_user",
        source: "policy",
        reason: "fixture",
      },
    });

    const first = await client.request("permissions.resolve", {
      projectId,
      decisionId: requestEvent.id,
      resolution: "approve",
      actor: "test",
      reason: "first resolution",
    });
    assert.equal(first.outcome, "APPROVED");

    const second = await client.request("permissions.resolve", {
      projectId,
      decisionId: "decision-alias-1",
      resolution: "reject",
      actor: "test",
      reason: "second resolution with alias",
    });
    assert.equal(second.outcome, "UNCHANGED");

    const approvals = await client.request("dashboard.get", { projectId });
    assert.ok(
      !approvals.pendingApprovals.some((entry) => entry.kind === "permission"),
      "resolved permission must not remain pending",
    );
  });
});
