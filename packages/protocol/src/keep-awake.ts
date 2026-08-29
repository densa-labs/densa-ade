import { z } from "zod";

import { projectIdSchema } from "./ids.js";
import { isoTimestampSchema } from "./json.js";

const boundedText = z.string().trim().min(1).max(4_096);

export const keepAwakeReasonIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
export type KeepAwakeReasonId = z.infer<typeof keepAwakeReasonIdSchema>;

export const keepAwakeReasonSchema = z
  .strictObject({
    id: keepAwakeReasonIdSchema,
    projectId: projectIdSchema,
    reason: boundedText,
    actor: boundedText,
    acquiredAt: isoTimestampSchema,
  })
  .readonly();
export type KeepAwakeReason = z.infer<typeof keepAwakeReasonSchema>;

export const keepAwakeBatteryPolicySchema = z
  .strictObject({
    minimumLevelPercent: z.number().int().min(0).max(100),
  })
  .readonly();
export type KeepAwakeBatteryPolicy = z.infer<typeof keepAwakeBatteryPolicySchema>;

export const keepAwakeBatteryStateSchema = z
  .strictObject({
    powerSource: z.enum(["battery", "external_power", "unknown"]),
    levelPercent: z.number().int().min(0).max(100).optional(),
    observedAt: isoTimestampSchema,
  })
  .readonly();
export type KeepAwakeBatteryState = z.infer<typeof keepAwakeBatteryStateSchema>;

export const keepAwakeStatusSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    projectId: projectIdSchema,
    state: z.enum(["inactive", "active", "declined", "recovery_required", "unavailable"]),
    systemSleepPrevented: z.boolean(),
    displaySleepAllowed: z.literal(true),
    reasons: z.array(keepAwakeReasonSchema),
    batteryPolicy: keepAwakeBatteryPolicySchema,
    batteryState: keepAwakeBatteryStateSchema.optional(),
    updatedAt: isoTimestampSchema,
    message: boundedText.optional(),
  })
  .superRefine((status, context) => {
    if (status.systemSleepPrevented !== (status.state === "active")) {
      context.addIssue({
        code: "custom",
        message: "Only active keep-awake status may claim that system sleep is prevented",
      });
    }
    if (status.state === "inactive" && status.reasons.length !== 0) {
      context.addIssue({
        code: "custom",
        message: "Inactive keep-awake status cannot retain active reasons",
      });
    }
    if (status.state === "active" && status.reasons.length === 0) {
      context.addIssue({
        code: "custom",
        message: "Active keep-awake status requires at least one reason",
      });
    }
  })
  .readonly();
export type KeepAwakeStatus = z.infer<typeof keepAwakeStatusSchema>;
