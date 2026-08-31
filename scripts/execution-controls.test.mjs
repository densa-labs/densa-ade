import assert from "node:assert/strict";
import { test } from "node:test";

import { ProjectExecutionControlService, StateTransitionService } from "@densa-ade/core";
import { DensaAdeDatabase } from "@densa-ade/core/persistence";

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
      branch: "densa-ade/run/project-controls",
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
    ignoredDensaAdeRuntimeArtifacts: [],
    densaAdeRun: {
      branchPrefix: "densa-ade/run/",
      currentBranchOwned: true,
      ownedBranches: ["densa-ade/run/project-controls"],
      hasOwnedRunBranch: true,
    },
    decision: {
      outcome: dirty ? "STOP" : "PROCEED",
      code,
      requiresUserDecision: dirty,
      reason: dirty ? "User changes are present" : "Existing Densa ADE run is safe",
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

test("a delayed pause finalization cannot overwrite a newer stop", async () => {
  const database = DensaAdeDatabase.openInMemory();
  const now = clock();
  const project = seed(database, now);
  let releasePause;
  let calls = 0;
  const service = new ProjectExecutionControlService(database, {
    now,
    workspaceProbe: {
      async inspect() {
        if (calls++ === 0)
          await new Promise((resolve) => {
            releasePause = resolve;
          });
        return { status: "available", snapshot: snapshot("same") };
      },
    },
  });
  const pause = service.pause(request(project));
  assert.equal((await service.stop(request(project))).status, "STOPPED");
  releasePause();
  await pause;
  assert.equal(
    database.repositories.projectSettings.findByProjectId(project.id).values.executionControl
      .status,
    "stopped",
  );
  database.close();
});

test("intervention context refreshes when dirty files change without a HEAD change", async () => {
  const database = DensaAdeDatabase.openInMemory();
  const now = clock();
  const project = seed(database, now);
  let current = "baseline";
  let path = "src/manual.ts";
  const service = new ProjectExecutionControlService(database, {
    now,
    workspaceProbe: {
      async inspect() {
        return { status: "available", snapshot: snapshot(current) };
      },
    },
    recoveryInspector: {
      async inspect() {
        return recovery("WORKSPACE_DIVERGED");
      },
    },
    preflight: {
      async inspect() {
        const result = preflight({ dirty: true });
        result.changes.unstaged = [{ path, status: "M", kind: "modified" }];
        return result;
      },
    },
  });
  await service.pause(request(project));
  current = "first-edit";
  await service.resume(request(project));
  current = "second-edit";
  path = "src/second.ts";
  const result = await service.resume(request(project));
  assert.equal(result.status, "INTERVENTION_REQUIRED");
  assert.deepEqual(result.recontextualization.changedPaths, ["src/second.ts"]);
  database.close();
});

test("resumed execution propagates the persisted intervention context", async () => {
  const database = DensaAdeDatabase.openInMemory();
  const now = clock();
  const project = seed(database, now);
  let current = snapshot("before");
  let received;
  const service = new ProjectExecutionControlService(database, {
    now,
    runner: {
      async execute(runRequest) {
        received = runRequest.recontextualization;
        return { status: "STOPPED", projectId: project.id, reason: "observed" };
      },
    },
    workspaceProbe: {
      async inspect() {
        return { status: "available", snapshot: current };
      },
    },
    preflight: {
      async inspect() {
        return preflight({ dirty: true });
      },
    },
    recoveryInspector: {
      async inspect() {
        return recovery("WORKSPACE_DIVERGED");
      },
    },
  });
  await service.pause(request(project));
  current = snapshot("after");
  await service.resume({ ...request(project), acknowledgeIntervention: true });
  await service.execute({
    ...request(project),
    gates: { outstandingUserDecisionIds: [], permissionBlockers: [] },
    taskExecutor: {},
    validator: {},
  });
  assert.equal(received.detectedAt.length > 0, true);
  assert.deepEqual(received.changedPaths, ["src/manual.ts"]);
  database.close();
});

test("graceful pause during a worker finishes the safe unit and stops before scheduling more", async () => {
  const database = DensaAdeDatabase.openInMemory();
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
  const database = DensaAdeDatabase.openInMemory();
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
  const database = DensaAdeDatabase.openInMemory();
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

test("stop remains available at the later usage-wait boundary", async () => {
  const database = DensaAdeDatabase.openInMemory();
  const now = clock();
  const project = seed(database, now);
  const current = database.repositories.projects.findById(project.id);
  database.persistStateTransition(
    new StateTransitionService().transitionProject(current, "WAITING_FOR_USAGE", {
      actor: "execution-control:test",
      occurredAt: now(),
      reason: "fixture usage wait",
    }),
    "event-project-usage-wait",
  );
  const service = new ProjectExecutionControlService(database, {
    now,
    workspaceProbe: {
      async inspect() {
        return { status: "available", snapshot: snapshot("usage-stop") };
      },
    },
  });
  const stopped = await service.stop(request(project));
  assert.equal(stopped.status, "STOPPED", JSON.stringify(stopped));
  assert.equal(database.repositories.projects.findById(project.id).state, "PAUSED");
  assert.equal((await service.resume(request(project))).status, "STOPPED");
  database.close();
});

test("resume checks recovery and workspace first, detects manual edits, then returns recontextualization", async () => {
  const database = DensaAdeDatabase.openInMemory();
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
  const database = DensaAdeDatabase.openInMemory();
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
  database.repositories.densaAdeRunBranches.createCreating({
    projectId: project.id,
    workspacePath,
    branchName: "densa-ade/run/project-controls",
    sourceBranch: "main",
    startingCommit: "a".repeat(40),
    createdAt: now(),
  });
  database.repositories.densaAdeRunBranches.activate(project.id, now());
  database.repositories.attemptRollbackPlans.create({
    attemptId: "attempt-controls",
    agentRunId: "agent-run-controls",
    projectId: project.id,
    taskId: task.id,
    workspacePath,
    branchName: "densa-ade/run/project-controls",
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
  const database = DensaAdeDatabase.openInMemory();
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
