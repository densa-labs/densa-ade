import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile, rm } from "node:fs/promises";
import { test } from "node:test";

import {
  ProjectDecisionService,
  TASK_PACKET_MAX_BYTES,
  TaskPacketBuilder,
  renderTaskPacketPrompt,
} from "@densa-ade/core";
import { DensaAdeDatabase } from "@densa-ade/core/persistence";
import { masterRoadmapSchema } from "@densa-ade/protocol";

const createdAt = "2026-08-27T09:00:00.000Z";
const projectId = "project-task-packet";
const taskId = "task.implement";

function roadmap({ oversized = false } = {}) {
  const large = oversized ? "bounded context ".repeat(20_000) : undefined;
  return masterRoadmapSchema.parse({
    formatVersion: 1,
    projectGoal: large ?? "Build a focused local orchestration proof.",
    phases: [
      {
        id: "phase.core",
        title: "Core",
        goal: large ?? "Deliver the editor-independent Core behavior.",
        required: true,
        completionCriteria: ["Core behavior is verified."],
        tasks: [
          {
            id: "task.prepare",
            title: "Prepare foundation",
            goal: "Create the prerequisite contract.",
            executable: true,
            dependencyIds: [],
            acceptanceCriteria: ["The prerequisite contract is tested."],
            riskLevel: "low",
            expectedValidators: ["unit_test"],
          },
          {
            id: taskId,
            title: "Implement focused context",
            goal: "Build a deterministic and safe worker packet.",
            executable: true,
            dependencyIds: ["task.prepare"],
            acceptanceCriteria: ["Irrelevant context is omitted.", "The worker prompt is clean."],
            riskLevel: "high",
            expectedValidators: ["unit_test", "security"],
          },
        ],
      },
    ],
  });
}

function specification({ oversized = false } = {}) {
  return {
    formatVersion: 1,
    projectGoal: "Build focused worker context.",
    targetUsers: ["Local developers"],
    coreUserJourneys: ["Run a scoped implementation task"],
    requiredFeatures: ["Task packets"],
    nonGoals: ["Do not implement orchestration lifecycle yet."],
    architectureConstraints: [
      oversized ? "Core remains independent. ".repeat(10_000) : "Core remains editor-independent.",
      "This irrelevant architecture constraint must not leak.",
    ],
    platformRuntimeConstraints: ["Use TypeScript and Node."],
    integrations: [],
    dataStorageNeeds: [],
    securityPrivacyRequirements: [
      "Never reveal <secret>fixture-security-value</secret> in worker context.",
    ],
    uxConstraints: [],
    deploymentIntent: [],
    explicitUserDecisions: [],
    unresolvedQuestions: [],
  };
}

function seed(database, options = {}) {
  const persistedRoadmap = roadmap(options);
  database.repositories.projects.create({
    id: projectId,
    name: "Task packet proof",
    state: "DRAFT",
    executionMode: "phase",
    createdAt,
    updatedAt: createdAt,
  });
  database.repositories.specifications.set({
    projectId,
    specification: specification(options),
    createdAt,
    updatedAt: createdAt,
  });
  for (const [phasePosition, phase] of persistedRoadmap.phases.entries()) {
    database.repositories.phases.create({
      id: phase.id,
      projectId,
      title: phase.title,
      state: "PENDING",
      position: phasePosition,
      createdAt,
      updatedAt: createdAt,
    });
    for (const [taskPosition, task] of phase.tasks.entries()) {
      database.repositories.tasks.create({
        id: task.id,
        projectId,
        phaseId: phase.id,
        title: task.title,
        state: "PENDING",
        position: taskPosition,
        acceptanceCriteria: task.acceptanceCriteria,
        dependencyIds: task.dependencyIds,
        createdAt,
        updatedAt: createdAt,
      });
    }
  }
  database.persistInitialMasterRoadmap({
    projectId,
    roadmap: persistedRoadmap,
    revisionNumber: 0,
    createdAt,
    updatedAt: createdAt,
  });
  database.repositories.decisions.create({
    id: "decision.relevant",
    projectId,
    kind: "decision",
    statement: "Keep Core independent.",
    title: "Keep Core independent",
    rationale: "The adapter token is <secret>decision-secret</secret> and must stay hidden.",
    category: "architecture.core",
    source: "system",
    scope: "project",
    status: "active",
    affectedPhaseIds: [],
    affectedTaskIds: [],
    createdAt: "2026-08-27T09:00:01.000Z",
  });
  database.repositories.decisions.create({
    id: "decision.irrelevant",
    projectId,
    kind: "decision",
    statement: "IRRELEVANT_DECISION_SENTINEL",
    title: "IRRELEVANT_DECISION_SENTINEL",
    rationale: "This applies only to a future UI phase.",
    category: "ux.future",
    source: "system",
    scope: "project",
    status: "active",
    affectedPhaseIds: [],
    affectedTaskIds: [],
    createdAt: "2026-08-27T09:00:02.000Z",
  });
  database.repositories.events.append({
    id: "event-master-history",
    projectId,
    type: "MASTER_MESSAGE_RECORDED",
    eventVersion: 1,
    occurredAt: "2026-08-27T09:00:03.000Z",
    actor: "master:test",
    payload: { transcript: "RAW_MASTER_CONVERSATION_SENTINEL" },
  });
}

