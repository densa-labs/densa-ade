import { z } from "zod";

export const projectStateSchema = z.enum([
  "DRAFT",
  "PLANNING",
  "READY",
  "RUNNING",
  "PAUSED",
  "WAITING_FOR_USER",
  "WAITING_FOR_USAGE",
  "BLOCKED",
  "COMPLETED",
  "FAILED",
]);
export type ProjectState = z.infer<typeof projectStateSchema>;

export const phaseStateSchema = z.enum([
  "PENDING",
  "READY",
  "RUNNING",
  "VALIDATING",
  "AWAITING_APPROVAL",
  "COMPLETED",
  "BLOCKED",
]);
export type PhaseState = z.infer<typeof phaseStateSchema>;

export const taskStateSchema = z.enum([
  "PENDING",
  "READY",
  "RUNNING",
  "VALIDATING",
  "RETRYING",
  "WAITING_FOR_USER",
  "WAITING_FOR_USAGE",
  "BLOCKED",
  "INTERRUPTED",
  "COMPLETED",
  "CANCELLED",
]);
export type TaskState = z.infer<typeof taskStateSchema>;

export const executionModeSchema = z.enum(["guided", "phase", "continuous"]);
export type ExecutionMode = z.infer<typeof executionModeSchema>;

export const roadmapMutationClassificationSchema = z.enum(["minor", "significant", "scope"]);
export type RoadmapMutationClassification = z.infer<typeof roadmapMutationClassificationSchema>;

export const usageStateSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("available") }),
  z.strictObject({
    status: z.literal("limited"),
    resetAt: z.iso.datetime({ offset: true }).optional(),
  }),
  z.strictObject({
    status: z.literal("unknown"),
    reason: z.string().min(1).optional(),
  }),
]);
export type UsageState = z.infer<typeof usageStateSchema>;
