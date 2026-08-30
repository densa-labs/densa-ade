import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DENSA_ADE_RUN_BRANCH_PREFIX,
  DENSA_RUN_BRANCH_PREFIX,
  WorkspacePreflight,
} from "@densa-ade/core";

const temporaryRoots = new Set();

function git(repository, args, options = {}) {
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      ...options.env,
    },
    stdio: options.stdio ?? "pipe",
  });
}

function createDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "densa-workspace-preflight-test-"));
  temporaryRoots.add(directory);
  return directory;
}

function createRepository() {
  const repository = createDirectory();
  git(repository, ["init", "--quiet", "--initial-branch=main"]);
  writeFileSync(
    join(repository, ".gitignore"),
    "densa*.sqlite\ndensa*.pid\ndensa*.sock\n.densa-ade/runtime/\n",
    "utf8",
  );
  writeFileSync(join(repository, "tracked.txt"), "initial\n", "utf8");
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

function commit(repository, message) {
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
    message,
  ]);
}

function createConflictingBranches() {
  const repository = createRepository();
  git(repository, ["switch", "--quiet", "-c", "topic"]);
  writeFileSync(join(repository, "tracked.txt"), "topic\n", "utf8");
  commit(repository, "fixture: topic change");
  git(repository, ["switch", "--quiet", "main"]);
  writeFileSync(join(repository, "tracked.txt"), "main\n", "utf8");
  commit(repository, "fixture: main change");
  return repository;
}

test.after(() => {
  for (const directory of temporaryRoots) rmSync(directory, { recursive: true, force: true });
});

test("clean real repository produces UI-ready proceed evidence", async () => {
  const repository = createRepository();
  const expectedHead = git(repository, ["rev-parse", "HEAD"]).trim();

  const result = await new WorkspacePreflight().inspect(repository);

  assert.equal(result.schemaVersion, 1);
  assert.equal(result.repository.isGitRepository, true);
  assert.equal(result.repository.isWorkTree, true);
  assert.equal(result.repository.isBare, false);
  assert.equal(result.head.branch, "main");
  assert.equal(result.head.commit, expectedHead);
  assert.equal(result.head.detached, false);
  assert.equal(result.changes.dirty, false);
  assert.deepEqual(result.operations.active, []);
  assert.deepEqual(result.decision, {
    outcome: "PROCEED",
    code: "CLEAN_REPOSITORY",
    requiresUserDecision: false,
    reason: "Repository is clean and has no active Git operation",
  });
  assert.equal(result.automaticActionsPerformed, false);
});

