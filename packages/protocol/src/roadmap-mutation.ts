import { z } from "zod";

import { decisionIdSchema } from "./ids.js";
import {
  masterRoadmapPhaseSchema,
  masterRoadmapTaskSchema,
  roadmapRiskLevelSchema,
  roadmapValidatorCategorySchema,
} from "./master-roadmap.js";
import { roadmapMutationClassificationSchema } from "./states.js";

const nonEmptyText = z.string().refine((value) => value.trim().length > 0, {
  message: "Roadmap mutation text must contain non-whitespace content",
});
const stableRoadmapId = z.string().regex(/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/u);
const position = z.number().int().nonnegative();

export const roadmapMutationApprovalSchema = z
  .strictObject({
    decisionId: decisionIdSchema,
    approvedBy: nonEmptyText,
    approvedAt: z.iso.datetime({ offset: true }),
    sessionId: nonEmptyText,
  })
  .readonly();
export type RoadmapMutationApproval = z.infer<typeof roadmapMutationApprovalSchema>;

export const roadmapMutationOperationSchema = z.discriminatedUnion("kind", [
  z
    .strictObject({
      kind: z.literal("add_task"),
      phaseId: stableRoadmapId,
      position,
      task: masterRoadmapTaskSchema,
    })
    .readonly(),
  z
    .strictObject({
      kind: z.literal("split_task"),
      taskId: stableRoadmapId,
      replacementTasks: z.array(masterRoadmapTaskSchema).min(2),
    })
    .readonly(),
  z
    .strictObject({
      kind: z.literal("reorder_task"),
      taskId: stableRoadmapId,
      phaseId: stableRoadmapId,
      position,
    })
    .readonly(),
  z
    .strictObject({
      kind: z.literal("change_dependency"),
      taskId: stableRoadmapId,
      dependencyIds: z.array(stableRoadmapId),
    })
    .readonly(),
  z
    .strictObject({
      kind: z.literal("modify_acceptance_criteria"),
      taskId: stableRoadmapId,
      acceptanceCriteria: z.array(nonEmptyText),
    })
    .readonly(),
  z
    .strictObject({
      kind: z.literal("add_phase"),
      position,
      phase: masterRoadmapPhaseSchema,
    })
    .readonly(),
  z
    .strictObject({
      kind: z.literal("remove_phase"),
      phaseId: stableRoadmapId,
    })
    .readonly(),
  z
    .strictObject({
      kind: z.literal("change_architecture_task_details"),
      taskId: stableRoadmapId,
      title: nonEmptyText.optional(),
      goal: nonEmptyText.optional(),
      riskLevel: roadmapRiskLevelSchema.optional(),
      expectedValidators: z.array(roadmapValidatorCategorySchema).optional(),
    })
    .refine(
      ({ title, goal, riskLevel, expectedValidators }) =>
        title !== undefined ||
        goal !== undefined ||
        riskLevel !== undefined ||
        expectedValidators !== undefined,
      { message: "Architecture detail mutation must change at least one field" },
    )
    .readonly(),
  z
    .strictObject({
      kind: z.literal("mark_task_superseded"),
      taskId: stableRoadmapId,
      supersededByTaskIds: z.array(stableRoadmapId).min(1),
    })
    .readonly(),
]);
export type RoadmapMutationOperation = z.infer<typeof roadmapMutationOperationSchema>;

export const roadmapMutationRequestSchema = z
  .strictObject({
    operation: roadmapMutationOperationSchema,
    classification: roadmapMutationClassificationSchema.optional(),
    rationale: nonEmptyText,
    actor: nonEmptyText,
    sessionId: nonEmptyText,
    applicationMode: z.enum(["automatic", "approved"]),
    approval: roadmapMutationApprovalSchema.optional(),
  })
  .superRefine((request, context) => {
    if (request.applicationMode === "approved" && request.approval === undefined) {
      context.addIssue({
        code: "custom",
        message: "Approved roadmap mutations require explicit approval evidence",
        path: ["approval"],
      });
    }
    if (request.applicationMode === "automatic" && request.approval !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Automatic roadmap mutations must not attach approval evidence",
        path: ["approval"],
      });
    }
  })
  .readonly();
export type RoadmapMutationRequest = z.infer<typeof roadmapMutationRequestSchema>;
