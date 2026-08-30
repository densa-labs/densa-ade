import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const GIT_TIMEOUT_MS = 10_000;
const GIT_OUTPUT_LIMIT_BYTES = 1024 * 1024;

/** Reserved for Densa ADE-created run branches. P3M0 only recognizes it; it never creates a branch. */
export const DENSA_ADE_RUN_BRANCH_PREFIX = "densa-ade/run/";
/** @deprecated Use DENSA_ADE_RUN_BRANCH_PREFIX. Retained for package consumer compatibility. */
export const DENSA_RUN_BRANCH_PREFIX = DENSA_ADE_RUN_BRANCH_PREFIX;
const LEGACY_DENSA_RUN_BRANCH_PREFIX = "densa/run/";

const DENSA_ADE_RUNTIME_PATHS = [
  ":(glob)**/.densa-ade/runtime/**",
  ":(glob)**/.densa-ade/*.db",
  ":(glob)**/.densa-ade/*.db-shm",
  ":(glob)**/.densa-ade/*.db-wal",
  ":(glob)**/.densa-ade/*.sqlite",
  ":(glob)**/.densa-ade/*.sqlite-shm",
  ":(glob)**/.densa-ade/*.sqlite-wal",
  ":(glob)**/.densa-ade/*.sqlite3",
  ":(glob)**/.densa-ade/*.sqlite3-shm",
  ":(glob)**/.densa-ade/*.sqlite3-wal",
  ":(glob)**/.densa-ade/*.pid",
  ":(glob)**/.densa-ade/*.sock",
  // Existing workspaces may still contain ignored runtime files at the pre-migration path.
  ":(glob)**/.densa/runtime/**",
  ":(glob)**/.densa/*.db",
  ":(glob)**/.densa/*.db-shm",
  ":(glob)**/.densa/*.db-wal",
  ":(glob)**/.densa/*.sqlite",
  ":(glob)**/.densa/*.sqlite-shm",
  ":(glob)**/.densa/*.sqlite-wal",
  ":(glob)**/.densa/*.sqlite3",
  ":(glob)**/.densa/*.sqlite3-shm",
  ":(glob)**/.densa/*.sqlite3-wal",
  ":(glob)**/.densa/*.pid",
  ":(glob)**/.densa/*.sock",
  ":(glob)**/densa*.db",
  ":(glob)**/densa*.db-shm",
  ":(glob)**/densa*.db-wal",
  ":(glob)**/densa*.sqlite",
  ":(glob)**/densa*.sqlite-shm",
  ":(glob)**/densa*.sqlite-wal",
  ":(glob)**/densa*.sqlite3",
  ":(glob)**/densa*.sqlite3-shm",
  ":(glob)**/densa*.sqlite3-wal",
  ":(glob)**/densa*.pid",
  ":(glob)**/densa*.sock",
] as const;

function isOwnedDensaAdeRunBranch(branch: string): boolean {
  return (
    branch.startsWith(DENSA_ADE_RUN_BRANCH_PREFIX) ||
    branch.startsWith(LEGACY_DENSA_RUN_BRANCH_PREFIX)
  );
}

export type WorkspaceChangeKind =
  "added" | "copied" | "deleted" | "modified" | "renamed" | "type-changed" | "unmerged" | "unknown";

export interface WorkspaceChange {
  readonly path: string;
  readonly status: string;
  readonly kind: WorkspaceChangeKind;
}

export interface WorkspacePreflightChanges {
  readonly staged: readonly WorkspaceChange[];
  readonly unstaged: readonly WorkspaceChange[];
  readonly untracked: readonly string[];
  readonly dirty: boolean;
}

export interface GitOperationState {
  readonly merge: boolean;
  readonly rebase: boolean;
  readonly cherryPick: boolean;
  readonly active: readonly ("merge" | "rebase" | "cherry-pick")[];
}

export interface WorkspaceHead {
  readonly commit?: string;
  readonly branch?: string;
  readonly detached: boolean;
  readonly unborn: boolean;
}

