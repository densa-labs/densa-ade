import { z } from "zod";

import {
  eventIdSchema,
  independentReviewIdSchema,
  phaseIdSchema,
  projectIdSchema,
  taskIdSchema,
  validationRunIdSchema,
} from "./ids.js";
import { isoTimestampSchema } from "./json.js";

const nonEmptyText = z.string().trim().min(1);

export const independentReviewVerdictSchema = z.enum(["pass", "advisory", "fail"]);
export type IndependentReviewVerdict = z.infer<typeof independentReviewVerdictSchema>;

export const independentReviewFindingSchema = z
  .strictObject({
    severity: z.enum(["info", "warning", "error", "critical"]),
    title: nonEmptyText.max(256),
    detail: nonEmptyText.max(4_096),
    criterionPosition: z.number().int().nonnegative().optional(),
  })
  .readonly();
export type IndependentReviewFinding = z.infer<typeof independentReviewFindingSchema>;

export const independentReviewCriterionSchema = z
  .strictObject({
    criterionPosition: z.number().int().nonnegative(),
    criterion: nonEmptyText.max(4_096).optional(),
    assessment: z.enum(["satisfied", "failed", "unknown"]),
    rationale: nonEmptyText.max(4_096),
  })
  .readonly();
export type IndependentReviewCriterion = z.infer<typeof independentReviewCriterionSchema>;

export const independentReviewOutputSchema = z
  .strictObject({
    verdict: independentReviewVerdictSchema,
    summary: nonEmptyText.max(4_096),
    findings: z.array(independentReviewFindingSchema).max(32),
    criteria: z.array(independentReviewCriterionSchema).max(128),
    confidence: z.number().min(0).max(1),
    unknowns: z.array(nonEmptyText.max(4_096)).max(32),
  })
  .superRefine((output, context) => {
    if (
      output.verdict === "pass" &&
      output.findings.some(
        (finding) => finding.severity === "error" || finding.severity === "critical",
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "A passing review cannot contain error or critical findings",
        path: ["findings"],
      });
    }
    if (
      output.verdict === "pass" &&
      output.criteria.some((criterion) => criterion.assessment !== "satisfied")
    ) {
      context.addIssue({
        code: "custom",
        message: "A passing review must mark every acceptance criterion satisfied",
        path: ["criteria"],
      });
    }
  })
  .readonly();
export type IndependentReviewOutput = z.infer<typeof independentReviewOutputSchema>;

export const independentReviewSchema = z
  .strictObject({
    id: independentReviewIdSchema,
    projectId: projectIdSchema,
    taskId: taskIdSchema.optional(),
    phaseId: phaseIdSchema.optional(),
    validationRunId: validationRunIdSchema.optional(),
    validationEventId: eventIdSchema.optional(),
    adapterId: nonEmptyText,
    reviewerRunId: nonEmptyText,
    contextHash: z.string().regex(/^[a-f0-9]{64}$/u),
    requestedAt: isoTimestampSchema,
    completedAt: isoTimestampSchema.optional(),
    output: independentReviewOutputSchema.optional(),
  })
  .superRefine((review, context) => {
    if ((review.taskId === undefined) === (review.phaseId === undefined)) {
      context.addIssue({
        code: "custom",
        message: "Independent review must target exactly one task or phase",
      });
    }
    if (
      review.taskId !== undefined
        ? review.validationRunId === undefined || review.validationEventId !== undefined
        : review.validationEventId === undefined || review.validationRunId !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Task reviews require one validation run and phase reviews require one validation-start event",
      });
    }
    if ((review.completedAt === undefined) !== (review.output === undefined)) {
      context.addIssue({
        code: "custom",
        message: "Independent review completion and structured output must be recorded together",
      });
    }
    if (
      review.completedAt !== undefined &&
      Date.parse(review.completedAt) < Date.parse(review.requestedAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "Independent review completion cannot precede its request",
        path: ["completedAt"],
      });
    }
  })
  .readonly();
export type IndependentReview = z.infer<typeof independentReviewSchema>;

/** Provider-neutral JSON Schema passed to AgentAdapter constrained-output implementations. */
export const independentReviewOutputJsonSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings", "criteria", "confidence", "unknowns"],
  properties: {
    verdict: { type: "string", enum: ["pass", "advisory", "fail"] },
    summary: { type: "string", minLength: 1, maxLength: 4_096 },
    findings: {
      type: "array",
      maxItems: 32,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "title", "detail"],
        properties: {
          severity: { type: "string", enum: ["info", "warning", "error", "critical"] },
          title: { type: "string", minLength: 1, maxLength: 256 },
          detail: { type: "string", minLength: 1, maxLength: 4_096 },
          criterionPosition: { type: "integer", minimum: 0 },
        },
      },
    },
    criteria: {
      type: "array",
      maxItems: 128,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterionPosition", "assessment", "rationale"],
        properties: {
          criterionPosition: { type: "integer", minimum: 0 },
          assessment: { type: "string", enum: ["satisfied", "failed", "unknown"] },
          rationale: { type: "string", minLength: 1, maxLength: 4_096 },
        },
      },
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    unknowns: {
      type: "array",
      maxItems: 32,
      items: { type: "string", minLength: 1, maxLength: 4_096 },
    },
  },
});
