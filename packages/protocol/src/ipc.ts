import { z } from "zod";

import { PROTOCOL_VERSION, requestEnvelopeSchema, type RequestEnvelope } from "./envelope.js";
import { projectIdSchema } from "./ids.js";
import { isoTimestampSchema } from "./json.js";

export const CORE_EVENT_NOTIFICATION = "core.event" as const;

export const coreDaemonStatusSchema = z
  .strictObject({
    state: z.literal("running"),
    instanceId: z.string().min(1),
    pid: z.number().int().positive(),
    startedAt: isoTimestampSchema,
    socketPath: z.string().min(1),
    connectedClients: z.number().int().nonnegative(),
    protocolVersion: z.literal(PROTOCOL_VERSION),
  })
  .readonly();
export type CoreDaemonStatus = z.infer<typeof coreDaemonStatusSchema>;

export const stoppedCoreDaemonStatusSchema = z
  .strictObject({
    state: z.literal("stopped"),
  })
  .readonly();
export type StoppedCoreDaemonStatus = z.infer<typeof stoppedCoreDaemonStatusSchema>;
export type CoreDaemonLifecycleStatus = CoreDaemonStatus | StoppedCoreDaemonStatus;

export const authenticatedRequestFrameSchema = z.strictObject({
  authToken: z.string().min(32).max(512),
  envelope: requestEnvelopeSchema,
});
export interface AuthenticatedRequestFrame {
  readonly authToken: string;
  readonly envelope: RequestEnvelope;
}

export const CORE_IPC_EVENT_REPLAY_DEFAULT = 50 as const;
export const CORE_IPC_EVENT_REPLAY_LIMIT = 200 as const;
const replayLimitSchema = z.number().int().min(1).max(CORE_IPC_EVENT_REPLAY_LIMIT).optional();
const afterSequenceSchema = z.number().int().nonnegative().optional();

export const eventReplayRequestSchema = z.strictObject({
  projectId: projectIdSchema.optional(),
  afterSequence: afterSequenceSchema,
  limit: replayLimitSchema,
});
export type EventReplayRequest = z.infer<typeof eventReplayRequestSchema>;

export const eventSubscriptionRequestSchema = z.strictObject({
  projectId: projectIdSchema,
  afterSequence: afterSequenceSchema,
  limit: replayLimitSchema,
});
export type EventSubscriptionRequest = z.infer<typeof eventSubscriptionRequestSchema>;
