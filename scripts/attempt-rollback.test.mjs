import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  AttemptRollbackService,
  RunCheckpointService,
  StateTransitionService,
} from "@densa-ade/core";
import { DensaAdeDatabase } from "@densa-ade/core/persistence";

const temporaryRoots = new Set();
const createdAt = "2026-08-26T09:00:00.000Z";

function git(repository, args) {
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdio: "pipe",
  });
}

function createRoot() {
  const root = mkdtempSync(join(tmpdir(), "densa-attempt-rollback-test-"));
  temporaryRoots.add(root);
  return root;
}

function createRepository(root) {
  const repository = join(root, "workspace");
  git(root, ["init", "--quiet", "--initial-branch=main", repository]);
  writeFileSync(join(repository, "task.txt"), "checkpoint\n", "utf8");
  writeFileSync(join(repository, "user.txt"), "user checkpoint\n", "utf8");
  writeFileSync(join(repository, "literal*.txt"), "literal checkpoint\n", "utf8");
  writeFileSync(join(repository, "literal-human.txt"), "human checkpoint\n", "utf8");
  git(repository, ["add", "--all"]);
  git(repository, [
    "-c",
    "user.name=Densa ADE Fixture",
    "-c",
    "user.email=densa-fixture@localhost",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "fixture: rollback checkpoint",
  ]);
  return repository;
}

function seedGraph(database) {
  const project = {
    id: "project-attempt-rollback",
    name: "Bounded rollback proof",
    state: "DRAFT",
    executionMode: "guided",
    createdAt,
    updatedAt: createdAt,
  };
  const phase = {
    id: "phase-attempt-rollback",
    projectId: project.id,
    title: "Safe Git rollback",
    state: "PENDING",
    position: 0,
    createdAt,
    updatedAt: createdAt,
  };
  const task = {
    id: "TASK-ROLLBACK",
    projectId: project.id,
    phaseId: phase.id,
    title: "restore a failed attempt",
    state: "PENDING",
    position: 0,
    acceptanceCriteria: ["Failed work returns to its checkpoint"],
    dependencyIds: [],
    createdAt,
    updatedAt: createdAt,
  };
  const attempt = {
    id: "attempt-rollback-1",
    taskId: task.id,
    number: 1,
    startedAt: createdAt,
  };
  const agentRun = {
    id: "agent-run-rollback-1",
    attemptId: attempt.id,
    adapterId: "fixture-agent",
    startedAt: "2026-08-26T09:05:00.000Z",
    adapterRunId: "fixture-run-rollback-1",
  };
  database.repositories.projects.create(project);
  database.repositories.phases.create(phase);
  database.repositories.tasks.create(task);
  database.repositories.attempts.create(attempt);
  return { project, phase, task, attempt, agentRun };
}

async function prepareRunningAttempt(database, repository) {
  const graph = seedGraph(database);
  const checkpoint = await new RunCheckpointService(database).prepareTask({
    projectId: graph.project.id,
    taskId: graph.task.id,
    attemptId: graph.attempt.id,
    checkpointId: "checkpoint-rollback-1",
    runActivatedEventId: "event-rollback-run-activated",
    checkpointEventId: "event-rollback-checkpoint-1",
    workspacePath: repository,
    createdAt,
    actor: "densa-core:test",
  });
  assert.equal(checkpoint.status, "READY");
  const transitions = new StateTransitionService();
  let task = graph.task;
  for (const [state, eventId, occurredAt] of [
    ["READY", "event-rollback-task-ready", "2026-08-26T09:03:00.000Z"],
    ["RUNNING", "event-rollback-task-running", "2026-08-26T09:05:00.000Z"],
  ]) {
    database.persistStateTransition(
      transitions.transitionTask(task, state, {
        actor: "densa-core:test",
        occurredAt,
      }),
      eventId,
    );
    task = database.repositories.tasks.findById(task.id);
  }
  database.repositories.agentRuns.create(graph.agentRun);
  return { ...graph, checkpoint };
}

function captureRequest(graph, repository) {
  return {
    projectId: graph.project.id,
    taskId: graph.task.id,
    attemptId: graph.attempt.id,
    agentRunId: graph.agentRun.id,
    workspacePath: repository,
    ownedPaths: ["attempt.tmp", "task.txt"],
    temporaryPaths: ["attempt.tmp"],
    recordedAt: "2026-08-26T09:08:00.000Z",
    actor: "densa-core:test",
    eventId: "event-attempt-output-captured",
  };
}

