import { z } from "zod";

import { interviewAnswerSchema, interviewQuestionSchema } from "./adaptive-interview.js";
import {
  attemptSchema,
  decisionSchema,
  eventSchema,
  masterRoadmapRecordSchema,
  phaseSchema,
  projectSchema,
  roadmapRevisionSchema,
  roadmapRevisionProposalSchema,
  taskSchema,
  validationRunSchema,
} from "./domain.js";
import {
  PROTOCOL_VERSION,
  notificationEnvelopeSchema,
  requestEnvelopeSchema,
  type NotificationEnvelope,
  type RequestEnvelope,
} from "./envelope.js";
import {
  attemptIdSchema,
  phaseIdSchema,
  projectIdSchema,
  requestIdSchema,
  taskIdSchema,
  validationRunIdSchema,
} from "./ids.js";
import { keepAwakeBatteryPolicySchema, keepAwakeStatusSchema } from "./keep-awake.js";
import { isoTimestampSchema, jsonObjectSchema, type JsonValue } from "./json.js";
import { masterAgentProposalSchema } from "./master-agent.js";
import { permissionPolicyConfigurationSchema } from "./permission-policy.js";
import { phaseReportSchema } from "./phase-report.js";
import { projectSpecificationSchema } from "./project-specification.js";
import { roadmapMutationOperationSchema } from "./roadmap-mutation.js";
import { executionModeSchema, usageStateSchema } from "./states.js";
import { validationResultSchema } from "./validation.js";

const emptyPayloadSchema = z.strictObject({}).readonly();
const nonEmptyTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(64 * 1_024);
const actorSchema = z.string().trim().min(1).max(256);
const sessionIdSchema = z.string().trim().min(1).max(256);
const workspacePathSchema = z.string().trim().min(1).max(4_096);
const opaqueCursorSchema = z.string().min(1).max(512);
const gitShaSchema = z.string().regex(/^[0-9a-f]{7,64}$/u);

export const CORE_V1_DEFAULT_PAGE_SIZE = 50 as const;
export const CORE_V1_MAX_PAGE_SIZE = 200 as const;
export const CORE_V1_MAX_SNAPSHOT_ITEMS = 5_000 as const;

const pageRequestShape = {
  cursor: opaqueCursorSchema.optional(),
  limit: z.number().int().min(1).max(CORE_V1_MAX_PAGE_SIZE).optional(),
};
const pageRequestSchema = z.strictObject(pageRequestShape).readonly();

export const coreV1PageInfoSchema = z
  .strictObject({
    nextCursor: opaqueCursorSchema.optional(),
    hasMore: z.boolean(),
  })
  .superRefine((page, context) => {
    if (page.hasMore !== (page.nextCursor !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "A continuing page must provide exactly one next cursor",
        path: ["nextCursor"],
      });
    }
  })
  .readonly();
export type CoreV1PageInfo = z.infer<typeof coreV1PageInfoSchema>;

export const coreV1ProjectSummarySchema = z
  .strictObject({
    project: projectSchema,
    workspacePath: workspacePathSchema,
    currentPhaseId: phaseIdSchema.optional(),
    completedTaskCount: z.number().int().nonnegative(),
    totalTaskCount: z.number().int().nonnegative(),
    attentionRequired: z.boolean(),
  })
  .readonly();
export type CoreV1ProjectSummary = z.infer<typeof coreV1ProjectSummarySchema>;

export const coreV1PendingApprovalSchema = z.discriminatedUnion("kind", [
  z
    .strictObject({
      kind: z.literal("phase"),
      projectId: projectIdSchema,
      phaseId: phaseIdSchema,
      requestedAt: isoTimestampSchema,
      summary: nonEmptyTextSchema,
    })
    .readonly(),
  z
    .strictObject({
      kind: z.literal("task"),
      projectId: projectIdSchema,
      phaseId: phaseIdSchema,
      taskId: taskIdSchema,
      requestedAt: isoTimestampSchema,
      summary: nonEmptyTextSchema,
    })
    .readonly(),
  z
    .strictObject({
      kind: z.literal("roadmap_revision"),
      projectId: projectIdSchema,
      proposal: roadmapRevisionProposalSchema,
      requestedAt: isoTimestampSchema,
      summary: nonEmptyTextSchema,
    })
    .readonly(),
  z
    .strictObject({
      kind: z.literal("permission"),
      projectId: projectIdSchema,
      decisionId: z.string().min(1).max(256),
      requestedAt: isoTimestampSchema,
      summary: nonEmptyTextSchema,
    })
    .readonly(),
]);
export type CoreV1PendingApproval = z.infer<typeof coreV1PendingApprovalSchema>;

