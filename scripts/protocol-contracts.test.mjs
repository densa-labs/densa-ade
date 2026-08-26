import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PROTOCOL_VERSION,
  ProtocolVersionMismatchError,
  attemptSchema,
  checkpointSchema,
  densaErrorCodeSchema,
  deserializeProtocolEnvelope,
  executionModeSchema,
  eventSchema,
  phaseStateSchema,
  parseProtocolEnvelope,
  projectStateSchema,
  protocolEnvelopeSchema,
  roadmapMutationClassificationSchema,
  serializeProtocolEnvelope,
  taskStateSchema,
  taskSchema,
  usageStateSchema,
} from "../packages/protocol/dist/index.js";

const timestamp = "2026-08-25T10:15:30.000Z";

test("exports every canonical state and policy value", () => {
  assert.deepEqual(projectStateSchema.options, [
    "DRAFT",
    "PLANNING",
    "READY",
    "RUNNING",
    "PAUSED",
    "WAITING_FOR_USER",
    "WAITING_FOR_USAGE",
    "BLOCKED",
    "COMPLETED",
    "FAILED",
  ]);
  assert.deepEqual(phaseStateSchema.options, [
    "PENDING",
    "READY",
    "RUNNING",
    "VALIDATING",
    "AWAITING_APPROVAL",
    "COMPLETED",
    "BLOCKED",
  ]);
  assert.deepEqual(taskStateSchema.options, [
    "PENDING",
    "READY",
    "RUNNING",
    "VALIDATING",
    "RETRYING",
    "WAITING_FOR_USER",
    "WAITING_FOR_USAGE",
    "BLOCKED",
    "INTERRUPTED",
    "COMPLETED",
    "CANCELLED",
  ]);
  assert.deepEqual(executionModeSchema.options, ["guided", "phase", "continuous"]);
  assert.deepEqual(roadmapMutationClassificationSchema.options, ["minor", "significant", "scope"]);
  assert.deepEqual(densaErrorCodeSchema.options, [
    "USER_CONFIGURATION_ERROR",
    "AGENT_UNAVAILABLE",
    "AUTHENTICATION_REQUIRED",
    "USAGE_LIMITED",
    "PERMISSION_DENIED",
    "PROCESS_FAILURE",
    "VALIDATION_FAILURE",
    "WORKSPACE_CONFLICT",
    "GIT_FAILURE",
    "PERSISTENCE_FAILURE",
    "PROTOCOL_VERSION_MISMATCH",
    "INVALID_STATE_TRANSITION",
    "INTERNAL_INVARIANT_VIOLATION",
  ]);
});

test("every valid envelope kind survives a JSON round-trip without value changes", () => {
  const envelopes = [
    {
      protocolVersion: PROTOCOL_VERSION,
      kind: "request",
      requestId: "request-1",
      correlationId: "project-setup-1",
      method: "project.create",
      payload: {
        name: "Example project",
        executionMode: "guided",
        nested: [true, null, 3],
      },
    },
    {
      protocolVersion: PROTOCOL_VERSION,
      kind: "response",
      requestId: "request-1",
      correlationId: "project-setup-1",
      ok: true,
      result: { projectId: "project-1" },
    },
    {
      protocolVersion: PROTOCOL_VERSION,
      kind: "response",
      requestId: "request-2",
      ok: false,
      error: {
        code: "USER_CONFIGURATION_ERROR",
        message: "Project name is required",
        details: { field: "name" },
      },
    },
    {
      protocolVersion: PROTOCOL_VERSION,
      kind: "notification",
      correlationId: "project-setup-1",
      event: "project.changed",
      payload: { projectId: "project-1", state: "READY" },
    },
  ];

  for (const envelope of envelopes) {
    const parsed = parseProtocolEnvelope(envelope);
    assert.deepEqual(deserializeProtocolEnvelope(serializeProtocolEnvelope(parsed)), envelope);
  }
});

