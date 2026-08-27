import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { SingleTaskOrchestrator, StateTransitionService } from "@densa/core";
import { DensaDatabase } from "@densa/core/persistence";
import { FakeAgentAdapter } from "@densa/testing";

const temporaryRoots = new Set();
const createdAt = "2026-08-27T00:00:00.000Z";

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

function clock() {
  let tick = 0;
  return () => {
    const value = new Date(Date.parse(createdAt) + tick * 1_000).toISOString();
    tick += 1;
    return value;
  };
}

function createFixture(prefix = "densa-task-orchestrator-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.add(root);
  const repository = join(root, "workspace");
  git(root, ["init", "--quiet", "--initial-branch=main", repository]);
  writeFileSync(join(repository, ".gitignore"), ".densa/runtime/\n*.sqlite\n", "utf8");
  writeFileSync(join(repository, "task.txt"), "baseline\n", "utf8");
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
  git(repository, ["config", "user.name", "Densa Fixture"]);
  git(repository, ["config", "user.email", "densa-fixture@localhost"]);
  git(repository, ["config", "commit.gpgsign", "false"]);

  const databasePath = join(root, "runtime.sqlite");
  const database = DensaDatabase.open(databasePath);
  const project = {
    id: "project-task-lifecycle",
    name: "Task lifecycle proof",
    state: "DRAFT",
    executionMode: "guided",
    createdAt,
    updatedAt: createdAt,
  };
  const phase = {
    id: "phase-task-lifecycle",
    projectId: project.id,
    title: "Persistent orchestration",
    state: "PENDING",
    position: 0,
    createdAt,
    updatedAt: createdAt,
  };
  const task = {
    id: "TASK-LIFECYCLE-001",
    projectId: project.id,
    phaseId: phase.id,
    title: "write validated output",
    state: "PENDING",
    position: 0,
    acceptanceCriteria: ["task.txt contains the validator-approved output"],
    dependencyIds: [],
    createdAt,
    updatedAt: createdAt,
  };
  database.repositories.projects.create(project);
  database.repositories.phases.create(phase);
  database.repositories.tasks.create(task);
  database.persistStateTransition(
    new StateTransitionService().transitionTask(task, "READY", {
      actor: "densa-core:test",
      occurredAt: "2026-08-27T00:00:00.500Z",
    }),
    "event-task-ready",
  );
  return { root, repository, databasePath, database, project, task };
}

function requestFor(fixture, adapter, validator, overrides = {}) {
  return {
    projectId: fixture.project.id,
    taskId: fixture.task.id,
    workspacePath: fixture.repository,
    workerPrompt: "Modify task.txt. Agent assertions of success are not validation evidence.",
    ownedPaths: ["task.txt"],
    intendedPaths: ["task.txt"],
    adapter,
    validator,
    actor: "densa-core:test",
    ...overrides,
  };
}

function passingValidator(expected) {
  return {
    validatorId: "fixture-validator",
    async validate({ workspacePath, attempt }) {
      const actual = readFileSync(join(workspacePath, "task.txt"), "utf8");
      return {
        passed: actual === expected,
        diagnostics: { attemptNumber: attempt.number, expected, actual },
      };
    },
  };
}

test.after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

test("passes first try only after independent validation and commits the exact task output", async () => {
  const fixture = createFixture("densa-orchestrator-pass-");
  const streamed = [];
  const adapter = new FakeAgentAdapter({
    finalMessage: "Done; trust me.",
    onExecute() {
      const [attempt] = fixture.database.repositories.attempts.listByTaskId(fixture.task.id);
      assert.equal(attempt.number, 1);
      assert.ok(fixture.database.repositories.agentRuns.findByAttemptId(attempt.id));
      assert.equal(fixture.database.repositories.tasks.findById(fixture.task.id).state, "RUNNING");
      writeFileSync(join(fixture.repository, "task.txt"), "accepted\n", "utf8");
    },
  });
  const result = await new SingleTaskOrchestrator(fixture.database, { now: clock() }).execute(
    requestFor(fixture, adapter, passingValidator("accepted\n"), {
      onAgentEvent(event) {
        streamed.push(event.type);
      },
    }),
  );

  assert.equal(result.status, "COMPLETED");
  assert.equal(result.attemptCount, 1);
  assert.deepEqual(streamed, ["run.started", "run.terminal"]);
  assert.equal(fixture.database.repositories.tasks.findById(fixture.task.id).state, "COMPLETED");
  const [attempt] = fixture.database.repositories.attempts.listByTaskId(fixture.task.id);
  assert.ok(attempt.completedAt);
  assert.equal(attempt.commitSha, result.commitSha);
  assert.equal(git(fixture.repository, ["rev-parse", "HEAD"]).trim(), result.commitSha);
  assert.equal(readFileSync(join(fixture.repository, "task.txt"), "utf8"), "accepted\n");
  assert.equal(
    fixture.database.repositories.events
      .replay({ projectId: fixture.project.id })
      .some((event) => event.type === "VALIDATION_PASSED"),
    true,
  );
  fixture.database.close();
});