export const coreV1ProjectSnapshotSchema = z
  .strictObject({
    summary: coreV1ProjectSummarySchema,
    specification: projectSpecificationSchema.optional(),
    roadmap: masterRoadmapRecordSchema.optional(),
    phases: z.array(phaseSchema).max(CORE_V1_MAX_SNAPSHOT_ITEMS),
    tasks: z.array(taskSchema).max(CORE_V1_MAX_SNAPSHOT_ITEMS),
    pendingApprovals: z.array(coreV1PendingApprovalSchema).max(CORE_V1_MAX_PAGE_SIZE),
    usage: usageStateSchema,
    latestEventSequence: z.number().int().nonnegative(),
  })
  .readonly();
export type CoreV1ProjectSnapshot = z.infer<typeof coreV1ProjectSnapshotSchema>;

const stateCountSchema = z
  .strictObject({ state: z.string().min(1).max(64), count: z.number().int().nonnegative() })
  .readonly();

export const coreV1DashboardSchema = z
  .strictObject({
    project: coreV1ProjectSummarySchema,
    phaseCounts: z.array(stateCountSchema).max(16),
    taskCounts: z.array(stateCountSchema).max(32),
    currentPhase: phaseSchema.optional(),
    currentTask: taskSchema.optional(),
    pendingApprovals: z.array(coreV1PendingApprovalSchema).max(CORE_V1_MAX_PAGE_SIZE),
    recentFailureCount: z.number().int().nonnegative(),
    retryCount: z.number().int().nonnegative(),
    validation: z
      .strictObject({
        passed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        incomplete: z.number().int().nonnegative(),
      })
      .readonly(),
    usage: usageStateSchema,
    keepAwake: keepAwakeStatusSchema.optional(),
    latestEventSequence: z.number().int().nonnegative(),
  })
  .readonly();
export type CoreV1Dashboard = z.infer<typeof coreV1DashboardSchema>;

export const coreV1RunLogEntrySchema = z
  .strictObject({
    cursor: opaqueCursorSchema,
    projectId: projectIdSchema,
    occurredAt: isoTimestampSchema,
    source: z.enum(["core", "master", "worker", "validation", "git"]),
    level: z.enum(["debug", "info", "warning", "error"]),
    message: z.string().max(16 * 1_024),
    phaseId: phaseIdSchema.optional(),
    taskId: taskIdSchema.optional(),
    attemptId: attemptIdSchema.optional(),
    details: jsonObjectSchema.optional(),
    redacted: z.boolean(),
  })
  .readonly();
export type CoreV1RunLogEntry = z.infer<typeof coreV1RunLogEntrySchema>;

export const coreV1PersistedEventSchema = eventSchema
  .extend({ sequenceNumber: z.number().int().positive() })
  .readonly();
export type CoreV1PersistedEvent = z.infer<typeof coreV1PersistedEventSchema>;

export const coreV1GitStatusSchema = z
  .strictObject({
    projectId: projectIdSchema,
    workspacePath: workspacePathSchema,
    available: z.boolean(),
    headSha: gitShaSchema.optional(),
    branch: z.string().min(1).max(1_024).optional(),
    dirty: z.boolean().optional(),
    changedPaths: z.array(z.string().min(1).max(4_096)).max(CORE_V1_MAX_PAGE_SIZE),
    reason: nonEmptyTextSchema.optional(),
    observedAt: isoTimestampSchema,
  })
  .superRefine((status, context) => {
    if (status.available && status.headSha === undefined) {
      context.addIssue({ code: "custom", message: "Available Git status requires HEAD" });
    }
    if (!status.available && status.reason === undefined) {
      context.addIssue({ code: "custom", message: "Unavailable Git status requires a reason" });
    }
  })
  .readonly();