test("rejects malformed envelope shapes and payloads", () => {
  assert.equal(
    protocolEnvelopeSchema.safeParse({
      protocolVersion: PROTOCOL_VERSION,
      kind: "request",
      method: "project.create",
      payload: {},
    }).success,
    false,
  );

  assert.equal(
    protocolEnvelopeSchema.safeParse({
      protocolVersion: PROTOCOL_VERSION,
      kind: "notification",
      event: "clock.sampled",
      payload: { sampledAt: new Date(timestamp) },
    }).success,
    false,
  );

  assert.equal(
    protocolEnvelopeSchema.safeParse({
      protocolVersion: PROTOCOL_VERSION,
      kind: "notification",
      event: "metric.sampled",
      payload: { value: Number.NaN },
    }).success,
    false,
  );
});

test("reports a protocol version mismatch with a stable error code", () => {
  assert.throws(
    () =>
      parseProtocolEnvelope({
        protocolVersion: "99.0.0",
        kind: "request",
        requestId: "request-1",
        method: "project.get",
        payload: {},
      }),
    (error) => {
      assert.ok(error instanceof ProtocolVersionMismatchError);
      assert.equal(error.code, "PROTOCOL_VERSION_MISMATCH");
      assert.equal(error.receivedVersion, "99.0.0");
      return true;
    },
  );
});

test("domain schemas enforce acceptance criteria, ISO timestamps, and JSON events", () => {
  const validTask = {
    id: "task-1",
    projectId: "project-1",
    phaseId: "phase-1",
    title: "Define contracts",
    state: "READY",
    position: 0,
    acceptanceCriteria: ["Malformed envelopes are rejected"],
    dependencyIds: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  assert.equal(taskSchema.safeParse(validTask).success, true);
  const task = taskSchema.parse(validTask);
  assert.equal(Object.isFrozen(task), true);
  assert.throws(() => {
    task.state = "COMPLETED";
  }, TypeError);
  assert.equal(taskSchema.safeParse({ ...validTask, acceptanceCriteria: [] }).success, false);
  assert.equal(
    taskSchema.safeParse({ ...validTask, createdAt: new Date(timestamp) }).success,
    false,
  );

  assert.equal(
    eventSchema.safeParse({
      id: "event-1",
      projectId: "project-1",
      type: "ROADMAP_GENERATED",
      eventVersion: 1,
      occurredAt: timestamp,
      actor: "densa-core",
      payload: { phaseCount: 2 },
    }).success,
    true,
  );
});

test("task checkpoints require a complete task-attempt-run association and Git base", () => {
  const base = {
    id: "checkpoint-1",
    projectId: "project-1",
    createdAt: timestamp,
    gitHead: "0123456789abcdef",
  };
  assert.equal(checkpointSchema.safeParse(base).success, true);
  assert.equal(
    checkpointSchema.safeParse({
      ...base,
      taskId: "task-1",
      attemptId: "attempt-1",
      runBranch: "densa/run/project-1-abcd1234",
    }).success,
    true,
  );
  assert.equal(checkpointSchema.safeParse({ ...base, taskId: "task-1" }).success, false);
  assert.equal(
    checkpointSchema.safeParse({
      ...base,
      taskId: "task-1",
      attemptId: "attempt-1",
      runBranch: "densa/run/project-1-abcd1234",
      gitHead: undefined,
    }).success,
    false,
  );
});

test("attempt commit SHAs are optional but runtime validated when present", () => {
  const attempt = {
    id: "attempt-1",
    taskId: "task-1",
    number: 1,
    startedAt: timestamp,
  };
  assert.equal(attemptSchema.safeParse(attempt).success, true);
  assert.equal(attemptSchema.safeParse({ ...attempt, commitSha: "abc123" }).success, true);
  assert.equal(attemptSchema.safeParse({ ...attempt, commitSha: "" }).success, false);
});

test("usage state never fabricates a reset time", () => {
  assert.equal(usageStateSchema.safeParse({ status: "available" }).success, true);
  assert.equal(usageStateSchema.safeParse({ status: "limited" }).success, true);
  assert.equal(
    usageStateSchema.safeParse({ status: "limited", resetAt: "in five hours" }).success,
    false,
  );
  assert.equal(
    usageStateSchema.safeParse({ status: "unknown", reason: "ambiguous" }).success,
    true,
  );
});
