import assert from "node:assert/strict";
import { test } from "node:test";

import {
  InvalidStateTransitionError,
  StateTransitionService,
} from "../packages/core/dist/index.js";
import {
  eventSchema,
  phaseSchema,
  phaseStateSchema,
  projectSchema,
  projectStateSchema,
  taskSchema,
  taskStateSchema,
} from "../packages/protocol/dist/index.js";

const createdAt = "2026-08-26T01:00:00.000Z";
const occurredAt = "2026-08-26T02:00:00.000Z";
const context = {
  actor: "densa-core:test",
  occurredAt,
  reason: "exercise the declared lifecycle edge",
};

const expectedProjectTransitions = {
  DRAFT: ["PLANNING"],
  PLANNING: ["READY", "WAITING_FOR_USER", "BLOCKED", "FAILED"],
  READY: ["RUNNING", "PAUSED", "WAITING_FOR_USER", "WAITING_FOR_USAGE", "BLOCKED", "FAILED"],
  RUNNING: ["PAUSED", "WAITING_FOR_USER", "WAITING_FOR_USAGE", "BLOCKED", "COMPLETED", "FAILED"],
  PAUSED: ["READY", "RUNNING", "BLOCKED", "FAILED"],
  WAITING_FOR_USER: ["PLANNING", "READY", "RUNNING", "PAUSED", "BLOCKED", "FAILED"],
  WAITING_FOR_USAGE: ["READY", "RUNNING", "PAUSED", "BLOCKED", "FAILED"],
  BLOCKED: ["PLANNING", "READY", "RUNNING", "PAUSED", "FAILED"],
  COMPLETED: [],
  FAILED: [],
};

const expectedPhaseTransitions = {
  PENDING: ["READY", "BLOCKED"],
  READY: ["RUNNING", "BLOCKED"],
  RUNNING: ["VALIDATING", "BLOCKED"],
  VALIDATING: ["RUNNING", "AWAITING_APPROVAL", "COMPLETED", "BLOCKED"],
  AWAITING_APPROVAL: ["RUNNING", "COMPLETED", "BLOCKED"],
  COMPLETED: [],
  BLOCKED: ["PENDING", "READY", "RUNNING", "VALIDATING", "AWAITING_APPROVAL"],
};

