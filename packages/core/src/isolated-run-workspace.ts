import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { ProjectId } from "@densa-ade/protocol";
import type { DensaAdeDatabase } from "./persistence/database.js";
import type { DensaAdeRunBranchRecord } from "./persistence/repositories.js";
import { PermissionPolicyService } from "./permission-policy.js";
import { WorkspacePreflight } from "./workspace-preflight.js";

const exec = promisify(execFile);
export async function workspaceGit(
  cwd: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): Promise<string> {
  const result = await exec("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      ...environment,
    },
  });
  return result.stdout;
}

export async function assertIsolatedRunWorkspace(run: DensaAdeRunBranchRecord): Promise<void> {
  if (run.sourceWorkspacePath === undefined || run.sourceWorkspacePath === run.workspacePath)
    throw new Error("Legacy shared workspaces have no isolated rollback authority");
  if (
    (await realpath(run.workspacePath)) !== run.workspacePath ||
    (await realpath(run.sourceWorkspacePath)) !== run.sourceWorkspacePath
  )
    throw new Error("Workspace identity changed");
  const [root, sourceCommon, executionCommon, branch] = await Promise.all([
    workspaceGit(run.workspacePath, ["rev-parse", "--show-toplevel"]),
    workspaceGit(run.sourceWorkspacePath, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]),
    workspaceGit(run.workspacePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    workspaceGit(run.workspacePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
  ]);
  if (
    (await realpath(root.trim())) !== run.workspacePath ||
    (await realpath(sourceCommon.trim())) !== (await realpath(executionCommon.trim())) ||
    branch.trim() !== run.branchName
  )
    throw new Error("Isolated worktree ownership does not match persisted Git identity");
  const registration = await workspaceGit(run.sourceWorkspacePath, [
    "worktree",
    "list",
    "--porcelain",
    "-z",
  ]);
  if (
    !registration
      .split("\0\0")
      .some(
        (record) =>
          record.split("\0").includes(`worktree ${run.workspacePath}`) &&
          record.split("\0").includes(`branch refs/heads/${run.branchName}`),
      )
  )
    throw new Error("Execution worktree is not registered to the owned branch");
}

/** Persist intent before creating a private execution worktree; never switch or clean the source. */
export async function ensureIsolatedRunWorkspace(
  database: DensaAdeDatabase,
  request: {
    projectId: ProjectId;
    workspacePath: string;
    branchName: string;
    createdAt: string;
    actor: string;
  },
): Promise<{ run: DensaAdeRunBranchRecord; created: boolean }> {
  let run = database.repositories.densaAdeRunBranches.findByProjectId(request.projectId);
  const requestedRoot = await realpath(
    (await workspaceGit(request.workspacePath, ["rev-parse", "--show-toplevel"])).trim(),
  );
  if (run !== undefined) {
    if (
      run.sourceWorkspacePath === undefined ||
      (requestedRoot !== run.sourceWorkspacePath && requestedRoot !== run.workspacePath)
    )
      throw new Error("Run is not bound to this source and isolated execution workspace");
    if (run.status === "FAILED")
      throw new Error("Run creation previously failed; inspection is required");
  }
  const source = run?.sourceWorkspacePath ?? requestedRoot;
  const preflight = await new WorkspacePreflight().inspect(source);
  if (
    preflight.decision.outcome !== "PROCEED" ||
    preflight.head.branch === undefined ||
    preflight.head.commit === undefined
  )
    throw new Error(`Source preflight stopped: ${preflight.decision.reason}`);
  const permission = new PermissionPolicyService(database).authorize({
    projectId: request.projectId,
    operation: "git_mutation",
    actor: request.actor,
    occurredAt: request.createdAt,
    reason: "Create or verify the Core-owned isolated execution worktree",
  });
  if (permission.authorization === undefined)
    throw new Error(
      `Run workspace policy ${permission.decision.disposition}: ${permission.decision.reason}`,
    );
  let created = false;
  if (run === undefined) {
    const common = await realpath(
      (
        await workspaceGit(source, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
      ).trim(),
    );
    const folder = resolve(common, "densa-ade-workspaces");
    try {
      await mkdir(folder, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if ((await lstat(folder)).isSymbolicLink() || (await realpath(folder)) !== folder)
      throw new Error("Execution workspace container is not a real private Git directory");
    const workspacePath = resolve(
      folder,
      createHash("sha256").update(request.projectId).digest("hex").slice(0, 24),
    );
    try {
      await lstat(workspacePath);
      throw new Error("Execution workspace path already exists without ownership");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const refs = await workspaceGit(source, [
      "for-each-ref",
      "--format=%(refname)",
      `refs/heads/${request.branchName}`,
    ]);
    if (refs.trim() !== "")
      throw new Error("Run branch collision: an unowned execution branch already exists");
    run = database.repositories.densaAdeRunBranches.createCreating({
      projectId: request.projectId,
      workspacePath,
      sourceWorkspacePath: source,
      branchName: request.branchName,
      sourceBranch: preflight.head.branch,
      startingCommit: preflight.head.commit,
      createdAt: request.createdAt,
    });
    created = true;
  }
  if (preflight.head.branch !== run.sourceBranch)
    throw new Error("Source branch changed since run ownership was recorded");
  try {
    await lstat(run.workspacePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || run.status !== "CREATING")
      throw error;
    const refs = (
      await workspaceGit(source, [
        "for-each-ref",
        "--format=%(objectname)",
        `refs/heads/${run.branchName}`,
      ])
    ).trim();
    if (refs !== "" && refs !== run.startingCommit)
      throw new Error("Interrupted worktree creation has a divergent branch", { cause: error });
    await workspaceGit(source, [
      "worktree",
      "add",
      "--quiet",
      "--lock",
      "--reason",
      "Densa ADE owned execution workspace",
      ...(refs === "" ? ["-b", run.branchName] : []),
      run.workspacePath,
      refs === "" ? run.startingCommit : run.branchName,
    ]);
    created = true;
  }
  await assertIsolatedRunWorkspace(run);
  const executionHead = (await workspaceGit(run.workspacePath, ["rev-parse", "HEAD"])).trim();
  if (preflight.head.commit !== executionHead) {
    const unfinishedWorker = database.repositories.tasks
      .listByProjectId(run.projectId)
      .some((task) =>
        database.repositories.attempts.listByTaskId(task.id).some((attempt) => {
          const agent = database.repositories.agentRuns.findByAttemptId(attempt.id);
          return agent !== undefined && agent.completedAt === undefined;
        }),
      );
    const execution = await new WorkspacePreflight().inspect(run.workspacePath);
    if (unfinishedWorker || execution.decision.outcome !== "PROCEED")
      throw new Error("Execution state is unfinished or dirty; preserve it for recovery");
    // Explicitly committed source intervention may advance a clean worker base. Never rebase,
    // reset, merge divergent histories, or copy uncommitted human content into worker ownership.
    await workspaceGit(source, [
      "merge-base",
      "--is-ancestor",
      executionHead,
      preflight.head.commit,
    ]);
    await workspaceGit(run.workspacePath, [
      "merge",
      "--ff-only",
      "--no-edit",
      "--no-autostash",
      "--no-overwrite-ignore",
      preflight.head.commit,
    ]);
  }
  return { run, created };
}
