import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  RunCheckpointService,
  RecoveryInspector,
  GitWorkspaceProbe,
  WorkspacePreflight,
  densaAdeRunBranchName,
  densaRunBranchName,
} from "@densa-ade/core";
import { DensaAdeDatabase } from "@densa-ade/core/persistence";

const temporaryRoots = new Set();
const createdAt = "2026-08-26T08:00:00.000Z";

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

function createRoot(prefix = "densa-run-checkpoint-test-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.add(root);
  return root;
}

function createRepository(root = createRoot()) {
  const repository = join(root, "workspace");
  git(root, ["init", "--quiet", "--initial-branch=main", repository]);
  writeFileSync(join(repository, ".gitignore"), ".densa-ade/runtime/\n*.sqlite\n", "utf8");
  writeFileSync(join(repository, "tracked.txt"), "user baseline\n", "utf8");
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

function seedGraph(database, taskCount = 1) {
  const project = {
    id: "project/run branch:proof",
    name: "Run checkpoint proof",
    state: "DRAFT",
    executionMode: "guided",
    createdAt,
    updatedAt: createdAt,
  };
  const phase = {
    id: "phase-run-checkpoint",
    projectId: project.id,
    title: "Safe Git execution",
    state: "PENDING",
    position: 0,
    createdAt,
    updatedAt: createdAt,
  };
  database.repositories.projects.create(project);
  database.repositories.phases.create(phase);
  const tasks = [];
  const attempts = [];
  for (let index = 0; index < taskCount; index += 1) {
    const task = {
      id: `task-run-${String(index + 1)}`,
      projectId: project.id,
      phaseId: phase.id,
      title: `Task ${String(index + 1)}`,
      state: "PENDING",
      position: index,
      acceptanceCriteria: ["A durable checkpoint exists"],
      dependencyIds: [],
      createdAt,
      updatedAt: createdAt,
    };
    const attempt = {
      id: `attempt-run-${String(index + 1)}`,
      taskId: task.id,
      number: 1,
      startedAt: createdAt,
    };
    database.repositories.tasks.create(task);
    database.repositories.attempts.create(attempt);
    tasks.push(task);
    attempts.push(attempt);
  }
  return { project, phase, tasks, attempts };
}

function requestFor(graph, workspacePath, index = 0) {
  const suffix = String(index + 1);
  return {
    projectId: graph.project.id,
    taskId: graph.tasks[index].id,
    attemptId: graph.attempts[index].id,
    checkpointId: `checkpoint-run-${suffix}`,
    runActivatedEventId: `event-run-activated-${suffix}`,
    checkpointEventId: `event-checkpoint-${suffix}`,
    workspacePath,
    createdAt: `2026-08-26T08:0${String(index)}:00.000Z`,
    actor: "densa-core:test",
  };
}

test.after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

test("a dirty snapshot after a clean preflight cannot become a task checkpoint", async () => {
  const root = createRoot();
  const repository = createRepository(root);
  const database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
  const graph = seedGraph(database);
  const result = await new RunCheckpointService(database, {
    workspaceProbe: {
      async inspect(workspacePath) {
        writeFileSync(join(repository, "late-human.txt"), "preserve me\n");
        return new GitWorkspaceProbe().inspect(workspacePath);
      },
    },
  }).prepareTask(requestFor(graph, repository));
  assert.equal(result.status, "STOPPED");
  assert.equal(result.code, "WORKSPACE_CHANGED");
  assert.equal(database.repositories.checkpoints.listByProjectId(graph.project.id).length, 0);
  assert.equal(readFileSync(join(repository, "late-human.txt"), "utf8"), "preserve me\n");
  database.close();
});

test("switching back to a run branch preserves colliding ignored user files", async () => {
  const root = createRoot();
  const repository = createRepository(root);
  const database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
  const graph = seedGraph(database, 2);
  await new RunCheckpointService(database).prepareTask(requestFor(graph, repository));
  writeFileSync(join(repository, "user.sqlite"), "run version\n");
  git(repository, ["add", "--force", "user.sqlite"]);
  git(repository, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@localhost",
    "commit",
    "-qm",
    "run artifact",
  ]);
  git(repository, ["switch", "main"]);
  writeFileSync(join(repository, "user.sqlite"), "irreplaceable ignored user data\n");
  const result = await new RunCheckpointService(database).prepareTask(
    requestFor(graph, repository, 1),
  );
  assert.equal(result.status, "STOPPED");
  assert.equal(
    readFileSync(join(repository, "user.sqlite"), "utf8"),
    "irreplaceable ignored user data\n",
  );
  database.close();
});

