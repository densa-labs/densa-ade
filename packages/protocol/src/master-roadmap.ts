import { z } from "zod";

import type { JsonObject } from "./json.js";

const preservedTextSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "Roadmap text must contain non-whitespace content",
});
const stableRoadmapIdSchema = z.string().regex(/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/u, {
  message: "Roadmap IDs must be stable alphanumeric segments separated by '.', '_' or '-'",
});

export const roadmapRiskLevelSchema = z.enum(["low", "medium", "high", "critical"]);
export type RoadmapRiskLevel = z.infer<typeof roadmapRiskLevelSchema>;

export const roadmapValidatorCategorySchema = z.enum([
  "build",
  "typecheck",
  "lint",
  "unit_test",
  "integration_test",
  "end_to_end",
  "acceptance",
  "security",
  "accessibility",
  "performance",
  "manual_review",
  "independent_ai_review",
]);
export type RoadmapValidatorCategory = z.infer<typeof roadmapValidatorCategorySchema>;

export const masterRoadmapTaskSchema = z
  .strictObject({
    id: stableRoadmapIdSchema,
    title: preservedTextSchema,
    goal: preservedTextSchema,
    executable: z.boolean(),
    dependencyIds: z.array(stableRoadmapIdSchema),
    acceptanceCriteria: z.array(preservedTextSchema),
    riskLevel: roadmapRiskLevelSchema,
    expectedValidators: z.array(roadmapValidatorCategorySchema),
  })
  .superRefine((task, context) => {
    const dependencies = new Set<string>();
    for (const [index, dependencyId] of task.dependencyIds.entries()) {
      if (dependencies.has(dependencyId)) {
        context.addIssue({
          code: "custom",
          message: `Task ${task.id} repeats dependency ${dependencyId}`,
          path: ["dependencyIds", index],
        });
      }
      dependencies.add(dependencyId);
    }
    if (task.executable && task.acceptanceCriteria.length === 0) {
      context.addIssue({
        code: "custom",
        message: `Executable task ${task.id} must define at least one concrete acceptance criterion`,
        path: ["acceptanceCriteria"],
      });
    }
    if (task.executable && task.expectedValidators.length === 0) {
      context.addIssue({
        code: "custom",
        message: `Executable task ${task.id} must name at least one expected validator category`,
        path: ["expectedValidators"],
      });
    }
  })
  .readonly();
export type MasterRoadmapTask = z.infer<typeof masterRoadmapTaskSchema>;

export const masterRoadmapPhaseSchema = z
  .strictObject({
    id: stableRoadmapIdSchema,
    title: preservedTextSchema,
    goal: preservedTextSchema,
    required: z.boolean(),
    completionCriteria: z.array(preservedTextSchema),
    tasks: z.array(masterRoadmapTaskSchema),
  })
  .superRefine((phase, context) => {
    if (phase.required && phase.tasks.length === 0) {
      context.addIssue({
        code: "custom",
        message: `Required phase ${phase.id} must contain at least one task`,
        path: ["tasks"],
      });
    }
    if (phase.required && phase.completionCriteria.length === 0) {
      context.addIssue({
        code: "custom",
        message: `Required phase ${phase.id} must define explicit completion criteria`,
        path: ["completionCriteria"],
      });
    }
  })
  .readonly();
export type MasterRoadmapPhase = z.infer<typeof masterRoadmapPhaseSchema>;

