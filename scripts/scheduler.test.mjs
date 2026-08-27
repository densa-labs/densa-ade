import assert from "node:assert/strict";
import { test } from "node:test";

import { DependencyScheduler, StateTransitionService } from "@densa/core";
import { DensaDatabase } from "@densa/core/persistence";
import { masterRoadmapSchema } from "@densa/protocol";

const createdAt = "2026-08-27T08:00:00.000Z";
const projectId = "project-scheduler";
let transitionSequence = 0;

function roadmapTask(id, dependencyIds = []) {
  return {
    id,
    title: `Deliver ${id}`,
    goal: `Complete ${id}.`,
    executable: true,
    dependencyIds,
    acceptanceCriteria: [`${id} passes deterministic acceptance checks.`],
    riskLevel: "medium",
    expectedValidators: ["unit_test", "acceptance"],
  };
}

function roadmap() {
  return masterRoadmapSchema.parse({
    formatVersion: 1,
    projectGoal: "Prove deterministic persisted task scheduling.",
    phases: [
      {
        id: "phase.foundation",
        title: "Foundation",
        goal: "Create the prerequisite.",
        required: true,
        completionCriteria: ["The foundation is complete."],
        tasks: [roadmapTask("task.foundation")],
      },
      {
        id: "phase.product",
        title: "Product",
        goal: "Build independent product work and integration.",
        required: true,
        completionCriteria: ["Product work passes integration checks."],
        tasks: [
          roadmapTask("task.alpha", ["task.foundation"]),
          roadmapTask("task.beta", ["task.foundation"]),
          roadmapTask("task.finish", ["task.alpha", "task.beta"]),
        ],
      },
    ],
  });
}

