import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";

import {
  GitWorkspaceProbe,
  NodeProcessProbe,
  RecoveryInspector,
  StateTransitionService,
} from "@densa/core";
import { DensaDatabase } from "@densa/core/persistence";

const createdAt = "2026-08-26T12:00:00.000Z";
const workspacePath = "/fixture/workspace";
const checkpointSnapshot = {
  gitHead: "checkpoint-head",
  gitStatus: "",
  workspaceFingerprint: "checkpoint-fingerprint",
};

function fakeWorkspace(snapshot = checkpointSnapshot) {
  return {
    inspect: async () => ({
      status: "available",
      snapshot: {
        gitHead: snapshot.gitHead,
        gitStatus: snapshot.gitStatus,
        fingerprint: snapshot.workspaceFingerprint,
      },
    }),
  };
}

function fakeProcess(status) {
  return {
    inspect: async (processId) => ({
      processId,
      status,
      ...(status === "alive" ? { identityVerified: true } : {}),
    }),
  };
}

function seedProject(database, suffix, { checkpoint = true } = {}) {
  const project = {
    id: `project-${suffix}`,
    name: `Recovery ${suffix}`,
    state: "DRAFT",
    executionMode: "guided",
    createdAt,
    updatedAt: createdAt,
  };
  const phase = {
    id: `phase-${suffix}`,
    projectId: project.id,
    title: "Recovery phase",
    state: "PENDING",
    position: 0,
    createdAt,
    updatedAt: createdAt,
  };
  const task = {
    id: `task-${suffix}`,
    projectId: project.id,
    phaseId: phase.id,
    title: "Recover interrupted work",
    state: "PENDING",
    position: 0,
    acceptanceCriteria: ["Interruption is classified"],
    dependencyIds: [],
    createdAt,
    updatedAt: createdAt,
  };
  database.repositories.projects.create(project);
  database.repositories.phases.create(phase);
  database.repositories.tasks.create(task);
  if (checkpoint) {
    database.repositories.checkpoints.create({
      id: `checkpoint-${suffix}`,
      projectId: project.id,
      createdAt,
      description: "Known workspace",
      ...checkpointSnapshot,
    });
  }
  return { project, phase, task };
}

function transition(database, entity, states, prefix) {
  const service = new StateTransitionService();
  return states.reduce((current, state, index) => {
    const context = {
      actor: "densa-core:test",
      occurredAt: `2026-08-26T12:${String(index + 1).padStart(2, "0")}:00.000Z`,
      reason: "recovery fixture lifecycle",
    };
    const result =
      prefix === "project"
        ? service.transitionProject(current, state, context)
        : prefix === "phase"
          ? service.transitionPhase(current, state, context)
          : service.transitionTask(current, state, context);
    database.persistStateTransition(result, `event-${prefix}-${entity.id}-${String(index)}`);
    return result.entity;
  }, entity);
}

function seedRunning(database, suffix, { processId = 4242 } = {}) {
  const seeded = seedProject(database, suffix);
  const project = transition(database, seeded.project, ["PLANNING", "READY", "RUNNING"], "project");
  const phase = transition(database, seeded.phase, ["READY", "RUNNING"], "phase");
  const task = transition(database, seeded.task, ["READY", "RUNNING"], "task");
  const attempt = database.repositories.attempts.create({
    id: `attempt-${suffix}`,
    taskId: task.id,
    number: 1,
    startedAt: "2026-08-26T12:05:00.000Z",
  });
  const agentRun = database.repositories.agentRuns.create({
    id: `agent-run-${suffix}`,
    attemptId: attempt.id,
    adapterId: "fake",
    adapterRunId: `adapter-run-${suffix}`,
    processId,
    processIdentity: `process-identity-${suffix}`,
    startedAt: "2026-08-26T12:06:00.000Z",
  });
  return { project, phase, task, attempt, agentRun };
}

async function withDatabase(work) {
  const database = DensaDatabase.openInMemory();
  try {
    await work(database);
  } finally {
    database.close();
  }
}

