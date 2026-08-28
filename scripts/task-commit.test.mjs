import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RunCheckpointService, StateTransitionService, TaskCommitService } from "@densa/core";
import { DensaDatabase } from "@densa/core/persistence";

const temporaryRoots = new Set();
const createdAt = "2026-08-26T08:00:00.000Z";
const committedAt = "2026-08-26T08:30:00.000Z";

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
  const root = mkdtempSync(join(tmpdir(), "densa-task-commit-test-"));
  temporaryRoots.add(root);
  return root;
}

function createRepository(root) {
  const repository = join(root, "workspace");
  git(root, ["init", "--quiet", "--initial-branch=main", repository]);
  writeFileSync(join(repository, ".gitignore"), ".densa/runtime/\n*.sqlite\n", "utf8");
  writeFileSync(join(repository, "task.txt"), "before\n", "utf8");
  writeFileSync(join(repository, "user.txt"), "user baseline\n", "utf8");
  git(repository, ["add", "--all"]);
  git(repository, [
    "-c",
    "user.name=Densa Fixture",
    "-c",
    "user.email=densa-fixture@localhost",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "fixture: initial checkpoint",
  ]);
  return repository;
}

function seedGraph(database) {
  const project = {
    id: "project-task-commit",
    name: "Atomic task commit proof",
    state: "DRAFT",
    executionMode: "guided",
    createdAt,
    updatedAt: createdAt,
  };
  const phase = {
    id: "phase-task-commit",
    projectId: project.id,
    title: "Safe Git execution",
    state: "PENDING",
    position: 0,
    createdAt,
    updatedAt: createdAt,
  };
  const task = {
    id: "TASK-042",
    projectId: project.id,
    phaseId: phase.id,
    title: "write the intended file",
    state: "PENDING",
    position: 0,
    acceptanceCriteria: ["The intended file is validated"],
    dependencyIds: [],
    createdAt,
    updatedAt: createdAt,
  };
  const attempt = {
    id: "attempt-task-commit",
    taskId: task.id,
    number: 1,
    startedAt: createdAt,
  };
  database.repositories.projects.create(project);
  database.repositories.phases.create(phase);
  database.repositories.tasks.create(task);
  database.repositories.attempts.create(attempt);
  return { project, phase, task, attempt };
}

