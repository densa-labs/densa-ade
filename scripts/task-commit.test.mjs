import {
  captureValidationWorkspace,
  recordValidationWorkspace,
  validationWorkspaceEventId,
} from "../packages/core/dist/validation-workspace.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  RunCheckpointService,
  StateTransitionService,
  TaskCommitService,
  ValidationPipeline,
} from "@densa-ade/core";
import { DensaAdeDatabase } from "@densa-ade/core/persistence";

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
  writeFileSync(join(repository, ".gitignore"), ".densa-ade/runtime/\n*.sqlite\n", "utf8");
  writeFileSync(join(repository, "task.txt"), "before\n", "utf8");
  writeFileSync(join(repository, "user.txt"), "user baseline\n", "utf8");
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
  { passed = true, planBased = true, withEvidence = planBased } = {},
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
  if (withEvidence) {
    database.repositories.validationResults.create({
      id: `${validation.id}:result:0`,
      validationRunId: validation.id,
      position: 0,
      validatorId: validation.validatorId,
      validatorVersion: "1",
      evidenceSource: "deterministic_validator",
      policy: "required",
      status: passed ? "passed" : "failed",
      startedAt: validation.startedAt,
      completedAt: validation.completedAt,
      diagnostics: [],
      relatedAcceptanceCriteria: [...task.acceptanceCriteria],
      retryRelevant: !passed,
    });
  }
  return {
    ...graph,
    task,
    validation,
    checkpoint,
    database,
    executionPath: checkpoint.run.workspacePath,
  };
}

async function requestFor(graph, repository, suffix = "success") {
  if (
    graph.validation.passed &&
    !graph.database.repositories.events.findById(validationWorkspaceEventId(graph.validation.id))
  ) {
    const evidence = await captureValidationWorkspace(repository);
    recordValidationWorkspace(graph.database, graph.validation.id, evidence);
  }
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
  git(repository, ["config", "user.name", "Densa ADE Fixture"]);
  git(repository, ["config", "user.email", "densa-fixture@localhost"]);
  git(repository, ["config", "commit.gpgsign", "false"]);
}

test.after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

test("automatic commits never sweep an explicitly named .env into Git history", async () => {
  const root = createRoot();
  let repository = createRepository(root);
  const database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
  const graph = await preparePassingAttempt(database, repository);
  repository = graph.executionPath;
  configureCommitIdentity(repository);
  writeFileSync(join(repository, ".env"), "PASSWORD=fixture-canary-only\n");
  const result = await new TaskCommitService(database).commitPassingTask({
    ...(await requestFor(graph, repository)),
    intendedPaths: [".env"],
  });
  assert.equal(result.status, "STOPPED");
  assert.equal(result.code, "POLICY_DENIED");
  assert.equal(git(repository, ["rev-parse", "HEAD"]).trim(), graph.checkpoint.checkpoint.gitHead);
  assert.equal(git(repository, ["diff", "--cached", "--name-only"]).trim(), "");
  database.close();
});

test("a newly selected legacy validation without criterion evidence cannot authorize a commit", async () => {
  const root = createRoot();
  let repository = createRepository(root);
  const database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
  try {
    const graph = await preparePassingAttempt(database, repository, { planBased: false });
    repository = graph.executionPath;
    configureCommitIdentity(repository);
    writeFileSync(join(repository, "task.txt"), "legacy validator claimed pass\n");
    const result = await new TaskCommitService(database).commitPassingTask(
      await requestFor(graph, repository),
    );
    assert.equal(result.status, "STOPPED");
    assert.equal(result.code, "NOT_VALIDATED");
    assert.match(result.reason, /criterion evidence|plan/u);
  } finally {
    database.close();
  }
});

