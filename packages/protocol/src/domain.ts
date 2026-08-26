import { z } from "zod";

import {
  agentRunIdSchema,
  attemptIdSchema,
  checkpointIdSchema,
  decisionIdSchema,
  eventIdSchema,
  phaseIdSchema,
  projectIdSchema,
  roadmapRevisionIdSchema,
  taskIdSchema,
  validationRunIdSchema,
} from "./ids.js";
import { isoTimestampSchema, jsonObjectSchema } from "./json.js";
import {
  executionModeSchema,
  phaseStateSchema,
  projectStateSchema,
  roadmapMutationClassificationSchema,
  taskStateSchema,
} from "./states.js";

const nonEmptyText = z.string().min(1);
const position = z.number().int().nonnegative();

export const projectSchema = z
  .strictObject({
    id: projectIdSchema,
    name: nonEmptyText,
    state: projectStateSchema,
    executionMode: executionModeSchema,
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .readonly();
export type Project = z.infer<typeof projectSchema>;

export const phaseSchema = z
  .strictObject({
    id: phaseIdSchema,
    projectId: projectIdSchema,
    title: nonEmptyText,
    state: phaseStateSchema,
    position,
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .readonly();
export type Phase = z.infer<typeof phaseSchema>;

export const taskSchema = z
  .strictObject({
    id: taskIdSchema,
    projectId: projectIdSchema,
    phaseId: phaseIdSchema,
    title: nonEmptyText,
    state: taskStateSchema,
    position,
    acceptanceCriteria: z.array(nonEmptyText).min(1),
    dependencyIds: z.array(taskIdSchema),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .readonly();
export type Task = z.infer<typeof taskSchema>;

export const attemptSchema = z.strictObject({
  id: attemptIdSchema,
  taskId: taskIdSchema,
  number: z.number().int().positive(),
  startedAt: isoTimestampSchema,
  completedAt: isoTimestampSchema.optional(),
  agentRunId: agentRunIdSchema.optional(),
});
export type Attempt = z.infer<typeof attemptSchema>;

export const agentRunSchema = z.strictObject({
  id: agentRunIdSchema,
  attemptId: attemptIdSchema,
  adapterId: nonEmptyText,
  startedAt: isoTimestampSchema,
  completedAt: isoTimestampSchema.optional(),
  adapterRunId: nonEmptyText.optional(),
  processId: z.number().int().positive().max(2_147_483_647).optional(),
  processIdentity: nonEmptyText.optional(),
});
export type AgentRun = z.infer<typeof agentRunSchema>;

export const validationRunSchema = z.strictObject({
  id: validationRunIdSchema,
  taskId: taskIdSchema,
  attemptId: attemptIdSchema.optional(),
  validatorId: nonEmptyText,
  startedAt: isoTimestampSchema,
  completedAt: isoTimestampSchema.optional(),
  passed: z.boolean().optional(),
});
export type ValidationRun = z.infer<typeof validationRunSchema>;

export const checkpointSchema = z
  .strictObject({
    id: checkpointIdSchema,
    projectId: projectIdSchema,
    taskId: taskIdSchema.optional(),
    attemptId: attemptIdSchema.optional(),
    runBranch: nonEmptyText.optional(),
    createdAt: isoTimestampSchema,
    description: nonEmptyText.optional(),
    gitHead: nonEmptyText.optional(),
    gitStatus: z.string().optional(),
    workspaceFingerprint: nonEmptyText.optional(),
  })
  .superRefine((checkpoint, context) => {
    const association = [checkpoint.taskId, checkpoint.attemptId, checkpoint.runBranch];
    const associatedFields = association.filter((value) => value !== undefined).length;
    if (associatedFields !== 0 && associatedFields !== association.length) {
      context.addIssue({
        code: "custom",
        message: "Task checkpoints require taskId, attemptId, and runBranch together",
      });
    }
    if (associatedFields === association.length && checkpoint.gitHead === undefined) {
      context.addIssue({
        code: "custom",
        message: "Task checkpoints require a starting Git commit",
        path: ["gitHead"],
      });
    }
  });
export type Checkpoint = z.infer<typeof checkpointSchema>;

export const decisionSchema = z.strictObject({
  id: decisionIdSchema,
  projectId: projectIdSchema,
  title: nonEmptyText,
  rationale: nonEmptyText,
  createdAt: isoTimestampSchema,
});
export type Decision = z.infer<typeof decisionSchema>;

export const roadmapRevisionSchema = z.strictObject({
  id: roadmapRevisionIdSchema,
  projectId: projectIdSchema,
  classification: roadmapMutationClassificationSchema,
  reason: nonEmptyText,
  actor: nonEmptyText,
  createdAt: isoTimestampSchema,
  affectedPhaseIds: z.array(phaseIdSchema),
  affectedTaskIds: z.array(taskIdSchema),
  oldValue: jsonObjectSchema,
  newValue: jsonObjectSchema,
});
export type RoadmapRevision = z.infer<typeof roadmapRevisionSchema>;

export const eventSchema = z.strictObject({
  id: eventIdSchema,
  projectId: projectIdSchema,
  type: z.string().regex(/^[A-Z][A-Z0-9_]*$/u),
  eventVersion: z.number().int().positive(),
  occurredAt: isoTimestampSchema,
  actor: nonEmptyText,
  phaseId: phaseIdSchema.optional(),
  taskId: taskIdSchema.optional(),
  payload: jsonObjectSchema,
});
export type Event = z.infer<typeof eventSchema>;
