import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  ExecutionModeService,
  IndependentReviewService,
  ProjectExecutionOrchestrator,
  StateTransitionService,
} from "@densa-ade/core";
import { DensaAdeDatabase } from "@densa-ade/core/persistence";
import { masterRoadmapSchema } from "@densa-ade/protocol";
import { FakeAgentAdapter } from "@densa-ade/testing";

const baseTime = Date.parse("2026-08-27T12:00:00.000Z");
let sequence = 0;

function now() {
  sequence += 1;
  return new Date(baseTime + sequence * 1_000).toISOString();
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
    projectGoal: "Prove all three persistent execution modes.",
    phases: [
      {
        id: "phase.build",
        title: "Build",
        goal: "Complete two serial tasks.",
        required: true,
        completionCriteria: ["Both build tasks pass."],
        tasks: [roadmapTask("task.alpha"), roadmapTask("task.beta", ["task.alpha"])],
      },
      {
        id: "phase.release",
        title: "Release",
        goal: "Complete the release task.",
        required: true,
        completionCriteria: ["Release passes."],
        tasks: [roadmapTask("task.release", ["task.beta"])],
      },
    ],
  });
}

function transition(database, entityType, entityId, state) {
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
  const context = { actor: "execution-mode:test", occurredAt, reason: "fixture transition" };
  const change =
    entityType === "project"
      ? service.transitionProject(entity, state, context)
      : entityType === "phase"
        ? service.transitionPhase(entity, state, context)
        : service.transitionTask(entity, state, context);
  database.persistStateTransition(change, `event-execution-mode-${sequence}`);
}