test("creates a predictable Densa ADE run branch and durable task-attempt checkpoint", async () => {
  const root = createRoot();
  const repository = createRepository(root);
  const databasePath = join(root, "runtime.sqlite");
  const startingCommit = git(repository, ["rev-parse", "HEAD"]).trim();
  const database = DensaAdeDatabase.open(databasePath);
  const graph = seedGraph(database);
  const request = requestFor(graph, repository);

  const result = await new RunCheckpointService(database).prepareTask(request);

  assert.equal(result.status, "READY");
  assert.equal(result.branchAction, "CREATED");
  assert.equal(result.recoveredExistingCheckpoint, false);
  assert.equal(result.run.branchName, densaAdeRunBranchName(graph.project.id));
  assert.equal(densaRunBranchName(graph.project.id), densaAdeRunBranchName(graph.project.id));
  assert.equal(result.run.status, "ACTIVE");
  assert.equal(result.run.startingCommit, startingCommit);
  assert.equal(git(repository, ["branch", "--show-current"]).trim(), "main");
  assert.equal(
    git(result.run.workspacePath, ["branch", "--show-current"]).trim(),
    result.run.branchName,
  );
  assert.equal(git(repository, ["rev-parse", "HEAD"]).trim(), startingCommit);
  assert.equal(result.checkpoint.taskId, graph.tasks[0].id);
  assert.equal(result.checkpoint.attemptId, graph.attempts[0].id);
  assert.equal(result.checkpoint.gitHead, startingCommit);
  assert.equal(result.checkpoint.gitStatus, "");
  assert.deepEqual(result.automaticActionsPerformed, ["CREATED_RUN_BRANCH", "RECORDED_CHECKPOINT"]);
  assert.equal(
    database.repositories.checkpoints.findByAttemptId(graph.attempts[0].id).id,
    result.checkpoint.id,
  );
  assert.deepEqual(
    database.repositories.events.replay({ projectId: graph.project.id }).map((event) => event.type),
    ["DENSA_RUN_BRANCH_ACTIVATED", "TASK_CHECKPOINT_CREATED"],
  );
  database.close();

  const reopened = DensaAdeDatabase.open(databasePath);
  const recovered = await new RunCheckpointService(reopened).prepareTask(request);
  assert.equal(recovered.status, "READY");
  assert.equal(recovered.recoveredExistingCheckpoint, true);
  assert.equal(recovered.checkpoint.id, result.checkpoint.id);
  assert.equal(reopened.repositories.checkpoints.listByTaskId(graph.tasks[0].id).length, 1);
  assert.equal(reopened.repositories.events.replay({ projectId: graph.project.id }).length, 2);
  reopened.close();
});

test("reuses persisted run ownership for a later task after Core restart", async () => {
  const root = createRoot();
  const repository = createRepository(root);
  const databasePath = join(root, "runtime.sqlite");
  let database = DensaAdeDatabase.open(databasePath);
  const graph = seedGraph(database, 2);
  const first = await new RunCheckpointService(database).prepareTask(
    requestFor(graph, repository, 0),
  );
  assert.equal(first.status, "READY");
  database.close();

  database = DensaAdeDatabase.open(databasePath);
  const second = await new RunCheckpointService(database).prepareTask(
    requestFor(graph, repository, 1),
  );
  assert.equal(second.status, "READY");
  assert.equal(second.branchAction, "REUSED");
  assert.equal(second.run.branchName, first.run.branchName);
  assert.equal(second.checkpoint.taskId, graph.tasks[1].id);
  assert.deepEqual(second.automaticActionsPerformed, ["RECORDED_CHECKPOINT"]);
  assert.equal(database.repositories.checkpoints.listByProjectId(graph.project.id).length, 2);
  database.close();
});

