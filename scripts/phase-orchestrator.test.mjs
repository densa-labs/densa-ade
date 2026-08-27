import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { PhaseLifecycleOrchestrator, StateTransitionService } from "@densa/core";
import { DensaDatabase } from "@densa/core/persistence";
import { masterRoadmapSchema } from "@densa/protocol";

const baseTime = Date.parse("2026-08-27T10:00:00.000Z");
let globalSequence = 0;

function now() {
  globalSequence += 1;
  return new Date(baseTime + globalSequence * 1_000).toISOString();
}

function roadmapTask(id, dependencyIds = []) {
  return {
    id,
    title: `Deliver ${id}`,
    goal: `Complete ${id}.`,
    executable: true,
    dependencyIds,
    acceptanceCriteria: [`${id} has deterministic evidence.`],
    riskLevel: "medium",
    expectedValidators: ["unit_test"],
  };
}

function roadmap() {
  return masterRoadmapSchema.parse({
    formatVersion: 1,
    projectGoal: "Prove one complete serial phase lifecycle.",
    phases: [
      {
        id: "phase.build",
        title: "Build",
        goal: "Build two dependency-ordered tasks.",
        required: true,
        completionCriteria: ["Both tasks and phase validation pass."],
        tasks: [roadmapTask("task.alpha"), roadmapTask("task.beta", ["task.alpha"])],
      },
      {
        id: "phase.release",
        title: "Release",
        goal: "Prepare the next phase without executing it.",
        required: true,
        completionCriteria: ["Release is ready."],
        tasks: [roadmapTask("task.release", ["task.beta"])],
      },
    ],
  });
}

function transition(database, entityType, entityId, state, reason = "test transition") {
  const service = new StateTransitionService();
  const repository =
    entityType === "project"
      ? database.repositories.projects
      : entityType === "phase"
        ? database.repositories.phases
        : database.repositories.tasks;
  const entity = repository.findById(entityId);
  assert.ok(entity);
  const occurredAt = now();
  const change =
    entityType === "project"
      ? service.transitionProject(entity, state, { actor: "phase:test", occurredAt, reason })
      : entityType === "phase"
        ? service.transitionPhase(entity, state, { actor: "phase:test", occurredAt, reason })
        : service.transitionTask(entity, state, { actor: "phase:test", occurredAt, reason });
  database.persistStateTransition(change, `event-phase-test-${globalSequence}`);
}

