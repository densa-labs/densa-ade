import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { StateTransitionService, UsageAutoResumeService } from "@densa/core";
import { DensaDatabase } from "@densa/core/persistence";

const workspacePath = "/tmp/densa-p7m1-workspace";
const startingTime = Date.parse("2026-08-29T04:00:00.000Z");

class FakeClock {
  #now = startingTime;
  #nextId = 1;
  #timers = new Map();

  now() {
    return this.#now;
  }

  set(milliseconds) {
    this.#now = milliseconds;
  }

  setTimeout(callback, delayMs) {
    const id = this.#nextId++;
    this.#timers.set(id, { callback, dueAt: this.#now + delayMs });
    return id;
  }

  clearTimeout(id) {
    this.#timers.delete(id);
  }

  get pendingCount() {
    return this.#timers.size;
  }
}

function iso(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function transition(database, entity, state, occurredAt, sequence) {
  const transitions = new StateTransitionService();
  const current =
    "executionMode" in entity
      ? database.repositories.projects.findById(entity.id)
      : "acceptanceCriteria" in entity
        ? database.repositories.tasks.findById(entity.id)
        : database.repositories.phases.findById(entity.id);
  const change =
    "executionMode" in entity
      ? transitions.transitionProject(current, state, {
          actor: "usage-auto-resume:test",
          occurredAt,
        })
      : "acceptanceCriteria" in entity
        ? transitions.transitionTask(current, state, {
            actor: "usage-auto-resume:test",
            occurredAt,
          })
        : transitions.transitionPhase(current, state, {
            actor: "usage-auto-resume:test",
            occurredAt,
          });
  database.persistStateTransition(change, `usage-auto-resume-seed-${sequence}`);
}

function seedWaiting(database, clock, resetAt) {
  let sequence = 0;
  const tick = () => iso(clock.now() + sequence++ * 10);
  const createdAt = tick();
  const project = {
    id: "project-usage-auto-resume",
    name: "Usage auto-resume proof",
    state: "DRAFT",
    executionMode: "continuous",
    createdAt,
    updatedAt: createdAt,
  };
  const phase = {
    id: "phase-usage-auto-resume",
    projectId: project.id,
    title: "Resume usage",
    state: "PENDING",
    position: 0,
    createdAt,
    updatedAt: createdAt,
  };
  const task = {
    id: "task-usage-auto-resume",
    projectId: project.id,
    phaseId: phase.id,
    title: "Resume rolled-back task",
    state: "PENDING",
    position: 0,
    acceptanceCriteria: ["Usage resumes conservatively."],
    dependencyIds: [],
    createdAt,
    updatedAt: createdAt,
  };
  database.repositories.projects.create(project);
  database.repositories.phases.create(phase);
  database.repositories.tasks.create(task);
  transition(database, project, "PLANNING", tick(), sequence++);
  transition(database, project, "READY", tick(), sequence++);
  transition(database, project, "RUNNING", tick(), sequence++);
  transition(database, phase, "READY", tick(), sequence++);
  transition(database, phase, "RUNNING", tick(), sequence++);
  transition(database, task, "READY", tick(), sequence++);
  transition(database, task, "RUNNING", tick(), sequence++);

  database.repositories.attempts.create({
    id: "attempt-usage-auto-resume",
    taskId: task.id,
    number: 1,
    startedAt: tick(),
  });
  database.repositories.agentRuns.create({
    id: "run-usage-auto-resume",
    attemptId: "attempt-usage-auto-resume",
    adapterId: "fake",
    adapterRunId: "fake-usage-run",
    startedAt: tick(),
  });
  database.repositories.densaRunBranches.createCreating({
    projectId: project.id,
    workspacePath,
    branchName: "densa/run/project-usage-auto-resume",
    sourceBranch: "main",
    startingCommit: "a".repeat(40),
    createdAt: tick(),
  });
  database.repositories.densaRunBranches.activate(project.id, tick());
  database.repositories.attemptRollbackPlans.create({
    attemptId: "attempt-usage-auto-resume",
    agentRunId: "run-usage-auto-resume",
    projectId: project.id,
    taskId: task.id,
    workspacePath,
    branchName: "densa/run/project-usage-auto-resume",
    checkpointHead: "a".repeat(40),
    ownedPaths: [
      {
        path: "src/usage-task.ts",
        kind: "FILE",
        contentHash: "b".repeat(64),
        indexHash: "c".repeat(64),
        temporary: false,
      },
    ],
    recordedAt: tick(),
  });
  database.repositories.attemptRollbackPlans.recordFailure(
    "attempt-usage-auto-resume",
    { kind: "usage_limited" },
    tick(),
  );
  database.repositories.attemptRollbackPlans.recordApplied("attempt-usage-auto-resume", tick());
  database.repositories.agentRuns.recordCompleted("run-usage-auto-resume", tick());
  database.repositories.attempts.recordCompleted("attempt-usage-auto-resume", tick());
  transition(database, task, "INTERRUPTED", tick(), sequence++);
  transition(database, task, "WAITING_FOR_USAGE", tick(), sequence++);
  transition(database, project, "WAITING_FOR_USAGE", tick(), sequence++);
  database.repositories.events.append({
    id: "usage-auto-resume-seed-limit",
    projectId: project.id,
    phaseId: phase.id,
    taskId: task.id,
    type: "USAGE_LIMIT_REACHED",
    eventVersion: 1,
    occurredAt: tick(),
    actor: "usage-auto-resume:test",
    payload: {
      attemptId: "attempt-usage-auto-resume",
      agentRunId: "run-usage-auto-resume",
      usageState: resetAt === undefined ? { status: "limited" } : { status: "limited", resetAt },
    },
  });
  return { project, phase, task };
}

function safePreflight() {
  return {
    schemaVersion: 1,
    workspacePath,
    repository: { isGitRepository: true, isWorkTree: true, isBare: false, root: workspacePath },
    head: {
      commit: "a".repeat(40),
      branch: "densa/run/project-usage-auto-resume",
      detached: false,
      unborn: false,
    },
    changes: { staged: [], unstaged: [], untracked: [], dirty: false },
    operations: { merge: false, rebase: false, cherryPick: false, active: [] },
    ignoredDensaRuntimeArtifacts: [],
    densaRun: {
      branchPrefix: "densa/run/",
      currentBranchOwned: true,
      ownedBranches: ["densa/run/project-usage-auto-resume"],
      hasOwnedRunBranch: true,
    },
    decision: {
      outcome: "PROCEED",
      code: "EXISTING_DENSA_RUN",
      requiresUserDecision: false,
      reason: "Existing Densa run is safe",
    },
    automaticActionsPerformed: false,
  };
}

function recovery(classification = "CLEANLY_IDLE") {
  return {
    classification,
    reason:
      classification === "CLEANLY_IDLE"
        ? "Workspace matches the checkpoint"
        : "Workspace differs from the checkpoint",
    actions: classification === "CLEANLY_IDLE" ? ["NONE"] : ["RECONCILE_WORKSPACE"],
    automaticActionsPerformed: false,
  };
}

function service(database, clock, usageStates, overrides = {}) {
  let usageCalls = 0;
  const instance = new UsageAutoResumeService(database, {
    clock,
    initialBackoffMs: 1_000,
    maxBackoffMs: 8_000,
    maxProbeAttempts: 4,
    usageProbe: {
      async getUsageState() {
        const value = usageStates[Math.min(usageCalls, usageStates.length - 1)];
        usageCalls += 1;
        return value;
      },
    },
    gateProvider: {
      async inspect() {
        return { outstandingUserDecisionIds: [], permissionBlockers: [] };
      },
    },
    preflight: {
      async inspect() {
        return safePreflight();
      },
    },
    recoveryInspector: {
      async inspect() {
        return recovery();
      },
    },
    ...overrides,
  });
  return { instance, usageCalls: () => usageCalls };
}

function enable(instance, project) {
  return instance.enable({
    projectId: project.id,
    workspacePath,
    actor: "usage-auto-resume:test",
  });
}

test("fake clock proves bounded exponential backoff when resetAt is unknown", async () => {
  const database = DensaDatabase.openInMemory();
  const clock = new FakeClock();
  const { project } = seedWaiting(database, clock);
  const { instance, usageCalls } = service(database, clock, [
    { status: "limited" },
    { status: "unknown", reason: "No reliable signal" },
  ]);

  const initial = enable(instance, project);
  assert.equal(initial.status, "SCHEDULED");
  assert.equal(initial.nextProbeAt, iso(startingTime + 1_000));
  assert.equal((await instance.probe(project.id)).status, "SCHEDULED");
  assert.equal(usageCalls(), 0);

  clock.set(startingTime + 1_000);
  const first = await instance.probe(project.id);
  assert.equal(first.nextProbeAt, iso(startingTime + 3_000));
  assert.equal(first.probeAttempt, 1);

  clock.set(startingTime + 3_000);
  const second = await instance.probe(project.id);
  assert.equal(second.nextProbeAt, iso(startingTime + 7_000));
  assert.equal(second.probeAttempt, 2);

  clock.set(startingTime + 7_000);
  const third = await instance.probe(project.id);
  assert.equal(third.nextProbeAt, iso(startingTime + 15_000));
  assert.equal(third.probeAttempt, 3);
  clock.set(startingTime + 15_000);
  const exhausted = await instance.probe(project.id);
  assert.equal(exhausted.status, "BLOCKED");
  assert.match(exhausted.reason, /after 4 conservative probes/u);
  assert.equal(usageCalls(), 4);
  assert.equal(clock.pendingCount, 0);
  assert.equal(database.repositories.projects.findById(project.id).state, "WAITING_FOR_USAGE");
  instance.dispose();
  database.close();
});

test("reset time only permits verification; elapsed time alone never resumes the project", async () => {
  const database = DensaDatabase.openInMemory();
  const clock = new FakeClock();
  const resetAt = iso(startingTime + 10_000);
  const { project, task } = seedWaiting(database, clock, resetAt);
  let continued = 0;
  const { instance, usageCalls } = service(
    database,
    clock,
    [{ status: "limited" }, { status: "available" }],
    { onResumed: () => (continued += 1) },
  );

  assert.equal(enable(instance, project).nextProbeAt, resetAt);
  clock.set(startingTime + 9_999);
  assert.equal((await instance.probe(project.id)).status, "SCHEDULED");
  assert.equal(usageCalls(), 0);

  clock.set(startingTime + 10_000);
  const stillLimited = await instance.probe(project.id);
  assert.equal(stillLimited.status, "SCHEDULED");
  assert.equal(database.repositories.projects.findById(project.id).state, "WAITING_FOR_USAGE");

  clock.set(Date.parse(stillLimited.nextProbeAt));
  const resumed = await instance.probe(project.id);
  assert.equal(resumed.status, "RESUMED");
  assert.equal(database.repositories.projects.findById(project.id).state, "RUNNING");
  assert.equal(database.repositories.tasks.findById(task.id).state, "RETRYING");
  assert.equal(continued, 1);
  const events = database.eventJournal.replay({ projectId: project.id, limit: 1_000 });
  assert.equal(events.filter((event) => event.type === "PROJECT_RESUMED").length, 1);
  assert.equal(events.filter((event) => event.type === "USAGE_AVAILABILITY_CONFIRMED").length, 1);
  instance.dispose();
  database.close();
});

test("workspace divergence blocks auto-resume before the backend is probed", async () => {
  const database = DensaDatabase.openInMemory();
  const clock = new FakeClock();
  const { project } = seedWaiting(database, clock);
  const { instance, usageCalls } = service(database, clock, [{ status: "available" }], {
    recoveryInspector: {
      async inspect() {
        return recovery("WORKSPACE_DIVERGED");
      },
    },
  });
  enable(instance, project);
  clock.set(startingTime + 1_000);

  const blocked = await instance.probe(project.id);
  assert.equal(blocked.status, "BLOCKED");
  assert.match(blocked.reason, /Workspace recovery blocked/u);
  assert.equal(usageCalls(), 0);
  assert.equal(clock.pendingCount, 0);
  assert.equal(database.repositories.projects.findById(project.id).state, "WAITING_FOR_USAGE");
  assert.equal(instance.restore(project.id).status, "BLOCKED");
  database.close();
});

test("mandatory user decisions block auto-resume before usage availability is trusted", async () => {
  const database = DensaDatabase.openInMemory();
  const clock = new FakeClock();
  const { project } = seedWaiting(database, clock);
  const { instance, usageCalls } = service(database, clock, [{ status: "available" }], {
    gateProvider: {
      async inspect() {
        return { outstandingUserDecisionIds: ["decision-security"], permissionBlockers: [] };
      },
    },
  });
  enable(instance, project);
  clock.set(startingTime + 1_000);

  const blocked = await instance.probe(project.id);
  assert.equal(blocked.status, "BLOCKED");
  assert.match(blocked.reason, /decision-security/u);
  assert.equal(usageCalls(), 0);
  database.close();
});

test("restart restores the exact durable schedule and resumes from the rolled-back boundary", async () => {
  const directory = mkdtempSync(join(tmpdir(), "densa-p7m1-restart-"));
  const databasePath = join(directory, "runtime.sqlite");
  const clock = new FakeClock();
  let database;
  try {
    database = DensaDatabase.open(databasePath);
    const { project, task } = seedWaiting(database, clock);
    const first = service(database, clock, [{ status: "available" }]);
    const scheduled = enable(first.instance, project);
    assert.equal(clock.pendingCount, 1);
    first.instance.dispose();
    database.close();
    database = undefined;
    assert.equal(clock.pendingCount, 0);

    database = DensaDatabase.open(databasePath);
    const second = service(database, clock, [{ status: "available" }]);
    const restored = second.instance.restore(project.id);
    assert.equal(restored.nextProbeAt, scheduled.nextProbeAt);
    assert.equal(restored.probeAttempt, 0);
    assert.equal(clock.pendingCount, 1);

    clock.set(Date.parse(restored.nextProbeAt));
    assert.equal((await second.instance.probe(project.id)).status, "RESUMED");
    assert.equal(database.repositories.projects.findById(project.id).state, "RUNNING");
    assert.equal(database.repositories.tasks.findById(task.id).state, "RETRYING");
    second.instance.dispose();
  } finally {
    database?.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("cancellation and disable durably stop all future probes", async () => {
  const database = DensaDatabase.openInMemory();
  const clock = new FakeClock();
  const { project } = seedWaiting(database, clock);
  const { instance, usageCalls } = service(database, clock, [{ status: "available" }]);
  enable(instance, project);
  assert.equal(instance.cancel(project.id, "usage-auto-resume:test").status, "CANCELLED");
  assert.equal(clock.pendingCount, 0);
  assert.equal(instance.restore(project.id).status, "CANCELLED");

  enable(instance, project);
  assert.equal(clock.pendingCount, 1);
  assert.equal(instance.disable(project.id, "usage-auto-resume:test").status, "DISABLED");
  clock.set(startingTime + 60_000);
  assert.equal((await instance.probe(project.id)).status, "DISABLED");
  assert.equal(instance.restore(project.id).status, "DISABLED");
  assert.equal(usageCalls(), 0);
  assert.equal(clock.pendingCount, 0);
  database.close();
});

test("cancelling an in-flight backend check prevents a late available result from resuming", async () => {
  const database = DensaDatabase.openInMemory();
  const clock = new FakeClock();
  const { project } = seedWaiting(database, clock);
  let releaseUsage;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const usageResult = new Promise((resolve) => {
    releaseUsage = resolve;
  });
  const { instance } = service(database, clock, [{ status: "available" }], {
    usageProbe: {
      async getUsageState() {
        markStarted();
        return await usageResult;
      },
    },
  });
  enable(instance, project);
  clock.set(startingTime + 1_000);
  const probing = instance.probe(project.id);
  await started;
  assert.equal(instance.cancel(project.id, "usage-auto-resume:test").status, "CANCELLED");
  releaseUsage({ status: "available" });

  assert.equal((await probing).status, "CANCELLED");
  assert.equal(database.repositories.projects.findById(project.id).state, "WAITING_FOR_USAGE");
  assert.equal(
    database.eventJournal.replay({ projectId: project.id, types: ["PROJECT_RESUMED"] }).length,
    0,
  );
  database.close();
});