test("recovers a persisted branch-creation intent after Core restart", async () => {
  const root = createRoot();
  const repository = createRepository(root);
  const databasePath = join(root, "runtime.sqlite");
  const startingCommit = git(repository, ["rev-parse", "HEAD"]).trim();
  let database = DensaAdeDatabase.open(databasePath);
  const graph = seedGraph(database);
  const branchName = densaAdeRunBranchName(graph.project.id);
  database.repositories.densaAdeRunBranches.createCreating({
    projectId: graph.project.id,
    workspacePath: join(realpathSync(root), "execution"),
    sourceWorkspacePath: realpathSync(repository),
    branchName,
    sourceBranch: "main",
    startingCommit,
    createdAt,
  });
  git(repository, ["branch", branchName, startingCommit]);
  database.close();

  database = DensaAdeDatabase.open(databasePath);
  const result = await new RunCheckpointService(database).prepareTask(
    requestFor(graph, repository),
  );

  assert.equal(result.status, "READY");
  assert.equal(result.run.status, "ACTIVE");
  assert.equal(result.run.branchName, branchName);
  assert.equal(git(repository, ["branch", "--show-current"]).trim(), "main");
  assert.equal(git(result.run.workspacePath, ["branch", "--show-current"]).trim(), branchName);
  assert.deepEqual(result.automaticActionsPerformed, ["CREATED_RUN_BRANCH", "RECORDED_CHECKPOINT"]);
  database.close();
});

test("dirty user work stops branch setup and remains byte-for-byte untouched", async () => {
  const root = createRoot();
  const repository = createRepository(root);
  const database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
  const graph = seedGraph(database);
  writeFileSync(join(repository, "tracked.txt"), "user edit\n", "utf8");
  writeFileSync(join(repository, "untracked.txt"), "user draft\n", "utf8");
  const beforeStatus = git(repository, ["status", "--porcelain=v1", "--untracked-files=all"]);

  const result = await new RunCheckpointService(database).prepareTask(
    requestFor(graph, repository),
  );

  assert.equal(result.status, "STOPPED");
  assert.equal(result.code, "PREFLIGHT_STOPPED");
  assert.equal(result.preflight.decision.code, "USER_CHANGES_PRESENT");
  assert.equal(git(repository, ["branch", "--show-current"]).trim(), "main");
  assert.equal(
    git(repository, ["status", "--porcelain=v1", "--untracked-files=all"]),
    beforeStatus,
  );
  assert.equal(readFileSync(join(repository, "tracked.txt"), "utf8"), "user edit\n");
  assert.equal(readFileSync(join(repository, "untracked.txt"), "utf8"), "user draft\n");
  assert.equal(
    database.repositories.densaAdeRunBranches.findByProjectId(graph.project.id),
    undefined,
  );
  assert.equal(database.repositories.checkpoints.listByProjectId(graph.project.id).length, 0);
  database.close();
});

test("user work appearing during branch setup is preserved and blocks checkpoint creation", async () => {
  const root = createRoot();
  const repository = createRepository(root);
  const database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
  const graph = seedGraph(database);
  const actualPreflight = new WorkspacePreflight();
  let inspections = 0;
  const injectedPreflight = {
    async inspect(workspacePath) {
      inspections += 1;
      if (inspections === 2) {
        writeFileSync(join(repository, "appeared-during-setup.txt"), "user work\n", "utf8");
      }
      return await actualPreflight.inspect(workspacePath);
    },
  };

  const result = await new RunCheckpointService(database, {
    preflight: injectedPreflight,
  }).prepareTask(requestFor(graph, repository));

  assert.equal(result.status, "STOPPED");
  assert.equal(result.code, "WORKSPACE_CHANGED");
  assert.equal(result.preflight.decision.code, "USER_CHANGES_PRESENT");
  assert.equal(readFileSync(join(repository, "appeared-during-setup.txt"), "utf8"), "user work\n");
  assert.equal(database.repositories.checkpoints.listByProjectId(graph.project.id).length, 0);
  assert.equal(
    database.repositories.densaAdeRunBranches.findByProjectId(graph.project.id).status,
    "CREATING",
  );
  database.close();
});

test("an unowned predictable branch collision fails closed without adopting it", async () => {
  const root = createRoot();
  const repository = createRepository(root);
  const database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
  const graph = seedGraph(database);
  const branchName = densaAdeRunBranchName(graph.project.id);
  git(repository, ["branch", branchName]);
  const refsBefore = git(repository, [
    "for-each-ref",
    "--format=%(refname):%(objectname)",
    "refs/heads/",
  ]);

  const result = await new RunCheckpointService(database).prepareTask(
    requestFor(graph, repository),
  );

  assert.equal(result.status, "STOPPED");
  assert.equal(result.code, "BRANCH_COLLISION");
  assert.equal(git(repository, ["branch", "--show-current"]).trim(), "main");
  assert.equal(
    git(repository, ["for-each-ref", "--format=%(refname):%(objectname)", "refs/heads/"]),
    refsBefore,
  );
  assert.equal(
    database.repositories.densaAdeRunBranches.findByProjectId(graph.project.id),
    undefined,
  );
  database.close();
});