test("classifies a matching inactive project as cleanly idle", async () => {
  await withDatabase(async (database) => {
    const { project } = seedProject(database, "idle");
    const result = await new RecoveryInspector(database.repositories, {
      workspaceProbe: fakeWorkspace(),
      processProbe: fakeProcess("unknown"),
    }).inspect({ projectId: project.id, workspacePath });

    assert.equal(result.classification, "CLEANLY_IDLE");
    assert.deepEqual(result.actions, ["NONE"]);
    assert.equal(result.automaticActionsPerformed, false);
    assert.equal(result.evidence.checkpoint.id, "checkpoint-idle");
  });
});

test("classifies an active task with a live recorded worker", async () => {
  await withDatabase(async (database) => {
    const { project, task, agentRun } = seedRunning(database, "alive");
    const result = await new RecoveryInspector(database.repositories, {
      workspaceProbe: fakeWorkspace({
        gitHead: checkpointSnapshot.gitHead,
        gitStatus: " M src.ts\n",
        workspaceFingerprint: "active-worker-fingerprint",
      }),
      processProbe: fakeProcess("alive"),
    }).inspect({ projectId: project.id, workspacePath });

    assert.equal(result.classification, "ACTIVE_PROCESS_ALIVE");
    assert.deepEqual(result.actions, ["KEEP_MONITORING"]);
    assert.equal(result.evidence.task.id, task.id);
    assert.equal(result.evidence.agentRun.id, agentRun.id);
    assert.equal(result.evidence.workspaceDiverged, true);
  });
});

test("recommends INTERRUPTED when a RUNNING task's recorded worker is gone", async () => {
  await withDatabase(async (database) => {
    const { project, task } = seedRunning(database, "gone", { processId: 9911 });
    const before = database.repositories.tasks.findById(task.id);
    const result = await new RecoveryInspector(database.repositories, {
      workspaceProbe: fakeWorkspace(),
      processProbe: fakeProcess("gone"),
    }).inspect({ projectId: project.id, workspacePath });

    assert.equal(result.classification, "TASK_PROCESS_GONE");
    assert.deepEqual(result.taskStateRecommendation, { taskId: task.id, state: "INTERRUPTED" });
    assert.deepEqual(result.actions, ["MARK_TASK_INTERRUPTED"]);
    assert.deepEqual(database.repositories.tasks.findById(task.id), before);
  });
});

test("classifies crashes before and during validation without guessing an outcome", async () => {
  await withDatabase(async (database) => {
    for (const withRun of [false, true]) {
      const suffix = withRun ? "validation-run" : "validation-intent";
      const seeded = seedProject(database, suffix);
      transition(database, seeded.project, ["PLANNING", "READY", "RUNNING"], "project");
      transition(database, seeded.phase, ["READY", "RUNNING", "VALIDATING"], "phase");
      const task = transition(database, seeded.task, ["READY", "RUNNING", "VALIDATING"], "task");
      if (withRun) {
        database.repositories.validationRuns.create({
          id: `validation-${suffix}`,
          taskId: task.id,
          validatorId: "node-test",
          startedAt: "2026-08-26T12:09:00.000Z",
        });
      }
      const result = await new RecoveryInspector(database.repositories, {
        workspaceProbe: fakeWorkspace(),
        processProbe: fakeProcess("unknown"),
      }).inspect({ projectId: seeded.project.id, workspacePath });

      assert.equal(result.classification, "VALIDATION_INTERRUPTED");
      assert.deepEqual(result.taskStateRecommendation, { taskId: task.id, state: "INTERRUPTED" });
      assert.equal(result.evidence.validationRun?.completedAt, undefined);
    }
  });
});

