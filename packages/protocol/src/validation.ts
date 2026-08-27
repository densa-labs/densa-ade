import { z } from "zod";

import { validationResultIdSchema, validationRunIdSchema } from "./ids.js";
import { isoTimestampSchema, jsonObjectSchema } from "./json.js";

const nonEmptyText = z.string().min(1);

export const validationPolicySchema = z.enum(["required", "advisory"]);
export type ValidationPolicy = z.infer<typeof validationPolicySchema>;

export const validationResultStatusSchema = z.enum(["passed", "failed", "error", "skipped"]);
export type ValidationResultStatus = z.infer<typeof validationResultStatusSchema>;

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