test("fails validation, rolls back, supplies persisted retry evidence, then passes", async () => {
  const fixture = createFixture("densa-orchestrator-retry-pass-");
  const adapter = new FakeAgentAdapter({
    finalMessage: "Every attempt is complete.",
    onExecute(request) {
      const number = adapter.requests.length;
      if (number === 2) {
        assert.match(request.prompt, /Required retry evidence/u);
        assert.match(request.prompt, /first attempt is intentionally rejected/u);
      }
      writeFileSync(
        join(fixture.repository, "task.txt"),
        number === 1 ? "rejected\n" : "accepted\n",
        "utf8",
      );
    },
  });
  const validator = {
    validatorId: "fixture-validator",
    async validate({ workspacePath, attempt }) {
      const actual = readFileSync(join(workspacePath, "task.txt"), "utf8");
      return attempt.number === 1
        ? {
            passed: false,
            diagnostics: {
              attemptNumber: 1,
              failingCriterion: "first attempt is intentionally rejected",
              actual,
            },
          }
        : { passed: actual === "accepted\n", diagnostics: { attemptNumber: 2, actual } };
    },
  };

  const result = await new SingleTaskOrchestrator(fixture.database, { now: clock() }).execute(
    requestFor(fixture, adapter, validator),
  );

  assert.equal(result.status, "COMPLETED");
  assert.equal(result.attemptCount, 2);
  const attempts = fixture.database.repositories.attempts.listByTaskId(fixture.task.id);
  assert.equal(attempts.length, 2);
  assert.ok(attempts.every((attempt) => attempt.completedAt !== undefined));
  const firstPlan = fixture.database.repositories.attemptRollbackPlans.findByAttemptId(
    attempts[0].id,
  );
  assert.equal(firstPlan.diagnostics.failingCriterion, "first attempt is intentionally rejected");
  assert.ok(firstPlan.appliedAt);
  assert.equal(readFileSync(join(fixture.repository, "task.txt"), "utf8"), "accepted\n");
  fixture.database.close();

  const reopened = DensaDatabase.open(fixture.databasePath);
  assert.equal(reopened.repositories.attempts.listByTaskId(fixture.task.id).length, 2);
  assert.equal(
    reopened.repositories.attemptRollbackPlans.findByAttemptId(attempts[0].id).diagnostics
      .failingCriterion,
    "first attempt is intentionally rejected",
  );
  reopened.close();
});

