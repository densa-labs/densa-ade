import { z } from "zod";

const id = () => z.string().min(1);

export const projectIdSchema = id().brand<"ProjectId">();
export type ProjectId = z.infer<typeof projectIdSchema>;

export const phaseIdSchema = id().brand<"PhaseId">();
export type PhaseId = z.infer<typeof phaseIdSchema>;

export const taskIdSchema = id().brand<"TaskId">();
export type TaskId = z.infer<typeof taskIdSchema>;

export const attemptIdSchema = id().brand<"AttemptId">();
export type AttemptId = z.infer<typeof attemptIdSchema>;

export const agentRunIdSchema = id().brand<"AgentRunId">();
export type AgentRunId = z.infer<typeof agentRunIdSchema>;

export const validationRunIdSchema = id().brand<"ValidationRunId">();
export type ValidationRunId = z.infer<typeof validationRunIdSchema>;

export const validationResultIdSchema = id().brand<"ValidationResultId">();
export type ValidationResultId = z.infer<typeof validationResultIdSchema>;

export const checkpointIdSchema = id().brand<"CheckpointId">();
export type CheckpointId = z.infer<typeof checkpointIdSchema>;

export const decisionIdSchema = id().brand<"DecisionId">();
export type DecisionId = z.infer<typeof decisionIdSchema>;

export const roadmapRevisionIdSchema = id().brand<"RoadmapRevisionId">();
export type RoadmapRevisionId = z.infer<typeof roadmapRevisionIdSchema>;

export const eventIdSchema = id().brand<"EventId">();
export type EventId = z.infer<typeof eventIdSchema>;

export const requestIdSchema = id().brand<"RequestId">();
export type RequestId = z.infer<typeof requestIdSchema>;

export const correlationIdSchema = id().brand<"CorrelationId">();
export type CorrelationId = z.infer<typeof correlationIdSchema>;
