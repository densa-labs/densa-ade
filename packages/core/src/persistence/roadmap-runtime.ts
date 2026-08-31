import { isDeepStrictEqual } from "node:util";
import {
  phaseSchema,
  phaseIdSchema,
  taskSchema,
  taskIdSchema,
  type MasterRoadmap,
  type MasterRoadmapRecord,
  type Task,
} from "@densa-ade/protocol";
import type { DensaAdeRepositories } from "./repositories.js";
import { PersistenceError, type SqliteConnection } from "./sqlite-connection.js";

/** Called only inside the roadmap transaction. Runtime rows project the same graph as the JSON.
 * Existing lifecycle states and historical evidence are never rewritten to fit a new plan.
 */
export function synchronizeRoadmapRuntime(
  connection: SqliteConnection,
  repositories: DensaAdeRepositories,
  record: MasterRoadmapRecord,
  before?: MasterRoadmap,
  cancelSupersededTask?: (task: Task) => void,
): void {
  const projectId = record.projectId;
  const phases = repositories.phases.listByProjectId(projectId);
  const tasks = repositories.tasks.listByProjectId(projectId);
  const phaseById = new Map(phases.map((phase) => [String(phase.id), phase]));
  const taskById = new Map(tasks.map((task) => [String(task.id), task]));
  const oldPhases = new Map(before?.phases.map((phase) => [phase.id, phase]));
  const oldTasks = new Map(
    before?.phases.flatMap((phase) => phase.tasks.map((task) => [task.id, task] as const)),
  );
  const nextPhases = new Map(record.roadmap.phases.map((phase) => [phase.id, phase]));
  const nextTasks = new Map(
    record.roadmap.phases.flatMap((phase) =>
      phase.tasks.map((task) => [task.id, { task, phase }] as const),
    ),
  );
  const fail = (message: string): never => {
    throw new PersistenceError(`Roadmap runtime reconciliation: ${message}`);
  };
  if (before === undefined && (phases.length > 0 || tasks.length > 0)) {
    fail(
      "Initial runtime materialization requires empty phase/task storage; existing work must not be overwritten",
    );
  }

  // IDs are global runtime keys, even though each submitted graph is validated separately.
  for (const phase of record.roadmap.phases) {
    const existing = repositories.phases.findById(phaseIdSchema.parse(phase.id));
    if (existing !== undefined && existing.projectId !== projectId)
      fail(`phase ID ${phase.id} belongs to another project; use project-qualified stable IDs`);
    for (const task of phase.tasks) {
      const existingTask = repositories.tasks.findById(taskIdSchema.parse(task.id));
      if (existingTask !== undefined && existingTask.projectId !== projectId)
        fail(`task ID ${task.id} belongs to another project; use project-qualified stable IDs`);
    }
  }

  if (before !== undefined && (phases.length > 0 || tasks.length > 0)) {
    for (const [position, phase] of before.phases.entries()) {
      const persisted = phaseById.get(phase.id);
      if (persisted === undefined || persisted.position !== position)
        fail(`phase ${phase.id} has stale runtime metadata`);
      for (const [taskPosition, task] of phase.tasks.entries()) {
        const persistedTask = taskById.get(task.id);
        if (!task.executable && persistedTask === undefined) continue;
        if (
          persistedTask === undefined ||
          persistedTask.phaseId !== phase.id ||
          persistedTask.position !== taskPosition ||
          !isDeepStrictEqual(persistedTask.dependencyIds, task.dependencyIds) ||
          !isDeepStrictEqual(persistedTask.acceptanceCriteria, task.acceptanceCriteria)
        )
          fail(`task ${task.id} has stale runtime metadata`);
      }
    }
    if (
      phases.some((phase) => !oldPhases.has(phase.id)) ||
      tasks.some((task) => !oldTasks.has(task.id))
    )
      fail("runtime contains work absent from the current roadmap");
  }

  for (const phase of phases) {
    const next = nextPhases.get(phase.id);
    const previous = oldPhases.get(phase.id);
    if (
      previous !== undefined &&
      ((!isDeepStrictEqual(previous, next) &&
        ["VALIDATING", "AWAITING_APPROVAL", "COMPLETED"].includes(phase.state)) ||
        (record.roadmap.phases.findIndex((candidate) => candidate.id === phase.id) !==
          phase.position &&
          phase.state !== "PENDING"))
    ) {
      fail(`phase ${phase.id} is active or completed; a safe boundary is required`);
    }
    if (
      next === undefined &&
      (phase.state !== "PENDING" ||
        connection.get("SELECT id FROM events WHERE phase_id = ? LIMIT 1", phase.id) !== undefined)
    )
      fail(`cannot remove phase ${phase.id} with lifecycle history`);
  }
  for (const task of tasks) {
    const next = nextTasks.get(task.id);
    const previous = oldTasks.get(task.id);
    const changed =
      next === undefined ||
      !isDeepStrictEqual(previous, next.task) ||
      next.phase.id !== task.phaseId ||
      next.phase.tasks.findIndex((candidate) => candidate.id === task.id) !== task.position;
    const attempts = repositories.attempts.listByTaskId(task.id);
    if (
      changed &&
      (["RUNNING", "VALIDATING", "RETRYING", "WAITING_FOR_USAGE"].includes(task.state) ||
        attempts.some((attempt) => attempt.completedAt === undefined))
    )
      fail(`task ${task.id} is active; a safe boundary is required`);
    if (
      next !== undefined &&
      task.state === "READY" &&
      next.task.executable &&
      !isDeepStrictEqual(task.dependencyIds, next.task.dependencyIds) &&
      next.task.dependencyIds.some((id) => taskById.get(id)?.state !== "COMPLETED")
    ) {
      fail(
        `task ${task.id} cannot remain READY with new incomplete dependencies; return it to planning first`,
      );
    }
    if (next === undefined || next.phase.id !== task.phaseId) {
      if (
        task.state !== "PENDING" ||
        attempts.length > 0 ||
        connection.get("SELECT id FROM events WHERE task_id = ? LIMIT 1", task.id) !== undefined ||
        connection.get("SELECT id FROM validation_runs WHERE task_id = ? LIMIT 1", task.id) !==
          undefined
      )
        fail(`cannot remove or move task ${task.id} with lifecycle history; use supersession`);
    }
    if (
      next !== undefined &&
      previous !== undefined &&
      !isDeepStrictEqual(previous, next.task) &&
      task.state === "COMPLETED"
    ) {
      // Supersession retains the old task and all its evidence; changing a validated promise does not.
      const superseded = {
        ...previous,
        executable: false,
        supersededByTaskIds: next.task.supersededByTaskIds,
      };
      if (!isDeepStrictEqual(superseded, next.task))
        fail(`task ${task.id} has execution evidence; revise through replacement work`);
    }
  }

  for (const task of tasks) {
    if (
      oldTasks.get(task.id)?.executable === true &&
      nextTasks.get(task.id)?.task.executable === false &&
      task.state !== "COMPLETED" &&
      task.state !== "CANCELLED"
    ) {
      if (cancelSupersededTask === undefined)
        fail("Supersession requires an audited cancellation boundary");
      cancelSupersededTask?.(task);
    }
  }

  // Vacate unique position slots without deleting rows or touching their states/history.
  const phaseOffset =
    Math.max(0, ...phases.map((phase) => phase.position)) + record.roadmap.phases.length + 1;
  const taskOffset = Math.max(0, ...tasks.map((task) => task.position)) + nextTasks.size + 1;
  connection.run(
    "UPDATE phases SET position = position + ? WHERE project_id = ?",
    phaseOffset,
    projectId,
  );
  connection.run(
    "UPDATE tasks SET position = position + ? WHERE project_id = ?",
    taskOffset,
    projectId,
  );
  connection.run("DELETE FROM task_dependencies WHERE project_id = ?", projectId);
  for (const task of tasks)
    if (!nextTasks.has(task.id))
      connection.run("DELETE FROM tasks WHERE id = ? AND project_id = ?", task.id, projectId);

  for (const [position, phase] of record.roadmap.phases.entries()) {
    const previous = phaseById.get(phase.id);
    if (previous === undefined) {
      repositories.phases.create(
        phaseSchema.parse({
          id: phase.id,
          projectId,
          title: phase.title,
          state: "PENDING",
          position,
          createdAt: record.updatedAt,
          updatedAt: record.updatedAt,
        }),
      );
    } else {
      connection.run(
        "UPDATE phases SET title = ?, position = ?, updated_at = ? WHERE id = ? AND project_id = ?",
        phase.title,
        position,
        record.updatedAt,
        phase.id,
        projectId,
      );
    }
    for (const [taskPosition, task] of phase.tasks.entries()) {
      const persisted = taskById.get(task.id);
      if (persisted === undefined) {
        // Install dependency edges only after every target row exists (including forward references).
        repositories.tasks.create(
          taskSchema.parse({
            id: task.id,
            projectId,
            phaseId: phase.id,
            title: task.title,
            state: "PENDING",
            position: taskPosition,
            acceptanceCriteria: task.acceptanceCriteria,
            dependencyIds: [],
            createdAt: record.updatedAt,
            updatedAt: record.updatedAt,
          }),
        );
      } else {
        connection.run(
          "UPDATE tasks SET phase_id = ?, title = ?, position = ?, updated_at = ? WHERE id = ? AND project_id = ?",
          phase.id,
          task.title,
          taskPosition,
          record.updatedAt,
          task.id,
          projectId,
        );
        connection.run("DELETE FROM acceptance_criteria WHERE task_id = ?", task.id);
        for (const [criterionPosition, criterion] of task.acceptanceCriteria.entries()) {
          connection.run(
            "INSERT INTO acceptance_criteria (project_id, task_id, position, description) VALUES (?, ?, ?, ?)",
            projectId,
            task.id,
            criterionPosition,
            criterion,
          );
        }
      }
    }
  }
  for (const phase of phases)
    if (!nextPhases.has(phase.id))
      connection.run("DELETE FROM phases WHERE id = ? AND project_id = ?", phase.id, projectId);
  for (const { task } of nextTasks.values()) {
    for (const [position, dependencyId] of task.dependencyIds.entries()) {
      connection.run(
        "INSERT INTO task_dependencies (project_id, task_id, dependency_task_id, position) VALUES (?, ?, ?, ?)",
        projectId,
        task.id,
        dependencyId,
        position,
      );
    }
  }
}