export const coreV1GitCommitSchema = z
  .strictObject({
    sha: gitShaSchema,
    subject: nonEmptyTextSchema,
    authoredAt: isoTimestampSchema,
    reachable: z.boolean(),
    taskId: taskIdSchema.optional(),
    attemptId: attemptIdSchema.optional(),
    changedPaths: z.array(z.string().min(1).max(4_096)).max(CORE_V1_MAX_SNAPSHOT_ITEMS),
  })
  .readonly();

export const coreV1ValidationDetailSchema = z
  .strictObject({
    run: validationRunSchema,
    results: z.array(validationResultSchema).max(CORE_V1_MAX_SNAPSHOT_ITEMS),
  })
  .readonly();

export const coreV1SettingsSchema = z
  .strictObject({
    projectId: projectIdSchema,
    executionMode: executionModeSchema,
    permissionPolicy: permissionPolicyConfigurationSchema,
    keepAwakeBatteryPolicy: keepAwakeBatteryPolicySchema,
    telemetryEnabled: z.literal(false),
    updatedAt: isoTimestampSchema,
  })
  .readonly();

const projectReferenceSchema = z.strictObject({ projectId: projectIdSchema }).readonly();
const projectWorkspaceReferenceShape = {
  projectId: projectIdSchema,
  workspacePath: workspacePathSchema,
};
const projectWorkspaceReferenceSchema = z.strictObject(projectWorkspaceReferenceShape).readonly();

const projectControlResultSchema = z
  .strictObject({
    projectId: projectIdSchema,
    status: z.enum([
      "REQUESTED",
      "PAUSED",
      "RESUMED",
      "STOPPED",
      "UNCHANGED",
      "INTERVENTION_REQUIRED",
      "BLOCKED",
      "NOT_FOUND",
      "REJECTED",
    ]),
    reason: nonEmptyTextSchema.optional(),
    changedPaths: z.array(z.string().min(1).max(4_096)).max(CORE_V1_MAX_PAGE_SIZE).optional(),
  })
  .readonly();

const projectStartResultSchema = z
  .strictObject({
    projectId: projectIdSchema,
    state: z.enum(["READY", "RUNNING", "WAITING_FOR_USER", "BLOCKED"]),
    firstPhaseId: phaseIdSchema.optional(),
  })
  .readonly();

const roadmapProposalResultSchema = z
  .strictObject({
    proposal: roadmapRevisionProposalSchema,
    outcome: z.enum(["APPLIED", "AWAITING_USER_APPROVAL", "WAITING_FOR_SAFE_BOUNDARY", "STALE"]),
  })
  .readonly();

const settingsUpdatePayloadSchema = z
  .strictObject({
    projectId: projectIdSchema,
    actor: actorSchema,
    reason: nonEmptyTextSchema,
    executionMode: executionModeSchema.optional(),
    permissionPolicy: permissionPolicyConfigurationSchema.optional(),
    keepAwakeBatteryPolicy: keepAwakeBatteryPolicySchema.optional(),
  })
  .refine(
    (payload) =>
      payload.executionMode !== undefined ||
      payload.permissionPolicy !== undefined ||
      payload.keepAwakeBatteryPolicy !== undefined,
    { message: "A settings update must change at least one setting" },
  )
  .readonly();

/**
 * Frozen operation names for the first IDE integration pass. New operations are additive within
 * protocol v1; changing an existing payload or result meaning requires a new protocol major.
 */
export const CORE_V1_METHODS = [
  "system.bootstrap",
  "projects.list",
  "projects.create",
  "projects.get",
  "projects.specification.get",
  "projects.interview.answer",
  "roadmaps.generate",
  "projects.start",
  "dashboard.get",
  "decisions.list",
  "roadmaps.get",
  "roadmaps.revisions.list",
  "roadmaps.revisions.propose",
  "roadmaps.revisions.resolve",
  "master.send",
  "phases.approve",
  "phases.report.get",
  "projects.pause",
  "projects.resume",
  "projects.stop",
  "settings.get",
  "settings.update",
  "usage.get",
  "events.replay",
  "events.subscribe",
  "logs.list",
  "git.status",
  "git.commit.get",
  "attempts.list",
  "validation.list",
  "validation.get",
] as const;

