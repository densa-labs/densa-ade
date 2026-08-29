import assert from "node:assert/strict";
import { test } from "node:test";

import { ProjectExecutionControlService, StateTransitionService } from "@densa/core";
import { DensaDatabase } from "@densa/core/persistence";

const workspacePath = "/tmp/densa-p5m5-workspace";
const baseTime = Date.parse("2026-08-27T14:00:00.000Z");

function clock() {
  let tick = 0;
  return () => new Date(baseTime + tick++ * 1_000).toISOString();
}

function transition(database, project, state, occurredAt) {
  const current = database.repositories.projects.findById(project.id);
  database.persistStateTransition(
    new StateTransitionService().transitionProject(current, state, {
      actor: "execution-control:test",
      occurredAt,
    }),
    `event-project-${state.toLowerCase()}-${occurredAt}`,
  );
}

function seed(database, now) {
  const createdAt = now();
  const project = {
    id: "project-controls",
    name: "Execution controls proof",
    state: "DRAFT",
    executionMode: "continuous",
    createdAt,
    updatedAt: createdAt,
  };
  database.repositories.projects.create(project);
  transition(database, project, "PLANNING", now());
  transition(database, project, "READY", now());
  transition(database, project, "RUNNING", now());
  return project;
}

function snapshot(fingerprint, gitHead = "a".repeat(40), gitStatus = "") {
  return { gitHead, gitStatus, fingerprint };
}

function preflight({
  dirty = false,
  code = dirty ? "USER_CHANGES_PRESENT" : "EXISTING_DENSA_RUN",
  commit = "a".repeat(40),
} = {}) {
  return {
    schemaVersion: 1,
    workspacePath,
    repository: { isGitRepository: true, isWorkTree: true, isBare: false, root: workspacePath },
    head: {
      commit,
      branch: "densa/run/project-controls",
      detached: false,
      unborn: false,
    },
    changes: {
      staged: [],
      unstaged: dirty ? [{ path: "src/manual.ts", status: "M", kind: "modified" }] : [],
      untracked: [],
      dirty,
    },
    operations: { merge: false, rebase: false, cherryPick: false, active: [] },
    ignoredDensaRuntimeArtifacts: [],
    densaRun: {
      branchPrefix: "densa/run/",
      currentBranchOwned: true,
      ownedBranches: ["densa/run/project-controls"],
      hasOwnedRunBranch: true,
    },
    decision: {
      outcome: dirty ? "STOP" : "PROCEED",
      code,
      requiresUserDecision: dirty,
      reason: dirty ? "User changes are present" : "Existing Densa run is safe",
    },
    automaticActionsPerformed: false,
  };
}

function recovery(classification = "CLEANLY_IDLE") {
  return {
    classification,
    reason: classification === "CLEANLY_IDLE" ? "Idle" : "Workspace changed",
    actions: classification === "CLEANLY_IDLE" ? ["NONE"] : ["RECONCILE_WORKSPACE"],
    automaticActionsPerformed: false,
  };
}

function request(project) {
  return {
    projectId: project.id,
    workspacePath,
    actor: "execution-control:test",
  };
}

test("graceful pause during a worker finishes the safe unit and stops before scheduling more", async () => {
  const database = DensaDatabase.openInMemory();
  const now = clock();
  const project = seed(database, now);
  let releaseWorker;
  let startedWorker;
  const workerStarted = new Promise((resolve) => {
    startedWorker = resolve;
  });
  const workerReleased = new Promise((resolve) => {
    releaseWorker = resolve;
  });
  let completedSafeUnits = 0;
  const runner = {
    async execute(runRequest) {
      startedWorker();
      await workerReleased;
      completedSafeUnits += 1;
      assert.equal(runRequest.controlBoundary(), "pause");
      return { status: "STOPPED", projectId: project.id, reason: "safe boundary" };
    },
  };
  const service = new ProjectExecutionControlService(database, {
    now,
    runner,
    workspaceProbe: {
      async inspect() {
        return { status: "available", snapshot: snapshot("pause") };
      },
    },
  });

  const execution = service.execute({
    ...request(project),
    gates: { outstandingUserDecisionIds: [], permissionBlockers: [] },
    taskExecutor: {
      async execute() {
        throw new Error("runner owns this fixture");
      },
    },
    validator: {
      validatorId: "fixture",
      async validate() {
        throw new Error("unused");
      },
    },
  });
  await workerStarted;
  assert.equal((await service.pause(request(project))).status, "REQUESTED");
  assert.equal(completedSafeUnits, 0);
  releaseWorker();

  assert.equal((await execution).status, "PAUSED");
  assert.equal(completedSafeUnits, 1);
  assert.equal(database.repositories.projects.findById(project.id).state, "PAUSED");
  assert.equal((await service.pause(request(project))).status, "UNCHANGED");
  database.close();
});

