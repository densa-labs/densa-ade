import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { workspaceGit } from "./isolated-run-workspace.js";

/** Exclude checkout/index writers and pin both the symbolic HEAD and its expected branch.
 * A crash leaves identifiable lock files and the private index for explicit recovery inspection.
 * We never delete an existing lock, infer ownership of a stale lock, or force a ref update.
 */
export async function guardedPublication(request: {
  source: string;
  sourceBranch: string;
  expectedHead: string;
  commitSha: string;
  attemptId: string;
  verify: () => Promise<void>;
}): Promise<void> {
  const { source, sourceBranch, expectedHead, commitSha } = request;
  const branchRef = `refs/heads/${sourceBranch}`;
  await workspaceGit(source, ["check-ref-format", branchRef]);
  if (![expectedHead, commitSha].every((value) => /^[a-f0-9]{40,64}$/.test(value)))
    throw new Error("Invalid publication commit identity");
  const indexPath = (
    await workspaceGit(source, ["rev-parse", "--path-format=absolute", "--git-path", "index"])
  ).trim();
  const token = JSON.stringify({
    owner: "densa-ade-publication",
    attemptId: request.attemptId,
    processId: process.pid,
    expectedHead,
    commitSha,
  });
  const privateDirectory = join(
    dirname(indexPath),
    `densa-ade-publication-${createHash("sha256").update(request.attemptId).digest("hex")}`,
  );
  const privateIndex = join(privateDirectory, "index");
  const commonDirectory = (
    await workspaceGit(source, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  ).trim();
  const held: string[] = [];
  let transaction: Awaited<ReturnType<typeof prepareRefUpdate>> | undefined;
  let copied = false;
  let finished = false;
  try {
    for (const path of [`${indexPath}.lock`]) {
      const handle = await open(path, "wx", 0o600);
      held.push(path);
      try {
        await handle.writeFile(token);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    // These checks occur after intent, permission and lock acquisition. A branch switch at any
    // earlier boundary must stop before touching the source worktree, index or branch ref.
    await request.verify();
    if (
      (await workspaceGit(source, ["symbolic-ref", "HEAD"])).trim() !== branchRef ||
      (await workspaceGit(source, ["rev-parse", "HEAD"])).trim() !== expectedHead
    )
      throw new Error("Publication source branch or HEAD changed before locks were acquired");
    transaction = await prepareRefUpdate(source, expectedHead, commitSha);
    // update HEAD prepares locks for both HEAD and its referent. Verify the referent after
    // preparation, before any worktree change, so even a prior symbolic-ref race only aborts.
    if ((await workspaceGit(source, ["symbolic-ref", "HEAD"])).trim() !== branchRef)
      throw new Error("Publication HEAD resolved to a different branch");
    await mkdir(privateDirectory, { mode: 0o700 }); // Existing recovery evidence is never replaced.
    await writeFile(join(privateDirectory, "HEAD"), `${expectedHead}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(join(privateDirectory, "publication.json"), token, { flag: "wx", mode: 0o600 });
    await copyFile(indexPath, privateIndex, 1);
    copied = true;
    // A copied split index still references sharedindex.* in the real Git directory. Expand it
    // there before using private metadata; the installed index must not depend on private files.
    await workspaceGit(
      source,
      ["-c", "core.splitIndex=false", "update-index", "--no-split-index"],
      { GIT_INDEX_FILE: privateIndex },
    );
    // A detached private HEAD lets Git perform its guarded checkout without touching the real
    // locked HEAD/ref. Unlike read-tree, merge's no-overwrite-ignore protects late ignored files.
    await workspaceGit(
      source,
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.splitIndex=false",
        "merge",
        "--ff-only",
        "--no-edit",
        "--no-autostash",
        "--no-overwrite-ignore",
        commitSha,
      ],
      {
        GIT_DIR: privateDirectory,
        GIT_COMMON_DIR: commonDirectory,
        GIT_WORK_TREE: source,
        GIT_INDEX_FILE: privateIndex,
      },
    );
    await rename(privateIndex, indexPath);
    await transaction.commit();
    finished = true;
  } finally {
    await transaction?.abort();
    for (const path of held.reverse()) {
      if ((await readFile(path, "utf8")) === token) await unlink(path);
    }
    // Keep a failed operation's private index for inspection; it never replaces user state on retry.
    if (finished && copied) await rm(privateDirectory, { recursive: true });
  }
}

async function prepareRefUpdate(source: string, expected: string, target: string) {
  const child = spawn("git", ["-c", "core.hooksPath=/dev/null", "update-ref", "--stdin"], {
    cwd: source,
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let done = false;
  let preparedResolve: (() => void) | undefined;
  let preparedReject: ((error: Error) => void) | undefined;
  const prepared = new Promise<void>((resolve, reject) => {
    preparedResolve = resolve;
    preparedReject = reject;
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once("error", (error) => {
      preparedReject?.(error);
      done = true;
      resolve(null);
    });
    child.once("close", (code) => {
      done = true;
      preparedReject?.(new Error("Publication ref transaction ended before preparation"));
      resolve(code);
    });
  });
  child.stdin.on("error", (error) => preparedReject?.(error));
  child.stderr.resume();
  child.stdout.on("data", (chunk: Buffer) => {
    output = (output + chunk.toString("utf8")).slice(-1024);
    if (output.includes("prepare: ok\n")) preparedResolve?.();
  });
  const timeout = setTimeout(() => {
    preparedReject?.(new Error("Publication ref transaction timed out"));
    child.kill("SIGKILL");
  }, 30_000);
  void exited.then(() => clearTimeout(timeout));
  child.stdin.write(`start\nupdate HEAD ${target} ${expected}\nprepare\n`);
  try {
    await prepared;
  } catch (error) {
    child.stdin.end();
    await exited;
    throw error;
  }
  return {
    async commit() {
      child.stdin.end("commit\n");
      if ((await exited) !== 0 || !output.includes("commit: ok\n"))
        throw new Error(
          "Publication ref commit failed; inspect the durable intent and source index",
        );
    },
    async abort() {
      if (!done) child.stdin.end("abort\n");
      await exited;
    },
  };
}