function seed(database, executionMode) {
  const persistedRoadmap = roadmap();
  const createdAt = now();
  database.repositories.projects.create({
    id: "project-phase",
    name: "Phase proof",
    state: "DRAFT",
    executionMode,
    createdAt,
    updatedAt: createdAt,
  });
  for (const [phasePosition, phase] of persistedRoadmap.phases.entries()) {
    database.repositories.phases.create({
      id: phase.id,
      projectId: "project-phase",
      title: phase.title,
      state: "PENDING",
      position: phasePosition,
      createdAt,
      updatedAt: createdAt,
    });
    for (const [taskPosition, task] of phase.tasks.entries()) {
      database.repositories.tasks.create({
        id: task.id,
        projectId: "project-phase",
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
    projectId: "project-phase",
    roadmap: persistedRoadmap,
    revisionNumber: 0,
    createdAt,
    updatedAt: createdAt,
  });
  transition(database, "project", "project-phase", "PLANNING");
  transition(database, "project", "project-phase", "READY");
  transition(database, "project", "project-phase", "RUNNING");
  transition(database, "phase", "phase.build", "READY");
}

function completingExecutor(database, order) {
  let active = 0;
  return {
    async execute(request) {
      active += 1;
      assert.equal(active, 1, "phase execution must remain serial");
      order.push(request.taskId);
      const attemptId = `attempt-${request.taskId}`;
      const validationId = `validation-${request.taskId}`;
      const commitSha = `commit-${request.taskId}`;
      const startedAt = now();
      database.repositories.attempts.create({
        id: attemptId,
        taskId: request.taskId,
        number: 1,
        startedAt,
      });
      transition(database, "task", request.taskId, "RUNNING");
      transition(database, "task", request.taskId, "VALIDATING");
      database.repositories.validationRuns.create({
        id: validationId,
        taskId: request.taskId,
        attemptId,
        validatorId: "fake-task-validator",
        startedAt,
      });
      database.repositories.validationRuns.recordCompleted(validationId, now(), true);
      database.repositories.attempts.recordCommit(attemptId, request.taskId, commitSha);
      database.repositories.attempts.recordCompleted(attemptId, now());
      database.repositories.events.append({
        id: `event-commit-${request.taskId}`,
        projectId: request.projectId,
        phaseId: request.phaseId,
        taskId: request.taskId,
        type: "TASK_COMMITTED",
        eventVersion: 1,
        occurredAt: now(),
        actor: request.actor,
        payload: { commitSha, intendedPaths: [`src/${request.taskId}.ts`] },
      });
      transition(database, "task", request.taskId, "COMPLETED");
      active -= 1;
      return { status: "COMPLETED", taskId: request.taskId, attemptCount: 1, commitSha };
    },
  };
}

function passingValidator(calls) {
  return {
    validatorId: "fake-phase-validator",
    async validate({ tasks }) {
      calls.push(tasks.map((task) => task.id));
      return {
        passed: true,
        summary: "All phase acceptance checks passed.",
        checks: [
          {
            validatorId: "fake-phase-suite",
            passed: true,
            summary: "The deterministic phase suite passed.",
          },
        ],
      };
    },
  };
}

function emptyGates() {
  return { outstandingUserDecisionIds: [], permissionBlockers: [] };
}

async function withFixture(executionMode, work) {
  const workspace = mkdtempSync(join(tmpdir(), "densa-p5m3-"));
  const database = DensaDatabase.openInMemory();
  try {
    seed(database, executionMode);
    return await work({ database, workspace });
  } finally {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  }
}

test("phase-by-phase mode executes a multi-task phase serially and persists its durable report", async () => {
  await withFixture("phase", async ({ database, workspace }) => {
    const order = [];
    const validationCalls = [];
    const orchestrator = new PhaseLifecycleOrchestrator(database, { now });
    const request = {
      projectId: "project-phase",
      phaseId: "phase.build",
      workspacePath: workspace,
      gates: emptyGates(),
      taskExecutor: completingExecutor(database, order),
      validator: passingValidator(validationCalls),
      actor: "phase:test",
    };

    const result = await orchestrator.execute(request);

    assert.equal(result.status, "AWAITING_APPROVAL");
    assert.deepEqual(order, ["task.alpha", "task.beta"]);
    assert.deepEqual(validationCalls, [["task.alpha", "task.beta"]]);
    assert.equal(database.repositories.phases.findById("phase.build").state, "AWAITING_APPROVAL");
    assert.equal(database.repositories.phases.findById("phase.release").state, "PENDING");
    assert.equal(result.report.tasksCompleted.length, 2);
    assert.deepEqual(
      result.report.commits.map((entry) => entry.sha),
      ["commit-task.alpha", "commit-task.beta"],
    );
    assert.deepEqual(result.report.filesChanged, [
      { taskId: "task.alpha", paths: ["src/task.alpha.ts"] },
      { taskId: "task.beta", paths: ["src/task.beta.ts"] },
    ]);
    assert.deepEqual(
      database.repositories.phaseReports.findByPhaseId("phase.build"),
      result.report,
    );
    const markdown = readFileSync(join(workspace, result.report.reportPath), "utf8");
    assert.match(markdown, /## Tasks completed/u);
    assert.match(markdown, /## Tests and validators/u);
    assert.match(markdown, /## Next phase/u);

    const resumed = await orchestrator.execute(request);
    assert.equal(resumed.status, "AWAITING_APPROVAL");
    assert.deepEqual(order, ["task.alpha", "task.beta"], "recovery must not rerun completed tasks");
  });
});

test("continuous mode completes the validated phase and only then makes the next phase READY", async () => {
  await withFixture("continuous", async ({ database, workspace }) => {
    const order = [];
    const result = await new PhaseLifecycleOrchestrator(database, { now }).execute({
      projectId: "project-phase",
      phaseId: "phase.build",
      workspacePath: workspace,
      gates: emptyGates(),
      taskExecutor: completingExecutor(database, order),
      validator: passingValidator([]),
      actor: "phase:test",
    });

    assert.equal(result.status, "COMPLETED");
    assert.equal(database.repositories.phases.findById("phase.build").state, "COMPLETED");
    assert.equal(database.repositories.phases.findById("phase.release").state, "READY");
    const events = database.eventJournal.replay({ projectId: "project-phase", limit: 1_000 });
    const validationIndex = events.findIndex((event) => event.type === "PHASE_VALIDATION_PASSED");
    const nextReadyIndex = events.findIndex(
      (event) =>
        event.type === "PHASE_STATE_CHANGED" &&
        event.phaseId === "phase.release" &&
        event.payload.state === "READY",
    );
    assert.ok(validationIndex >= 0 && nextReadyIndex > validationIndex);
  });
});

test("a blocked required task blocks the phase, skips phase validation, and records unresolved work", async () => {
  await withFixture("phase", async ({ database, workspace }) => {
    const validationCalls = [];
    const completing = completingExecutor(database, []);
    const taskExecutor = {
      async execute(request) {
        if (request.taskId === "task.alpha") return completing.execute(request);
        transition(database, "task", request.taskId, "BLOCKED", "fake task blocker");
        return {
          status: "BLOCKED",
          taskId: request.taskId,
          attemptCount: 0,
          reason: "Required fixture task is blocked.",
        };
      },
    };
    const result = await new PhaseLifecycleOrchestrator(database, { now }).execute({
      projectId: "project-phase",
      phaseId: "phase.build",
      workspacePath: workspace,
      gates: emptyGates(),
      taskExecutor,
      validator: passingValidator(validationCalls),
      actor: "phase:test",
    });

    assert.equal(result.status, "BLOCKED");
    assert.equal(database.repositories.phases.findById("phase.build").state, "BLOCKED");
    assert.equal(database.repositories.phases.findById("phase.release").state, "PENDING");
    assert.deepEqual(validationCalls, []);
    assert.equal(result.report.phaseValidation.status, "not_run");
    assert.match(result.report.unresolvedIssues[0], /task\.beta is BLOCKED/u);
    assert.equal(readFileSync(join(workspace, result.report.reportPath), "utf8").length > 0, true);
  });
});

test("failed phase validation blocks completion and never unlocks the next phase", async () => {
  await withFixture("continuous", async ({ database, workspace }) => {
    const result = await new PhaseLifecycleOrchestrator(database, { now }).execute({
      projectId: "project-phase",
      phaseId: "phase.build",
      workspacePath: workspace,
      gates: emptyGates(),
      taskExecutor: completingExecutor(database, []),
      validator: {
        validatorId: "failing-phase-validator",
        async validate() {
          return {
            passed: false,
            summary: "Integration acceptance failed.",
            checks: [
              {
                validatorId: "integration",
                passed: false,
                summary: "The integration check failed.",
              },
            ],
          };
        },
      },
      actor: "phase:test",
    });

    assert.equal(result.status, "BLOCKED");
    assert.equal(result.report.phaseValidation.status, "failed");
    assert.equal(database.repositories.phases.findById("phase.release").state, "PENDING");
  });
});

test("phase report and state outcomes roll back together when an audit fact cannot persist", async () => {
  await withFixture("continuous", async ({ database, workspace }) => {
    const key = createHash("sha256")
      .update("project-phase")
      .update("\0")
      .update("phase.build")
      .digest("hex")
      .slice(0, 20);
    database.repositories.events.append({
      id: `phase-lifecycle-${key}-report-generated`,
      projectId: "project-phase",
      phaseId: "phase.build",
      type: "INJECTED_COLLISION",
      eventVersion: 1,
      occurredAt: now(),
      actor: "phase:test",
      payload: {},
    });

    await assert.rejects(() =>
      new PhaseLifecycleOrchestrator(database, { now }).execute({
        projectId: "project-phase",
        phaseId: "phase.build",
        workspacePath: workspace,
        gates: emptyGates(),
        taskExecutor: completingExecutor(database, []),
        validator: passingValidator([]),
        actor: "phase:test",
      }),
    );

    assert.equal(database.repositories.phaseReports.findByPhaseId("phase.build"), undefined);
    assert.equal(database.repositories.phases.findById("phase.build").state, "VALIDATING");
    assert.equal(database.repositories.phases.findById("phase.release").state, "PENDING");
  });
});