test("the public validation pipeline records commit-verifiable workspace evidence", async () => {
  const root = createRoot();
  let repository = createRepository(root);
  const database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
  const graph = await preparePassingAttempt(database, repository);
  repository = graph.executionPath;
  configureCommitIdentity(repository);
  writeFileSync(join(repository, "task.txt"), "pipeline validated\n");
  const pipeline = await new ValidationPipeline(database, { now: () => committedAt }).execute({
    runId: "pipeline-run",
    projectId: graph.project.id,
    taskId: graph.task.id,
    attemptId: graph.attempt.id,
    workspacePath: graph.checkpoint.run.sourceWorkspacePath,
    plan: {
      id: "pipeline-plan",
      version: "1",
      validators: [
        {
          validator: {
            id: "real-file-check",
            version: "1",
            async validate(context) {
              assert.equal(context.workspacePath, repository);
              return {
                status:
                  readFileSync(join(repository, "task.txt"), "utf8") === "pipeline validated\n"
                    ? "passed"
                    : "failed",
                diagnostics: [],
                retryRelevant: true,
              };
            },
          },
          policy: "required",
          evidenceSource: "deterministic_validator",
          relatedAcceptanceCriteria: graph.task.acceptanceCriteria,
        },
      ],
    },
  });
  assert.equal(pipeline.canComplete, true);
  const result = await new TaskCommitService(database).commitPassingTask({
    ...(await requestFor(graph, repository)),
    validationRunId: pipeline.run.id,
  });
  assert.equal(result.status, "COMMITTED", JSON.stringify(result));
  database.close();
});

test("a failed Git hook can retry its own staging without accepting different worktree bytes", async () => {
  const root = createRoot();
  let repository = createRepository(root);
  const database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
  const graph = await preparePassingAttempt(database, repository);
  repository = graph.executionPath;
  configureCommitIdentity(repository);
  writeFileSync(join(repository, "task.txt"), "validated retry\n");
  const request = await requestFor(graph, repository);
  const hook = join(graph.checkpoint.run.sourceWorkspacePath, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o700);
  assert.equal(
    (await new TaskCommitService(database).commitPassingTask(request)).code,
    "GIT_COMMAND_FAILED",
  );
  rmSync(hook);
  const recovered = await new TaskCommitService(database).commitPassingTask(request);
  assert.equal(recovered.status, "COMMITTED", JSON.stringify(recovered));
  database.close();
});

test("literal intended filenames never expand into unrelated human paths", async () => {
  const root = createRoot();
  let repository = createRepository(root);
  const database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
  const graph = await preparePassingAttempt(database, repository);
  repository = graph.executionPath;
  configureCommitIdentity(repository);
  writeFileSync(join(repository, "literal*.txt"), "task result\n");
  writeFileSync(join(repository, "literal-human.txt"), "human draft\n");
  const result = await new TaskCommitService(database).commitPassingTask({
    ...(await requestFor(graph, repository)),
    intendedPaths: ["literal*.txt"],
  });
  assert.equal(result.status, "COMMITTED", JSON.stringify(result));
  assert.equal(
    git(repository, ["show", "--format=", "--name-only", "HEAD"]).trim(),
    "literal*.txt",
  );
  assert.equal(readFileSync(join(repository, "literal-human.txt"), "utf8"), "human draft\n");
  assert.equal(
    git(repository, ["ls-files", "--error-unmatch", "literal*.txt"]).trim(),
    "literal*.txt",
  );
  database.close();
});

test("a renamed task file is committed as the exact source and destination paths", async () => {
  const root = createRoot();
  let repository = createRepository(root);
  const database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
  const graph = await preparePassingAttempt(database, repository);
  repository = graph.executionPath;
  configureCommitIdentity(repository);
  git(repository, ["mv", "task.txt", "renamed.txt"]);
  const result = await new TaskCommitService(database).commitPassingTask({
    ...(await requestFor(graph, repository)),
    intendedPaths: ["task.txt", "renamed.txt"],
  });
  assert.equal(result.status, "COMMITTED", JSON.stringify(result));
  database.close();
});

