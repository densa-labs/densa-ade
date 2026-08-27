import { z } from "zod";

import {
  decisionIdSchema,
  phaseIdSchema,
  projectIdSchema,
  roadmapRevisionIdSchema,
  taskIdSchema,
} from "./ids.js";
import { isoTimestampSchema } from "./json.js";
import {
  executionModeSchema,
  phaseStateSchema,
  roadmapMutationClassificationSchema,
} from "./states.js";

const nonEmptyText = z.string().trim().min(1);

export const phaseReportOutcomeSchema = z.enum(["blocked", "awaiting_approval", "completed"]);
export type PhaseReportOutcome = z.infer<typeof phaseReportOutcomeSchema>;

export const phaseReportValidationCheckSchema = z
  .strictObject({
    scope: z.enum(["task", "phase"]),
    validatorId: nonEmptyText,
    taskId: taskIdSchema.optional(),
    passed: z.boolean(),
    summary: nonEmptyText,
    startedAt: isoTimestampSchema.optional(),
    completedAt: isoTimestampSchema.optional(),
  })
  .superRefine((check, context) => {
    if ((check.scope === "task") !== (check.taskId !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Task validation checks require taskId and phase checks must omit it",
        path: ["taskId"],
      });
    }
  })
  .readonly();
export type PhaseReportValidationCheck = z.infer<typeof phaseReportValidationCheckSchema>;

export const phaseReportSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    projectId: projectIdSchema,
    phaseId: phaseIdSchema,
    phaseTitle: nonEmptyText,
    outcome: phaseReportOutcomeSchema,
    executionMode: executionModeSchema,
    roadmapRevisionNumber: z.number().int().nonnegative(),
    phaseStartedAt: isoTimestampSchema,
    generatedAt: isoTimestampSchema,
    reportPath: z.string().regex(/^\.densa\/reports\/[A-Za-z0-9._-]+\.md$/u),
    tasksCompleted: z.array(
      z
        .strictObject({
          taskId: taskIdSchema,
          title: nonEmptyText,
          attemptCount: z.number().int().nonnegative(),
        })
        .readonly(),
    ),
    validations: z.array(phaseReportValidationCheckSchema),
    commits: z.array(
      z
        .strictObject({
          taskId: taskIdSchema,
          sha: nonEmptyText,
        })
        .readonly(),
    ),
    filesChanged: z.array(
      z
        .strictObject({
          taskId: taskIdSchema,
          paths: z.array(nonEmptyText),
        })
        .readonly(),
    ),
    importantDecisions: z.array(
      z
        .strictObject({
          id: decisionIdSchema,
          title: nonEmptyText,
          rationale: nonEmptyText,
        })
        .readonly(),
    ),
    roadmapChanges: z.array(
      z
        .strictObject({
          id: roadmapRevisionIdSchema,
          classification: roadmapMutationClassificationSchema,
          reason: nonEmptyText,
          createdAt: isoTimestampSchema,
        })
        .readonly(),
    ),
    retriesAndFailures: z.array(
      z
        .strictObject({
          taskId: taskIdSchema,
          attemptCount: z.number().int().nonnegative(),
          failedValidationCount: z.number().int().nonnegative(),
          summary: nonEmptyText,
        })
        .readonly(),
    ),
    unresolvedIssues: z.array(nonEmptyText),
    phaseValidation: z
      .strictObject({
        status: z.enum(["not_run", "passed", "failed"]),
        validatorId: nonEmptyText.optional(),
        summary: nonEmptyText,
      })
      .readonly(),
    nextPhase: z
      .strictObject({
        phaseId: phaseIdSchema,
        title: nonEmptyText,
        goal: nonEmptyText,
        state: phaseStateSchema,
      })
      .readonly()
      .optional(),
  })
  .superRefine((report, context) => {
    if (
      (report.phaseValidation.status === "not_run") !==
      (report.phaseValidation.validatorId === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Only a phase validation that ran may name a validator",
        path: ["phaseValidation", "validatorId"],
      });
    }
    if (report.outcome !== "blocked" && report.phaseValidation.status !== "passed") {
      context.addIssue({
        code: "custom",
        message: "A successful phase outcome requires passing phase validation",
        path: ["phaseValidation", "status"],
      });
    }
  })
  .readonly();
export type PhaseReport = z.infer<typeof phaseReportSchema>;