test("four validation failures persist diagnostics, restore Git, and block the task", async () => {
  const fixture = createFixture("densa-orchestrator-four-failures-");
  const startingHead = git(fixture.repository, ["rev-parse", "HEAD"]).trim();
  const adapter = new FakeAgentAdapter({
    finalMessage: "Done despite the validator.",
    onExecute() {
      writeFileSync(
        join(fixture.repository, "task.txt"),
        `invalid attempt ${String(adapter.requests.length)}\n`,
        "utf8",
      );
    },
  });
  const validator = {
    validatorId: "always-fail-validator",
    async validate({ attempt, workspacePath }) {
      return {
        passed: false,
        diagnostics: {
          attemptNumber: attempt.number,
          failingCriterion: "output must be independently accepted",
          actual: readFileSync(join(workspacePath, "task.txt"), "utf8"),
        },
      };
    },
  };

  const result = await new SingleTaskOrchestrator(fixture.database, { now: clock() }).execute(
    requestFor(fixture, adapter, validator),
  );

  assert.equal(result.status, "BLOCKED");
  assert.equal(result.attemptCount, 4);
  assert.equal(fixture.database.repositories.tasks.findById(fixture.task.id).state, "BLOCKED");
  const attempts = fixture.database.repositories.attempts.listByTaskId(fixture.task.id);
  assert.equal(attempts.length, 4);
  assert.ok(attempts.every((attempt) => attempt.completedAt !== undefined));
  for (const attempt of attempts) {
    const plan = fixture.database.repositories.attemptRollbackPlans.findByAttemptId(attempt.id);
    assert.equal(plan.diagnostics.attemptNumber, attempt.number);
    assert.ok(plan.appliedAt);
  }
  assert.equal(readFileSync(join(fixture.repository, "task.txt"), "utf8"), "baseline\n");
  assert.equal(git(fixture.repository, ["rev-parse", "HEAD"]).trim(), startingHead);
  assert.equal(git(fixture.repository, ["status", "--porcelain"]), "");
  fixture.database.close();

  const reopened = DensaDatabase.open(fixture.databasePath);
  assert.equal(reopened.repositories.tasks.findById(fixture.task.id).state, "BLOCKED");
  assert.equal(reopened.repositories.attempts.listByTaskId(fixture.task.id).length, 4);
  reopened.close();
});

test("cancellation is explicit, durable, and rolls back owned output", async () => {
  const fixture = createFixture("densa-orchestrator-cancel-");
  const controller = new globalThis.AbortController();
  const adapter = new FakeAgentAdapter({
    holdOpen: true,
    onExecute() {
      writeFileSync(join(fixture.repository, "task.txt"), "cancelled output\n", "utf8");
    },
  });
  const result = await new SingleTaskOrchestrator(fixture.database, { now: clock() }).execute(
    requestFor(fixture, adapter, passingValidator("cancelled output\n"), {
      signal: controller.signal,
      onAgentEvent(event) {
        if (event.type === "run.started") controller.abort();
      },
    }),
  );

  assert.equal(result.status, "CANCELLED");
  assert.deepEqual(adapter.cancelledRunIds, [adapter.requests[0].runId]);
  assert.equal(fixture.database.repositories.tasks.findById(fixture.task.id).state, "CANCELLED");
  assert.equal(readFileSync(join(fixture.repository, "task.txt"), "utf8"), "baseline\n");
  assert.equal(
    fixture.database.repositories.validationRuns.listByTaskId(fixture.task.id).length,
    0,
  );
  fixture.database.close();
});

test("worker process crash persists diagnostics and leaves an interrupted coherent checkpoint", async () => {
  const fixture = createFixture("densa-orchestrator-crash-");
  const startingHead = git(fixture.repository, ["rev-parse", "HEAD"]).trim();
  const adapter = new FakeAgentAdapter({
    onExecute() {
      writeFileSync(join(fixture.repository, "task.txt"), "partial crash output\n", "utf8");
      throw new Error("fixture worker process crashed");
    },
  });
  const result = await new SingleTaskOrchestrator(fixture.database, { now: clock() }).execute(
    requestFor(fixture, adapter, passingValidator("partial crash output\n")),
  );

  assert.equal(result.status, "INTERRUPTED");
  assert.equal(fixture.database.repositories.tasks.findById(fixture.task.id).state, "INTERRUPTED");
  const [attempt] = fixture.database.repositories.attempts.listByTaskId(fixture.task.id);
  assert.ok(attempt.completedAt);
  const plan = fixture.database.repositories.attemptRollbackPlans.findByAttemptId(attempt.id);
  assert.equal(plan.diagnostics.kind, "process_crash");
  assert.match(plan.diagnostics.message, /fixture worker process crashed/u);
  assert.ok(plan.appliedAt);
  assert.equal(readFileSync(join(fixture.repository, "task.txt"), "utf8"), "baseline\n");
  assert.equal(git(fixture.repository, ["rev-parse", "HEAD"]).trim(), startingHead);
  assert.equal(git(fixture.repository, ["status", "--porcelain"]), "");
  fixture.database.close();
});

test("orchestrator source stays editor-independent", () => {
  const source = readFileSync(
    new globalThis.URL("../packages/core/src/task-orchestrator.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /(?:from|import\()\s*["']vs\//u);
  assert.doesNotMatch(source, /vscode/u);
});