test("an older passing attempt cannot complete a task after a newer attempt exists", async () => {
  const root = createRoot();
  let repository = createRepository(root);
  const database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
  const graph = await preparePassingAttempt(database, repository);
  repository = graph.executionPath;
  configureCommitIdentity(repository);
  writeFileSync(join(repository, "task.txt"), "old output\n");
  database.repositories.attempts.create({
    id: "attempt-newer",
    taskId: graph.task.id,
    number: 2,
    startedAt: committedAt,
  });
  const result = await new TaskCommitService(database).commitPassingTask(
    await requestFor(graph, repository),
  );
  assert.equal(result.status, "STOPPED");
  assert.equal(result.code, "ATTEMPT_MISMATCH");
  assert.equal(database.repositories.tasks.findById(graph.task.id).state, "VALIDATING");
  assert.equal(git(repository, ["rev-parse", "HEAD"]).trim(), graph.checkpoint.checkpoint.gitHead);
  database.close();
});

test("edits after passing validation are preserved and never certified by a task commit", async () => {
  const root = createRoot();
  let repository = createRepository(root);
  const database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
  const graph = await preparePassingAttempt(database, repository);
  repository = graph.executionPath;
  configureCommitIdentity(repository);
  writeFileSync(join(repository, "task.txt"), "validated\n");
  const request = await requestFor(graph, repository);
  writeFileSync(join(repository, "task.txt"), "later human edit\n");
  const result = await new TaskCommitService(database).commitPassingTask(request);
  assert.equal(result.status, "STOPPED");
  assert.equal(result.code, "WORKSPACE_MISMATCH");
  assert.equal(database.repositories.tasks.findById(graph.task.id).state, "VALIDATING");
  assert.equal(git(repository, ["rev-parse", "HEAD"]).trim(), graph.checkpoint.checkpoint.gitHead);
  assert.equal(readFileSync(join(repository, "task.txt"), "utf8"), "later human edit\n");
  database.close();
});

test("a hook cannot certify different bytes, even when filenames and commit message match", async () => {
  const root = createRoot();
  let repository = createRepository(root);
  const database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
  const graph = await preparePassingAttempt(database, repository);
  repository = graph.executionPath;
  configureCommitIdentity(repository);
  writeFileSync(join(repository, "task.txt"), "validated\n");
  const request = await requestFor(graph, repository);
  const hook = join(graph.checkpoint.run.sourceWorkspacePath, ".git", "hooks", "pre-commit");
  writeFileSync(
    hook,
    "#!/bin/sh\nprintf 'unvalidated hook output\\n' > task.txt\ngit add -- task.txt\n",
  );
  chmodSync(hook, 0o700);
  const result = await new TaskCommitService(database).commitPassingTask(request);
  assert.equal(result.status, "STOPPED");
  assert.equal(result.code, "COMMIT_VERIFICATION_FAILED");
  assert.equal(database.repositories.tasks.findById(graph.task.id).state, "VALIDATING");
  database.close();
  const reopened = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
  const recovery = await new TaskCommitService(reopened).commitPassingTask(request);
  assert.equal(recovery.status, "STOPPED");
  assert.equal(reopened.repositories.tasks.findById(graph.task.id).state, "VALIDATING");
  reopened.close();
});

test("a superseding failed validation prevents an earlier passing result from committing", async () => {
  const root = createRoot();
  let repository = createRepository(root);
  const database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
  const graph = await preparePassingAttempt(database, repository);
  repository = graph.executionPath;
  configureCommitIdentity(repository);
  writeFileSync(join(repository, "task.txt"), "validated\n");
  const request = await requestFor(graph, repository);
  database.repositories.validationRuns.create({
    ...graph.validation,
    id: "validation-newer",
    startedAt: committedAt,
    completedAt: committedAt,
    passed: false,
  });
  const result = await new TaskCommitService(database).commitPassingTask(request);
  assert.equal(result.status, "STOPPED");
  assert.equal(result.code, "NOT_VALIDATED");
  assert.equal(git(repository, ["rev-parse", "HEAD"]).trim(), graph.checkpoint.checkpoint.gitHead);
  database.close();
});