function request(overrides = {}) {
  return {
    taskId,
    selection: {
      globalConstraints: [
        { field: "securityPrivacyRequirements", index: 0 },
        { field: "architectureConstraints", index: 0 },
      ],
      architecturalDecisionIds: ["decision.relevant"],
    },
    relevantFiles: [
      {
        path: "src/task-packet.ts",
        summary: "Contains the packet builder; [secret:file-summary-secret] must be hidden.",
      },
      {
        path: "secrets/private.txt",
        summary: "fixture-sensitive-file-value",
        sensitive: true,
      },
    ],
    permissionEnvelope: {
      id: "permission-standard",
      preset: "standard",
      grantedActions: ["edit selected workspace files", "run deterministic tests"],
      deniedActions: ["push remotes", "read unrelated files"],
      writablePaths: ["src/task-packet.ts", "tests/task-packet.test.ts"],
      networkAccess: "approval_required",
    },
    ...overrides,
  };
}

function withDatabase(work, options) {
  const database = DensaAdeDatabase.openInMemory();
  try {
    seed(database, options);
    return work(database);
  } finally {
    database.close();
  }
}

test("builds deterministic focused context and omits irrelevant decisions and history", () => {
  withDatabase((database) => {
    const builder = new TaskPacketBuilder(database.repositories);
    const first = builder.build(request());
    const second = builder.build(
      request({
        relevantFiles: [...request().relevantFiles].reverse(),
        permissionEnvelope: {
          ...request().permissionEnvelope,
          grantedActions: [...request().permissionEnvelope.grantedActions].reverse(),
        },
      }),
    );

    assert.equal(first.status, "built");
    assert.equal(second.status, "built");
    assert.deepEqual(first.packet, second.packet);
    assert.deepEqual(
      first.packet.architecturalDecisions.map((decision) => decision.id),
      ["decision.relevant"],
    );
    assert.deepEqual(
      first.packet.globalConstraints.map(({ field, index }) => ({ field, index })),
      [
        { field: "architectureConstraints", index: 0 },
        { field: "securityPrivacyRequirements", index: 0 },
      ],
    );
    assert.equal(first.packet.task.dependencies[0].id, "task.prepare");
    assert.equal(first.packet.scopeInstruction.includes("Do not alter unrelated scope"), true);
    assert.equal(Object.isFrozen(first.packet), true);
    assert.equal(Object.isFrozen(first.packet.task.dependencies), true);

    const serialized = JSON.stringify(first.packet);
    assert.equal(serialized.includes("IRRELEVANT_DECISION_SENTINEL"), false);
    assert.equal(serialized.includes("RAW_MASTER_CONVERSATION_SENTINEL"), false);
    assert.equal(serialized.includes("fixture-sensitive-file-value"), false);
    assert.equal(serialized.includes("fixture-security-value"), false);
    assert.equal(serialized.includes("decision-secret"), false);
    assert.equal(serialized.includes("file-summary-secret"), false);
    assert.equal(serialized.includes("[REDACTED]"), true);
    assert.equal(
      first.packet.contextSources.some(
        (source) =>
          source.kind === "architectural_decision" &&
          source.sourceId === "decision:decision.relevant",
      ),
      true,
    );

    const prompt = renderTaskPacketPrompt(first.packet);
    assert.match(prompt, /^# Densa ADE Worker Task Packet/mu);
    assert.match(prompt, /## Exact task/u);
    assert.match(prompt, /## Permission envelope/u);
    assert.match(prompt, /## Scope boundary/u);
    assert.equal(prompt.includes("undefined"), false);
    assert.equal(prompt.includes("IRRELEVANT_DECISION_SENTINEL"), false);
    assert.equal(prompt.includes("fixture-security-value"), false);
  });
});

test("retry packets include only the latest relevant prior failed-attempt diagnostics", () => {
  withDatabase((database) => {
    database.repositories.attempts.create({
      id: "attempt-1",
      taskId,
      number: 1,
      startedAt: "2026-08-27T09:01:00.000Z",
      completedAt: "2026-08-27T09:02:00.000Z",
    });
    database.repositories.agentRuns.create({
      id: "agent-run-1",
      attemptId: "attempt-1",
      adapterId: "fake",
      startedAt: "2026-08-27T09:01:00.000Z",
      completedAt: "2026-08-27T09:02:00.000Z",
    });
    database.repositories.densaAdeRunBranches.createCreating({
      projectId,
      workspacePath: "/tmp/task-packet-proof",
      branchName: "densa-ade/run/project-task-packet",
      sourceBranch: "main",
      startingCommit: "1111111111111111111111111111111111111111",
      createdAt: "2026-08-27T09:00:30.000Z",
    });
    database.repositories.densaAdeRunBranches.activate(projectId, "2026-08-27T09:00:31.000Z");
    database.repositories.attemptRollbackPlans.create({
      attemptId: "attempt-1",
      agentRunId: "agent-run-1",
      projectId,
      taskId,
      workspacePath: "/tmp/task-packet-proof",
      branchName: "densa-ade/run/project-task-packet",
      checkpointHead: "1111111111111111111111111111111111111111",
      ownedPaths: [{ path: "src/task-packet.ts", kind: "ABSENT", temporary: false }],
      recordedAt: "2026-08-27T09:02:01.000Z",
    });
    database.repositories.attemptRollbackPlans.recordFailure(
      "attempt-1",
      {
        failingCommand: "npm test",
        message: "Expected relevant retry failure; token=retry-secret-value",
        authToken: "nested-retry-secret",
      },
      "2026-08-27T09:02:02.000Z",
    );
    database.repositories.attempts.create({
      id: "attempt-2",
      taskId,
      number: 2,
      startedAt: "2026-08-27T09:03:00.000Z",
    });

    const result = new TaskPacketBuilder(database.repositories).build(
      request({ currentAttemptId: "attempt-2" }),
    );

    assert.equal(result.status, "built");
    assert.equal(result.packet.previousAttemptFailure.attemptId, "attempt-1");
    assert.equal(result.packet.previousAttemptFailure.attemptNumber, 1);
    assert.match(
      result.packet.previousAttemptFailure.diagnostics,
      /Expected relevant retry failure/u,
    );
    assert.equal(
      result.packet.previousAttemptFailure.diagnostics.includes("retry-secret-value"),
      false,
    );
    assert.equal(
      result.packet.previousAttemptFailure.diagnostics.includes("nested-retry-secret"),
      false,
    );
    assert.match(renderTaskPacketPrompt(result.packet), /### Previous attempt failure/u);
  });
});

test("oversized structured inputs are deterministically bounded", () => {
  withDatabase(
    (database) => {
      const result = new TaskPacketBuilder(database.repositories).build(request());

      assert.equal(result.status, "built");
      assert.equal(result.packet.bounds.truncated, true);
      assert.equal(result.packet.bounds.byteLength <= TASK_PACKET_MAX_BYTES, true);
      assert.equal(
        Buffer.byteLength(JSON.stringify(result.packet), "utf8"),
        result.packet.bounds.byteLength,
      );
      assert.equal(result.packet.task.acceptanceCriteria.length, 2);
    },
    { oversized: true },
  );
});

test("stale or unsafe context selections fail closed", () => {
  withDatabase((database) => {
    const builder = new TaskPacketBuilder(database.repositories);
    const missingDecision = builder.build(
      request({
        selection: {
          globalConstraints: [],
          architecturalDecisionIds: ["decision.missing"],
        },
      }),
    );
    assert.deepEqual(missingDecision, {
      status: "rejected",
      code: "INVALID_CONTEXT_SELECTION",
      message: "Architectural decision decision.missing does not exist for the project",
    });

    const unsafePath = builder.build(
      request({ relevantFiles: [{ path: "../outside.txt", summary: "Outside the workspace" }] }),
    );
    assert.equal(unsafePath.status, "rejected");
    assert.equal(unsafePath.code, "INVALID_CONTEXT_SELECTION");
  });
});

test("durable active constraints affect future packets while conflicts and supersession stay auditable", async () => {
  const workspacePath = "/tmp/densa-p8m1-task-packet";
  await rm(workspacePath, { force: true, recursive: true });
  const database = DensaAdeDatabase.openInMemory();
  try {
    seed(database);
    let tick = 0;
    let decisionNumber = 0;
    let eventNumber = 0;
    const service = new ProjectDecisionService(database, {
      workspacePath,
      now: () => new Date(Date.parse(createdAt) + ++tick * 1_000).toISOString(),
      decisionIdFactory: () => `decision.constraint.${String(++decisionNumber)}`,
      eventIdFactory: () => `event-constraint-${String(++eventNumber)}`,
    });
    const base = {
      projectId,
      kind: "constraint",
      title: "Database constraint",
      rationale: "The user wants one durable persistence boundary.",
      category: "architecture.database",
      source: "user",
      scope: "project",
      affectedPhaseIds: [],
      affectedTaskIds: [],
      actor: "user:test",
    };

    const first = await service.record({
      ...base,
      statement: "Do not use Firebase anywhere in this project.",
    });
    assert.equal(first.status, "RECORDED");
    const firstPacket = new TaskPacketBuilder(database.repositories).build(request());
    assert.equal(firstPacket.status, "built");
    assert.deepEqual(
      firstPacket.packet.projectConstraints.map(({ id, statement }) => ({ id, statement })),
      [
        {
          id: "decision.constraint.1",
          statement: "Do not use Firebase anywhere in this project.",
        },
      ],
    );

    database.repositories.events.append({
      id: "event-old-worker-session",
      projectId,
      type: "WORKER_MESSAGE_RECORDED",
      eventVersion: 1,
      occurredAt: "2026-08-27T09:00:10.000Z",
      actor: "worker:old-session",
      payload: { rememberedConstraint: "Use Firebase instead." },
    });
    const conflict = await service.record({
      ...base,
      statement: "Use Firebase for all project persistence.",
    });
    assert.equal(conflict.status, "CONFLICT_REQUIRES_USER_DECISION");
    assert.deepEqual(conflict.conflictDecisionIds, ["decision.constraint.1"]);
    assert.equal(conflict.event.type, "PROJECT_CONSTRAINT_CONFLICT_DETECTED");

    const replacement = await service.record({
      ...base,
      statement: "Use SQLite for authoritative runtime state.",
      supersedesId: "decision.constraint.1",
    });
    assert.equal(replacement.status, "RECORDED");
    assert.equal(replacement.decision.supersedesId, "decision.constraint.1");
    assert.equal(
      database.repositories.decisions.findById("decision.constraint.1").status,
      "superseded",
    );

    const futurePacket = new TaskPacketBuilder(database.repositories).build(request());
    assert.equal(futurePacket.status, "built");
    assert.deepEqual(
      futurePacket.packet.projectConstraints.map(({ id, statement }) => ({ id, statement })),
      [
        {
          id: "decision.constraint.2",
          statement: "Use SQLite for authoritative runtime state.",
        },
      ],
    );
    assert.equal(JSON.stringify(futurePacket.packet).includes("Use Firebase instead"), false);

    const portable = await readFile(`${workspacePath}/.densa-ade/DECISIONS.md`, "utf8");
    assert.match(portable, /Status: superseded/u);
    assert.match(portable, /Supersedes: `decision\.constraint\.1`/u);
    assert.match(portable, /Use SQLite for authoritative runtime state\./u);
  } finally {
    database.close();
    await rm(workspacePath, { force: true, recursive: true });
  }
});