const expectedTaskTransitions = {
  PENDING: ["READY", "BLOCKED", "CANCELLED"],
  READY: ["RUNNING", "WAITING_FOR_USER", "WAITING_FOR_USAGE", "BLOCKED", "CANCELLED"],
  RUNNING: [
    "VALIDATING",
    "RETRYING",
    "WAITING_FOR_USER",
    "WAITING_FOR_USAGE",
    "BLOCKED",
    "INTERRUPTED",
    "CANCELLED",
  ],
  VALIDATING: [
    "COMPLETED",
    "RETRYING",
    "WAITING_FOR_USER",
    "WAITING_FOR_USAGE",
    "BLOCKED",
    "INTERRUPTED",
    "CANCELLED",
  ],
  RETRYING: [
    "RUNNING",
    "WAITING_FOR_USER",
    "WAITING_FOR_USAGE",
    "BLOCKED",
    "INTERRUPTED",
    "CANCELLED",
  ],
  WAITING_FOR_USER: ["READY", "RUNNING", "VALIDATING", "RETRYING", "BLOCKED", "CANCELLED"],
  WAITING_FOR_USAGE: [
    "READY",
    "RUNNING",
    "VALIDATING",
    "RETRYING",
    "BLOCKED",
    "INTERRUPTED",
    "CANCELLED",
  ],
  BLOCKED: ["PENDING", "READY", "RUNNING", "VALIDATING", "RETRYING", "CANCELLED"],
  INTERRUPTED: ["READY", "RETRYING", "WAITING_FOR_USAGE", "BLOCKED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

function makeProject(state) {
  return projectSchema.parse({
    id: "project-state-machine",
    name: "State machine test",
    state,
    executionMode: "guided",
    createdAt,
    updatedAt: createdAt,
  });
}

function makePhase(state) {
  return phaseSchema.parse({
    id: "phase-state-machine",
    projectId: "project-state-machine",
    title: "State machine phase",
    state,
    position: 0,
    createdAt,
    updatedAt: createdAt,
  });
}

function makeTask(state) {
  return taskSchema.parse({
    id: "task-state-machine",
    projectId: "project-state-machine",
    phaseId: "phase-state-machine",
    title: "State machine task",
    state,
    position: 0,
    acceptanceCriteria: ["The transition is explicit"],
    dependencyIds: [],
    createdAt,
    updatedAt: createdAt,
  });
}

function assertTransitionMatrix({ states, expected, makeEntity, canTransition, transition }) {
  for (const previousState of states) {
    for (const requestedState of states) {
      const allowed = expected[previousState].includes(requestedState);
      assert.equal(
        canTransition(previousState, requestedState),
        allowed,
        `${previousState} -> ${requestedState}`,
      );

      const entity = makeEntity(previousState);
      if (allowed) {
        const result = transition(entity, requestedState);
        assert.equal(result.previousState, previousState);
        assert.equal(result.state, requestedState);
        assert.equal(result.entity.state, requestedState);
        assert.equal(result.entity.updatedAt, occurredAt);
        assert.equal(entity.state, previousState, "the input snapshot must not be mutated");
        assert.equal(result.event.payload.previousState, previousState);
        assert.equal(result.event.payload.state, requestedState);
        assert.equal(result.event.occurredAt, occurredAt);
        assert.equal(result.event.actor, context.actor);
        assert.equal(
          eventSchema.safeParse({ id: "event-transition-matrix", ...result.event }).success,
          true,
        );
      } else {
        assert.throws(
          () => transition(entity, requestedState),
          (error) => {
            assert.ok(error instanceof InvalidStateTransitionError);
            assert.equal(error.code, "INVALID_STATE_TRANSITION");
            assert.equal(error.previousState, previousState);
            assert.equal(error.requestedState, requestedState);
            return true;
          },
          `${previousState} -> ${requestedState} must be rejected`,
        );
      }
    }
  }
}

test("project transition matrix exhaustively accepts only declared lifecycle edges", () => {
  const service = new StateTransitionService();
  assertTransitionMatrix({
    states: projectStateSchema.options,
    expected: expectedProjectTransitions,
    makeEntity: makeProject,
    canTransition: (from, to) => service.canTransitionProject(from, to),
    transition: (entity, to) => service.transitionProject(entity, to, context),
  });
});

test("phase transition matrix exhaustively accepts only declared lifecycle edges", () => {
  const service = new StateTransitionService();
  assertTransitionMatrix({
    states: phaseStateSchema.options,
    expected: expectedPhaseTransitions,
    makeEntity: makePhase,
    canTransition: (from, to) => service.canTransitionPhase(from, to),
    transition: (entity, to) => service.transitionPhase(entity, to, context),
  });
});

test("task transition matrix exhaustively accepts only declared lifecycle edges", () => {
  const service = new StateTransitionService();
  assertTransitionMatrix({
    states: taskStateSchema.options,
    expected: expectedTaskTransitions,
    makeEntity: makeTask,
    canTransition: (from, to) => service.canTransitionTask(from, to),
    transition: (entity, to) => service.transitionTask(entity, to, context),
  });
});

test("accepted transition returns immutable, append-ready audit facts", () => {
  const service = new StateTransitionService();
  const result = service.transitionTask(makeTask("RUNNING"), "INTERRUPTED", context);

  assert.deepEqual(result.event, {
    projectId: "project-state-machine",
    phaseId: "phase-state-machine",
    taskId: "task-state-machine",
    type: "TASK_STATE_CHANGED",
    eventVersion: 1,
    occurredAt,
    actor: "densa-core:test",
    payload: {
      previousState: "RUNNING",
      state: "INTERRUPTED",
      reason: "exercise the declared lifecycle edge",
    },
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.entity), true);
  assert.equal(Object.isFrozen(result.event), true);
  assert.equal(Object.isFrozen(result.event.payload), true);
  assert.equal(eventSchema.safeParse({ id: "event-state-machine", ...result.event }).success, true);
});

test("illegal PENDING -> COMPLETED jumps carry stable entity diagnostics", () => {
  const service = new StateTransitionService();

  assert.throws(
    () => service.transitionTask(makeTask("PENDING"), "COMPLETED", context),
    (error) => {
      assert.ok(error instanceof InvalidStateTransitionError);
      assert.equal(error.code, "INVALID_STATE_TRANSITION");
      assert.equal(error.entityType, "task");
      assert.equal(error.entityId, "task-state-machine");
      assert.match(error.message, /PENDING to COMPLETED/u);
      return true;
    },
  );
});
