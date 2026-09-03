import { isAbsolute, resolve } from "node:path";

import type { ProjectId } from "@densa-ade/protocol";

import type { DensaAdeDatabase } from "./persistence/database.js";

export class ProjectWorkspaceError extends Error {
  readonly code = "WORKSPACE_CONFLICT" as const;

  constructor(message: string) {
    super(message);
    this.name = "ProjectWorkspaceError";
  }
}

function configuredWorkspace(value: unknown): string | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("workspacePath" in value) ||
    typeof value.workspacePath !== "string" ||
    !isAbsolute(value.workspacePath)
  ) {
    return undefined;
  }
  return resolve(value.workspacePath);
}

/** Fails closed when persisted execution ownership binds a project to another workspace. */
export function assertProjectWorkspace(
  database: DensaAdeDatabase,
  projectId: ProjectId,
  requestedWorkspacePath: string,
): void {
  const requested = resolve(requestedWorkspacePath);
  const run = database.repositories.densaAdeRunBranches.findByProjectId(projectId);
  const settings = database.repositories.projectSettings.findByProjectId(projectId)?.values;
  const expected =
    configuredWorkspace(settings?.["coreRuntime"]) ??
    run?.sourceWorkspacePath ??
    run?.workspacePath ??
    configuredWorkspace(settings?.["executionControl"]) ??
    configuredWorkspace(settings?.["usageAutoResume"]);
  if (expected !== undefined && resolve(expected) !== requested) {
    throw new ProjectWorkspaceError(
      `Project ${projectId} is bound to workspace ${expected}, not ${requested}`,
    );
  }
}