export const coreV1MethodSchema = z.enum(CORE_V1_METHODS);
export type CoreV1Method = z.infer<typeof coreV1MethodSchema>;

export const coreV1OperationContracts = {
  "system.bootstrap": {
    payload: emptyPayloadSchema,
    result: z
      .strictObject({
        protocolVersion: z.literal(PROTOCOL_VERSION),
        serverInstanceId: z.string().min(1).max(256),
        capabilities: z.array(z.string().min(1).max(256)).min(1).max(256),
        projects: z.array(coreV1ProjectSummarySchema).max(CORE_V1_MAX_PAGE_SIZE),
        projectsPage: coreV1PageInfoSchema,
      })
      .readonly(),
  },
  "projects.list": {
    payload: pageRequestSchema,
    result: z
      .strictObject({
        projects: z.array(coreV1ProjectSummarySchema).max(CORE_V1_MAX_PAGE_SIZE),
        page: coreV1PageInfoSchema,
      })
      .readonly(),
  },
  "projects.create": {
    payload: z
      .strictObject({
        name: z.string().trim().min(1).max(256),
        workspacePath: workspacePathSchema,
        idea: nonEmptyTextSchema,
        executionMode: executionModeSchema,
        actor: actorSchema,
      })
      .readonly(),
    result: z
      .strictObject({
        project: projectSchema,
        workspacePath: workspacePathSchema,
        interviewQuestions: z.array(interviewQuestionSchema).max(CORE_V1_MAX_PAGE_SIZE),
      })
      .readonly(),
  },
  "projects.get": { payload: projectReferenceSchema, result: coreV1ProjectSnapshotSchema },
  "projects.specification.get": {
    payload: projectReferenceSchema,
    result: z
      .strictObject({
        projectId: projectIdSchema,
        specification: projectSpecificationSchema,
      })
      .readonly(),
  },
  "projects.interview.answer": {
    payload: z
      .strictObject({
        projectId: projectIdSchema,
        sessionId: sessionIdSchema,
        answers: z.array(interviewAnswerSchema).min(1).max(CORE_V1_MAX_PAGE_SIZE),
      })
      .readonly(),
    result: z
      .strictObject({
        projectId: projectIdSchema,
        specification: projectSpecificationSchema,
        nextQuestions: z.array(interviewQuestionSchema).max(CORE_V1_MAX_PAGE_SIZE),
        readyForRoadmap: z.boolean(),
      })
      .readonly(),
  },
  "roadmaps.generate": {
    payload: z
      .strictObject({ projectId: projectIdSchema, sessionId: sessionIdSchema, actor: actorSchema })
      .readonly(),
    result: masterRoadmapRecordSchema,
  },
  "projects.start": {
    payload: z
      .strictObject({
        projectId: projectIdSchema,
        workspacePath: workspacePathSchema,
        actor: actorSchema,
      })
      .readonly(),
    result: projectStartResultSchema,
  },
  "dashboard.get": { payload: projectReferenceSchema, result: coreV1DashboardSchema },
  "decisions.list": {
    payload: z.strictObject({ projectId: projectIdSchema, ...pageRequestShape }).readonly(),
    result: z
      .strictObject({
        decisions: z.array(decisionSchema).max(CORE_V1_MAX_PAGE_SIZE),
        page: coreV1PageInfoSchema,
      })
      .readonly(),
  },
  "roadmaps.get": { payload: projectReferenceSchema, result: masterRoadmapRecordSchema },
  "roadmaps.revisions.list": {
    payload: z.strictObject({ projectId: projectIdSchema, ...pageRequestShape }).readonly(),
    result: z
      .strictObject({
        revisions: z.array(roadmapRevisionSchema).max(CORE_V1_MAX_PAGE_SIZE),
        page: coreV1PageInfoSchema,
      })
      .readonly(),
  },
  "roadmaps.revisions.propose": {
    payload: z
      .strictObject({
        projectId: projectIdSchema,
        baseRevisionNumber: z.number().int().nonnegative(),
        operations: z.array(roadmapMutationOperationSchema).min(1).max(32),
        rationale: nonEmptyTextSchema,
        actor: actorSchema,
        sessionId: sessionIdSchema,
      })
      .readonly(),
    result: roadmapProposalResultSchema,
  },
  "roadmaps.revisions.resolve": {
    payload: z
      .strictObject({
        projectId: projectIdSchema,
        proposalEventId: z.string().min(1).max(256),
        resolution: z.enum(["approve", "reject"]),
        rationale: nonEmptyTextSchema,
        actor: actorSchema,
        sessionId: sessionIdSchema,
      })
      .readonly(),
    result: roadmapProposalResultSchema,
  },
  "master.send": {
    payload: z
      .strictObject({
        projectId: projectIdSchema,
        workspacePath: workspacePathSchema,
        sessionId: sessionIdSchema,
        message: nonEmptyTextSchema,
      })
      .readonly(),
    result: z
      .strictObject({
        proposal: masterAgentProposalSchema,
        commandStatus: z.string().min(1).max(128).optional(),
        commandDetails: jsonObjectSchema.optional(),
      })
      .readonly(),
  },
  "phases.approve": {
    payload: z
      .strictObject({
        projectId: projectIdSchema,
        phaseId: phaseIdSchema,
        decision: z.enum(["approve", "reject"]),
        actor: actorSchema,
        reason: nonEmptyTextSchema,
      })
      .readonly(),
    result: z
      .strictObject({
        projectId: projectIdSchema,
        phase: phaseSchema,
        nextPhase: phaseSchema.optional(),
        outcome: z.enum(["APPROVED", "REJECTED", "UNCHANGED"]),
      })
      .readonly(),
  },
  "phases.report.get": {
    payload: z.strictObject({ projectId: projectIdSchema, phaseId: phaseIdSchema }).readonly(),
    result: phaseReportSchema,
  },
  "projects.pause": {
    payload: z.strictObject({ ...projectWorkspaceReferenceShape, actor: actorSchema }).readonly(),
    result: projectControlResultSchema,
  },
  "projects.resume": {
    payload: z
      .strictObject({
        ...projectWorkspaceReferenceShape,
        actor: actorSchema,
        acknowledgeIntervention: z.boolean().optional(),
      })
      .readonly(),
    result: projectControlResultSchema,
  },
  "projects.stop": {
    payload: z.strictObject({ ...projectWorkspaceReferenceShape, actor: actorSchema }).readonly(),
    result: projectControlResultSchema,
  },
  "settings.get": { payload: projectReferenceSchema, result: coreV1SettingsSchema },
  "settings.update": { payload: settingsUpdatePayloadSchema, result: coreV1SettingsSchema },
  "usage.get": {
    payload: projectReferenceSchema,
    result: z
      .strictObject({
        projectId: projectIdSchema,
        usage: usageStateSchema,
        observedAt: isoTimestampSchema,
      })
      .readonly(),
  },
  "events.replay": {
    payload: z
      .strictObject({
        projectId: projectIdSchema,
        afterSequence: z.number().int().nonnegative().optional(),
        limit: z.number().int().min(1).max(CORE_V1_MAX_PAGE_SIZE).optional(),
      })
      .readonly(),
    result: z
      .strictObject({
        events: z.array(coreV1PersistedEventSchema).max(CORE_V1_MAX_PAGE_SIZE),
        latestSequence: z.number().int().nonnegative(),
        hasMore: z.boolean(),
      })
      .readonly(),
  },
  "events.subscribe": {
    payload: z
      .strictObject({
        projectId: projectIdSchema,
        afterSequence: z.number().int().nonnegative().optional(),
        limit: z.number().int().min(1).max(CORE_V1_MAX_PAGE_SIZE).optional(),
      })
      .readonly(),
    result: z
      .strictObject({
        events: z.array(coreV1PersistedEventSchema).max(CORE_V1_MAX_PAGE_SIZE),
        latestSequence: z.number().int().nonnegative(),
        hasMore: z.boolean(),
        subscribed: z.literal(true),
      })
      .readonly(),
  },
  "logs.list": {
    payload: z
      .strictObject({
        projectId: projectIdSchema,
        phaseId: phaseIdSchema.optional(),
        taskId: taskIdSchema.optional(),
        attemptId: attemptIdSchema.optional(),
        ...pageRequestShape,
      })
      .readonly(),
    result: z
      .strictObject({
        entries: z.array(coreV1RunLogEntrySchema).max(CORE_V1_MAX_PAGE_SIZE),
        page: coreV1PageInfoSchema,
      })
      .readonly(),
  },
  "git.status": { payload: projectWorkspaceReferenceSchema, result: coreV1GitStatusSchema },
  "git.commit.get": {
    payload: z.strictObject({ projectId: projectIdSchema, sha: gitShaSchema }).readonly(),
    result: coreV1GitCommitSchema,
  },
  "attempts.list": {
    payload: z
      .strictObject({ projectId: projectIdSchema, taskId: taskIdSchema, ...pageRequestShape })
      .readonly(),
    result: z
      .strictObject({
        attempts: z.array(attemptSchema).max(CORE_V1_MAX_PAGE_SIZE),
        page: coreV1PageInfoSchema,
      })
      .readonly(),
  },
  "validation.list": {
    payload: z
      .strictObject({ projectId: projectIdSchema, taskId: taskIdSchema, ...pageRequestShape })
      .readonly(),
    result: z
      .strictObject({
        runs: z.array(validationRunSchema).max(CORE_V1_MAX_PAGE_SIZE),
        page: coreV1PageInfoSchema,
      })
      .readonly(),
  },
  "validation.get": {
    payload: z
      .strictObject({ projectId: projectIdSchema, validationRunId: validationRunIdSchema })
      .readonly(),
    result: coreV1ValidationDetailSchema,
  },
} as const;