test("dirty user work is classified and remains byte-for-byte untouched", async () => {
  const repository = createRepository();
  writeFileSync(join(repository, "staged.txt"), "staged user work\n", "utf8");
  git(repository, ["add", "staged.txt"]);
  writeFileSync(join(repository, "tracked.txt"), "unstaged user work\n", "utf8");
  writeFileSync(join(repository, "untracked.txt"), "untracked user work\n", "utf8");
  const beforeStatus = git(repository, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const beforeHead = git(repository, ["rev-parse", "HEAD"]).trim();

  const result = await new WorkspacePreflight().inspect(repository);

  assert.equal(result.decision.code, "USER_CHANGES_PRESENT");
  assert.equal(result.decision.outcome, "STOP");
  assert.equal(result.decision.requiresUserDecision, true);
  assert.deepEqual(
    result.changes.staged.map((change) => change.path),
    ["staged.txt"],
  );
  assert.deepEqual(
    result.changes.unstaged.map((change) => change.path),
    ["tracked.txt"],
  );
  assert.deepEqual(result.changes.untracked, ["untracked.txt"]);
  assert.equal(readFileSync(join(repository, "staged.txt"), "utf8"), "staged user work\n");
  assert.equal(readFileSync(join(repository, "tracked.txt"), "utf8"), "unstaged user work\n");
  assert.equal(readFileSync(join(repository, "untracked.txt"), "utf8"), "untracked user work\n");
  assert.equal(
    git(repository, ["status", "--porcelain=v1", "--untracked-files=all"]),
    beforeStatus,
  );
  assert.equal(git(repository, ["rev-parse", "HEAD"]).trim(), beforeHead);
});

test("ignored Densa ADE runtime artifacts are visible but do not make the repository dirty", async () => {
  const repository = createRepository();
  writeFileSync(join(repository, "densa-core.sqlite"), "runtime database", "utf8");
  writeFileSync(join(repository, "densa-core.pid"), "1234\n", "utf8");
  writeFileSync(join(repository, "densa-core.sock"), "socket fixture\n", "utf8");
  mkdirSync(join(repository, ".densa-ade", "runtime"), { recursive: true });
  writeFileSync(join(repository, ".densa-ade", "runtime", "worker.pid"), "5678\n", "utf8");

  const result = await new WorkspacePreflight().inspect(repository);

  assert.equal(result.changes.dirty, false);
  assert.deepEqual(result.ignoredDensaAdeRuntimeArtifacts, [
    ".densa-ade/runtime/worker.pid",
    "densa-core.pid",
    "densa-core.sock",
    "densa-core.sqlite",
  ]);
  assert.equal(result.ignoredDensaRuntimeArtifacts, result.ignoredDensaAdeRuntimeArtifacts);
  assert.equal(result.decision.code, "CLEAN_REPOSITORY");
});

test("reserved Densa ADE run branches are detected without creating or switching branches", async () => {
  const repository = createRepository();
  const branch = `${DENSA_ADE_RUN_BRANCH_PREFIX}project-123`;
  git(repository, ["switch", "--quiet", "-c", branch]);
  const refsBefore = git(repository, ["for-each-ref", "--format=%(refname)", "refs/heads/"]);

  const result = await new WorkspacePreflight().inspect(repository);

  assert.equal(result.densaAdeRun.currentBranchOwned, true);
  assert.equal(result.densaAdeRun.hasOwnedRunBranch, true);
  assert.deepEqual(result.densaAdeRun.ownedBranches, [branch]);
  assert.equal(result.densaRun, result.densaAdeRun);
  assert.equal(DENSA_RUN_BRANCH_PREFIX, DENSA_ADE_RUN_BRANCH_PREFIX);
  assert.equal(result.decision.code, "EXISTING_DENSA_RUN");
  assert.equal(git(repository, ["for-each-ref", "--format=%(refname)", "refs/heads/"]), refsBefore);
  assert.equal(git(repository, ["branch", "--show-current"]).trim(), branch);
});

test("legacy run branches remain recognizable for recovery", async () => {
  const repository = createRepository();
  const branch = "densa/run/legacy-project-123";
  git(repository, ["switch", "--quiet", "-c", branch]);

  const result = await new WorkspacePreflight().inspect(repository);

  assert.equal(result.densaAdeRun.branchPrefix, DENSA_ADE_RUN_BRANCH_PREFIX);
  assert.equal(result.densaAdeRun.currentBranchOwned, true);
  assert.deepEqual(result.densaAdeRun.ownedBranches, [branch]);
  assert.equal(result.decision.code, "EXISTING_DENSA_RUN");
});

test("a conflicted merge is an operation stop and is not altered", async () => {
  const repository = createConflictingBranches();
  assert.throws(() => git(repository, ["merge", "--no-edit", "topic"]));
  const beforeStatus = git(repository, ["status", "--porcelain=v1"]);

  const result = await new WorkspacePreflight().inspect(repository);

  assert.equal(result.operations.merge, true);
  assert.deepEqual(result.operations.active, ["merge"]);
  assert.equal(result.decision.code, "GIT_OPERATION_IN_PROGRESS");
  assert.equal(result.decision.outcome, "STOP");
  assert.equal(git(repository, ["status", "--porcelain=v1"]), beforeStatus);
  assert.equal(git(repository, ["rev-parse", "--verify", "MERGE_HEAD"]).length > 0, true);
});

test("conflicted rebase and cherry-pick states are classified independently", async () => {
  const rebaseRepository = createConflictingBranches();
  git(rebaseRepository, ["switch", "--quiet", "topic"]);
  assert.throws(() => git(rebaseRepository, ["rebase", "main"]));

  const rebaseResult = await new WorkspacePreflight().inspect(rebaseRepository);
  assert.equal(rebaseResult.operations.rebase, true);
  assert.deepEqual(rebaseResult.operations.active, ["rebase"]);
  assert.equal(rebaseResult.decision.code, "GIT_OPERATION_IN_PROGRESS");

  const cherryPickRepository = createConflictingBranches();
  const topicCommit = git(cherryPickRepository, ["rev-parse", "topic"]).trim();
  assert.throws(() => git(cherryPickRepository, ["cherry-pick", topicCommit]));

  const cherryPickResult = await new WorkspacePreflight().inspect(cherryPickRepository);
  assert.equal(cherryPickResult.operations.cherryPick, true);
  assert.deepEqual(cherryPickResult.operations.active, ["cherry-pick"]);
  assert.equal(cherryPickResult.decision.code, "GIT_OPERATION_IN_PROGRESS");
});

test("detached, unborn, and non-Git workspaces fail closed with classified decisions", async () => {
  const detachedRepository = createRepository();
  git(detachedRepository, ["switch", "--quiet", "--detach"]);
  const detached = await new WorkspacePreflight().inspect(detachedRepository);
  assert.equal(detached.head.detached, true);
  assert.equal(detached.decision.code, "DETACHED_HEAD");

  const unbornRepository = createDirectory();
  git(unbornRepository, ["init", "--quiet", "--initial-branch=main"]);
  const unborn = await new WorkspacePreflight().inspect(unbornRepository);
  assert.equal(unborn.head.unborn, true);
  assert.equal(unborn.decision.code, "UNBORN_HEAD");

  const nonGitDirectory = createDirectory();
  mkdirSync(join(nonGitDirectory, "nested"));
  const nonGit = await new WorkspacePreflight().inspect(join(nonGitDirectory, "nested"));
  assert.equal(nonGit.repository.isGitRepository, false);
  assert.equal(nonGit.decision.code, "NON_GIT_DIRECTORY");
  assert.equal(nonGit.decision.requiresUserDecision, true);
});

test("bare Git repositories are distinguished from non-Git directories", async () => {
  const bareRepository = createDirectory();
  git(bareRepository, ["init", "--quiet", "--bare", "--initial-branch=main"]);

  const result = await new WorkspacePreflight().inspect(bareRepository);

  assert.equal(result.repository.isGitRepository, true);
  assert.equal(result.repository.isWorkTree, false);
  assert.equal(result.repository.isBare, true);
  assert.equal(result.decision.code, "BARE_REPOSITORY");
  assert.equal(result.decision.outcome, "STOP");
});