async function preparePassingAttempt(
  database,
  repository,
  { passed = true, planBased = false } = {},
) {
  const graph = seedGraph(database);
  const checkpoint = await new RunCheckpointService(database).prepareTask({
    projectId: graph.project.id,
    taskId: graph.task.id,
    attemptId: graph.attempt.id,
    checkpointId: "checkpoint-task-commit",
    runActivatedEventId: "event-task-run-activated",
    checkpointEventId: "event-task-checkpoint",
    workspacePath: repository,
    createdAt,
    actor: "densa-core:test",
  });
  assert.equal(checkpoint.status, "READY");

  const transitions = new StateTransitionService();
  let task = graph.task;
  for (const [state, eventId, occurredAt] of [
    ["READY", "event-task-ready", "2026-08-26T08:05:00.000Z"],
    ["RUNNING", "event-task-running", "2026-08-26T08:10:00.000Z"],
    ["VALIDATING", "event-task-validating", "2026-08-26T08:20:00.000Z"],
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
  const validation = {
    id: "validation-task-commit",
    taskId: task.id,
    attemptId: graph.attempt.id,
    validatorId: "fixture-validator",
    ...(planBased ? { planId: "fixture-plan", planVersion: "1" } : {}),
    startedAt: "2026-08-26T08:15:00.000Z",
    completedAt: "2026-08-26T08:19:00.000Z",
    passed,
  };
  database.repositories.validationRuns.create(validation);
  return { ...graph, task, validation, checkpoint };
}

function requestFor(graph, repository, suffix = "success") {
  return {
    projectId: graph.project.id,
    taskId: graph.task.id,
    attemptId: graph.attempt.id,
    validationRunId: graph.validation.id,
    workspacePath: repository,
    intendedPaths: ["task.txt"],
    committedAt,
    actor: "densa-core:test",
    commitRecordedEventId: `event-task-committed-${suffix}`,
    completionEventId: `event-task-completed-${suffix}`,
  };
}

function configureCommitIdentity(repository) {
  git(repository, ["config", "user.name", "Densa Fixture"]);
  git(repository, ["config", "user.email", "densa-fixture@localhost"]);
  git(repository, ["config", "commit.gpgsign", "false"]);
}

test.after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

test("commits exactly the intended passing-task change and atomically completes the task", async () => {
  const root = createRoot();
  const repository = createRepository(root);
  const remote = join(root, "origin.git");
  git(root, ["init", "--quiet", "--bare", "--initial-branch=main", remote]);
  git(repository, ["remote", "add", "origin", remote]);
  git(repository, ["push", "--quiet", "--set-upstream", "origin", "main"]);
  const remoteBefore = git(remote, ["for-each-ref", "--format=%(refname):%(objectname)"]);
  const databasePath = join(root, "runtime.sqlite");
  const database = DensaDatabase.open(databasePath);
  const graph = await preparePassingAttempt(database, repository);
  configureCommitIdentity(repository);
  writeFileSync(join(repository, "task.txt"), "after\n", "utf8");

  const result = await new TaskCommitService(database).commitPassingTask(
    requestFor(graph, repository),
  );

  assert.equal(result.status, "COMMITTED");
  assert.equal(result.commitMessage, "densa: TASK-042 write the intended file");
  assert.equal(git(repository, ["rev-parse", "HEAD"]).trim(), result.commitSha);
  assert.equal(
    git(repository, ["show", "--format=%s", "--no-patch", "HEAD"]).trim(),
    result.commitMessage,
  );
  assert.deepEqual(
    git(repository, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])
      .trim()
      .split("\n"),
    ["task.txt"],
  );
  assert.equal(database.repositories.tasks.findById(graph.task.id).state, "COMPLETED");
  assert.equal(
    database.repositories.attempts.findById(graph.attempt.id).commitSha,
    result.commitSha,
  );
  assert.equal(
    database.repositories.taskCommitIntents.findByAttemptId(graph.attempt.id).commitSha,
    result.commitSha,
  );
  assert.deepEqual(
    database.repositories.events
      .replay({ projectId: graph.project.id })
      .slice(-2)
      .map((event) => event.type),
    ["TASK_COMMITTED", "TASK_STATE_CHANGED"],
  );
  assert.equal(git(remote, ["for-each-ref", "--format=%(refname):%(objectname)"]), remoteBefore);

  const repeated = await new TaskCommitService(database).commitPassingTask(
    requestFor(graph, repository, "repeat"),
  );
  assert.equal(repeated.status, "COMMITTED");
  assert.equal(repeated.recoveredExistingCommit, true);
  assert.equal(git(repository, ["rev-list", "--count", "HEAD"]).trim(), "2");
  database.close();

  const reopened = DensaDatabase.open(databasePath);
  assert.equal(
    reopened.repositories.attempts.findById(graph.attempt.id).commitSha,
    result.commitSha,
  );
  reopened.close();
});

test("preserves unrelated staged and unstaged user changes outside the intended path", async () => {
  const root = createRoot();
  const repository = createRepository(root);
  const database = DensaDatabase.open(join(root, "runtime.sqlite"));
  const graph = await preparePassingAttempt(database, repository);
  configureCommitIdentity(repository);
  writeFileSync(join(repository, "task.txt"), "task result\n", "utf8");
  writeFileSync(join(repository, "user.txt"), "staged user edit\n", "utf8");
  git(repository, ["add", "--", "user.txt"]);
  writeFileSync(join(repository, "user-draft.txt"), "unstaged user draft\n", "utf8");

  const result = await new TaskCommitService(database).commitPassingTask(
    requestFor(graph, repository),
  );

  assert.equal(result.status, "COMMITTED");
  assert.deepEqual(result.preservedChangedPaths, ["user-draft.txt", "user.txt"]);
  assert.equal(git(repository, ["show", "--format=", "--name-only", "HEAD"]).trim(), "task.txt");
  assert.equal(git(repository, ["diff", "--cached", "--name-only"]).trim(), "user.txt");
  assert.equal(readFileSync(join(repository, "user.txt"), "utf8"), "staged user edit\n");
  assert.equal(readFileSync(join(repository, "user-draft.txt"), "utf8"), "unstaged user draft\n");
  database.close();
});

test("a Git commit failure leaves the task VALIDATING with no persisted commit SHA", async () => {
  const root = createRoot();
  const repository = createRepository(root);
  const database = DensaDatabase.open(join(root, "runtime.sqlite"));
  const graph = await preparePassingAttempt(database, repository);
  configureCommitIdentity(repository);
  const hook = join(repository, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n", "utf8");
  chmodSync(hook, 0o700);
  const checkpointHead = git(repository, ["rev-parse", "HEAD"]).trim();
  writeFileSync(join(repository, "task.txt"), "cannot commit without identity\n", "utf8");

  const result = await new TaskCommitService(database).commitPassingTask(
    requestFor(graph, repository),
  );

  assert.equal(result.status, "STOPPED");
  assert.equal(result.code, "GIT_COMMAND_FAILED");
  assert.equal(git(repository, ["rev-parse", "HEAD"]).trim(), checkpointHead);
  assert.equal(database.repositories.tasks.findById(graph.task.id).state, "VALIDATING");
  assert.equal(database.repositories.attempts.findById(graph.attempt.id).commitSha, undefined);
  database.close();
});

test("a failed completion transaction rolls back state and SHA, then retry recovers the same commit", async () => {
  const root = createRoot();
  const repository = createRepository(root);
  const database = DensaDatabase.open(join(root, "runtime.sqlite"));
  const graph = await preparePassingAttempt(database, repository);
  configureCommitIdentity(repository);
  writeFileSync(join(repository, "task.txt"), "recoverable task result\n", "utf8");
  database.repositories.events.append({
    id: "event-task-committed-conflict",
    projectId: graph.project.id,
    type: "TEST_CONFLICT",
    eventVersion: 1,
    occurredAt: "2026-08-26T08:25:00.000Z",
    actor: "densa-core:test",
    payload: {},
  });

  const failed = await new TaskCommitService(database).commitPassingTask(
    requestFor(graph, repository, "conflict"),
  );

  assert.equal(failed.status, "STOPPED");
  assert.equal(failed.code, "PERSISTENCE_FAILED");
  assert.ok(failed.commitSha);
  assert.equal(database.repositories.tasks.findById(graph.task.id).state, "VALIDATING");
  assert.equal(database.repositories.attempts.findById(graph.attempt.id).commitSha, undefined);
  assert.equal(
    database.repositories.taskCommitIntents.findByAttemptId(graph.attempt.id).commitSha,
    failed.commitSha,
  );
  const commitCount = git(repository, ["rev-list", "--count", "HEAD"]).trim();

  const recovered = await new TaskCommitService(database).commitPassingTask(
    requestFor(graph, repository, "recovered"),
  );

  assert.equal(recovered.status, "COMMITTED");
  assert.equal(recovered.commitSha, failed.commitSha);
  assert.equal(recovered.recoveredExistingCommit, true);
  assert.equal(git(repository, ["rev-list", "--count", "HEAD"]).trim(), commitCount);
  assert.equal(database.repositories.tasks.findById(graph.task.id).state, "COMPLETED");
  assert.equal(
    database.repositories.attempts.findById(graph.attempt.id).commitSha,
    failed.commitSha,
  );
  database.close();
});

test("does not stage or commit an attempt whose validation failed", async () => {
  const root = createRoot();
  const repository = createRepository(root);
  const database = DensaDatabase.open(join(root, "runtime.sqlite"));
  const graph = await preparePassingAttempt(database, repository, { passed: false });
  configureCommitIdentity(repository);
  const checkpointHead = git(repository, ["rev-parse", "HEAD"]).trim();
  writeFileSync(join(repository, "task.txt"), "unvalidated result\n", "utf8");

  const result = await new TaskCommitService(database).commitPassingTask(
    requestFor(graph, repository),
  );

  assert.equal(result.status, "STOPPED");
  assert.equal(result.code, "NOT_VALIDATED");
  assert.equal(git(repository, ["rev-parse", "HEAD"]).trim(), checkpointHead);
  assert.equal(git(repository, ["diff", "--cached", "--name-only"]).trim(), "");
  assert.equal(
    database.repositories.taskCommitIntents.findByAttemptId(graph.attempt.id),
    undefined,
  );
  database.close();
});

test("does not stage or commit when a required criterion has no plan evidence", async () => {
  const root = createRoot();
  const repository = createRepository(root);
  const database = DensaDatabase.open(join(root, "runtime.sqlite"));
  const graph = await preparePassingAttempt(database, repository, { planBased: true });
  configureCommitIdentity(repository);
  const checkpointHead = git(repository, ["rev-parse", "HEAD"]).trim();
  writeFileSync(
    join(repository, "task.txt"),
    "validator passed without criterion evidence\n",
    "utf8",
  );

  const result = await new TaskCommitService(database).commitPassingTask(
    requestFor(graph, repository, "criterion-gate"),
  );

  assert.equal(result.status, "STOPPED");
  assert.equal(result.code, "NOT_VALIDATED");
  assert.match(result.reason, /acceptance criteria remain/u);
  assert.equal(git(repository, ["rev-parse", "HEAD"]).trim(), checkpointHead);
  assert.equal(git(repository, ["diff", "--cached", "--name-only"]).trim(), "");
  assert.equal(
    database.repositories.taskCommitIntents.findByAttemptId(graph.attempt.id),
    undefined,
  );
  database.close();
});
