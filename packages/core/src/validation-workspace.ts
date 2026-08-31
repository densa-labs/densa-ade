import { realpath } from "node:fs/promises";
import { eventIdSchema, jsonObjectSchema, type ValidationRunId } from "@densa-ade/protocol";
import type { DensaAdeDatabase } from "./persistence/database.js";
import type { RollbackPathSnapshot } from "./persistence/repositories.js";
import { GitWorkspaceProbe, type WorkspaceSnapshot } from "./recovery-inspector.js";
import { WorkspacePreflight } from "./workspace-preflight.js";
import {
  inspectChangedPaths,
  inspectCurrentPath,
  normalizePaths,
  sameState,
} from "./workspace-path-evidence.js";

export interface ValidationWorkspaceEvidence {
  readonly workspaceRoot: string;
  readonly snapshot: WorkspaceSnapshot;
  readonly paths: readonly RollbackPathSnapshot[];
}

export function validationWorkspaceEventId(runId: ValidationRunId) {
  return eventIdSchema.parse(`${runId}:workspace-verified`);
}

/** Capture bytes before validation. Only hashes and repository-relative paths become durable. */
export async function captureValidationWorkspace(
  workspacePath: string,
): Promise<ValidationWorkspaceEvidence> {
  const preflight = await new WorkspacePreflight().inspect(workspacePath);
  if (
    preflight.repository.root === undefined ||
    (preflight.decision.outcome === "STOP" && preflight.decision.code !== "USER_CHANGES_PRESENT")
  )
    throw new Error("Validation workspace has incomplete or unsafe Git evidence");
  const workspaceRoot = await realpath(preflight.repository.root);
  const probe = new GitWorkspaceProbe();
  const before = await probe.inspect(workspaceRoot);
  if (before.status !== "available") throw new Error(before.reason);
  const changed = await inspectChangedPaths(workspaceRoot);
  if (changed.length > 0 && normalizePaths(changed) === undefined)
    throw new Error("Unsupported validation workspace paths");
  const paths = [];
  for (const path of changed) paths.push(await inspectCurrentPath(workspaceRoot, path, false));
  const after = await probe.inspect(workspaceRoot);
  if (after.status !== "available" || before.snapshot.fingerprint !== after.snapshot.fingerprint) {
    throw new Error("Workspace changed while capturing validation evidence");
  }
  return Object.freeze({ workspaceRoot, snapshot: after.snapshot, paths: Object.freeze(paths) });
}

export async function assertValidationWorkspaceUnchanged(
  evidence: ValidationWorkspaceEvidence,
  stagedPaths: readonly string[] = [],
): Promise<void> {
  const current = await captureValidationWorkspace(evidence.workspaceRoot);
  const pathsMatch =
    current.paths.length === evidence.paths.length &&
    current.paths.every((path, index) => {
      const expected = evidence.paths[index];
      if (expected === undefined || path.path !== expected.path) return false;
      return (
        sameState(path, expected) ||
        (stagedPaths.includes(path.path) &&
          path.kind === expected.kind &&
          path.contentHash === expected.contentHash &&
          path.indexHash === expected.contentHash)
      );
    });
  if (
    current.snapshot.gitHead !== evidence.snapshot.gitHead ||
    !pathsMatch ||
    (stagedPaths.length === 0 && current.snapshot.fingerprint !== evidence.snapshot.fingerprint)
  ) {
    throw new Error("Workspace changed during or after validation; validation must run again");
  }
}

/** Call in the same transaction as the completed passing validation outcome. */
export function recordValidationWorkspace(
  database: DensaAdeDatabase,
  runId: ValidationRunId,
  evidence: ValidationWorkspaceEvidence,
): void {
  const run = database.repositories.validationRuns.findById(runId);
  const task = run === undefined ? undefined : database.repositories.tasks.findById(run.taskId);
  if (run?.passed !== true || run.completedAt === undefined || task === undefined)
    throw new Error("Workspace proof requires a completed passing validation");
  database.repositories.events.append({
    id: validationWorkspaceEventId(runId),
    projectId: task.projectId,
    phaseId: task.phaseId,
    taskId: task.id,
    type: "VALIDATION_WORKSPACE_VERIFIED",
    eventVersion: 1,
    occurredAt: run.completedAt,
    actor: "densa-ade:validation",
    payload: jsonObjectSchema.parse({ validationRunId: runId, ...evidence }),
  });
}

/** Old validations remain readable, but cannot certify a new commit without content evidence. */
export function readValidationWorkspace(
  database: DensaAdeDatabase,
  runId: ValidationRunId,
): ValidationWorkspaceEvidence | undefined {
  const run = database.repositories.validationRuns.findById(runId);
  const task = run === undefined ? undefined : database.repositories.tasks.findById(run.taskId);
  const event = database.repositories.events.findById(validationWorkspaceEventId(runId));
  if (
    event?.type !== "VALIDATION_WORKSPACE_VERIFIED" ||
    event.eventVersion !== 1 ||
    event.taskId !== task?.id ||
    event.projectId !== task?.projectId ||
    event.occurredAt !== run?.completedAt ||
    event.payload["validationRunId"] !== runId
  )
    return undefined;
  const { workspaceRoot, snapshot, paths } = event.payload;
  if (
    typeof workspaceRoot !== "string" ||
    snapshot === null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot) ||
    !Array.isArray(paths)
  )
    return undefined;
  if (
    typeof snapshot["gitHead"] !== "string" ||
    typeof snapshot["gitStatus"] !== "string" ||
    typeof snapshot["fingerprint"] !== "string" ||
    !/^[a-f0-9]{64}$/u.test(snapshot["fingerprint"])
  )
    return undefined;
  const parsed: RollbackPathSnapshot[] = [];
  for (const path of paths) {
    if (
      path === null ||
      typeof path !== "object" ||
      Array.isArray(path) ||
      typeof path["path"] !== "string" ||
      normalizePaths([path["path"]]) === undefined ||
      !(path["kind"] === "ABSENT" || path["kind"] === "FILE" || path["kind"] === "SYMLINK") ||
      path["temporary"] !== false
    )
      return undefined;
    const contentHash = path["contentHash"];
    const indexHash = path["indexHash"];
    if (
      (path["kind"] === "ABSENT") !== (contentHash === undefined) ||
      (contentHash !== undefined &&
        (typeof contentHash !== "string" || !/^[a-f0-9]{64}$/u.test(contentHash))) ||
      (indexHash !== undefined &&
        (typeof indexHash !== "string" || !/^[a-f0-9]{64}$/u.test(indexHash)))
    )
      return undefined;
    parsed.push({
      path: path["path"],
      kind: path["kind"],
      temporary: false,
      ...(contentHash === undefined ? {} : { contentHash: contentHash as string }),
      ...(indexHash === undefined ? {} : { indexHash: indexHash as string }),
    });
  }
  if (new Set(parsed.map((path) => path.path)).size !== parsed.length) return undefined;
  return {
    workspaceRoot,
    snapshot: {
      gitHead: snapshot["gitHead"],
      gitStatus: snapshot["gitStatus"],
      fingerprint: snapshot["fingerprint"],
    },
    paths: parsed,
  };
}
