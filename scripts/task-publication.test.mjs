import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { guardedPublication } from "../packages/core/dist/guarded-publication.js";

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    env: {
      PATH: process.env.PATH,
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  }).trim();
}
function fixture() {
  const source = mkdtempSync(join(tmpdir(), "densa-publication-locks-"));
  git(source, "init", "--quiet", "-b", "main");
  git(source, "config", "user.name", "Fixture");
  git(source, "config", "user.email", "fixture@localhost");
  writeFileSync(join(source, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(source, "task.txt"), "base\n");
  writeFileSync(join(source, "user.txt"), "human baseline\n");
  git(source, "add", ".");
  git(source, "commit", "--quiet", "-m", "base");
  const expectedHead = git(source, "rev-parse", "HEAD");
  git(source, "switch", "--quiet", "-c", "worker");
  writeFileSync(join(source, "task.txt"), "validated\n");
  writeFileSync(join(source, "ignored.txt"), "worker created\n");
  git(source, "add", "--force", "task.txt", "ignored.txt");
  git(source, "commit", "--quiet", "-m", "worker");
  const commitSha = git(source, "rev-parse", "HEAD");
  git(source, "switch", "--quiet", "main");
  return {
    source,
    sourceBranch: "main",
    expectedHead,
    commitSha,
    attemptId: "publication-attempt",
    verify: async () => {},
  };
}

test("publication holds the real index lock and bypasses source ref and merge hooks", async () => {
  const request = fixture();
  try {
    const { source } = request;
    writeFileSync(join(source, "user.txt"), "human staged\n");
    git(source, "add", "user.txt");
    writeFileSync(join(source, "user.txt"), "human unstaged\n");
    const index = git(source, "ls-files", "--stage", "user.txt");
    for (const name of ["reference-transaction", "post-merge"]) {
      const hook = join(source, ".git", "hooks", name);
      writeFileSync(hook, "#!/bin/sh\nprintf 'hook overwrote human data' > user.txt\n");
      chmodSync(hook, 0o755);
    }
    await guardedPublication({
      ...request,
      verify: async () => {
        assert.throws(() => git(source, "switch", "--quiet", "worker"), /index.lock/);
        assert.equal(git(source, "branch", "--show-current"), "main");
      },
    });
    assert.equal(git(source, "rev-parse", "HEAD"), request.commitSha);
    assert.equal(git(source, "ls-files", "--stage", "user.txt"), index);
    assert.equal(readFileSync(join(source, "user.txt"), "utf8"), "human unstaged\n");
    assert.equal(readFileSync(join(source, "task.txt"), "utf8"), "validated\n");
  } finally {
    rmSync(request.source, { recursive: true, force: true });
  }
});

test("an ignored human file appearing after verification is never overwritten", async () => {
  const request = fixture();
  try {
    const beforeIndex = readFileSync(join(request.source, ".git", "index"));
    await assert.rejects(
      guardedPublication({
        ...request,
        verify: async () => {
          writeFileSync(join(request.source, "ignored.txt"), "late human ignored file\n");
        },
      }),
    );
    assert.equal(git(request.source, "rev-parse", "HEAD"), request.expectedHead);
    assert.equal(
      readFileSync(join(request.source, "ignored.txt"), "utf8"),
      "late human ignored file\n",
    );
    assert.equal(readFileSync(join(request.source, "task.txt"), "utf8"), "base\n");
    assert.deepEqual(readFileSync(join(request.source, ".git", "index")), beforeIndex);
  } finally {
    rmSync(request.source, { recursive: true, force: true });
  }
});

test("a stopped Core leaves owned publication lock evidence and restart does not delete it", async () => {
  const request = fixture();
  try {
    const moduleURL = pathToFileURL(resolve("packages/core/dist/guarded-publication.js")).href;
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { guardedPublication } from ${JSON.stringify(moduleURL)}; await guardedPublication({ ...${JSON.stringify(request)}, verify: async () => { process.kill(process.pid, 'SIGKILL'); await new Promise(() => {}); } });`,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(child.signal, "SIGKILL", child.stderr);
    const lockPath = join(request.source, ".git", "index.lock");
    const evidence = readFileSync(lockPath, "utf8");
    assert.equal(JSON.parse(evidence).attemptId, request.attemptId);
    await assert.rejects(guardedPublication(request), /EEXIST/);
    assert.equal(readFileSync(lockPath, "utf8"), evidence);
    assert.equal(git(request.source, "rev-parse", "HEAD"), request.expectedHead);
    assert.equal(readFileSync(join(request.source, "task.txt"), "utf8"), "base\n");
  } finally {
    rmSync(request.source, { recursive: true, force: true });
  }
});

test("split source indexes publish without retaining references to private shared-index files", async () => {
  const request = fixture();
  try {
    git(request.source, "config", "core.splitIndex", "true");
    writeFileSync(join(request.source, "user.txt"), "human staged split index\n");
    git(request.source, "add", "user.txt");
    git(request.source, "update-index", "--split-index");
    assert.notEqual(git(request.source, "rev-parse", "--shared-index-path"), "");
    const staged = git(request.source, "ls-files", "--stage", "user.txt");
    await guardedPublication(request);
    assert.equal(git(request.source, "rev-parse", "HEAD"), request.commitSha);
    assert.equal(git(request.source, "ls-files", "--stage", "user.txt"), staged);
    assert.equal(
      git(request.source, "-c", "core.splitIndex=false", "rev-parse", "--shared-index-path"),
      "",
    );
    assert.equal(readFileSync(join(request.source, "task.txt"), "utf8"), "validated\n");
  } finally {
    rmSync(request.source, { recursive: true, force: true });
  }
});