test("does not rerun validation while a verified worker remains alive", async () => {
  await withDatabase(async (database) => {
    const running = seedRunning(database, "validation-worker-alive");
    const task = transition(database, running.task, ["VALIDATING"], "task-validation");
    database.repositories.validationRuns.create({
      id: "validation-worker-alive",
      taskId: task.id,
      attemptId: running.attempt.id,
      validatorId: "node-test",
      startedAt: "2026-08-26T12:09:00.000Z",
    });
    const result = await new RecoveryInspector(database.repositories, {
      workspaceProbe: fakeWorkspace(),
      processProbe: fakeProcess("alive"),
    }).inspect({ projectId: running.project.id, workspacePath });

    assert.equal(result.classification, "ACTIVE_PROCESS_ALIVE");
    assert.deepEqual(result.actions, ["KEEP_MONITORING"]);
    assert.equal(result.taskStateRecommendation, undefined);
  });
});

test("reports checkpoint divergence without changing the workspace or persisted records", async () => {
  await withDatabase(async (database) => {
    const { project } = seedProject(database, "diverged");
    const observedPaths = [];
    const result = await new RecoveryInspector(database.repositories, {
      workspaceProbe: {
        inspect: async (path) => {
          observedPaths.push(path);
          return {
            status: "available",
            snapshot: {
              gitHead: "different-head",
              gitStatus: "?? user-file.txt\n",
              fingerprint: "diverged-fingerprint",
            },
          };
        },
      },
      processProbe: fakeProcess("unknown"),
    }).inspect({ projectId: project.id, workspacePath });

    assert.equal(result.classification, "WORKSPACE_DIVERGED");
    assert.deepEqual(result.actions, ["RECONCILE_WORKSPACE"]);
    assert.deepEqual(observedPaths, [workspacePath]);
    assert.equal(database.repositories.checkpoints.listByProjectId(project.id).length, 1);
    assert.equal(database.repositories.events.latest(project.id), undefined);
  });
});

test("fails closed when process, checkpoint, or lifecycle evidence is insufficient", async () => {
  await withDatabase(async (database) => {
    const running = seedRunning(database, "unknown-process");
    const unknownProcess = await new RecoveryInspector(database.repositories, {
      workspaceProbe: fakeWorkspace(),
      processProbe: fakeProcess("unknown"),
    }).inspect({ projectId: running.project.id, workspacePath });
    assert.equal(unknownProcess.classification, "UNKNOWN");
    assert.equal(unknownProcess.taskStateRecommendation, undefined);

    const noCheckpoint = seedProject(database, "no-checkpoint", { checkpoint: false });
    const missingCheckpoint = await new RecoveryInspector(database.repositories, {
      workspaceProbe: fakeWorkspace(),
    }).inspect({ projectId: noCheckpoint.project.id, workspacePath });
    assert.equal(missingCheckpoint.classification, "UNKNOWN");

    const missingProject = await new RecoveryInspector(database.repositories, {
      workspaceProbe: fakeWorkspace(),
    }).inspect({ projectId: "does-not-exist", workspacePath });
    assert.equal(missingProject.classification, "UNKNOWN");
  });
});

test("fails closed on idle lifecycle and latest-event contradictions", async () => {
  await withDatabase(async (database) => {
    const runningWithoutTask = seedProject(database, "running-without-task");
    transition(database, runningWithoutTask.project, ["PLANNING", "READY", "RUNNING"], "project");
    const noActiveTask = await new RecoveryInspector(database.repositories, {
      workspaceProbe: fakeWorkspace(),
    }).inspect({ projectId: runningWithoutTask.project.id, workspacePath });
    assert.equal(noActiveTask.classification, "UNKNOWN");

    const contradictoryEvent = seedProject(database, "contradictory-event");
    database.repositories.events.append({
      id: "event-contradictory-task-state",
      projectId: contradictoryEvent.project.id,
      phaseId: contradictoryEvent.phase.id,
      taskId: contradictoryEvent.task.id,
      type: "TASK_STATE_CHANGED",
      eventVersion: 1,
      occurredAt: "2026-08-26T12:10:00.000Z",
      actor: "densa-core:test",
      payload: { previousState: "PENDING", state: "READY" },
    });
    const eventMismatch = await new RecoveryInspector(database.repositories, {
      workspaceProbe: fakeWorkspace(),
    }).inspect({ projectId: contradictoryEvent.project.id, workspacePath });
    assert.equal(eventMismatch.classification, "UNKNOWN");
    assert.match(eventMismatch.reason, /event disagrees/u);
  });
});