test("a current reserved branch without SQLite ownership is not trusted as a source", async () => {
  const root = createRoot();
  const repository = createRepository(root);
  const database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
  const graph = seedGraph(database);
  git(repository, ["switch", "--quiet", "--create", "densa-ade/run/unowned-user-branch"]);
  const headBefore = git(repository, ["rev-parse", "HEAD"]).trim();

  const result = await new RunCheckpointService(database).prepareTask(
    requestFor(graph, repository),
  );

  assert.equal(result.status, "STOPPED");
  assert.equal(result.code, "RUN_OWNERSHIP_MISMATCH");
  assert.equal(
    git(repository, ["branch", "--show-current"]).trim(),
    "densa-ade/run/unowned-user-branch",
  );
  assert.equal(git(repository, ["rev-parse", "HEAD"]).trim(), headBefore);
  assert.equal(
    database.repositories.densaAdeRunBranches.findByProjectId(graph.project.id),
    undefined,
  );
  database.close();
});

test("checkpoint setup never pushes its local run branch to a configured remote", async () => {
  const root = createRoot();
  const repository = createRepository(root);
  const remote = join(root, "origin.git");
  git(root, ["init", "--quiet", "--bare", "--initial-branch=main", remote]);
  git(repository, ["remote", "add", "origin", remote]);
  git(repository, ["push", "--quiet", "--set-upstream", "origin", "main"]);
  const remoteRefsBefore = git(remote, ["for-each-ref", "--format=%(refname):%(objectname)"]);
  const database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
  const graph = seedGraph(database);

  const result = await new RunCheckpointService(database).prepareTask(
    requestFor(graph, repository),
  );

  assert.equal(result.status, "READY");
  assert.equal(
    git(remote, ["for-each-ref", "--format=%(refname):%(objectname)"]),
    remoteRefsBefore,
  );
  assert.throws(() => git(remote, ["show-ref", "--verify", `refs/heads/${result.run.branchName}`]));
  database.close();
});

test("a clean committed source intervention becomes the next isolated checkpoint", async () => {
  const root = createRoot();
  const source = createRepository(root);
  const database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
  try {
    const graph = seedGraph(database, 2);
    const first = await new RunCheckpointService(database).prepareTask(requestFor(graph, source));
    assert.equal(first.status, "READY");
    writeFileSync(join(source, "tracked.txt"), "human committed intervention\n");
    git(source, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@localhost",
      "commit",
      "-am",
      "human intervention",
    ]);
    const expected = git(source, ["rev-parse", "HEAD"]).trim();
    const second = await new RunCheckpointService(database).prepareTask(
      requestFor(graph, source, 1),
    );
    assert.equal(second.status, "READY", JSON.stringify(second));
    assert.equal(second.checkpoint.gitHead, expected);
    assert.equal(git(first.run.workspacePath, ["rev-parse", "HEAD"]).trim(), expected);
    assert.equal(git(source, ["branch", "--show-current"]).trim(), "main");
  } finally {
    database.close();
  }
});

test("recovery inspects isolated execution even when the source checkout is clean", async () => {
  const root = createRoot();
  const source = createRepository(root);
  const database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
  try {
    const graph = seedGraph(database);
    const prepared = await new RunCheckpointService(database).prepareTask(
      requestFor(graph, source),
    );
    assert.equal(prepared.status, "READY");
    writeFileSync(join(prepared.run.workspacePath, "worker-leftover.txt"), "unfinished output\n");
    const recovery = await new RecoveryInspector(database.repositories).inspect({
      projectId: graph.project.id,
      workspacePath: source,
    });
    assert.equal(recovery.classification, "UNKNOWN", JSON.stringify(recovery));
    assert.equal(recovery.evidence.workspaceDiverged, true);
    assert.equal(recovery.evidence.workspace.snapshot.gitStatus, "");
    assert.match(recovery.evidence.executionWorkspace.snapshot.gitStatus, /worker-leftover/);
    git(source, ["switch", "--quiet", "-c", "human-branch"]);
    const moved = await new RecoveryInspector(database.repositories).inspect({
      projectId: graph.project.id,
      workspacePath: source,
    });
    assert.equal(moved.classification, "UNKNOWN");
    assert.equal(
      readFileSync(join(prepared.run.workspacePath, "worker-leftover.txt"), "utf8"),
      "unfinished output\n",
    );
  } finally {
    database.close();
  }
});
