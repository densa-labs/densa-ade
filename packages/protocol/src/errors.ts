import { z } from "zod";

import { jsonObjectSchema } from "./json.js";

export const densaErrorCodeSchema = z.enum([
  "USER_CONFIGURATION_ERROR",
  "AGENT_UNAVAILABLE",
  "AUTHENTICATION_REQUIRED",
  "USAGE_LIMITED",
  "PERMISSION_DENIED",
  "PROCESS_FAILURE",
  "VALIDATION_FAILURE",
  "WORKSPACE_CONFLICT",
  "GIT_FAILURE",
  "PERSISTENCE_FAILURE",
  "PROTOCOL_VERSION_MISMATCH",
  "INTERNAL_INVARIANT_VIOLATION",
]);
export type DensaErrorCode = z.infer<typeof densaErrorCodeSchema>;

export const protocolErrorSchema = z.strictObject({
  code: densaErrorCodeSchema,
  message: z.string().min(1),
  details: jsonObjectSchema.optional(),
});
export type ProtocolError = z.infer<typeof protocolErrorSchema>;
