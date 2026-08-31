import { eventIdSchema, type AttemptId } from "@densa-ade/protocol";
import type { DensaAdeDatabase } from "./persistence/database.js";
import type { DensaAdeRunBranchRecord } from "./persistence/repositories.js";
import { assertIsolatedRunWorkspace } from "./isolated-run-workspace.js";
import { guardedPublication } from "./guarded-publication.js";
import {
  inspectChangedPaths,
  inspectCheckpointPath,
  inspectCurrentPath,
  sameState,
  sameWorktree,
} from "./workspace-path-evidence.js";
import { PermissionPolicyService } from "./permission-policy.js";
import { WorkspacePreflight } from "./workspace-preflight.js";

/** Git's guarded fast-forward owns source checkout/index updates; never reset or force a ref. */
export async function publishTaskCommit(
  database: DensaAdeDatabase,
  request: {
    run: DensaAdeRunBranchRecord;
    attemptId: AttemptId;
    expectedHead: string;
    commitSha: string;
    intendedPaths: readonly string[];
    occurredAt: string;
    actor: string;
  },
): Promise<readonly string[]> {
  const { run } = request;
  await assertIsolatedRunWorkspace(run);
  const source = run.sourceWorkspacePath as string;
  const existing = database.repositories.taskPublicationIntents.findByAttemptId(request.attemptId);
  if (
    existing !== undefined &&
    (existing.sourceWorkspacePath !== source ||
      existing.sourceBranch !== run.sourceBranch ||
      existing.expectedHead !== request.expectedHead ||
      existing.commitSha !== request.commitSha)
  )
    throw new Error("Publication intent conflicts with the validated attempt");
  const preflight = await new WorkspacePreflight().inspect(source);
  if (
    preflight.repository.root !== source ||
    preflight.head.branch !== run.sourceBranch ||
    (preflight.decision.outcome === "STOP" && preflight.decision.code !== "USER_CHANGES_PRESENT")
  )
    throw new Error("Source workspace is no longer safe for publication");
  const head = preflight.head.commit;
  if (head !== request.expectedHead && head !== request.commitSha)
    throw new Error(
      "Source HEAD diverged from the publication checkpoint; preserve both branches for resolution",
    );
  const humanPaths = (await inspectChangedPaths(source)).filter(
    (path) => !request.intendedPaths.includes(path),
  );
  if (head === request.expectedHead) {
    // Source edits made even before terminal capture were never present in the worker worktree.
    for (const path of request.intendedPaths) {
      const baseline = await inspectCheckpointPath(source, request.expectedHead, path, false);
      const current = await inspectCurrentPath(source, path, false);
      if ("failure" in baseline || !sameState(current, baseline))
        throw new Error(`Source human edit overlaps ${path}; publication requires resolution`);
    }
  }
  if (existing === undefined)
    database.repositories.taskPublicationIntents.create({
      attemptId: request.attemptId,
      sourceWorkspacePath: source,
      sourceBranch: run.sourceBranch,
      expectedHead: request.expectedHead,
      commitSha: request.commitSha,
      createdAt: request.occurredAt,
    });
  if (head === request.expectedHead) {
    const permission = new PermissionPolicyService(database).authorize({
      projectId: run.projectId,
      operation: "git_mutation",
      actor: request.actor,
      occurredAt: request.occurredAt,
      reason:
        "Publish the verified task commit with a guarded fast-forward into its unchanged source paths",
    });
    if (permission.authorization === undefined)
      throw new Error(
        `Publication policy ${permission.decision.disposition}: ${permission.decision.reason}`,
      );
    await guardedPublication({
      source,
      sourceBranch: run.sourceBranch,
      expectedHead: request.expectedHead,
      commitSha: request.commitSha,
      attemptId: request.attemptId,
      verify: async () => {
        const current = await new WorkspacePreflight().inspect(source);
        if (
          current.head.branch !== run.sourceBranch ||
          current.head.commit !== request.expectedHead ||
          (current.decision.outcome === "STOP" && current.decision.code !== "USER_CHANGES_PRESENT")
        )
          throw new Error("Source changed after publication intent");
        for (const path of request.intendedPaths) {
          const baseline = await inspectCheckpointPath(source, request.expectedHead, path, false);
          if (
            "failure" in baseline ||
            !sameState(await inspectCurrentPath(source, path, false), baseline)
          )
            throw new Error(`Source human edit overlaps ${path}; publication requires resolution`);
        }
      },
    });
  }
  const after = await new WorkspacePreflight().inspect(source);
  if (
    after.head.commit !== request.commitSha ||
    after.head.branch !== run.sourceBranch ||
    after.operations.active.length !== 0
  )
    throw new Error("Publication Git identity could not be verified");
  for (const path of request.intendedPaths) {
    const expected = await inspectCheckpointPath(source, request.commitSha, path, false);
    const current = await inspectCurrentPath(source, path, false);
    if (
      "failure" in expected ||
      !sameWorktree(current, expected) ||
      current.indexHash !== expected.indexHash
    )
      throw new Error(
        `Published path ${path} differs from the validated commit; recovery must inspect it`,
      );
  }
  if (existing?.publishedAt === undefined)
    database.transaction((repositories) => {
      repositories.taskPublicationIntents.recordPublished(request.attemptId, request.occurredAt);
      const attempt = repositories.attempts.findById(request.attemptId);
      if (attempt === undefined) throw new Error("Publication attempt disappeared");
      const task = repositories.tasks.findById(attempt.taskId);
      if (task === undefined) throw new Error("Publication task disappeared");
      repositories.events.append({
        id: eventIdSchema.parse(`${request.attemptId}:published`),
        projectId: run.projectId,
        phaseId: task.phaseId,
        taskId: task.id,
        type: "TASK_COMMIT_PUBLISHED",
        eventVersion: 1,
        occurredAt: request.occurredAt,
        actor: request.actor,
        payload: {
          attemptId: request.attemptId,
          commitSha: request.commitSha,
          sourceBranch: run.sourceBranch,
        },
      });
    });
  return humanPaths;
}
