import { z } from "zod";

import { isoTimestampSchema } from "./json.js";
import { executionModeSchema, projectStateSchema } from "./states.js";

const nonEmptyText = z.string().trim().min(1);
const boundedCount = z.number().int().nonnegative();

export const rundownKindSchema = z.enum([
  "project_status",
  "phase_completion",
  "blocked_project",
  "usage_waiting",
  "recent_changes",
  "retry_failure_history",
]);
export type RundownKind = z.infer<typeof rundownKindSchema>;

export const rundownReferenceSchema = z
  .strictObject({
    kind: z.enum([
      "project",
      "phase",
      "task",
      "attempt",
      "validation_run",
      "validation_result",
      "decision",
      "event",
      "roadmap_revision",
      "phase_report",
      "git_commit",
    ]),
    id: nonEmptyText,
  })
  .readonly();
export type RundownReference = z.infer<typeof rundownReferenceSchema>;

export const rundownStateCountSchema = z
  .strictObject({ state: nonEmptyText, count: boundedCount })
  .readonly();

export const rundownGitCommitSchema = z
  .strictObject({
    sha: nonEmptyText,
    status: z.enum(["reachable", "unreachable", "missing"]),
  })
  .readonly();

export const rundownGitSnapshotSchema = z.discriminatedUnion("status", [
  z
    .strictObject({
      status: z.literal("available"),
      headSha: nonEmptyText,
      branch: nonEmptyText.optional(),
      dirty: z.boolean(),
      commits: z.array(rundownGitCommitSchema),
    })
    .readonly(),
  z
    .strictObject({
      status: z.literal("unavailable"),
      reason: nonEmptyText,
      commits: z.array(rundownGitCommitSchema).length(0),
    })
    .readonly(),
]);
export type RundownGitSnapshot = z.infer<typeof rundownGitSnapshotSchema>;

const knownResetSchema = z
  .strictObject({ status: z.literal("known"), value: isoTimestampSchema })
  .readonly();
const unknownResetSchema = z
  .strictObject({ status: z.literal("unknown"), reason: nonEmptyText })
  .readonly();

export const rundownUsageSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("not_waiting") }).readonly(),
  z
    .strictObject({
      status: z.literal("limited"),
      sourceEventId: nonEmptyText,
      taskId: nonEmptyText.optional(),
      resetAt: z.union([knownResetSchema, unknownResetSchema]),
    })
    .readonly(),
  z
    .strictObject({
      status: z.literal("unknown"),
      reason: nonEmptyText,
      sourceEventId: nonEmptyText.optional(),
    })
    .readonly(),
]);
export type RundownUsage = z.infer<typeof rundownUsageSchema>;

export const rundownValidationRunSchema = z
  .strictObject({
    id: nonEmptyText,
    taskId: nonEmptyText,
    validatorId: nonEmptyText,
    status: z.enum(["passed", "failed", "incomplete"]),
    resultIds: z.array(nonEmptyText),
  })
  .readonly();

export const rundownRetryHistorySchema = z
  .strictObject({
    taskId: nonEmptyText,
    attemptCount: boundedCount,
    attemptIds: z.array(nonEmptyText),
    failedValidationCount: boundedCount,
    failedValidationRunIds: z.array(nonEmptyText),
    latestFailureSummary: nonEmptyText.optional(),
  })
  .readonly();

export const rundownRecentChangeSchema = z
  .strictObject({
    kind: z.enum(["event", "decision", "roadmap_revision"]),
    id: nonEmptyText,
    occurredAt: isoTimestampSchema,
    summary: nonEmptyText,
    references: z.array(rundownReferenceSchema).min(1),
  })
  .readonly();

export const rundownPhaseReportSchema = z
  .strictObject({
    phaseId: nonEmptyText,
    reportPath: nonEmptyText,
    outcome: z.enum(["blocked", "awaiting_approval", "completed"]),
    generatedAt: isoTimestampSchema,
    verification: z.literal("verified"),
    taskIds: z.array(nonEmptyText),
    validationRunIds: z.array(nonEmptyText),
    commitShas: z.array(nonEmptyText),
  })
  .readonly();

export const projectRundownSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    kind: rundownKindSchema,
    generatedAt: isoTimestampSchema,
    factsDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    project: z
      .strictObject({
        id: nonEmptyText,
        name: nonEmptyText,
        state: projectStateSchema,
        executionMode: executionModeSchema,
        updatedAt: isoTimestampSchema,
      })
      .readonly(),
    scope: z
      .strictObject({
        phaseId: nonEmptyText.optional(),
        taskId: nonEmptyText.optional(),
      })
      .readonly(),
    phaseStateCounts: z.array(rundownStateCountSchema),
    taskStateCounts: z.array(rundownStateCountSchema),
    validation: z
      .strictObject({
        runCount: boundedCount,
        passedCount: boundedCount,
        failedCount: boundedCount,
        incompleteCount: boundedCount,
        resultCount: boundedCount,
        runs: z.array(rundownValidationRunSchema),
      })
      .readonly(),
    git: rundownGitSnapshotSchema,
    usage: rundownUsageSchema,
    activeDecisionIds: z.array(nonEmptyText),
    phaseReport: rundownPhaseReportSchema.optional(),
    recentChanges: z.array(rundownRecentChangeSchema),
    retryHistory: z.array(rundownRetryHistorySchema),
    drillDownReferences: z.array(rundownReferenceSchema),
  })
  .superRefine((rundown, context) => {
    const validationTotal =
      rundown.validation.passedCount +
      rundown.validation.failedCount +
      rundown.validation.incompleteCount;
    if (validationTotal !== rundown.validation.runCount) {
      context.addIssue({
        code: "custom",
        message: "Validation outcome counts must equal the run count",
        path: ["validation", "runCount"],
      });
    }
    if (rundown.validation.runs.length !== rundown.validation.runCount) {
      context.addIssue({
        code: "custom",
        message: "Every counted validation run must remain drillable",
        path: ["validation", "runs"],
      });
    }
    if (rundown.kind === "phase_completion" && rundown.phaseReport === undefined) {
      context.addIssue({
        code: "custom",
        message: "Phase-completion rundowns require a verified phase report",
        path: ["phaseReport"],
      });
    }
  })
  .readonly();
export type ProjectRundown = z.infer<typeof projectRundownSchema>;

/** A Master may choose emphasis, but Core remains the only renderer of factual values. */
export const rundownPresentationPlanSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    factsDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    highlightedReferences: z.array(rundownReferenceSchema).max(12),
  })
  .readonly();
export type RundownPresentationPlan = z.infer<typeof rundownPresentationPlanSchema>;