function failureRequest(graph) {
  return {
    projectId: graph.project.id,
    taskId: graph.task.id,
    attemptId: graph.attempt.id,
    diagnostics: {
      failureCode: "VALIDATION_FAILED",
      command: "fixture-validator",
      exitCode: 1,
      summary: "Expected checkpoint content",
      authorization: "Bearer fixture-secret-token",
      accessToken: "opaque-access-value",
      nested: { dbPassword: "opaque-password-value", safeCount: 3 },
    },
    recordedAt: "2026-08-26T09:12:00.000Z",
    actor: "densa-core:test",
    eventId: "event-rollback-planned",
  };
}

async function recordFailedValidation(database, graph) {
  const transitions = new StateTransitionService();
  const runningTask = database.repositories.tasks.findById(graph.task.id);
  database.persistStateTransition(
    transitions.transitionTask(runningTask, "VALIDATING", {
      actor: "densa-core:test",
      occurredAt: "2026-08-26T09:09:00.000Z",
    }),
    "event-rollback-task-validating",
  );
  database.repositories.validationRuns.create({
    id: "validation-rollback-1",
    taskId: graph.task.id,
    attemptId: graph.attempt.id,
    validatorId: "fixture-validator",
    startedAt: "2026-08-26T09:10:00.000Z",
    completedAt: "2026-08-26T09:11:00.000Z",
    passed: false,
  });
  return await new AttemptRollbackService(database).recordFailedAttempt(failureRequest(graph));
}

function rollbackRequest(graph, repository, suffix = "applied") {
  return {
    projectId: graph.project.id,
    taskId: graph.task.id,
    attemptId: graph.attempt.id,
    workspacePath: repository,
    rolledBackAt: "2026-08-26T09:13:00.000Z",
    actor: "densa-core:test",
    appliedEventId: `event-rollback-${suffix}`,
    conflictEventId: `event-rollback-conflict-${suffix}`,
  };
}

test.after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

test("output capture atomically completes the matching run with its immutable path manifest", async () => {
  const root = createRoot();
  const repository = createRepository(root);
  const database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
  const graph = await prepareRunningAttempt(database, repository);
  writeFileSync(join(repository, "task.txt"), "unattributed output\n", "utf8");
  writeFileSync(join(repository, "attempt.tmp"), "unattributed temporary output\n", "utf8");
  const service = new AttemptRollbackService(database);

  const mismatched = await service.captureAttemptOutput({
    ...captureRequest(graph, repository),
    agentRunId: "agent-run-from-another-attempt",
  });
  assert.equal(mismatched.status, "STOPPED");
  assert.equal(mismatched.code, "ATTEMPT_MISMATCH");

  assert.equal(database.repositories.agentRuns.findById(graph.agentRun.id).completedAt, undefined);
  assert.equal(
    database.repositories.attemptRollbackPlans.findByAttemptId(graph.attempt.id),
    undefined,
  );

  const captured = await service.captureAttemptOutput(captureRequest(graph, repository));
  assert.equal(captured.status, "CAPTURED");
  assert.equal(captured.plan.agentRunId, graph.agentRun.id);
  assert.equal(
    database.repositories.agentRuns.findById(graph.agentRun.id).completedAt,
    captured.plan.recordedAt,
  );
  database.close();
});

test("a run completed without an atomic output manifest is never rollback eligible", async () => {
  const root = createRoot();
  const repository = createRepository(root);
  const database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
  const graph = await prepareRunningAttempt(database, repository);
  database.repositories.agentRuns.recordCompleted(graph.agentRun.id, "2026-08-26T09:07:59.000Z");
  writeFileSync(join(repository, "task.txt"), "unattributed output\n", "utf8");
  writeFileSync(join(repository, "attempt.tmp"), "unattributed temporary output\n", "utf8");

  const result = await new AttemptRollbackService(database).captureAttemptOutput(
    captureRequest(graph, repository),
  );

  assert.equal(result.status, "STOPPED");
  assert.equal(result.code, "ATTEMPT_MISMATCH");
  assert.equal(
    database.repositories.attemptRollbackPlans.findByAttemptId(graph.attempt.id),
    undefined,
  );
  database.close();
});