function seed(database, { runtimeDependencyOverrides = {} } = {}) {
  const persistedRoadmap = roadmap();
  database.repositories.projects.create({
    id: projectId,
    name: "Scheduler proof",
    state: "DRAFT",
    executionMode: "phase",
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
        dependencyIds: runtimeDependencyOverrides[task.id] ?? task.dependencyIds,
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
}

function transition(database, entityType, entityId, requestedState) {
  transitionSequence += 1;
  const occurredAt = new Date(Date.parse(createdAt) + transitionSequence * 1_000).toISOString();
  const service = new StateTransitionService();
  const repository =
    entityType === "project"
      ? database.repositories.projects
      : entityType === "phase"
        ? database.repositories.phases
        : database.repositories.tasks;
  const entity = repository.findById(entityId);
  assert.ok(entity, `${entityType} ${entityId} must exist`);
  const result =
    entityType === "project"
      ? service.transitionProject(entity, requestedState, {
          actor: "scheduler:test",
          occurredAt,
        })
      : entityType === "phase"
        ? service.transitionPhase(entity, requestedState, {
            actor: "scheduler:test",
            occurredAt,
          })
        : service.transitionTask(entity, requestedState, {
            actor: "scheduler:test",
            occurredAt,
          });
  database.persistStateTransition(result, `event-scheduler-${transitionSequence}`);
}

function advance(database, entityType, entityId, ...states) {
  for (const state of states) transition(database, entityType, entityId, state);
}

function prepareRunnableProject(database) {
  advance(database, "project", projectId, "PLANNING", "READY", "RUNNING");
}

function emptyGates() {
  return { outstandingUserDecisionIds: [], permissionBlockers: [] };
}

function select(database, gates = emptyGates()) {
  return new DependencyScheduler(database.repositories).selectNext({ projectId, gates });
}

function withDatabase(work, options) {
  const database = DensaDatabase.openInMemory();
  try {
    seed(database, options);
    return work(database);
  } finally {
    database.close();
  }
}

test("selects exactly one READY task from persisted state using roadmap order tie-breaking", () => {
  withDatabase((database) => {
    prepareRunnableProject(database);
    advance(database, "phase", "phase.foundation", "READY", "RUNNING");
    advance(database, "task", "task.foundation", "READY", "RUNNING", "VALIDATING", "COMPLETED");
    advance(database, "phase", "phase.product", "READY");
    advance(database, "task", "task.alpha", "READY");
    advance(database, "task", "task.beta", "READY");

    const selected = select(database);

    assert.equal(selected.status, "selected");
    assert.equal(selected.task.id, "task.alpha");
    assert.equal(selected.task.state, "READY");
    assert.equal(selected.phase.id, "phase.product");
    assert.deepEqual(selected.tieBreak, {
      phasePosition: 1,
      taskPosition: 0,
      taskId: "task.alpha",
    });
    assert.equal(selected.roadmapRevisionNumber, 0);
    assert.equal(Object.isFrozen(selected), true);
    assert.equal(Object.isFrozen(selected.tieBreak), true);
  });
});

test("never selects a READY task before every hard dependency is COMPLETED", () => {
  withDatabase((database) => {
    prepareRunnableProject(database);
    advance(database, "phase", "phase.foundation", "READY");
    advance(database, "phase", "phase.product", "READY");
    advance(database, "task", "task.alpha", "READY");

    const blocked = select(database);

    assert.equal(blocked.status, "no_work");
    assert.deepEqual(
      blocked.reasons.map(({ code, taskId, relatedIds }) => ({ code, taskId, relatedIds })),
      [
        {
          code: "DEPENDENCIES_INCOMPLETE",
          taskId: "task.alpha",
          relatedIds: ["task.foundation"],
        },
      ],
    );
  });
});

test("an active task owns the single serial execution slot", () => {
  withDatabase((database) => {
    prepareRunnableProject(database);
    advance(database, "phase", "phase.foundation", "READY", "RUNNING");
    advance(database, "task", "task.foundation", "READY", "RUNNING");
    advance(database, "phase", "phase.product", "READY");
    advance(database, "task", "task.alpha", "READY");

    const blocked = select(database);

    assert.equal(blocked.status, "no_work");
    assert.equal(blocked.reasons[0].code, "ACTIVE_TASK");
    assert.deepEqual(blocked.reasons[0].relatedIds, ["task.foundation"]);
  });

  withDatabase((database) => {
    prepareRunnableProject(database);
    advance(database, "phase", "phase.foundation", "READY", "RUNNING");
    advance(database, "task", "task.foundation", "READY", "RUNNING", "VALIDATING", "COMPLETED");
    advance(database, "phase", "phase.product", "READY", "RUNNING");
    advance(database, "task", "task.alpha", "READY", "RUNNING");
    advance(database, "task", "task.beta", "READY", "RUNNING");

    const invalid = select(database);

    assert.equal(invalid.status, "no_work");
    assert.equal(invalid.reasons[0].code, "SERIAL_EXECUTION_VIOLATION");
    assert.equal(invalid.reasons[0].classification, "invalid");
    assert.deepEqual(invalid.reasons[0].relatedIds, ["task.alpha", "task.beta"]);
  });
});

test("outstanding user decisions and waiting task state stop scheduling", () => {
  withDatabase((database) => {
    prepareRunnableProject(database);
    advance(database, "phase", "phase.foundation", "READY");
    advance(database, "task", "task.foundation", "READY");

    const gated = select(database, {
      outstandingUserDecisionIds: ["decision-risk-approval"],
      permissionBlockers: [],
    });
    assert.equal(gated.status, "no_work");
    assert.equal(gated.reasons[0].code, "OUTSTANDING_USER_DECISION");
    assert.deepEqual(gated.reasons[0].relatedIds, ["decision-risk-approval"]);

    advance(database, "task", "task.foundation", "WAITING_FOR_USER");
    const persistedWait = select(database);
    assert.equal(persistedWait.status, "no_work");
    assert.equal(persistedWait.reasons[0].code, "OUTSTANDING_USER_DECISION");
    assert.deepEqual(persistedWait.reasons[0].relatedIds, ["task.foundation"]);
  });
});

test("permission gates are scope-aware and independent READY work may continue", () => {
  withDatabase((database) => {
    prepareRunnableProject(database);
    advance(database, "phase", "phase.foundation", "READY", "RUNNING");
    advance(database, "task", "task.foundation", "READY", "RUNNING", "VALIDATING", "COMPLETED");
    advance(database, "phase", "phase.product", "READY");
    advance(database, "task", "task.alpha", "READY");
    advance(database, "task", "task.beta", "READY");

    const selected = select(database, {
      outstandingUserDecisionIds: [],
      permissionBlockers: [
        {
          id: "permission-alpha",
          scope: "task",
          taskId: "task.alpha",
          reason: "The requested filesystem access has not been approved",
        },
      ],
    });
    assert.equal(selected.status, "selected");
    assert.equal(selected.task.id, "task.beta");

    const projectBlocked = select(database, {
      outstandingUserDecisionIds: [],
      permissionBlockers: [
        {
          id: "permission-project",
          scope: "project",
          reason: "The project permission preset prohibits execution",
        },
      ],
    });
    assert.equal(projectBlocked.status, "no_work");
    assert.equal(projectBlocked.reasons[0].code, "PERMISSION_BLOCKED");
    assert.deepEqual(projectBlocked.reasons[0].relatedIds, ["permission-project"]);
  });
});

test("project, phase, and blocked task states produce explicit no-work reasons", () => {
  withDatabase((database) => {
    advance(database, "project", projectId, "PLANNING", "READY", "PAUSED");
    assert.equal(select(database).reasons[0].code, "PROJECT_PAUSED");
  });

  withDatabase((database) => {
    prepareRunnableProject(database);
    advance(database, "phase", "phase.foundation", "BLOCKED");
    advance(database, "task", "task.foundation", "BLOCKED");
    const blocked = select(database);
    assert.equal(blocked.status, "no_work");
    assert.equal(blocked.reasons[0].code, "TASK_BLOCKED");
    assert.equal(blocked.reasons[0].taskId, "task.foundation");
  });

  withDatabase((database) => {
    prepareRunnableProject(database);
    advance(database, "phase", "phase.foundation", "READY", "RUNNING");
    advance(database, "task", "task.foundation", "READY", "RUNNING", "VALIDATING", "COMPLETED");
    advance(database, "phase", "phase.product", "READY", "RUNNING");
    for (const taskId of ["task.alpha", "task.beta", "task.finish"]) {
      advance(database, "task", taskId, "READY", "RUNNING", "VALIDATING", "COMPLETED");
    }
    const complete = select(database);
    assert.equal(complete.status, "no_work");
    assert.equal(complete.reasons[0].code, "ALL_TASKS_COMPLETED");
    assert.equal(complete.reasons[0].classification, "complete");
  });
});

test("fails closed for missing gate evidence or stale persisted roadmap metadata", () => {
  withDatabase((database) => {
    prepareRunnableProject(database);
    advance(database, "phase", "phase.foundation", "READY");
    advance(database, "task", "task.foundation", "READY");
    const missingGates = new DependencyScheduler(database.repositories).selectNext({ projectId });
    assert.equal(missingGates.status, "no_work");
    assert.equal(missingGates.reasons[0].code, "GATE_SNAPSHOT_INVALID");
  });

  withDatabase(
    (database) => {
      prepareRunnableProject(database);
      const inconsistent = select(database);
      assert.equal(inconsistent.status, "no_work");
      assert.equal(inconsistent.reasons[0].code, "PERSISTED_ROADMAP_INCONSISTENT");
      assert.equal(inconsistent.reasons[0].taskId, "task.alpha");
    },
    { runtimeDependencyOverrides: { "task.alpha": [] } },
  );
});
