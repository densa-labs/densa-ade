import { z } from "zod";

import { isoTimestampSchema } from "./json.js";

const nonEmptyText = z.string().trim().min(1).max(4_096);

export const permissionPolicyPresetSchema = z.enum(["cautious", "standard", "autonomous"]);
export type PermissionPolicyPreset = z.infer<typeof permissionPolicyPresetSchema>;

export const permissionOperationSchema = z.enum([
  "read_workspace",
  "write_workspace",
  "access_outside_workspace",
  "install_dependency",
  "network_access",
  "git_mutation",
  "destructive_file_operation",
  "secret_access",
  "privilege_escalation",
  "roadmap_significant_change",
  "roadmap_scope_change",
  "remote_push",
]);
export type PermissionOperation = z.infer<typeof permissionOperationSchema>;

export const permissionDispositionSchema = z.enum(["allow", "deny", "ask_user"]);
export type PermissionDisposition = z.infer<typeof permissionDispositionSchema>;

export const permissionOverrideSchema = z
  .strictObject({
    operation: permissionOperationSchema,
    disposition: permissionDispositionSchema,
    actor: nonEmptyText,
    reason: nonEmptyText,
    updatedAt: isoTimestampSchema,
  })
  .readonly();
export type PermissionOverride = z.infer<typeof permissionOverrideSchema>;

export const permissionPolicyConfigurationSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    preset: permissionPolicyPresetSchema,
    overrides: z.array(permissionOverrideSchema).max(permissionOperationSchema.options.length),
    updatedAt: isoTimestampSchema.optional(),
    updatedBy: nonEmptyText.optional(),
  })
  .superRefine((configuration, context) => {
    const operations = new Set(configuration.overrides.map((override) => override.operation));
    if (operations.size !== configuration.overrides.length) {
      context.addIssue({
        code: "custom",
        message: "Permission overrides must be unique by operation",
      });
    }
    if ((configuration.updatedAt === undefined) !== (configuration.updatedBy === undefined)) {
      context.addIssue({
        code: "custom",
        message: "Permission policy updater and timestamp must be recorded together",
      });
    }
  })
  .readonly();
export type PermissionPolicyConfiguration = z.infer<typeof permissionPolicyConfigurationSchema>;

export const permissionDecisionSchema = z
  .strictObject({
    decisionId: nonEmptyText.max(256),
    projectId: nonEmptyText.max(256),
    preset: permissionPolicyPresetSchema,
    operation: permissionOperationSchema,
    disposition: permissionDispositionSchema,
    source: z.enum(["preset", "override", "user_approval"]),
    actor: nonEmptyText,
    reason: nonEmptyText,
    occurredAt: isoTimestampSchema,
    approvalDecisionId: nonEmptyText.max(256).optional(),
  })
  .readonly();
export type PermissionDecision = z.infer<typeof permissionDecisionSchema>;