test("an existing PID without verified identity remains unknown", async () => {
  await withDatabase(async (database) => {
    const running = seedRunning(database, "unverified-identity");
    const result = await new RecoveryInspector(database.repositories, {
      workspaceProbe: fakeWorkspace(),
      processProbe: {
        inspect: async (processId) => ({ processId, status: "alive" }),
      },
    }).inspect({ projectId: running.project.id, workspacePath });

    assert.equal(result.classification, "UNKNOWN");
    assert.equal(result.taskStateRecommendation, undefined);
  });
});

test("an unfinished older attempt cannot be hidden by a newer completed retry", async () => {
  await withDatabase(async (database) => {
    const seeded = seedProject(database, "orphaned-retry");
    transition(database, seeded.project, ["PLANNING", "READY", "RUNNING"], "project");
    transition(database, seeded.phase, ["READY", "RUNNING", "VALIDATING"], "phase");
    const task = transition(database, seeded.task, ["READY", "RUNNING", "VALIDATING"], "task");
    const older = database.repositories.attempts.create({
      id: "attempt-orphaned-older",
      taskId: task.id,
      number: 1,
      startedAt: "2026-08-26T12:05:00.000Z",
    });
    database.repositories.agentRuns.create({
      id: "agent-run-orphaned-older",
      attemptId: older.id,
      adapterId: "fake",
      processId: 7331,
      processIdentity: "orphaned-worker-identity",
      startedAt: "2026-08-26T12:06:00.000Z",
    });
    const newer = database.repositories.attempts.create({
      id: "attempt-orphaned-newer",
      taskId: task.id,
      number: 2,
      startedAt: "2026-08-26T12:07:00.000Z",
      completedAt: "2026-08-26T12:08:00.000Z",
    });
    database.repositories.agentRuns.create({
      id: "agent-run-orphaned-newer",
      attemptId: newer.id,
      adapterId: "fake",
      startedAt: "2026-08-26T12:07:00.000Z",
      completedAt: "2026-08-26T12:08:00.000Z",
    });
    database.repositories.validationRuns.create({
      id: "validation-orphaned-retry",
      taskId: task.id,
      attemptId: newer.id,
      validatorId: "node-test",
      startedAt: "2026-08-26T12:09:00.000Z",
    });
    let processProbeCalls = 0;
    const result = await new RecoveryInspector(database.repositories, {
      workspaceProbe: fakeWorkspace(),
      processProbe: {
        inspect: async (processId) => {
          processProbeCalls += 1;
          return { processId, status: "alive", identityVerified: true };
        },
      },
    }).inspect({ projectId: seeded.project.id, workspacePath });

    assert.equal(result.classification, "UNKNOWN");
    assert.match(result.reason, /unfinished older attempt/u);
    assert.equal(result.taskStateRecommendation, undefined);
    assert.equal(processProbeCalls, 0, "contradictory history must fail before probing/rerunning");
  });
});