export interface DensaAdeRunOwnership {
  readonly branchPrefix: typeof DENSA_ADE_RUN_BRANCH_PREFIX;
  readonly currentBranchOwned: boolean;
  readonly ownedBranches: readonly string[];
  readonly hasOwnedRunBranch: boolean;
}

/** @deprecated Use DensaAdeRunOwnership. Retained for package consumer compatibility. */
export type DensaRunOwnership = DensaAdeRunOwnership;

export type WorkspacePreflightDecisionCode =
  | "CLEAN_REPOSITORY"
  | "EXISTING_DENSA_RUN"
  | "USER_CHANGES_PRESENT"
  | "GIT_OPERATION_IN_PROGRESS"
  | "DETACHED_HEAD"
  | "UNBORN_HEAD"
  | "BARE_REPOSITORY"
  | "NON_GIT_DIRECTORY"
  | "INSPECTION_FAILED";

export interface WorkspacePreflightDecision {
  readonly outcome: "PROCEED" | "STOP";
  readonly code: WorkspacePreflightDecisionCode;
  readonly requiresUserDecision: boolean;
  readonly reason: string;
}

export interface WorkspacePreflightResult {
  readonly schemaVersion: 1;
  readonly workspacePath: string;
  readonly repository: {
    readonly isGitRepository: boolean;
    readonly isWorkTree: boolean;
    readonly isBare: boolean;
    readonly root?: string;
    readonly gitDirectory?: string;
  };
  readonly head: WorkspaceHead;
  readonly changes: WorkspacePreflightChanges;
  readonly operations: GitOperationState;
  readonly ignoredDensaAdeRuntimeArtifacts: readonly string[];
  /** @deprecated Use ignoredDensaAdeRuntimeArtifacts. Retained in schema version 1. */
  readonly ignoredDensaRuntimeArtifacts: readonly string[];
  readonly densaAdeRun: DensaAdeRunOwnership;
  /** @deprecated Use densaAdeRun. Retained in schema version 1. */
  readonly densaRun: DensaAdeRunOwnership;
  readonly decision: WorkspacePreflightDecision;
  readonly automaticActionsPerformed: false;
}

interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly errorCode?: string;
  readonly timedOut: boolean;
}

function commandEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
}

