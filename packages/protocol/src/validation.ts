import { z } from "zod";

import {
  manualAcceptanceReviewIdSchema,
  taskIdSchema,
  validationResultIdSchema,
  validationRunIdSchema,
} from "./ids.js";
import { isoTimestampSchema, jsonObjectSchema } from "./json.js";

const nonEmptyText = z.string().min(1);

export const validationPolicySchema = z.enum(["required", "advisory"]);
export type ValidationPolicy = z.infer<typeof validationPolicySchema>;

export const validationResultStatusSchema = z.enum(["passed", "failed", "error", "skipped"]);
export type ValidationResultStatus = z.infer<typeof validationResultStatusSchema>;

export const acceptanceEvidenceSourceSchema = z.enum([
  "legacy_unspecified",
  "deterministic_validator",
  "targeted_check",
  "browser_test",
  "independent_review",
  "manual_review",
]);
export type AcceptanceEvidenceSource = z.infer<typeof acceptanceEvidenceSourceSchema>;

export const acceptanceCriterionStateSchema = z.enum([
  "satisfied",
  "failed",
  "not_evaluated",
  "manual_review_required",
]);
export type AcceptanceCriterionState = z.infer<typeof acceptanceCriterionStateSchema>;

export const validationDiagnosticSchema = z
  .strictObject({
    severity: z.enum(["info", "warning", "error"]),
    message: nonEmptyText.max(4_096),
    code: nonEmptyText.max(128).optional(),
  })
  .readonly();
export type ValidationDiagnostic = z.infer<typeof validationDiagnosticSchema>;

/** Provider output before Core adds identity, timing, policy, and acceptance mappings. */
export const validatorOutcomeSchema = z
  .strictObject({
    status: validationResultStatusSchema,
    command: z.array(nonEmptyText.max(4_096)).min(1).max(128).optional(),
    config: jsonObjectSchema.optional(),
    exitCode: z.number().int().min(-2_147_483_648).max(2_147_483_647).optional(),
    diagnostics: z.array(validationDiagnosticSchema).max(32).default([]),
    retryRelevant: z.boolean(),
  })
  .readonly();
export type ValidatorOutcome = z.infer<typeof validatorOutcomeSchema>;

/** Immutable evidence for one validator invocation in a persisted plan run. */
export const validationResultSchema = z
  .strictObject({
    id: validationResultIdSchema,
    validationRunId: validationRunIdSchema,
    position: z.number().int().nonnegative(),
    validatorId: nonEmptyText,
    validatorVersion: nonEmptyText,
    evidenceSource: acceptanceEvidenceSourceSchema,
    policy: validationPolicySchema,
    status: validationResultStatusSchema,
    startedAt: isoTimestampSchema,
    completedAt: isoTimestampSchema,
    command: z.array(nonEmptyText.max(4_096)).min(1).max(128).optional(),
    config: jsonObjectSchema.optional(),
    exitCode: z.number().int().min(-2_147_483_648).max(2_147_483_647).optional(),
    diagnostics: z.array(validationDiagnosticSchema).max(32),
    relatedAcceptanceCriteria: z.array(nonEmptyText),
    retryRelevant: z.boolean(),
  })
  .superRefine((result, context) => {
    if (result.completedAt < result.startedAt) {
      context.addIssue({
        code: "custom",
        message: "Validation result completion cannot precede its start",
        path: ["completedAt"],
      });
    }
  })
  .readonly();
export type ValidationResult = z.infer<typeof validationResultSchema>;

export const manualAcceptanceReviewSchema = z
  .strictObject({
    id: manualAcceptanceReviewIdSchema,
    validationRunId: validationRunIdSchema,
    criterionPosition: z.number().int().nonnegative(),
    criterion: nonEmptyText,
    decision: z.enum(["approved", "rejected"]),
    actor: nonEmptyText,
    reason: nonEmptyText.max(4_096),
    occurredAt: isoTimestampSchema,
  })
  .readonly();
export type ManualAcceptanceReview = z.infer<typeof manualAcceptanceReviewSchema>;

export const acceptanceEvidenceSchema = z
  .strictObject({
    source: acceptanceEvidenceSourceSchema,
    status: z.enum(["supports", "contradicts", "inconclusive"]),
    validatorId: nonEmptyText.optional(),
    validationResultId: validationResultIdSchema.optional(),
    manualReviewId: manualAcceptanceReviewIdSchema.optional(),
    summary: nonEmptyText.max(4_096),
  })
  .superRefine((evidence, context) => {
    const isManual = evidence.source === "manual_review";
    if (
      isManual !== (evidence.manualReviewId !== undefined) ||
      isManual === (evidence.validationResultId !== undefined) ||
      isManual === (evidence.validatorId !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Acceptance evidence must identify exactly one manual review or validator result",
      });
    }
  })
  .readonly();
export type AcceptanceEvidence = z.infer<typeof acceptanceEvidenceSchema>;

export const acceptanceCriterionEvaluationSchema = z
  .strictObject({
    position: z.number().int().nonnegative(),
    criterion: nonEmptyText,
    state: acceptanceCriterionStateSchema,
    evidence: z.array(acceptanceEvidenceSchema),
  })
  .readonly();
export type AcceptanceCriterionEvaluation = z.infer<typeof acceptanceCriterionEvaluationSchema>;

export const acceptanceReportSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    taskId: taskIdSchema,
    validationRunId: validationRunIdSchema,
    generatedAt: isoTimestampSchema,
    canComplete: z.boolean(),
    criteria: z.array(acceptanceCriterionEvaluationSchema).min(1),
  })
  .superRefine((report, context) => {
    const complete = report.criteria.every((criterion) => criterion.state === "satisfied");
    if (report.canComplete !== complete) {
      context.addIssue({
        code: "custom",
        message: "Acceptance completion must match the criterion evaluations",
        path: ["canComplete"],
      });
    }
    const positions = new Set(report.criteria.map((criterion) => criterion.position));
    if (positions.size !== report.criteria.length) {
      context.addIssue({
        code: "custom",
        message: "Acceptance criterion positions must be unique",
        path: ["criteria"],
      });
    }
  })
  .readonly();
export type AcceptanceReport = z.infer<typeof acceptanceReportSchema>;
