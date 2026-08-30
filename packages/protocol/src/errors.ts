import { z } from "zod";

import { jsonObjectSchema } from "./json.js";

export const densaAdeErrorCodeSchema = z.enum([
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
  "INVALID_STATE_TRANSITION",
  "INTERNAL_INVARIANT_VIOLATION",
]);
export type DensaAdeErrorCode = z.infer<typeof densaAdeErrorCodeSchema>;

/** @deprecated Use densaAdeErrorCodeSchema. Retained for protocol consumer compatibility. */
export const densaErrorCodeSchema = densaAdeErrorCodeSchema;
/** @deprecated Use DensaAdeErrorCode. Retained for protocol consumer compatibility. */
export type DensaErrorCode = DensaAdeErrorCode;

export const protocolErrorSchema = z.strictObject({
  code: densaAdeErrorCodeSchema,
  message: z.string().min(1),
  details: jsonObjectSchema.optional(),
});
export type ProtocolError = z.infer<typeof protocolErrorSchema>;