test("a manifest persistence failure rolls back AgentRun completion for a safe retry", async () => {
  const root = createRoot();
  const repository = createRepository(root);
  const database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
  const graph = await prepareRunningAttempt(database, repository);
  writeFileSync(join(repository, "task.txt"), "failed Densa ADE output\n", "utf8");
  writeFileSync(join(repository, "attempt.tmp"), "temporary Densa ADE output\n", "utf8");
  const request = captureRequest(graph, repository);
  database.repositories.events.append({
    id: request.eventId,
    projectId: graph.project.id,
    phaseId: graph.phase.id,
    taskId: graph.task.id,
    type: "FIXTURE_EVENT",
    eventVersion: 1,
    occurredAt: request.recordedAt,
    actor: "densa-core:test",
    payload: { purpose: "force the terminal transaction to fail" },
  });

  const failed = await new AttemptRollbackService(database).captureAttemptOutput(request);
  assert.equal(failed.status, "STOPPED");
  assert.equal(failed.code, "PERSISTENCE_FAILED");
  assert.equal(database.repositories.agentRuns.findById(graph.agentRun.id).completedAt, undefined);
  assert.equal(
    database.repositories.attemptRollbackPlans.findByAttemptId(graph.attempt.id),
    undefined,
  );

  const retried = await new AttemptRollbackService(database).captureAttemptOutput({
    ...request,
    eventId: "event-attempt-output-captured-after-retry",
  });
  assert.equal(retried.status, "CAPTURED");
  assert.equal(
    database.repositories.agentRuns.findById(graph.agentRun.id).completedAt,
    request.recordedAt,
  );
  database.close();
});

test("clean rollback restores only owned files, retains diagnostics, and enables a known retry checkpoint", async () => {
  const root = createRoot();
  const repository = createRepository(root);
  const databasePath = join(root, "runtime.sqlite");
  let database = DensaAdeDatabase.open(databasePath);
  const graph = await prepareRunningAttempt(database, repository);
  writeFileSync(join(repository, "task.txt"), "failed Densa ADE output\n", "utf8");
  writeFileSync(join(repository, "attempt.tmp"), "temporary Densa ADE output\n", "utf8");
  git(repository, ["add", "--", "task.txt", "attempt.tmp"]);

  const captured = await new AttemptRollbackService(database).captureAttemptOutput(
    captureRequest(graph, repository),
  );
  assert.equal(captured.status, "CAPTURED");
  const recorded = await recordFailedValidation(database, graph);
  assert.equal(recorded.status, "RECORDED");
  assert.equal(recorded.recoveredExistingPlan, false);
  database.close();

  database = DensaAdeDatabase.open(databasePath);
  assert.deepEqual(
    database.repositories.attemptRollbackPlans.findByAttemptId(graph.attempt.id).diagnostics,
    {
      ...failureRequest(graph).diagnostics,
      authorization: "[REDACTED]",
      accessToken: "[REDACTED]",
      nested: { dbPassword: "[REDACTED]", safeCount: 3 },
    },
  );
  const result = await new AttemptRollbackService(database).rollbackFailedAttempt(
    rollbackRequest(graph, repository),
  );

  assert.equal(result.status, "ROLLED_BACK");
  assert.deepEqual(result.restoredPaths, ["attempt.tmp", "task.txt"]);
  assert.deepEqual(result.cleanedTemporaryPaths, ["attempt.tmp"]);
  assert.deepEqual(result.preservedHumanPaths, []);
  assert.equal(result.workspaceReadyForRetry, true);
  assert.equal(readFileSync(join(repository, "task.txt"), "utf8"), "checkpoint\n");
  assert.equal(existsSync(join(repository, "attempt.tmp")), false);
  assert.equal(git(repository, ["status", "--porcelain=v1"]).trim(), "");
  assert.ok(database.repositories.attemptRollbackPlans.findByAttemptId(graph.attempt.id).appliedAt);
  assert.deepEqual(
    database.repositories.events
      .replay({ projectId: graph.project.id })
      .filter(
        (event) =>
          event.type === "ATTEMPT_OUTPUT_CAPTURED" ||
          event.type.startsWith("ATTEMPT_ROLLBACK") ||
          event.type === "ATTEMPT_ROLLED_BACK",
      )
      .map((event) => event.type),
    ["ATTEMPT_OUTPUT_CAPTURED", "ATTEMPT_ROLLBACK_PLANNED", "ATTEMPT_ROLLED_BACK"],
  );

  const nextAttempt = {
    id: "attempt-rollback-2",
    taskId: graph.task.id,
    number: 2,
    startedAt: "2026-08-26T09:14:00.000Z",
  };
  database.repositories.attempts.create(nextAttempt);
  const nextCheckpoint = await new RunCheckpointService(database).prepareTask({
    projectId: graph.project.id,
    taskId: graph.task.id,
    attemptId: nextAttempt.id,
    checkpointId: "checkpoint-rollback-2",
    runActivatedEventId: "event-unused-run-activation",
    checkpointEventId: "event-rollback-checkpoint-2",
    workspacePath: repository,
    createdAt: nextAttempt.startedAt,
    actor: "densa-core:test",
  });
  assert.equal(nextCheckpoint.status, "READY");
  assert.equal(nextCheckpoint.checkpoint.gitHead, graph.checkpoint.checkpoint.gitHead);
  database.close();
});