type CoreV1Contracts = typeof coreV1OperationContracts;
export type CoreV1Payload<Method extends CoreV1Method> = z.input<
  CoreV1Contracts[Method]["payload"]
>;
export type CoreV1Result<Method extends CoreV1Method> = z.output<CoreV1Contracts[Method]["result"]>;

export function parseCoreV1Payload<Method extends CoreV1Method>(
  method: Method,
  value: unknown,
): CoreV1Payload<Method> {
  return coreV1OperationContracts[method].payload.parse(value) as CoreV1Payload<Method>;
}

export function parseCoreV1Result<Method extends CoreV1Method>(
  method: Method,
  value: unknown,
): CoreV1Result<Method> {
  return coreV1OperationContracts[method].result.parse(value) as CoreV1Result<Method>;
}

export function parseCoreV1Request(value: unknown): RequestEnvelope & { method: CoreV1Method } {
  const envelope = requestEnvelopeSchema.parse(value);
  const method = coreV1MethodSchema.parse(envelope.method);
  parseCoreV1Payload(method, envelope.payload);
  return { ...envelope, method };
}

export const CORE_V1_NOTIFICATION_EVENTS = ["core.event", "run.log.appended"] as const;
export const coreV1NotificationEventSchema = z.enum(CORE_V1_NOTIFICATION_EVENTS);
export type CoreV1NotificationEvent = z.infer<typeof coreV1NotificationEventSchema>;

