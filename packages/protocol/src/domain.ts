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
  roadmapRevisionProposalIdSchema,
  taskIdSchema,
  validationRunIdSchema,
} from "./ids.js";
import { isoTimestampSchema, jsonObjectSchema } from "./json.js";
import { masterRoadmapSchema } from "./master-roadmap.js";
import {
  roadmapMutationApprovalSchema,
  roadmapMutationOperationSchema,
} from "./roadmap-mutation.js";
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
    acceptanceCriteria: z.array(nonEmptyText).min(1).readonly(),
    dependencyIds: z.array(taskIdSchema).readonly(),
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
  commitSha: nonEmptyText.optional(),
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

export const validationRunSchema = z
  .strictObject({
    id: validationRunIdSchema,
    taskId: taskIdSchema,
    attemptId: attemptIdSchema.optional(),
    validatorId: nonEmptyText,
    planId: nonEmptyText.optional(),
    planVersion: nonEmptyText.optional(),
    manualReviewCriteria: z.array(nonEmptyText).default([]),
    startedAt: isoTimestampSchema,
    completedAt: isoTimestampSchema.optional(),
    passed: z.boolean().optional(),
  })
  .superRefine((run, context) => {
    if ((run.planId === undefined) !== (run.planVersion === undefined)) {
      context.addIssue({
        code: "custom",
        message: "Validation plan ID and version must be recorded together",
      });
    }
    if (run.completedAt !== undefined && Date.parse(run.completedAt) < Date.parse(run.startedAt)) {
      context.addIssue({
        code: "custom",
        message: "Validation run completion cannot precede its start",
      });
    }
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

export const decisionKindSchema = z.enum(["decision", "constraint"]);
export type DecisionKind = z.infer<typeof decisionKindSchema>;

export const decisionSourceSchema = z.enum(["user", "master", "system"]);
export type DecisionSource = z.infer<typeof decisionSourceSchema>;

export const decisionScopeSchema = z.enum(["project", "phase", "task"]);
export type DecisionScope = z.infer<typeof decisionScopeSchema>;

export const decisionStatusSchema = z.enum(["active", "superseded"]);
export type DecisionStatus = z.infer<typeof decisionStatusSchema>;

export const decisionSchema = z
  .strictObject({
    id: decisionIdSchema,
    projectId: projectIdSchema,
    kind: decisionKindSchema,
    statement: nonEmptyText,
    title: nonEmptyText,
    rationale: nonEmptyText,
    category: nonEmptyText,
    source: decisionSourceSchema,
    scope: decisionScopeSchema,
    status: decisionStatusSchema,
    supersedesId: decisionIdSchema.optional(),
    affectedPhaseIds: z.array(phaseIdSchema),
    affectedTaskIds: z.array(taskIdSchema),
    createdAt: isoTimestampSchema,
    supersededAt: isoTimestampSchema.optional(),
  })
  .superRefine((decision, context) => {
    if (decision.supersedesId === decision.id) {
      context.addIssue({
        code: "custom",
        message: "A decision cannot supersede itself",
        path: ["supersedesId"],
      });
    }
    if (new Set(decision.affectedPhaseIds).size !== decision.affectedPhaseIds.length) {
      context.addIssue({
        code: "custom",
        message: "Affected phase references must be unique",
        path: ["affectedPhaseIds"],
      });
    }
    if (new Set(decision.affectedTaskIds).size !== decision.affectedTaskIds.length) {
      context.addIssue({
        code: "custom",
        message: "Affected task references must be unique",
        path: ["affectedTaskIds"],
      });
    }
    if (decision.scope === "phase" && decision.affectedPhaseIds.length === 0) {
      context.addIssue({
        code: "custom",
        message: "Phase-scoped decisions require an affected phase reference",
        path: ["affectedPhaseIds"],
      });
    }
    if (decision.scope === "task" && decision.affectedTaskIds.length === 0) {
      context.addIssue({
        code: "custom",
        message: "Task-scoped decisions require an affected task reference",
        path: ["affectedTaskIds"],
      });
    }
    if ((decision.status === "superseded") !== (decision.supersededAt !== undefined)) {
      context.addIssue({
        code: "custom",
        message:
          "Superseded decisions require a superseded timestamp and active decisions forbid it",
        path: ["supersededAt"],
      });
    }
  });
export type Decision = z.infer<typeof decisionSchema>;

export const roadmapRevisionSchema = z
  .strictObject({
    id: roadmapRevisionIdSchema,
    projectId: projectIdSchema,
    classification: roadmapMutationClassificationSchema,
    reason: nonEmptyText,
    actor: nonEmptyText,
    sessionId: nonEmptyText.optional(),
    createdAt: isoTimestampSchema,
    affectedPhaseIds: z.array(phaseIdSchema),
    affectedTaskIds: z.array(taskIdSchema),
    oldValue: jsonObjectSchema,
    newValue: jsonObjectSchema,
    operation: roadmapMutationOperationSchema.optional(),
    operations: z.array(roadmapMutationOperationSchema).min(2).max(32).optional(),
    approval: roadmapMutationApprovalSchema.optional(),
  })
  .superRefine((revision, context) => {
    if (revision.operation !== undefined && revision.operations !== undefined) {
      context.addIssue({
        code: "custom",
        message: "A roadmap revision records either one operation or an operation batch",
        path: ["operations"],
      });
    }
  });
export type RoadmapRevision = z.infer<typeof roadmapRevisionSchema>;

export const roadmapRevisionProposalStatusSchema = z.enum([
  "awaiting_approval",
  "waiting_for_safe_boundary",
  "ready_to_apply",
  "applied",
  "rejected",
  "stale",
]);
export type RoadmapRevisionProposalStatus = z.infer<typeof roadmapRevisionProposalStatusSchema>;

export const roadmapRevisionProposalSchema = z
  .strictObject({
    id: roadmapRevisionProposalIdSchema,
    proposalEventId: eventIdSchema,
    projectId: projectIdSchema,
    baseRevisionNumber: z.number().int().nonnegative(),
    classification: roadmapMutationClassificationSchema,
    rationale: nonEmptyText,
    actor: nonEmptyText,
    sessionId: nonEmptyText,
    operations: z.array(roadmapMutationOperationSchema).min(1).max(32),
    beforeValue: jsonObjectSchema,
    afterValue: jsonObjectSchema,
    affectedPhaseIds: z.array(phaseIdSchema),
    affectedTaskIds: z.array(taskIdSchema),
    activeTaskIds: z.array(taskIdSchema),
    approvalRequired: z.boolean(),
    status: roadmapRevisionProposalStatusSchema,
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
    resolvedAt: isoTimestampSchema.optional(),
    approvalDecisionId: decisionIdSchema.optional(),
    appliedRevisionId: roadmapRevisionIdSchema.optional(),
  })
  .superRefine((proposal, context) => {
    const terminal =
      proposal.status === "applied" ||
      proposal.status === "rejected" ||
      proposal.status === "stale";
    if (terminal !== (proposal.resolvedAt !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Applied or rejected roadmap proposals require a resolution timestamp",
        path: ["resolvedAt"],
      });
    }
    if ((proposal.status === "applied") !== (proposal.appliedRevisionId !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Only applied roadmap proposals reference an applied revision",
        path: ["appliedRevisionId"],
      });
    }
    if (proposal.approvalDecisionId !== undefined && !proposal.approvalRequired) {
      context.addIssue({
        code: "custom",
        message: "Approval evidence is only valid for proposals that required approval",
        path: ["approvalDecisionId"],
      });
    }
    if (
      proposal.status === "applied" &&
      proposal.approvalRequired &&
      proposal.approvalDecisionId === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Applied approval-required proposals must retain their user decision",
        path: ["approvalDecisionId"],
      });
    }
  })
  .readonly();
export type RoadmapRevisionProposal = z.infer<typeof roadmapRevisionProposalSchema>;

export const masterRoadmapRecordSchema = z
  .strictObject({
    projectId: projectIdSchema,
    roadmap: masterRoadmapSchema,
    revisionNumber: z.number().int().nonnegative(),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .readonly();
export type MasterRoadmapRecord = z.infer<typeof masterRoadmapRecordSchema>;

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