test("overlapping human edit blocks rollback before the edited file is overwritten", async () => {
  const root = createRoot();
  const repository = createRepository(root);
  const database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
  const graph = await prepareRunningAttempt(database, repository);
  writeFileSync(join(repository, "task.txt"), "failed Densa ADE output\n", "utf8");
  writeFileSync(join(repository, "attempt.tmp"), "temporary Densa ADE output\n", "utf8");
  const captured = await new AttemptRollbackService(database).captureAttemptOutput(
    captureRequest(graph, repository),
  );
  assert.equal(captured.status, "CAPTURED");
  writeFileSync(join(repository, "task.txt"), "human edit after worker output\n", "utf8");
  const recorded = await recordFailedValidation(database, graph);
  assert.equal(recorded.status, "RECORDED");

  const result = await new AttemptRollbackService(database).rollbackFailedAttempt(
    rollbackRequest(graph, repository, "blocked"),
  );

  assert.equal(result.status, "STOPPED");
  assert.equal(result.code, "HUMAN_EDIT_OVERLAP");
  assert.deepEqual(result.conflictingPaths, ["task.txt"]);
  assert.equal(
    readFileSync(join(repository, "task.txt"), "utf8"),
    "human edit after worker output\n",
  );
  assert.equal(
    readFileSync(join(repository, "attempt.tmp"), "utf8"),
    "temporary Densa ADE output\n",
  );
  assert.equal(
    database.repositories.attemptRollbackPlans.findByAttemptId(graph.attempt.id).appliedAt,
    undefined,
  );
  assert.equal(
    database.repositories.events.replay({ projectId: graph.project.id }).at(-1).type,
    "ATTEMPT_ROLLBACK_BLOCKED",
  );
  database.close();
});

test("an overlapping human index edit is detected even when the worktree still matches Densa ADE output", async () => {
  const root = createRoot();
  const repository = createRepository(root);
  const database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
  const graph = await prepareRunningAttempt(database, repository);
  writeFileSync(join(repository, "task.txt"), "failed Densa ADE output\n", "utf8");
  writeFileSync(join(repository, "attempt.tmp"), "temporary Densa ADE output\n", "utf8");
  const captured = await new AttemptRollbackService(database).captureAttemptOutput(
    captureRequest(graph, repository),
  );
  assert.equal(captured.status, "CAPTURED");
  writeFileSync(join(repository, "task.txt"), "human staged edit\n", "utf8");
  git(repository, ["add", "--", "task.txt"]);
  writeFileSync(join(repository, "task.txt"), "failed Densa ADE output\n", "utf8");
  const recorded = await recordFailedValidation(database, graph);
  assert.equal(recorded.status, "RECORDED");

  const result = await new AttemptRollbackService(database).rollbackFailedAttempt(
    rollbackRequest(graph, repository, "index-blocked"),
  );

  assert.equal(result.status, "STOPPED");
  assert.equal(result.code, "HUMAN_EDIT_OVERLAP");
  assert.deepEqual(result.conflictingPaths, ["task.txt"]);
  assert.equal(readFileSync(join(repository, "task.txt"), "utf8"), "failed Densa ADE output\n");
  assert.equal(git(repository, ["show", ":task.txt"]), "human staged edit\n");
  database.close();
});