function seed(database, executionMode) {
  const persistedRoadmap = roadmap();
  const createdAt = now();
  database.repositories.projects.create({
    id: "project-modes",
    name: "Execution modes proof",
    state: "DRAFT",
    executionMode,
    createdAt,
    updatedAt: createdAt,
  });
  for (const [phasePosition, phase] of persistedRoadmap.phases.entries()) {
    database.repositories.phases.create({
      id: phase.id,
      projectId: "project-modes",
      title: phase.title,
      state: "PENDING",
      position: phasePosition,
      createdAt,
      updatedAt: createdAt,
    });
    for (const [taskPosition, task] of phase.tasks.entries()) {
      database.repositories.tasks.create({
        id: task.id,
        projectId: "project-modes",
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
    projectId: "project-modes",
    roadmap: persistedRoadmap,
    revisionNumber: 0,
    createdAt,
    updatedAt: createdAt,
  });
  transition(database, "project", "project-modes", "PLANNING");
  transition(database, "project", "project-modes", "READY");
  transition(database, "project", "project-modes", "RUNNING");
  transition(database, "phase", "phase.build", "READY");
}

function completingExecutor(database, order, beforeCompletion = () => undefined) {
  return {
    async execute(request) {
      order.push(request.taskId);
      await beforeCompletion(request);
      const attemptId = `attempt-${request.taskId}`;
      const commitSha = `commit-${request.taskId}`;
      database.repositories.attempts.create({
        id: attemptId,
        taskId: request.taskId,
        number: 1,
        startedAt: now(),
      });
      transition(database, "task", request.taskId, "RUNNING");
      transition(database, "task", request.taskId, "VALIDATING");
      database.repositories.attempts.recordCommit(attemptId, request.taskId, commitSha);
      database.repositories.attempts.recordCompleted(attemptId, now());
      transition(database, "task", request.taskId, "COMPLETED");
      return { status: "COMPLETED", taskId: request.taskId, attemptCount: 1, commitSha };
    },
  };
}

function phaseValidator(database) {
  return {
    validatorId: "fake-phase-validator",
    providesIndependentReview: true,
    async validate({ projectId, phase, validationEventId, workspacePath }) {
      const reviewId = `review-${phase.id}`;
      if (database.repositories.independentReviews.findById(reviewId) === undefined) {
        const roadmapPhase = database.repositories.masterRoadmaps
          .findByProjectId(projectId)
          .roadmap.phases.find((entry) => entry.id === phase.id);
        assert.ok(roadmapPhase);
        await new IndependentReviewService(database, {
          now,
          workspaceFingerprint: async () => "unchanged",
        }).execute({
          id: reviewId,
          projectId,
          phaseId: phase.id,
          validationEventId,
          workspacePath,
          goal: roadmapPhase.goal,
          acceptanceCriteria: roadmapPhase.completionCriteria,
          relevantDiff: "+ execution-mode fixture",
          deterministicResults: [
            {
              validatorId: "phase-suite",
              status: "passed",
              required: true,
              summary: "Suite passed.",
            },
          ],
          architectureConstraints: ["Densa ADE Core owns the phase verdict."],
          adapter: new FakeAgentAdapter({
            finalMessage: JSON.stringify({
              verdict: "pass",
              summary: "Independent phase review passed.",
              findings: [],
              criteria: roadmapPhase.completionCriteria.map((_criterion, criterionPosition) => ({
                criterionPosition,
                assessment: "satisfied",
                rationale: "The fake reviewer inspected the phase evidence.",
              })),
              confidence: 0.9,
              unknowns: [],
            }),
          }),
          reviewerRunId: `reviewer-run-${phase.id}`,
        });
      }
      return {
        passed: true,
        independentReviewId: reviewId,
        summary: "Phase evidence passed.",
        checks: [{ validatorId: "phase-suite", passed: true, summary: "Suite passed." }],
      };
    },
  };
}

function emptyGates() {
  return { outstandingUserDecisionIds: [], permissionBlockers: [] };
}

function request(database, workspace, taskExecutor, overrides = {}) {
  return {
    projectId: "project-modes",
    workspacePath: workspace,
    gates: emptyGates(),
    taskExecutor,
    validator: phaseValidator(database),
    actor: "execution-mode:test",
    ...overrides,
  };
}

async function withFixture(executionMode, work) {
  const workspace = mkdtempSync(join(tmpdir(), "densa-p5m4-"));
  const database = DensaAdeDatabase.openInMemory();
  try {
    seed(database, executionMode);
    return await work({ database, workspace });
  } finally {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  }
}

test("Guided boundaries remain enforced after more than one event replay page", async () => {
  await withFixture("guided", async ({ database, workspace }) => {
    for (let index = 0; index < 1_001; index += 1) {
      database.repositories.events.append({
        id: `old-task-event-${index}`,
        projectId: "project-modes",
        phaseId: "phase.build",
        type: "TASK_STATE_CHANGED",
        eventVersion: 1,
        occurredAt: now(),
        actor: "fixture",
        payload: { state: "READY" },
      });
    }
    const order = [];
    const executor = completingExecutor(database, order);
    const result = await new ProjectExecutionOrchestrator(database, { now }).execute(
      request(database, workspace, executor),
    );
    assert.equal(result.status, "AWAITING_TASK_APPROVAL");
    assert.equal(result.taskId, "task.alpha");
    assert.deepEqual(order, ["task.alpha"]);
    const restarted = await new ProjectExecutionOrchestrator(database, { now }).execute(
      request(database, workspace, executor),
    );
    assert.equal(restarted.status, "AWAITING_TASK_APPROVAL");
    assert.deepEqual(order, ["task.alpha"]);
  });
});

test("phase loop resumes a reconciled RETRYING task before selecting new work", async () => {
  await withFixture("guided", async ({ database, workspace }) => {
    transition(database, "task", "task.alpha", "READY");
    transition(database, "task", "task.alpha", "RUNNING");
    transition(database, "task", "task.alpha", "RETRYING");
    const order = [];
    const result = await new ProjectExecutionOrchestrator(database, { now }).execute(
      request(database, workspace, completingExecutor(database, order)),
    );
    assert.equal(result.status, "AWAITING_TASK_APPROVAL");
    assert.deepEqual(order, ["task.alpha"]);
  });
});

test("Guided mode stops durably after every validated task and resumes only with matching approval", async () => {
  await withFixture("guided", async ({ database, workspace }) => {
    const order = [];
    const taskExecutor = completingExecutor(database, order);

    const first = await new ProjectExecutionOrchestrator(database, { now }).execute(
      request(database, workspace, taskExecutor),
    );
    assert.deepEqual(first, {
      status: "AWAITING_TASK_APPROVAL",
      projectId: "project-modes",
      phaseId: "phase.build",
      taskId: "task.alpha",
    });
    const restarted = await new ProjectExecutionOrchestrator(database, { now }).execute(
      request(database, workspace, taskExecutor),
    );
    assert.equal(restarted.status, "AWAITING_TASK_APPROVAL");
    assert.deepEqual(order, ["task.alpha"]);

    const second = await new ProjectExecutionOrchestrator(database, { now }).execute(
      request(database, workspace, taskExecutor, { guidedTaskApproval: { taskId: "task.alpha" } }),
    );
    assert.equal(second.status, "AWAITING_TASK_APPROVAL");
    assert.equal(second.taskId, "task.beta");

    const third = await new ProjectExecutionOrchestrator(database, { now }).execute(
      request(database, workspace, taskExecutor, { guidedTaskApproval: { taskId: "task.beta" } }),
    );
    assert.equal(third.status, "AWAITING_TASK_APPROVAL");
    assert.equal(third.taskId, "task.release");

    const completed = await new ProjectExecutionOrchestrator(database, { now }).execute(
      request(database, workspace, taskExecutor, {
        guidedTaskApproval: { taskId: "task.release" },
      }),
    );
    assert.equal(completed.status, "COMPLETED");
    assert.deepEqual(order, ["task.alpha", "task.beta", "task.release"]);
    assert.equal(database.repositories.projects.findById("project-modes").state, "COMPLETED");
    const events = database.eventJournal.replay({ projectId: "project-modes", limit: 1_000 });
    assert.equal(
      events.filter((event) => event.type === "GUIDED_TASK_APPROVAL_REQUIRED").length,
      3,
    );
    assert.equal(events.filter((event) => event.type === "GUIDED_TASK_APPROVED").length, 3);
  });
});

test("Phase mode stops after each durable phase report until explicit approval", async () => {
  await withFixture("phase", async ({ database, workspace }) => {
    const order = [];
    const taskExecutor = completingExecutor(database, order);
    const first = await new ProjectExecutionOrchestrator(database, { now }).execute(
      request(database, workspace, taskExecutor),
    );
    assert.equal(first.status, "AWAITING_PHASE_APPROVAL");
    assert.equal(first.phaseId, "phase.build");
    assert.deepEqual(order, ["task.alpha", "task.beta"]);

    const restarted = await new ProjectExecutionOrchestrator(database, { now }).execute(
      request(database, workspace, taskExecutor),
    );
    assert.equal(restarted.status, "AWAITING_PHASE_APPROVAL");
    assert.deepEqual(order, ["task.alpha", "task.beta"]);

    const release = await new ProjectExecutionOrchestrator(database, { now }).execute(
      request(database, workspace, taskExecutor, { phaseApproval: { phaseId: "phase.build" } }),
    );
    assert.equal(release.status, "AWAITING_PHASE_APPROVAL");
    assert.equal(release.phaseId, "phase.release");
    assert.deepEqual(order, ["task.alpha", "task.beta", "task.release"]);

    const completed = await new ProjectExecutionOrchestrator(database, { now }).execute(
      request(database, workspace, taskExecutor, { phaseApproval: { phaseId: "phase.release" } }),
    );
    assert.equal(completed.status, "COMPLETED");
  });
});

test("Continuous mode validates, reports, and completes every phase in one project run", async () => {
  await withFixture("continuous", async ({ database, workspace }) => {
    const order = [];
    const completed = await new ProjectExecutionOrchestrator(database, { now }).execute(
      request(database, workspace, completingExecutor(database, order)),
    );

    assert.equal(completed.status, "COMPLETED");
    assert.deepEqual(order, ["task.alpha", "task.beta", "task.release"]);
    assert.equal(database.repositories.phaseReports.listByProjectId("project-modes").length, 2);
    assert.deepEqual(
      database.repositories.phases.listByProjectId("project-modes").map((phase) => phase.state),
      ["COMPLETED", "COMPLETED"],
    );
  });
});

test("project execution surfaces durable WAITING_FOR_USAGE without inventing resetAt", async () => {
  await withFixture("continuous", async ({ database, workspace }) => {
    let executions = 0;
    const taskExecutor = {
      async execute({ projectId, taskId }) {
        executions += 1;
        const task = database.repositories.tasks.findById(taskId);
        const project = database.repositories.projects.findById(projectId);
        assert.equal(task.state, "READY");
        assert.equal(project.state, "RUNNING");
        const occurredAt = now();
        database.transaction((repositories) => {
          repositories.events.append({
            id: "event-project-usage-limited",
            projectId,
            phaseId: task.phaseId,
            taskId,
            type: "USAGE_LIMIT_REACHED",
            eventVersion: 1,
            occurredAt,
            actor: "execution-mode:test",
            payload: { usageState: { status: "limited" } },
          });
          database.persistStateTransition(
            new StateTransitionService().transitionTask(task, "WAITING_FOR_USAGE", {
              actor: "execution-mode:test",
              occurredAt,
            }),
            "event-task-waiting-for-usage",
          );
          database.persistStateTransition(
            new StateTransitionService().transitionProject(project, "WAITING_FOR_USAGE", {
              actor: "execution-mode:test",
              occurredAt,
            }),
            "event-project-waiting-for-usage",
          );
        });
        return {
          status: "WAITING_FOR_USAGE",
          taskId,
          attemptCount: 1,
          usageState: { status: "limited" },
        };
      },
    };

    const waiting = await new ProjectExecutionOrchestrator(database, { now }).execute(
      request(database, workspace, taskExecutor),
    );
    assert.deepEqual(waiting, {
      status: "WAITING_FOR_USAGE",
      projectId: "project-modes",
      phaseId: "phase.build",
      taskId: "task.alpha",
      usageState: { status: "limited" },
    });
    assert.equal("resetAt" in waiting.usageState, false);

    const restarted = await new ProjectExecutionOrchestrator(database, { now }).execute(
      request(database, workspace, taskExecutor),
    );
    assert.deepEqual(restarted, waiting);
    assert.equal(executions, 1);
  });
});

test("Continuous mode cannot bypass mandatory decisions or non-overridable permission blockers", async () => {
  await withFixture("continuous", async ({ database, workspace }) => {
    const order = [];
    const blocked = await new ProjectExecutionOrchestrator(database, { now }).execute(
      request(database, workspace, completingExecutor(database, order), {
        gates: {
          outstandingUserDecisionIds: ["decision.scope-change"],
          permissionBlockers: [
            { id: "secret.database", scope: "project", reason: "Secret access requires approval." },
          ],
        },
      }),
    );

    assert.equal(blocked.status, "BLOCKED");
    assert.match(blocked.reason, /decision\.scope-change/u);
    assert.deepEqual(order, []);
    assert.equal(database.repositories.phases.findById("phase.build").state, "READY");
  });
});

test("an audit insert failure rolls back the execution mode update", async () => {
  await withFixture("continuous", async ({ database }) => {
    const occurredAt = now();
    database.repositories.events.append({
      id: "event-mode-collision",
      projectId: "project-modes",
      type: "INJECTED_COLLISION",
      eventVersion: 1,
      occurredAt,
      actor: "execution-mode:test",
      payload: {},
    });

    assert.throws(() =>
      database.persistExecutionModeChange({
        projectId: "project-modes",
        previousMode: "continuous",
        mode: "guided",
        occurredAt: now(),
        actor: "execution-mode:test",
        eventId: "event-mode-collision",
      }),
    );
    assert.equal(
      database.repositories.projects.findById("project-modes").executionMode,
      "continuous",
    );
  });
});

test("mode changes persist across restart, emit audit facts, and take effect at task boundaries", async () => {
  const directory = mkdtempSync(join(tmpdir(), "densa-p5m4-restart-"));
  const workspace = join(directory, "workspace");
  const databasePath = join(directory, "runtime.sqlite");
  let database = DensaAdeDatabase.open(databasePath);
  try {
    seed(database, "continuous");
    const order = [];
    let changed = false;
    const taskExecutor = completingExecutor(database, order, () => {
      if (!changed) {
        changed = true;
        assert.equal(
          new ExecutionModeService(database, { now }).change(
            "project-modes",
            "guided",
            "execution-mode:test",
          ).status,
          "CHANGED",
        );
      }
    });
    const guided = await new ProjectExecutionOrchestrator(database, { now }).execute(
      request(database, workspace, taskExecutor),
    );
    assert.equal(guided.status, "AWAITING_TASK_APPROVAL");
    assert.equal(guided.taskId, "task.alpha");
    database.close();

    database = DensaAdeDatabase.open(databasePath);
    assert.equal(database.repositories.projects.findById("project-modes").executionMode, "guided");
    assert.equal(
      new ExecutionModeService(database, { now }).change(
        "project-modes",
        "continuous",
        "execution-mode:test",
      ).status,
      "CHANGED",
    );
    const completed = await new ProjectExecutionOrchestrator(database, { now }).execute(
      request(database, workspace, completingExecutor(database, order)),
    );
    assert.equal(completed.status, "COMPLETED");
    assert.deepEqual(order, ["task.alpha", "task.beta", "task.release"]);
    const modeEvents = database.eventJournal.replay({
      projectId: "project-modes",
      types: ["EXECUTION_MODE_CHANGED"],
      limit: 10,
    });
    assert.deepEqual(
      modeEvents.map((event) => [event.payload.previousMode, event.payload.mode]),
      [
        ["continuous", "guided"],
        ["guided", "continuous"],
      ],
    );
    assert.equal(
      database.eventJournal.replay({
        projectId: "project-modes",
        types: ["GUIDED_TASK_APPROVAL_SUPERSEDED"],
        limit: 10,
      }).length,
      1,
    );
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
