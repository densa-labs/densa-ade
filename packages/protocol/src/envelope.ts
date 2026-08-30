import { z } from "zod";

import { protocolErrorSchema } from "./errors.js";
import { correlationIdSchema, requestIdSchema } from "./ids.js";
import { jsonValueSchema } from "./json.js";

/** Frozen client-facing protocol line for the first IDE integration pass. */
export const PROTOCOL_VERSION = "1.0.0" as const;
export const protocolVersionSchema = z.literal(PROTOCOL_VERSION);
export type ProtocolVersion = z.infer<typeof protocolVersionSchema>;

const envelopeBase = {
  protocolVersion: protocolVersionSchema,
  correlationId: correlationIdSchema.optional(),
};

export const requestEnvelopeSchema = z.strictObject({
  ...envelopeBase,
  kind: z.literal("request"),
  requestId: requestIdSchema,
  method: z.string().min(1),
  payload: jsonValueSchema,
});
export type RequestEnvelope = z.infer<typeof requestEnvelopeSchema>;

export const successResponseEnvelopeSchema = z.strictObject({
  ...envelopeBase,
  kind: z.literal("response"),
  requestId: requestIdSchema,
  ok: z.literal(true),
  result: jsonValueSchema,
});
export type SuccessResponseEnvelope = z.infer<typeof successResponseEnvelopeSchema>;

export const errorResponseEnvelopeSchema = z.strictObject({
  ...envelopeBase,
  kind: z.literal("response"),
  requestId: requestIdSchema,
  ok: z.literal(false),
  error: protocolErrorSchema,
});
export type ErrorResponseEnvelope = z.infer<typeof errorResponseEnvelopeSchema>;

export const notificationEnvelopeSchema = z.strictObject({
  ...envelopeBase,
  kind: z.literal("notification"),
  event: z.string().min(1),
  payload: jsonValueSchema,
});
export type NotificationEnvelope = z.infer<typeof notificationEnvelopeSchema>;

export const protocolEnvelopeSchema = z.union([
  requestEnvelopeSchema,
  successResponseEnvelopeSchema,
  errorResponseEnvelopeSchema,
  notificationEnvelopeSchema,
]);
export type ProtocolEnvelope = z.infer<typeof protocolEnvelopeSchema>;

export class ProtocolVersionMismatchError extends Error {
  readonly code = "PROTOCOL_VERSION_MISMATCH" as const;

  constructor(readonly receivedVersion: unknown) {
    super(`Unsupported Densa ADE protocol version: ${String(receivedVersion)}`);
    this.name = "ProtocolVersionMismatchError";
  }
}

/**
 * Validates an untrusted IPC value and distinguishes version negotiation failures
 * from other malformed-message errors.
 */
export function parseProtocolEnvelope(value: unknown): ProtocolEnvelope {
  if (
    typeof value === "object" &&
    value !== null &&
    "protocolVersion" in value &&
    value.protocolVersion !== PROTOCOL_VERSION
  ) {
    throw new ProtocolVersionMismatchError(value.protocolVersion);
  }

  return protocolEnvelopeSchema.parse(value);
}

export function serializeProtocolEnvelope(envelope: ProtocolEnvelope): string {
  return JSON.stringify(parseProtocolEnvelope(envelope));
}

export function deserializeProtocolEnvelope(serialized: string): ProtocolEnvelope {
  return parseProtocolEnvelope(JSON.parse(serialized) as unknown);
}