test("immediate cancel aborts the active worker and leaves no live fake worker", async () => {
  const database = DensaDatabase.openInMemory();
  const now = clock();
  const project = seed(database, now);
  let startedWorker;
  const workerStarted = new Promise((resolve) => {
    startedWorker = resolve;
  });
  let activeWorkers = 0;
  const runner = {
    async execute(runRequest) {
      activeWorkers += 1;
      startedWorker();
      await new Promise((resolve) =>
        runRequest.signal.addEventListener("abort", resolve, { once: true }),
      );
      activeWorkers -= 1;
      return { status: "STOPPED", projectId: project.id, reason: "worker interrupted" };
    },
  };
  const service = new ProjectExecutionControlService(database, {
    now,
    runner,
    workspaceProbe: {
      async inspect() {
        return { status: "available", snapshot: snapshot("cancel") };
      },
    },
  });
  const execution = service.execute({
    ...request(project),
    gates: { outstandingUserDecisionIds: [], permissionBlockers: [] },
    taskExecutor: {
      async execute() {
        throw new Error("unused");
      },
    },
    validator: {
      validatorId: "fixture",
      async validate() {
        throw new Error("unused");
      },
    },
  });
  await workerStarted;
  assert.equal(activeWorkers, 1);
  assert.equal((await service.cancelCurrentAgent(request(project))).status, "REQUESTED");
  assert.equal((await execution).status, "PAUSED");
  assert.equal(activeWorkers, 0);
  database.close();
});

test("pause between tasks and stop are immediate, durable, idempotent, and preserve work", async () => {
  const database = DensaDatabase.openInMemory();
  const now = clock();
  const project = seed(database, now);
  const keepAwakeReleases = [];
  const service = new ProjectExecutionControlService(database, {
    now,
    keepAwake: {
      async releaseProject(releasedProjectId, actor) {
        keepAwakeReleases.push({ projectId: releasedProjectId, actor });
      },
    },
    workspaceProbe: {
      async inspect() {
        return { status: "available", snapshot: snapshot("idle") };
      },
    },
  });

  assert.equal((await service.pause(request(project))).status, "PAUSED");
  assert.equal((await service.pause(request(project))).status, "UNCHANGED");
  assert.equal((await service.stop(request(project))).status, "STOPPED");
  assert.equal((await service.stop(request(project))).status, "UNCHANGED");
  const events = database.eventJournal.replay({ projectId: project.id, limit: 1_000 });
  assert.equal(events.filter((event) => event.type === "PROJECT_PAUSED").length, 1);
  assert.equal(events.filter((event) => event.type === "PROJECT_STOPPED").length, 1);
  assert.equal(events.find((event) => event.type === "PROJECT_STOPPED").payload.workDeleted, false);
  assert.deepEqual(keepAwakeReleases, [{ projectId: project.id, actor: "execution-control:test" }]);
  database.close();
});

test("resume checks recovery and workspace first, detects manual edits, then returns recontextualization", async () => {
  const database = DensaDatabase.openInMemory();
  const now = clock();
  const project = seed(database, now);
  let currentSnapshot = snapshot("before");
  let preflightCalls = 0;
  let recoveryCalls = 0;
  const service = new ProjectExecutionControlService(database, {
    now,
    workspaceProbe: {
      async inspect() {
        return { status: "available", snapshot: currentSnapshot };
      },
    },
    preflight: {
      async inspect() {
        preflightCalls += 1;
        return preflight({ dirty: true, commit: "b".repeat(40) });
      },
    },
    recoveryInspector: {
      async inspect() {
        recoveryCalls += 1;
        return recovery("WORKSPACE_DIVERGED");
      },
    },
  });
  assert.equal((await service.pause(request(project))).status, "PAUSED");
  currentSnapshot = snapshot("after", "b".repeat(40), " M src/manual.ts\n");

  const detected = await service.resume(request(project));
  assert.equal(detected.status, "INTERVENTION_REQUIRED");
  assert.deepEqual(detected.recontextualization.changedPaths, ["src/manual.ts"]);
  assert.equal(database.repositories.projects.findById(project.id).state, "PAUSED");

  const detectedAgain = await service.resume(request(project));
  assert.deepEqual(detectedAgain, detected);
  assert.equal(
    database.eventJournal.replay({ projectId: project.id, types: ["HUMAN_INTERVENTION_DETECTED"] })
      .length,
    1,
  );

  const resumed = await service.resume({ ...request(project), acknowledgeIntervention: true });
  assert.equal(resumed.status, "RESUMED");
  assert.deepEqual(resumed.recontextualization.changedPaths, ["src/manual.ts"]);
  assert.equal(database.repositories.projects.findById(project.id).state, "RUNNING");
  assert.equal(preflightCalls, 3);
  assert.equal(recoveryCalls, 3);
  database.close();
});