test("an applied rollback cannot be treated as retry-ready after failed output reappears", async () => {
  const root = createRoot();
  const repository = createRepository(root);
  const database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
  const graph = await prepareRunningAttempt(database, repository);
  writeFileSync(join(repository, "task.txt"), "failed Densa ADE output\n", "utf8");
  writeFileSync(join(repository, "attempt.tmp"), "temporary Densa ADE output\n", "utf8");
  git(repository, ["add", "--", "task.txt", "attempt.tmp"]);
  const captured = await new AttemptRollbackService(database).captureAttemptOutput(
    captureRequest(graph, repository),
  );
  assert.equal(captured.status, "CAPTURED");
  const recorded = await recordFailedValidation(database, graph);
  assert.equal(recorded.status, "RECORDED");
  const applied = await new AttemptRollbackService(database).rollbackFailedAttempt(
    rollbackRequest(graph, repository, "first-application"),
  );
  assert.equal(applied.status, "ROLLED_BACK");
  assert.equal(applied.workspaceReadyForRetry, true);

  writeFileSync(join(repository, "task.txt"), "failed Densa ADE output\n", "utf8");
  writeFileSync(join(repository, "attempt.tmp"), "temporary Densa ADE output\n", "utf8");
  git(repository, ["add", "--", "task.txt", "attempt.tmp"]);
  const repeated = await new AttemptRollbackService(database).rollbackFailedAttempt({
    ...rollbackRequest(graph, repository, "reappeared-output"),
    rolledBackAt: "2026-08-26T09:14:00.000Z",
  });

  assert.equal(repeated.status, "STOPPED");
  assert.equal(repeated.code, "HUMAN_EDIT_OVERLAP");
  assert.deepEqual(repeated.conflictingPaths, ["attempt.tmp", "task.txt"]);
  assert.equal(readFileSync(join(repository, "task.txt"), "utf8"), "failed Densa ADE output\n");
  assert.equal(
    readFileSync(join(repository, "attempt.tmp"), "utf8"),
    "temporary Densa ADE output\n",
  );
  database.close();
});

test("rollback resumes from proven half-restored index and worktree states after a crash", async () => {
  const root = createRoot();
  const repository = createRepository(root);
  const database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
  const graph = await prepareRunningAttempt(database, repository);
  writeFileSync(join(repository, "task.txt"), "failed Densa ADE output\n", "utf8");
  writeFileSync(join(repository, "attempt.tmp"), "temporary Densa ADE output\n", "utf8");
  git(repository, ["add", "--", "task.txt", "attempt.tmp"]);
  const captured = await new AttemptRollbackService(database).captureAttemptOutput(
    captureRequest(graph, repository),
  );
  assert.equal(captured.status, "CAPTURED");
  const recorded = await recordFailedValidation(database, graph);
  assert.equal(recorded.status, "RECORDED");

  const checkpointHead = graph.checkpoint.checkpoint.gitHead;
  git(repository, ["restore", `--source=${checkpointHead}`, "--staged", "--", "attempt.tmp"]);
  git(repository, ["restore", `--source=${checkpointHead}`, "--staged", "--", "task.txt"]);
  assert.equal(
    readFileSync(join(repository, "attempt.tmp"), "utf8"),
    "temporary Densa ADE output\n",
  );
  assert.equal(readFileSync(join(repository, "task.txt"), "utf8"), "failed Densa ADE output\n");

  const resumed = await new AttemptRollbackService(database).rollbackFailedAttempt(
    rollbackRequest(graph, repository, "half-restored"),
  );

  assert.equal(resumed.status, "ROLLED_BACK");
  assert.equal(resumed.workspaceReadyForRetry, true);
  assert.equal(existsSync(join(repository, "attempt.tmp")), false);
  assert.equal(readFileSync(join(repository, "task.txt"), "utf8"), "checkpoint\n");
  assert.equal(git(repository, ["status", "--porcelain=v1"]).trim(), "");
  database.close();
});

test("non-overlapping human work is preserved and keeps automatic retry from claiming clean state", async () => {
  const root = createRoot();
  const repository = createRepository(root);
  const database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
  const graph = await prepareRunningAttempt(database, repository);
  writeFileSync(join(repository, "task.txt"), "failed Densa ADE output\n", "utf8");
  writeFileSync(join(repository, "attempt.tmp"), "temporary Densa ADE output\n", "utf8");
  const captured = await new AttemptRollbackService(database).captureAttemptOutput(
    captureRequest(graph, repository),
  );
  assert.equal(captured.status, "CAPTURED");
  const recorded = await recordFailedValidation(database, graph);
  assert.equal(recorded.status, "RECORDED");
  writeFileSync(join(repository, "user.txt"), "later non-overlapping human edit\n", "utf8");

  const result = await new AttemptRollbackService(database).rollbackFailedAttempt(
    rollbackRequest(graph, repository, "preserved"),
  );

  assert.equal(result.status, "ROLLED_BACK");
  assert.deepEqual(result.preservedHumanPaths, ["user.txt"]);
  assert.equal(result.workspaceReadyForRetry, false);
  assert.equal(
    readFileSync(join(repository, "user.txt"), "utf8"),
    "later non-overlapping human edit\n",
  );
  assert.equal(readFileSync(join(repository, "task.txt"), "utf8"), "checkpoint\n");
  database.close();
});