test("commits exactly the intended passing-task change and atomically completes the task", async () => {
  const root = createRoot();
  let repository = createRepository(root);
  const remote = join(root, "origin.git");
  git(root, ["init", "--quiet", "--bare", "--initial-branch=main", remote]);
  git(repository, ["remote", "add", "origin", remote]);
  git(repository, ["push", "--quiet", "--set-upstream", "origin", "main"]);
  const remoteBefore = git(remote, ["for-each-ref", "--format=%(refname):%(objectname)"]);
  const databasePath = join(root, "runtime.sqlite");
  const database = DensaAdeDatabase.open(databasePath);
  const graph = await preparePassingAttempt(database, repository);
  repository = graph.executionPath;
  configureCommitIdentity(repository);
  writeFileSync(join(repository, "task.txt"), "after\n", "utf8");

  const result = await new TaskCommitService(database).commitPassingTask(
    await requestFor(graph, repository),
  );

  assert.equal(result.status, "COMMITTED", JSON.stringify(result));
  assert.equal(result.commitMessage, "densa-ade: TASK-042 write the intended file");
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
    await requestFor(graph, repository, "repeat"),
  );
  assert.equal(repeated.status, "COMMITTED");
  assert.equal(repeated.recoveredExistingCommit, true);
  assert.equal(git(repository, ["rev-list", "--count", "HEAD"]).trim(), "2");
  database.close();

  const reopened = DensaAdeDatabase.open(databasePath);
  assert.equal(
    reopened.repositories.attempts.findById(graph.attempt.id).commitSha,
    result.commitSha,
  );
  reopened.close();
});

test("preserves unrelated staged and unstaged user changes outside the intended path", async () => {
  const root = createRoot();
  let repository = createRepository(root);
  const database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
  const graph = await preparePassingAttempt(database, repository);
  repository = graph.executionPath;
  configureCommitIdentity(repository);
  writeFileSync(join(repository, "task.txt"), "task result\n", "utf8");
  writeFileSync(join(repository, "user.txt"), "staged user edit\n", "utf8");
  git(repository, ["add", "--", "user.txt"]);
  writeFileSync(join(repository, "user-draft.txt"), "unstaged user draft\n", "utf8");

  const result = await new TaskCommitService(database).commitPassingTask(
    await requestFor(graph, repository),
  );

  assert.equal(result.status, "COMMITTED", JSON.stringify(result));
  assert.deepEqual(result.preservedChangedPaths, ["user-draft.txt", "user.txt"]);
  assert.equal(git(repository, ["show", "--format=", "--name-only", "HEAD"]).trim(), "task.txt");
  assert.equal(git(repository, ["diff", "--cached", "--name-only"]).trim(), "user.txt");
  assert.equal(readFileSync(join(repository, "user.txt"), "utf8"), "staged user edit\n");
  assert.equal(readFileSync(join(repository, "user-draft.txt"), "utf8"), "unstaged user draft\n");
  database.close();
});