async function runGit(cwd: string, args: readonly string[]): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve) => {
    let timedOut = false;
    const child = execFile(
      "git",
      ["-c", "core.fsmonitor=false", ...args],
      {
        cwd,
        encoding: "utf8",
        env: commandEnvironment(),
        maxBuffer: GIT_OUTPUT_LIMIT_BYTES,
      },
      (error, stdout, stderr) => {
        clearTimeout(timeoutHandle);
        const commandError = error as NodeJS.ErrnoException | null;
        resolve({
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

function emptyChanges(): WorkspacePreflightChanges {
  return Object.freeze({
    staged: Object.freeze([]),
    unstaged: Object.freeze([]),
    untracked: Object.freeze([]),
    dirty: false,
  });
}

function emptyOperations(): GitOperationState {
  return Object.freeze({
    merge: false,
    rebase: false,
    cherryPick: false,
    active: Object.freeze([]),
  });
}

function emptyOwnership(): DensaAdeRunOwnership {
  return Object.freeze({
    branchPrefix: DENSA_ADE_RUN_BRANCH_PREFIX,
    currentBranchOwned: false,
    ownedBranches: Object.freeze([]),
    hasOwnedRunBranch: false,
  });
}

function stopResult(
  workspacePath: string,
  code: Extract<WorkspacePreflightDecisionCode, "NON_GIT_DIRECTORY" | "INSPECTION_FAILED">,
  reason: string,
): WorkspacePreflightResult {
  const ignoredDensaAdeRuntimeArtifacts = Object.freeze([] as string[]);
  const densaAdeRun = emptyOwnership();
  return Object.freeze({
    schemaVersion: 1 as const,
    workspacePath,
    repository: Object.freeze({
      isGitRepository: false,
      isWorkTree: false,
      isBare: false,
    }),
    head: Object.freeze({ detached: false, unborn: false }),
    changes: emptyChanges(),
    operations: emptyOperations(),
    ignoredDensaAdeRuntimeArtifacts,
    ignoredDensaRuntimeArtifacts: ignoredDensaAdeRuntimeArtifacts,
    densaAdeRun,
    densaRun: densaAdeRun,
    decision: Object.freeze({
      outcome: "STOP" as const,
      code,
      requiresUserDecision: true,
      reason,
    }),
    automaticActionsPerformed: false as const,
  });
}

function failedGitInspectionResult(
  workspacePath: string,
  repository: WorkspacePreflightResult["repository"],
  reason: string,
): WorkspacePreflightResult {
  const ignoredDensaAdeRuntimeArtifacts = Object.freeze([] as string[]);
  const densaAdeRun = emptyOwnership();
  return Object.freeze({
    schemaVersion: 1 as const,
    workspacePath,
    repository,
    head: Object.freeze({ detached: false, unborn: false }),
    changes: emptyChanges(),
    operations: emptyOperations(),
    ignoredDensaAdeRuntimeArtifacts,
    ignoredDensaRuntimeArtifacts: ignoredDensaAdeRuntimeArtifacts,
    densaAdeRun,
    densaRun: densaAdeRun,
    decision: Object.freeze({
      outcome: "STOP" as const,
      code: "INSPECTION_FAILED" as const,
      requiresUserDecision: true,
      reason,
    }),
    automaticActionsPerformed: false as const,
  });
}

function commandFailure(command: string, result: CommandResult): Error {
  const detail = result.timedOut
    ? "timed out"
    : result.errorCode === undefined
      ? `exited ${String(result.exitCode)}`
      : `failed with ${result.errorCode}`;
  return new Error(`${command} ${detail}`);
}

async function successfulGit(
  cwd: string,
  args: readonly string[],
  command: string,
): Promise<string> {
  const result = await runGit(cwd, args);
  if (result.exitCode !== 0) throw commandFailure(command, result);
  return result.stdout;
}

function changeKind(status: string): WorkspaceChangeKind {
  switch (status[0]) {
    case "A":
      return "added";
    case "C":
      return "copied";
    case "D":
      return "deleted";
    case "M":
      return "modified";
    case "R":
      return "renamed";
    case "T":
      return "type-changed";
    case "U":
      return "unmerged";
    default:
      return "unknown";
  }
}

function parseNameStatus(value: string): readonly WorkspaceChange[] {
  const fields = value.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 2 !== 0) throw new Error("Git returned malformed name-status output");
  const changes: WorkspaceChange[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index];
    const filePath = fields[index + 1];
    if (status === undefined || filePath === undefined || status.length === 0) {
      throw new Error("Git returned an incomplete name-status record");
    }
    changes.push(Object.freeze({ path: filePath, status, kind: changeKind(status) }));
  }
  return Object.freeze(changes);
}

function parseNullPaths(value: string): readonly string[] {
  return Object.freeze(
    value
      .split("\0")
      .filter((entry) => entry.length > 0)
      .sort((left, right) => left.localeCompare(right)),
  );
}

async function gitPathExists(repositoryRoot: string, gitPathName: string): Promise<boolean> {
  const gitPath = (
    await successfulGit(
      repositoryRoot,
      ["rev-parse", "--git-path", gitPathName],
      `git rev-parse --git-path ${gitPathName}`,
    )
  ).trim();
  try {
    await lstat(path.resolve(repositoryRoot, gitPath));
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      String(error.code) === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

function decide(input: {
  isBare: boolean;
  head: WorkspaceHead;
  changes: WorkspacePreflightChanges;
  operations: GitOperationState;
  densaAdeRun: DensaAdeRunOwnership;
}): WorkspacePreflightDecision {
  if (input.isBare) {
    return Object.freeze({
      outcome: "STOP" as const,
      code: "BARE_REPOSITORY" as const,
      requiresUserDecision: true,
      reason: "Densa ADE requires a working tree and cannot operate in a bare repository",
    });
  }
  if (input.operations.active.length > 0) {
    return Object.freeze({
      outcome: "STOP" as const,
      code: "GIT_OPERATION_IN_PROGRESS" as const,
      requiresUserDecision: true,
      reason: `Repository has an active Git operation: ${input.operations.active.join(", ")}`,
    });
  }
  if (input.head.detached) {
    return Object.freeze({
      outcome: "STOP" as const,
      code: "DETACHED_HEAD" as const,
      requiresUserDecision: true,
      reason: "Repository is at a detached HEAD and needs an explicit branch decision",
    });
  }
  if (input.head.unborn) {
    return Object.freeze({
      outcome: "STOP" as const,
      code: "UNBORN_HEAD" as const,
      requiresUserDecision: true,
      reason: "Repository has no initial commit from which to establish a safe checkpoint",
    });
  }
  if (input.changes.dirty) {
    return Object.freeze({
      outcome: "STOP" as const,
      code: "USER_CHANGES_PRESENT" as const,
      requiresUserDecision: true,
      reason: "Repository contains staged, unstaged, or untracked user changes",
    });
  }
  if (input.densaAdeRun.currentBranchOwned) {
    return Object.freeze({
      outcome: "PROCEED" as const,
      code: "EXISTING_DENSA_RUN" as const,
      requiresUserDecision: false,
      reason: "Repository is clean and already on a reserved Densa ADE run branch",
    });
  }
  return Object.freeze({
    outcome: "PROCEED" as const,
    code: "CLEAN_REPOSITORY" as const,
    requiresUserDecision: false,
    reason: "Repository is clean and has no active Git operation",
  });
}

/**
 * Captures read-only, UI-ready Git safety evidence. It never stashes, resets, cleans, checks out,
 * creates refs, or writes Densa ADE metadata.
 */
export class WorkspacePreflight {
  async inspect(workspacePath: string): Promise<WorkspacePreflightResult> {
    const requestedPath = path.resolve(workspacePath);
    let inspectedPath: string;
    try {
      inspectedPath = await realpath(requestedPath);
      const metadata = await lstat(inspectedPath);
      if (!metadata.isDirectory()) {
        return stopResult(inspectedPath, "INSPECTION_FAILED", "Workspace path is not a directory");
      }
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? ` (${String(error.code)})`
          : "";
      return stopResult(
        requestedPath,
        "INSPECTION_FAILED",
        `Workspace directory could not be inspected${code}`,
      );
    }

    const discovery = await runGit(inspectedPath, [
      "rev-parse",
      "--is-inside-work-tree",
      "--is-bare-repository",
      "--absolute-git-dir",
    ]);
    if (discovery.exitCode !== 0) {
      if (
        discovery.errorCode === undefined &&
        !discovery.timedOut &&
        discovery.stderr.includes("not a git repository")
      ) {
        return stopResult(
          inspectedPath,
          "NON_GIT_DIRECTORY",
          "Workspace is not inside a Git working tree",
        );
      }
      return stopResult(
        inspectedPath,
        "INSPECTION_FAILED",
        discovery.timedOut
          ? "Git repository discovery timed out"
          : `Git repository discovery failed${
              discovery.errorCode === undefined ? "" : ` (${discovery.errorCode})`
            }`,
      );
    }

    let discoveredRepository: WorkspacePreflightResult["repository"] | undefined;
    try {
      const discoveryLines = discovery.stdout.trimEnd().split("\n");
      const insideWorkTree = discoveryLines[0] === "true";
      const isBare = discoveryLines[1] === "true";
      const gitDirectoryValue = discoveryLines[2];
      if ((!insideWorkTree && !isBare) || gitDirectoryValue === undefined) {
        throw new Error("Git repository discovery returned incomplete evidence");
      }
      discoveredRepository = Object.freeze({
        isGitRepository: true,
        isWorkTree: insideWorkTree,
        isBare,
        gitDirectory: gitDirectoryValue,
      });

      if (isBare) {
        const [branchResult, commitResult, refsRaw] = await Promise.all([
          runGit(inspectedPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
          runGit(inspectedPath, ["rev-parse", "--verify", "HEAD"]),
          successfulGit(
            inspectedPath,
            [
              "for-each-ref",
              "--format=%(refname:short)",
              `refs/heads/${DENSA_ADE_RUN_BRANCH_PREFIX}`,
              `refs/heads/${LEGACY_DENSA_RUN_BRANCH_PREFIX}`,
            ],
            "git for-each-ref Densa ADE run branches",
          ),
        ]);
        if (branchResult.timedOut || branchResult.errorCode !== undefined) {
          throw commandFailure("git symbolic-ref HEAD", branchResult);
        }
        if (commitResult.timedOut || commitResult.errorCode !== undefined) {
          throw commandFailure("git rev-parse --verify HEAD", commitResult);
        }
        const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : undefined;
        const commit = commitResult.exitCode === 0 ? commitResult.stdout.trim() : undefined;
        const head: WorkspaceHead = Object.freeze({
          ...(commit === undefined ? {} : { commit }),
          ...(branch === undefined ? {} : { branch }),
          detached: branch === undefined && commit !== undefined,
          unborn: commit === undefined,
        });
        const operations = emptyOperations();
        const changes = emptyChanges();
        const ownedBranches = Object.freeze(
          refsRaw
            .split("\n")
            .map((entry) => entry.trim())
            .filter(isOwnedDensaAdeRunBranch)
            .sort((left, right) => left.localeCompare(right)),
        );
        const densaAdeRun: DensaAdeRunOwnership = Object.freeze({
          branchPrefix: DENSA_ADE_RUN_BRANCH_PREFIX,
          currentBranchOwned: branch === undefined ? false : isOwnedDensaAdeRunBranch(branch),
          ownedBranches,
          hasOwnedRunBranch: ownedBranches.length > 0,
        });
        const decision = decide({ isBare, head, operations, changes, densaAdeRun });
        return Object.freeze({
          schemaVersion: 1 as const,
          workspacePath: inspectedPath,
          repository: Object.freeze({
            isGitRepository: true,
            isWorkTree: insideWorkTree,
            isBare,
            gitDirectory: gitDirectoryValue,
          }),
          head,
          changes,
          operations,
          ignoredDensaAdeRuntimeArtifacts: Object.freeze([]),
          ignoredDensaRuntimeArtifacts: Object.freeze([]),
          densaAdeRun,
          densaRun: densaAdeRun,
          decision,
          automaticActionsPerformed: false as const,
        });
      }

      const repositoryRootValue = (
        await successfulGit(
          inspectedPath,
          ["rev-parse", "--show-toplevel"],
          "git rev-parse --show-toplevel",
        )
      ).trim();
      const repositoryRoot = await realpath(repositoryRootValue);
      discoveredRepository = Object.freeze({
        ...discoveredRepository,
        root: repositoryRoot,
      });
      const [
        branchResult,
        commitResult,
        stagedRaw,
        unstagedRaw,
        untrackedRaw,
        ignoredRaw,
        refsRaw,
      ] = await Promise.all([
        runGit(repositoryRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
        runGit(repositoryRoot, ["rev-parse", "--verify", "HEAD"]),
        successfulGit(
          repositoryRoot,
          ["diff", "--cached", "--name-status", "-z", "--no-renames", "--"],
          "git diff --cached",
        ),
        successfulGit(
          repositoryRoot,
          ["diff", "--name-status", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "--"],
          "git diff",
        ),
        successfulGit(
          repositoryRoot,
          ["ls-files", "--others", "--exclude-standard", "-z"],
          "git ls-files --others",
        ),
        successfulGit(
          repositoryRoot,
          [
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "-z",
            "--",
            ...DENSA_ADE_RUNTIME_PATHS,
          ],
          "git ls-files --ignored Densa ADE runtime paths",
        ),
        successfulGit(
          repositoryRoot,
          [
            "for-each-ref",
            "--format=%(refname:short)",
            `refs/heads/${DENSA_ADE_RUN_BRANCH_PREFIX}`,
            `refs/heads/${LEGACY_DENSA_RUN_BRANCH_PREFIX}`,
          ],
          "git for-each-ref Densa ADE run branches",
        ),
      ]);

      if (branchResult.timedOut || branchResult.errorCode !== undefined) {
        throw commandFailure("git symbolic-ref HEAD", branchResult);
      }
      if (commitResult.timedOut || commitResult.errorCode !== undefined) {
        throw commandFailure("git rev-parse --verify HEAD", commitResult);
      }
      const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : undefined;
      const commit = commitResult.exitCode === 0 ? commitResult.stdout.trim() : undefined;
      if (branch === undefined && commit === undefined) {
        throw new Error("Git could not resolve either a branch or HEAD commit");
      }
      const head: WorkspaceHead = Object.freeze({
        ...(commit === undefined ? {} : { commit }),
        ...(branch === undefined ? {} : { branch }),
        detached: branch === undefined && commit !== undefined,
        unborn: commit === undefined,
      });

      const staged = parseNameStatus(stagedRaw);
      const unstaged = parseNameStatus(unstagedRaw);
      const untracked = parseNullPaths(untrackedRaw);
      const changes: WorkspacePreflightChanges = Object.freeze({
        staged,
        unstaged,
        untracked,
        dirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0,
      });

      const [merge, rebaseMerge, rebaseApply, cherryPick] = await Promise.all([
        gitPathExists(repositoryRoot, "MERGE_HEAD"),
        gitPathExists(repositoryRoot, "rebase-merge"),
        gitPathExists(repositoryRoot, "rebase-apply"),
        gitPathExists(repositoryRoot, "CHERRY_PICK_HEAD"),
      ]);
      const rebase = rebaseMerge || rebaseApply;
      const active = [
        ...(merge ? (["merge"] as const) : []),
        ...(rebase ? (["rebase"] as const) : []),
        ...(cherryPick ? (["cherry-pick"] as const) : []),
      ];
      const operations: GitOperationState = Object.freeze({
        merge,
        rebase,
        cherryPick,
        active: Object.freeze(active),
      });

      const ownedBranches = Object.freeze(
        refsRaw
          .split("\n")
          .map((entry) => entry.trim())
          .filter(isOwnedDensaAdeRunBranch)
          .sort((left, right) => left.localeCompare(right)),
      );
      const currentBranchOwned = branch === undefined ? false : isOwnedDensaAdeRunBranch(branch);
      const densaAdeRun: DensaAdeRunOwnership = Object.freeze({
        branchPrefix: DENSA_ADE_RUN_BRANCH_PREFIX,
        currentBranchOwned,
        ownedBranches,
        hasOwnedRunBranch: ownedBranches.length > 0,
      });
      const decision = decide({ isBare, head, changes, operations, densaAdeRun });

      const ignoredDensaAdeRuntimeArtifacts = parseNullPaths(ignoredRaw);
      return Object.freeze({
        schemaVersion: 1 as const,
        workspacePath: inspectedPath,
        repository: Object.freeze({
          isGitRepository: true,
          isWorkTree: true,
          isBare: false,
          root: repositoryRoot,
          gitDirectory: gitDirectoryValue,
        }),
        head,
        changes,
        operations,
        ignoredDensaAdeRuntimeArtifacts,
        ignoredDensaRuntimeArtifacts: ignoredDensaAdeRuntimeArtifacts,
        densaAdeRun,
        densaRun: densaAdeRun,
        decision,
        automaticActionsPerformed: false as const,
      });
    } catch (error) {
      if (discoveredRepository !== undefined) {
        return failedGitInspectionResult(
          inspectedPath,
          discoveredRepository,
          error instanceof Error ? error.message : "Git workspace inspection failed",
        );
      }
      return stopResult(
        inspectedPath,
        "INSPECTION_FAILED",
        error instanceof Error ? error.message : "Git workspace inspection failed",
      );
    }
  }
}