export function parseCoreV1Notification(
  value: unknown,
): NotificationEnvelope & { event: CoreV1NotificationEvent } {
  const envelope = notificationEnvelopeSchema.parse(value);
  const event = coreV1NotificationEventSchema.parse(envelope.event);
  if (event === "core.event") coreV1PersistedEventSchema.parse(envelope.payload);
  else coreV1RunLogEntrySchema.parse(envelope.payload);
  return { ...envelope, event };
}

/** Minimal transport boundary implemented by CoreIpcClient and deterministic fake clients. */
export interface CoreV1Transport {
  request(envelope: RequestEnvelope): Promise<JsonValue>;
}

/** Schema-validating client facade suitable for the IDE, CLI, Dashboard, and tests. */
export class CoreV1Client {
  readonly #transport: CoreV1Transport;
  readonly #createRequestId: () => string;

  constructor(transport: CoreV1Transport, createRequestId: () => string) {
    this.#transport = transport;
    this.#createRequestId = createRequestId;
  }

  async request<Method extends CoreV1Method>(
    method: Method,
    payload: CoreV1Payload<Method>,
  ): Promise<CoreV1Result<Method>> {
    const envelope = requestEnvelopeSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      kind: "request",
      requestId: requestIdSchema.parse(this.#createRequestId()),
      method,
      payload: parseCoreV1Payload(method, payload),
    });
    return parseCoreV1Result(method, await this.#transport.request(envelope));
  }
}