export const masterRoadmapSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    projectGoal: preservedTextSchema,
    phases: z.array(masterRoadmapPhaseSchema).min(1, {
      message: "A complete roadmap must contain at least one phase",
    }),
  })
  .superRefine((roadmap, context) => {
    const idPaths = new Map<string, readonly (string | number)[]>();
    const taskIds = new Set<string>();
    const tasks: {
      readonly task: MasterRoadmapTask;
      readonly path: readonly (string | number)[];
    }[] = [];

    for (const [phaseIndex, phase] of roadmap.phases.entries()) {
      const phasePath = ["phases", phaseIndex, "id"] as const;
      const priorPhasePath = idPaths.get(phase.id);
      if (priorPhasePath !== undefined) {
        context.addIssue({
          code: "custom",
          message: `Roadmap ID ${phase.id} is duplicated; first declared at ${priorPhasePath.join(".")}`,
          path: [...phasePath],
        });
      } else {
        idPaths.set(phase.id, phasePath);
      }

      for (const [taskIndex, task] of phase.tasks.entries()) {
        const taskPath = ["phases", phaseIndex, "tasks", taskIndex] as const;
        const priorTaskPath = idPaths.get(task.id);
        if (priorTaskPath !== undefined) {
          context.addIssue({
            code: "custom",
            message: `Roadmap ID ${task.id} is duplicated; first declared at ${priorTaskPath.join(".")}`,
            path: [...taskPath, "id"],
          });
        } else {
          idPaths.set(task.id, [...taskPath, "id"]);
        }
        taskIds.add(task.id);
        tasks.push({ task, path: taskPath });
      }
    }

    for (const { task, path } of tasks) {
      for (const [dependencyIndex, dependencyId] of task.dependencyIds.entries()) {
        if (!taskIds.has(dependencyId)) {
          context.addIssue({
            code: "custom",
            message: `Task ${task.id} depends on missing task ${dependencyId}`,
            path: [...path, "dependencyIds", dependencyIndex],
          });
        }
      }
    }

    const indegree = new Map(tasks.map(({ task }) => [task.id, 0]));
    const dependents = new Map(tasks.map(({ task }) => [task.id, [] as string[]]));
    for (const { task } of tasks) {
      for (const dependencyId of new Set(task.dependencyIds)) {
        if (!taskIds.has(dependencyId)) continue;
        indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1);
        dependents.get(dependencyId)?.push(task.id);
      }
    }
    const queue = tasks
      .filter(({ task }) => indegree.get(task.id) === 0)
      .map(({ task }) => task.id);
    let visited = 0;
    for (let index = 0; index < queue.length; index += 1) {
      const taskId = queue[index];
      if (taskId === undefined) continue;
      visited += 1;
      for (const dependentId of dependents.get(taskId) ?? []) {
        const nextIndegree = (indegree.get(dependentId) ?? 0) - 1;
        indegree.set(dependentId, nextIndegree);
        if (nextIndegree === 0) queue.push(dependentId);
      }
    }
    if (visited !== tasks.length) {
      const cyclicTaskIds = tasks
        .filter(({ task }) => (indegree.get(task.id) ?? 0) > 0)
        .map(({ task }) => task.id);
      context.addIssue({
        code: "custom",
        message: `Task dependency cycle includes: ${cyclicTaskIds.join(", ")}`,
        path: ["phases"],
      });
    }
  })
  .readonly();
export type MasterRoadmap = z.infer<typeof masterRoadmapSchema>;

/** JSON Schema supplied to adapters with constrained final-response support. */
export const masterRoadmapOutputSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["formatVersion", "projectGoal", "phases"],
  properties: {
    formatVersion: { type: "integer", enum: [1] },
    projectGoal: { type: "string", minLength: 1 },
    phases: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "goal", "required", "completionCriteria", "tasks"],
        properties: {
          id: { type: "string", pattern: "^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$" },
          title: { type: "string", minLength: 1 },
          goal: { type: "string", minLength: 1 },
          required: { type: "boolean" },
          completionCriteria: { type: "array", items: { type: "string", minLength: 1 } },
          tasks: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "id",
                "title",
                "goal",
                "executable",
                "dependencyIds",
                "acceptanceCriteria",
                "riskLevel",
                "expectedValidators",
              ],
              properties: {
                id: { type: "string", pattern: "^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$" },
                title: { type: "string", minLength: 1 },
                goal: { type: "string", minLength: 1 },
                executable: { type: "boolean" },
                dependencyIds: {
                  type: "array",
                  items: {
                    type: "string",
                    pattern: "^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$",
                  },
                },
                acceptanceCriteria: {
                  type: "array",
                  items: { type: "string", minLength: 1 },
                },
                riskLevel: { type: "string", enum: roadmapRiskLevelSchema.options },
                expectedValidators: {
                  type: "array",
                  items: { type: "string", enum: roadmapValidatorCategorySchema.options },
                },
              },
            },
          },
        },
      },
    },
  },
};