test("a Git commit failure leaves the task VALIDATING with no persisted commit SHA", async () => {
  const root = createRoot();
  let repository = createRepository(root);
  const database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
  const graph = await preparePassingAttempt(database, repository);
  repository = graph.executionPath;
  configureCommitIdentity(repository);
  const hook = join(graph.checkpoint.run.sourceWorkspacePath, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n", "utf8");
  chmodSync(hook, 0o700);
  const checkpointHead = git(repository, ["rev-parse", "HEAD"]).trim();
  writeFileSync(join(repository, "task.txt"), "cannot commit without identity\n", "utf8");

  const result = await new TaskCommitService(database).commitPassingTask(
    await requestFor(graph, repository),
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
  let repository = createRepository(root);
  const database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
  const graph = await preparePassingAttempt(database, repository);
  repository = graph.executionPath;
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
    await requestFor(graph, repository, "conflict"),
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
    await requestFor(graph, repository, "recovered"),
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
  let repository = createRepository(root);
  const database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
  const graph = await preparePassingAttempt(database, repository, { passed: false });
  repository = graph.executionPath;
  configureCommitIdentity(repository);
  const checkpointHead = git(repository, ["rev-parse", "HEAD"]).trim();
  writeFileSync(join(repository, "task.txt"), "unvalidated result\n", "utf8");

  const result = await new TaskCommitService(database).commitPassingTask(
    await requestFor(graph, repository),
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
  let repository = createRepository(root);
  const database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
  const graph = await preparePassingAttempt(database, repository, {
    planBased: true,
    withEvidence: false,
  });
  repository = graph.executionPath;
  configureCommitIdentity(repository);
  const checkpointHead = git(repository, ["rev-parse", "HEAD"]).trim();
  writeFileSync(
    join(repository, "task.txt"),
    "validator passed without criterion evidence\n",
    "utf8",
  );

  const result = await new TaskCommitService(database).commitPassingTask(
    await requestFor(graph, repository, "criterion-gate"),
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

test("publication preserves source staging even with merge.autostash enabled", async () => {
  const root = createRoot();
  const source = createRepository(root);
  const database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
  try {
    const graph = await preparePassingAttempt(database, source);
    configureCommitIdentity(source);
    git(source, ["config", "merge.autostash", "true"]);
    writeFileSync(join(source, "user.txt"), "human staged before terminal\n");
    git(source, ["add", "user.txt"]);
    writeFileSync(join(source, "user.txt"), "human unstaged after staging\n");
    const index = git(source, ["ls-files", "--stage", "user.txt"]);
    writeFileSync(join(graph.executionPath, "task.txt"), "worker validated\n");
    const result = await new TaskCommitService(database).commitPassingTask(
      await requestFor(graph, graph.executionPath),
    );
    assert.equal(result.status, "COMMITTED", JSON.stringify(result));
    assert.equal(git(source, ["branch", "--show-current"]).trim(), "main");
    assert.equal(git(source, ["rev-parse", "HEAD"]).trim(), result.commitSha);
    assert.equal(readFileSync(join(source, "task.txt"), "utf8"), "worker validated\n");
    assert.equal(readFileSync(join(source, "user.txt"), "utf8"), "human unstaged after staging\n");
    assert.equal(git(source, ["ls-files", "--stage", "user.txt"]), index);
    assert.deepEqual(result.preservedChangedPaths, ["user.txt"]);
  } finally {
    database.close();
  }
});

test("publication stops on a source edit saved before worker terminal capture", async () => {
  const root = createRoot();
  const source = createRepository(root);
  const database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
  try {
    const graph = await preparePassingAttempt(database, source);
    configureCommitIdentity(source);
    writeFileSync(join(graph.executionPath, "task.txt"), "worker validated\n");
    writeFileSync(join(source, "task.txt"), "human before terminal\n");
    const result = await new TaskCommitService(database).commitPassingTask(
      await requestFor(graph, graph.executionPath),
    );
    assert.equal(result.code, "PUBLICATION_STOPPED", JSON.stringify(result));
    assert.equal(git(source, ["rev-parse", "HEAD"]).trim(), graph.checkpoint.checkpoint.gitHead);
    assert.equal(readFileSync(join(source, "task.txt"), "utf8"), "human before terminal\n");
    assert.equal(database.repositories.tasks.findById(graph.task.id).state, "VALIDATING");
    assert.equal(database.repositories.attempts.findById(graph.attempt.id).completedAt, undefined);
  } finally {
    database.close();
  }
});

test("branch changes after publication intent cannot advance the wrong branch", async () => {
  const root = createRoot();
  const source = createRepository(root);
  const database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
  try {
    const graph = await preparePassingAttempt(database, source);
    configureCommitIdentity(source);
    writeFileSync(join(graph.executionPath, "task.txt"), "worker validated\n");
    const create = database.repositories.taskPublicationIntents.create.bind(
      database.repositories.taskPublicationIntents,
    );
    database.repositories.taskPublicationIntents.create = (intent) => {
      const value = create(intent);
      git(source, ["switch", "--quiet", "-c", "human-branch"]);
      return value;
    };
    const result = await new TaskCommitService(database).commitPassingTask(
      await requestFor(graph, graph.executionPath),
    );
    assert.equal(result.code, "PUBLICATION_STOPPED", JSON.stringify(result));
    assert.equal(git(source, ["rev-parse", "main"]).trim(), graph.checkpoint.checkpoint.gitHead);
    assert.equal(
      git(source, ["rev-parse", "human-branch"]).trim(),
      graph.checkpoint.checkpoint.gitHead,
    );
    assert.equal(readFileSync(join(source, "task.txt"), "utf8"), "before\n");
    assert.equal(git(source, ["status", "--porcelain"]), "");
  } finally {
    database.close();
  }
});

test("publication outcome interruption recovers the same commit after reopening Core", async () => {
  const root = createRoot();
  const source = createRepository(root);
  const databasePath = join(root, "runtime.sqlite");
  let database = DensaAdeDatabase.open(databasePath);
  try {
    const graph = await preparePassingAttempt(database, source);
    configureCommitIdentity(source);
    writeFileSync(join(graph.executionPath, "task.txt"), "worker validated\n");
    const request = await requestFor(graph, graph.executionPath);
    database.repositories.taskPublicationIntents.recordPublished = () => {
      throw new Error("injected publication persistence failure");
    };
    const stopped = await new TaskCommitService(database).commitPassingTask(request);
    assert.equal(stopped.code, "PUBLICATION_STOPPED", JSON.stringify(stopped));
    assert.equal(git(source, ["rev-parse", "HEAD"]).trim(), stopped.commitSha);
    assert.equal(database.repositories.tasks.findById(graph.task.id).state, "VALIDATING");
    database.close();
    database = DensaAdeDatabase.open(databasePath);
    const recovered = await new TaskCommitService(database).commitPassingTask(request);
    assert.equal(recovered.status, "COMMITTED", JSON.stringify(recovered));
    assert.equal(recovered.commitSha, stopped.commitSha);
    assert.ok(
      database.repositories.taskPublicationIntents.findByAttemptId(graph.attempt.id).publishedAt,
    );
    assert.equal(git(source, ["rev-list", "--count", "HEAD"]).trim(), "2");
  } finally {
    database.close();
  }
});

test("a validation failure recorded during publication prevents final completion", async () => {
  const root = createRoot();
  const source = createRepository(root);
  const database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
  try {
    const graph = await preparePassingAttempt(database, source);
    configureCommitIdentity(source);
    writeFileSync(join(graph.executionPath, "task.txt"), "worker validated\n");
    const publish = database.repositories.taskPublicationIntents.recordPublished.bind(
      database.repositories.taskPublicationIntents,
    );
    database.repositories.taskPublicationIntents.recordPublished = (...args) => {
      const result = publish(...args);
      database.repositories.validationRuns.create({
        ...graph.validation,
        id: "newer-during-publication",
        startedAt: "2026-08-26T08:25:00.000Z",
        completedAt: "2026-08-26T08:29:00.000Z",
        passed: false,
      });
      return result;
    };
    const result = await new TaskCommitService(database).commitPassingTask(
      await requestFor(graph, graph.executionPath),
    );
    assert.equal(result.code, "NOT_VALIDATED", JSON.stringify(result));
    assert.equal(database.repositories.tasks.findById(graph.task.id).state, "VALIDATING");
    assert.equal(database.repositories.attempts.findById(graph.attempt.id).completedAt, undefined);
  } finally {
    database.close();
  }
});
