import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { isAbsolute, posix, resolve } from "node:path";
import process from "node:process";
import type { RollbackPathSnapshot } from "./persistence/repositories.js";
const GIT_TIMEOUT_MS = 10_000;
const GIT_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;
interface GitResult {
  readonly exitCode: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly errorCode?: string;
  readonly timedOut: boolean;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

async function runGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  return await new Promise<GitResult>((resolveResult) => {
    let timedOut = false;
    const child = execFile(
      "git",
      ["-c", "core.fsmonitor=false", ...args],
      { cwd, encoding: "buffer", env: gitEnvironment(), maxBuffer: GIT_OUTPUT_LIMIT_BYTES },
      (error, stdout, stderr) => {
        clearTimeout(timeoutHandle);
        const commandError = error as NodeJS.ErrnoException | null;
        resolveResult({
          exitCode:
            commandError === null
              ? 0
              : typeof commandError.code === "number"
                ? commandError.code
                : child.exitCode,
          stdout,
          stderr,
          ...(commandError?.code === undefined || typeof commandError.code === "number"
            ? {}
            : { errorCode: commandError.code }),
          timedOut,
        });
      },
    );
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, GIT_TIMEOUT_MS);
    timeoutHandle.unref();
  });
}

function gitFailure(command: string, result: GitResult): string {
  const detail = result.timedOut
    ? "timed out"
    : result.errorCode === undefined
      ? `exited ${String(result.exitCode)}`
      : `failed with ${result.errorCode}`;
  return `${command} ${detail}${result.stderr.length === 0 ? "" : `: ${result.stderr.toString("utf8").slice(0, 4096).trim()}`}`;
}

function immutableStrings(values: Iterable<string>): readonly string[] {
  return Object.freeze([...values].sort((left, right) => left.localeCompare(right)));
}

export function normalizePaths(paths: readonly string[]): readonly string[] | undefined {
  if (paths.length === 0) return undefined;
  const normalized = new Set<string>();
  for (const path of paths) {
    if (
      path.length === 0 ||
      isAbsolute(path) ||
      path.includes("\\") ||
      posix.normalize(path) !== path ||
      path === "." ||
      path === ".." ||
      path.startsWith("../") ||
      path === ".git" ||
      path.startsWith(".git/") ||
      [...path].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || codePoint === 127;
      })
    ) {
      return undefined;
    }
    normalized.add(path);
  }
  return immutableStrings(normalized);
}

export function literalPathspec(path: string): string {
  return `:(literal)${path}`;
}

function contentHash(kind: "FILE" | "SYMLINK", executable: boolean, content: Buffer): string {
  return createHash("sha256")
    .update(kind)
    .update("\0")
    .update(executable ? "EXECUTABLE" : "REGULAR")
    .update("\0")
    .update(content)
    .digest("hex");
}

export function sameState(left: RollbackPathSnapshot, right: RollbackPathSnapshot): boolean {
  return (
    left.kind === right.kind &&
    left.contentHash === right.contentHash &&
    left.indexHash === right.indexHash
  );
}

export function sameWorktree(left: RollbackPathSnapshot, right: RollbackPathSnapshot): boolean {
  return left.kind === right.kind && left.contentHash === right.contentHash;
}

/** A crash may persist the index and worktree halves of one scoped restore independently. */
export function isRecoverablePartialState(
  current: RollbackPathSnapshot,
  failed: RollbackPathSnapshot,
  checkpoint: RollbackPathSnapshot,
): boolean {
  return (
    (sameWorktree(current, failed) || sameWorktree(current, checkpoint)) &&
    (current.indexHash === failed.indexHash || current.indexHash === checkpoint.indexHash)
  );
}

async function inspectIndexHash(workspaceRoot: string, path: string): Promise<string | undefined> {
  const result = await runGit(workspaceRoot, [
    "ls-files",
    "--stage",
    "-z",
    "--",
    literalPathspec(path),
  ]);
  if (result.exitCode !== 0) throw new Error(gitFailure("git ls-files --stage", result));
  const entries = result.stdout
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) return undefined;
  if (entries.length !== 1) throw new Error(`Index has unmerged entries for ${path}`);
  const header = entries[0]?.split("\t", 1)[0] ?? "";
  const [mode, objectId, stage] = header.split(" ");
  if (
    stage !== "0" ||
    objectId === undefined ||
    (mode !== "100644" && mode !== "100755" && mode !== "120000")
  ) {
    throw new Error(`Index path ${path} is not a supported file or symbolic link`);
  }
  const blob = await runGit(workspaceRoot, ["cat-file", "blob", objectId]);
  if (blob.exitCode !== 0) throw new Error(gitFailure("git cat-file", blob));
  const kind = mode === "120000" ? "SYMLINK" : "FILE";
  return contentHash(kind, mode === "100755", blob.stdout);
}