test("resume explicitly reconciles a confirmed interrupted task to RETRYING", async () => {
  const database = DensaDatabase.openInMemory();
  const now = clock();
  const project = seed(database, now);
  const createdAt = now();
  const phase = {
    id: "phase-controls",
    projectId: project.id,
    title: "Controlled phase",
    state: "PENDING",
    position: 0,
    createdAt,
    updatedAt: createdAt,
  };
  const task = {
    id: "task-controls",
    projectId: project.id,
    phaseId: phase.id,
    title: "Interrupted task",
    state: "PENDING",
    position: 0,
    acceptanceCriteria: ["The task can resume safely."],
    dependencyIds: [],
    createdAt,
    updatedAt: createdAt,
  };
  database.repositories.phases.create(phase);
  database.repositories.tasks.create(task);
  const transitions = new StateTransitionService();
  let currentTask = task;
  for (const state of ["READY", "RUNNING", "INTERRUPTED"]) {
    const occurredAt = now();
    database.persistStateTransition(
      transitions.transitionTask(currentTask, state, {
        actor: "execution-control:test",
        occurredAt,
      }),
      `event-task-${state.toLowerCase()}`,
    );
    currentTask = database.repositories.tasks.findById(task.id);
  }
  database.repositories.attempts.create({
    id: "attempt-controls",
    taskId: task.id,
    number: 1,
    startedAt: now(),
  });
  database.repositories.agentRuns.create({
    id: "agent-run-controls",
    attemptId: "attempt-controls",
    adapterId: "fake",
    adapterRunId: "agent-run-controls",
    startedAt: now(),
  });
  database.repositories.densaRunBranches.createCreating({
    projectId: project.id,
    workspacePath,
    branchName: "densa/run/project-controls",
    sourceBranch: "main",
    startingCommit: "a".repeat(40),
    createdAt: now(),
  });
  database.repositories.densaRunBranches.activate(project.id, now());
  database.repositories.attemptRollbackPlans.create({
    attemptId: "attempt-controls",
    agentRunId: "agent-run-controls",
    projectId: project.id,
    taskId: task.id,
    workspacePath,
    branchName: "densa/run/project-controls",
    checkpointHead: "a".repeat(40),
    ownedPaths: [
      {
        path: "task.txt",
        kind: "FILE",
        contentHash: "c".repeat(64),
        indexHash: "d".repeat(64),
        temporary: false,
      },
    ],
    recordedAt: now(),
  });
  database.repositories.attemptRollbackPlans.recordFailure(
    "attempt-controls",
    { kind: "cancellation" },
    now(),
  );
  database.repositories.attemptRollbackPlans.recordApplied("attempt-controls", now());
  database.repositories.agentRuns.recordCompleted("agent-run-controls", now());
  database.repositories.attempts.recordCompleted("attempt-controls", now());

  const service = new ProjectExecutionControlService(database, {
    now,
    workspaceProbe: {
      async inspect() {
        return { status: "available", snapshot: snapshot("interrupted") };
      },
    },
    preflight: {
      async inspect() {
        return preflight();
      },
    },
    recoveryInspector: {
      async inspect() {
        return {
          classification: "UNKNOWN",
          reason: "An INTERRUPTED task still requires an explicit recovery decision",
          actions: ["REQUEST_USER_INSPECTION"],
          automaticActionsPerformed: false,
        };
      },
    },
  });
  assert.equal((await service.pause(request(project))).status, "PAUSED");
  assert.equal((await service.resume(request(project))).status, "RESUMED");
  assert.equal(database.repositories.tasks.findById(task.id).state, "RETRYING");
  database.close();
});

test("even a stopped resume runs both safety inspections before it is rejected", async () => {
  const database = DensaDatabase.openInMemory();
  const now = clock();
  const project = seed(database, now);
  let preflightCalls = 0;
  let recoveryCalls = 0;
  const service = new ProjectExecutionControlService(database, {
    now,
    workspaceProbe: {
      async inspect() {
        return { status: "available", snapshot: snapshot("stop") };
      },
    },
    preflight: {
      async inspect() {
        preflightCalls += 1;
        return preflight();
      },
    },
    recoveryInspector: {
      async inspect() {
        recoveryCalls += 1;
        return recovery();
      },
    },
  });
  assert.equal((await service.stop(request(project))).status, "STOPPED");
  assert.equal((await service.resume(request(project))).status, "STOPPED");
  assert.equal(preflightCalls, 1);
  assert.equal(recoveryCalls, 1);
  database.close();
});