test("Git pathspec metacharacters are treated as a literal owned filename", async () => {
  const root = createRoot();
  const repository = createRepository(root);
  const database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
  const graph = await prepareRunningAttempt(database, repository);
  writeFileSync(join(repository, "literal*.txt"), "failed literal Densa ADE output\n", "utf8");
  writeFileSync(join(repository, "literal-human.txt"), "later human edit\n", "utf8");
  const captured = await new AttemptRollbackService(database).captureAttemptOutput({
    ...captureRequest(graph, repository),
    ownedPaths: ["literal*.txt"],
    temporaryPaths: [],
  });
  assert.equal(captured.status, "CAPTURED");
  const recorded = await recordFailedValidation(database, graph);
  assert.equal(recorded.status, "RECORDED");

  const result = await new AttemptRollbackService(database).rollbackFailedAttempt(
    rollbackRequest(graph, repository, "literal-pathspec"),
  );

  assert.equal(result.status, "ROLLED_BACK");
  assert.deepEqual(result.restoredPaths, ["literal*.txt"]);
  assert.deepEqual(result.preservedHumanPaths, ["literal-human.txt"]);
  assert.equal(result.workspaceReadyForRetry, false);
  assert.equal(readFileSync(join(repository, "literal*.txt"), "utf8"), "literal checkpoint\n");
  assert.equal(readFileSync(join(repository, "literal-human.txt"), "utf8"), "later human edit\n");
  database.close();
});

test("an older failed attempt cannot claim changes after a newer attempt starts", async () => {
  const root = createRoot();
  const repository = createRepository(root);
  const database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
  const graph = await prepareRunningAttempt(database, repository);
  writeFileSync(join(repository, "task.txt"), "failed Densa ADE output\n", "utf8");
  writeFileSync(join(repository, "attempt.tmp"), "temporary Densa ADE output\n", "utf8");
  const captured = await new AttemptRollbackService(database).captureAttemptOutput(
    captureRequest(graph, repository),
  );
  assert.equal(captured.status, "CAPTURED");
  const recorded = await recordFailedValidation(database, graph);
  assert.equal(recorded.status, "RECORDED");
  database.repositories.attempts.create({
    id: "attempt-rollback-newer",
    taskId: graph.task.id,
    number: 2,
    startedAt: "2026-08-26T09:11:30.000Z",
  });
  writeFileSync(join(repository, "task.txt"), "newer attempt output\n", "utf8");

  const result = await new AttemptRollbackService(database).rollbackFailedAttempt(
    rollbackRequest(graph, repository, "stale-attempt"),
  );

  assert.equal(result.status, "STOPPED");
  assert.equal(result.code, "ATTEMPT_MISMATCH");
  assert.ok(database.repositories.attemptRollbackPlans.findByAttemptId(graph.attempt.id));
  assert.equal(readFileSync(join(repository, "task.txt"), "utf8"), "newer attempt output\n");
  database.close();
});

test("a passing validation added after failure planning cancels rollback eligibility", async () => {
  const root = createRoot();
  const repository = createRepository(root);
  const database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
  const graph = await prepareRunningAttempt(database, repository);
  writeFileSync(join(repository, "task.txt"), "failed Densa ADE output\n", "utf8");
  writeFileSync(join(repository, "attempt.tmp"), "temporary Densa ADE output\n", "utf8");
  const captured = await new AttemptRollbackService(database).captureAttemptOutput(
    captureRequest(graph, repository),
  );
  assert.equal(captured.status, "CAPTURED");
  const recorded = await recordFailedValidation(database, graph);
  assert.equal(recorded.status, "RECORDED");
  database.repositories.validationRuns.create({
    id: "validation-rollback-later-pass",
    taskId: graph.task.id,
    attemptId: graph.attempt.id,
    validatorId: "fixture-validator",
    startedAt: "2026-08-26T09:12:10.000Z",
    completedAt: "2026-08-26T09:12:20.000Z",
    passed: true,
  });

  const result = await new AttemptRollbackService(database).rollbackFailedAttempt(
    rollbackRequest(graph, repository, "later-pass"),
  );

  assert.equal(result.status, "STOPPED");
  assert.equal(result.code, "NOT_FAILED");
  assert.equal(readFileSync(join(repository, "task.txt"), "utf8"), "failed Densa ADE output\n");
  database.close();
});