async function assertSafeParent(workspaceRoot: string, relativePath: string): Promise<void> {
  const parts = relativePath.split("/").slice(0, -1);
  let parent = workspaceRoot;
  for (const part of parts) {
    parent = resolve(parent, part);
    try {
      const stats = await lstat(parent);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error("Path parent must be a real workspace directory, never a symbolic link");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export async function inspectCurrentPath(
  workspaceRoot: string,
  path: string,
  temporary: boolean,
): Promise<RollbackPathSnapshot> {
  await assertSafeParent(workspaceRoot, path);
  const absolutePath = resolve(workspaceRoot, path);
  const indexHash = await inspectIndexHash(workspaceRoot, path);
  try {
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      return Object.freeze({
        path,
        kind: "SYMLINK" as const,
        contentHash: contentHash("SYMLINK", false, Buffer.from(await readlink(absolutePath))),
        ...(indexHash === undefined ? {} : { indexHash }),
        temporary,
      });
    }
    if (!stats.isFile())
      throw new Error("Only regular files and symbolic links can be rolled back");
    return Object.freeze({
      path,
      kind: "FILE" as const,
      contentHash: contentHash("FILE", (stats.mode & 0o111) !== 0, await readFile(absolutePath)),
      ...(indexHash === undefined ? {} : { indexHash }),
      temporary,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return Object.freeze({
        path,
        kind: "ABSENT" as const,
        ...(indexHash === undefined ? {} : { indexHash }),
        temporary,
      });
    }
    throw error;
  }
}

export async function inspectCheckpointPath(
  workspaceRoot: string,
  checkpointHead: string,
  path: string,
  temporary: boolean,
): Promise<RollbackPathSnapshot | { readonly failure: string }> {
  const tree = await runGit(workspaceRoot, [
    "ls-tree",
    "-z",
    checkpointHead,
    "--",
    literalPathspec(path),
  ]);
  if (tree.exitCode !== 0) return { failure: gitFailure("git ls-tree", tree) };
  if (tree.stdout.length === 0) {
    return Object.freeze({ path, kind: "ABSENT" as const, temporary });
  }
  const header = tree.stdout.toString("utf8").split("\t", 1)[0] ?? "";
  const [mode, type, objectId] = header.split(" ");
  if (
    type !== "blob" ||
    objectId === undefined ||
    (mode !== "100644" && mode !== "100755" && mode !== "120000")
  ) {
    return { failure: `Checkpoint path ${path} is not a supported file or symbolic link` };
  }
  const blob = await runGit(workspaceRoot, ["cat-file", "blob", objectId]);
  if (blob.exitCode !== 0) return { failure: gitFailure("git cat-file", blob) };
  const kind = mode === "120000" ? "SYMLINK" : "FILE";
  return Object.freeze({
    path,
    kind,
    contentHash: contentHash(kind, mode === "100755", blob.stdout),
    indexHash: contentHash(kind, mode === "100755", blob.stdout),
    temporary,
  });
}

export async function inspectChangedPaths(workspaceRoot: string): Promise<readonly string[]> {
  const results = await Promise.all([
    runGit(workspaceRoot, [
      "diff",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--name-only",
      "-z",
      "HEAD",
      "--",
    ]),
    runGit(workspaceRoot, [
      "diff",
      "--cached",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--name-only",
      "-z",
      "HEAD",
      "--",
    ]),
    runGit(workspaceRoot, ["ls-files", "--others", "--exclude-standard", "-z", "--"]),
  ]);
  for (const result of results)
    if (result.exitCode !== 0) throw new Error(gitFailure("Git changed paths", result));
  return immutableStrings(
    new Set(
      results.flatMap((result) => result.stdout.toString("utf8").split("\0").filter(Boolean)),
    ),
  );
}