test("an inactive task with an orphaned older attempt is not cleanly idle", async () => {
  await withDatabase(async (database) => {
    const seeded = seedProject(database, "inactive-orphan");
    const older = database.repositories.attempts.create({
      id: "attempt-inactive-older",
      taskId: seeded.task.id,
      number: 1,
      startedAt: "2026-08-26T12:05:00.000Z",
    });
    database.repositories.agentRuns.create({
      id: "agent-run-inactive-older",
      attemptId: older.id,
      adapterId: "fake",
      processId: 7332,
      processIdentity: "inactive-orphan-identity",
      startedAt: "2026-08-26T12:05:00.000Z",
    });
    const newer = database.repositories.attempts.create({
      id: "attempt-inactive-newer",
      taskId: seeded.task.id,
      number: 2,
      startedAt: "2026-08-26T12:06:00.000Z",
      completedAt: "2026-08-26T12:07:00.000Z",
    });
    database.repositories.agentRuns.create({
      id: "agent-run-inactive-newer",
      attemptId: newer.id,
      adapterId: "fake",
      startedAt: "2026-08-26T12:06:00.000Z",
      completedAt: "2026-08-26T12:07:00.000Z",
    });

    const result = await new RecoveryInspector(database.repositories, {
      workspaceProbe: fakeWorkspace(),
      processProbe: fakeProcess("alive"),
    }).inspect({ projectId: seeded.project.id, workspacePath });

    assert.equal(result.classification, "UNKNOWN");
    assert.notEqual(result.classification, "CLEANLY_IDLE");
    assert.match(result.reason, /unfinished older attempt/u);
  });
});

test("a RUNNING intent without recorded agent metadata remains unknown", async () => {
  await withDatabase(async (database) => {
    const seeded = seedProject(database, "before-agent-record");
    transition(database, seeded.project, ["PLANNING", "READY", "RUNNING"], "project");
    transition(database, seeded.phase, ["READY", "RUNNING"], "phase");
    const task = transition(database, seeded.task, ["READY", "RUNNING"], "task");
    database.repositories.attempts.create({
      id: "attempt-before-agent-record",
      taskId: task.id,
      number: 1,
      startedAt: "2026-08-26T12:08:00.000Z",
    });
    const result = await new RecoveryInspector(database.repositories, {
      workspaceProbe: fakeWorkspace(),
      processProbe: fakeProcess("gone"),
    }).inspect({ projectId: seeded.project.id, workspacePath });

    assert.equal(result.classification, "UNKNOWN");
    assert.equal(result.taskStateRecommendation, undefined);
  });
});

test("process identity logic and the default Git probe observe without mutation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "densa-p2m4-git-probe-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: directory });
    writeFileSync(join(directory, "tracked.txt"), "checkpoint\n", "utf8");
    execFileSync("git", ["add", "tracked.txt"], { cwd: directory });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Densa Test",
        "-c",
        "user.email=densa@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "fixture checkpoint",
      ],
      { cwd: directory },
    );

    const processProbe = new NodeProcessProbe(async () => "fixed-start-time /usr/bin/node");
    const processIdentity = await processProbe.captureIdentity(process.pid);
    const processObservation = await processProbe.inspect(process.pid, processIdentity);
    const unverifiedProcess = await processProbe.inspect(process.pid);
    const reusedPid = await processProbe.inspect(process.pid, "not-the-current-process");
    const clean = await new GitWorkspaceProbe().inspect(directory);
    assert.equal(processObservation.status, "alive");
    assert.equal(processObservation.identityVerified, true);
    assert.equal(unverifiedProcess.status, "unknown");
    assert.equal(reusedPid.status, "gone");
    assert.equal(clean.status, "available");
    assert.equal(clean.snapshot.gitStatus, "");

    writeFileSync(join(directory, "user-change.txt"), "preserve me\n", "utf8");
    const changed = await new GitWorkspaceProbe().inspect(directory);
    assert.equal(changed.status, "available");
    assert.match(changed.snapshot.gitStatus, /\?\? user-change\.txt/u);
    writeFileSync(join(directory, "user-change.txt"), "different content\n", "utf8");
    const samePathChanged = await new GitWorkspaceProbe().inspect(directory);
    assert.equal(samePathChanged.status, "available");
    assert.equal(samePathChanged.snapshot.gitStatus, changed.snapshot.gitStatus);
    assert.notEqual(samePathChanged.snapshot.fingerprint, changed.snapshot.fingerprint);
    assert.equal(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }),
      `${clean.snapshot.gitHead}\n`,
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
