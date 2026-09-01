import { randomUUID } from "node:crypto";

import {
  decisionIdSchema,
  eventIdSchema,
  eventSchema,
  isoTimestampSchema,
  jsonObjectSchema,
  projectIdSchema,
  roadmapMutationApprovalSchema,
  roadmapMutationClassificationSchema,
  roadmapMutationOperationSchema,
  roadmapRevisionProposalIdSchema,
  roadmapRevisionProposalSchema,
  type DecisionId,
  type EventId,
  type ProjectId,
  type RoadmapMutationApproval,
  type RoadmapMutationClassification,
  type RoadmapMutationOperation,
  type RoadmapRevisionProposal,
} from "@densa-ade/protocol";

import type { PersistedEvent } from "./event-publisher.js";
import type { DensaAdeDatabase } from "./persistence/database.js";
import { PermissionPolicyService, evaluatePermissionPolicy } from "./permission-policy.js";
import {
  RoadmapMutationService,
  type RoadmapMutationBatchResult,
  type RoadmapPortableSyncOutcome,
} from "./roadmap-mutations.js";
import { redactSensitiveText } from "./secret-redaction.js";

const ACTIVE_TASK_STATES = new Set(["RUNNING", "VALIDATING", "RETRYING"]);
const MAX_RATIONALE_BYTES = 64 * 1_024;
const MAX_ACTOR_BYTES = 512;
const MAX_SESSION_ID_BYTES = 512;

export interface ProposeRoadmapRevisionRequest {
  readonly operations: readonly RoadmapMutationOperation[];
  readonly classification?: RoadmapMutationClassification;
  readonly rationale: string;
  readonly actor: string;
  readonly sessionId: string;
}

export interface ApplyRoadmapRevisionProposalRequest {
  readonly proposalEventId: EventId;
  readonly approval?: RoadmapMutationApproval;
}

export interface RejectRoadmapRevisionProposalRequest {
  readonly proposalEventId: EventId;
  readonly actor: string;
  readonly rationale: string;
}

export type RoadmapRevisionWorkflowResult = Readonly<{
  status: "APPLIED" | "AWAITING_USER_APPROVAL" | "WAITING_FOR_SAFE_BOUNDARY" | "REJECTED" | "STALE";
  proposal: RoadmapRevisionProposal;
  event?: PersistedEvent;
  mutation?: RoadmapMutationBatchResult;
  portableSync?: RoadmapPortableSyncOutcome;
}>;

export interface MasterRoadmapRevisionWorkflowOptions {
  readonly workspacePath: string;
  readonly now?: () => string;
  readonly proposalIdFactory?: () => string;
  readonly eventIdFactory?: () => string;
  readonly revisionIdFactory?: () => string;
  readonly mutationEventIdFactory?: () => string;
}

export class MasterRoadmapRevisionWorkflowError extends Error {
  readonly code: "USER_CONFIGURATION_ERROR" | "PERMISSION_DENIED" | "PERSISTENCE_FAILURE";

  constructor(
    code: MasterRoadmapRevisionWorkflowError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MasterRoadmapRevisionWorkflowError";
    this.code = code;
  }
}

/** Durable steering workflow around the lower-level authoritative roadmap mutation service. */
export class MasterRoadmapRevisionWorkflow {
  readonly #now: () => string;
  readonly #proposalIdFactory: () => string;
  readonly #eventIdFactory: () => string;
  readonly #mutations: RoadmapMutationService;

  constructor(
    private readonly database: DensaAdeDatabase,
    options: MasterRoadmapRevisionWorkflowOptions,
  ) {
    if (!options.workspacePath.startsWith("/")) {
      throw new MasterRoadmapRevisionWorkflowError(
        "USER_CONFIGURATION_ERROR",
        "Roadmap revision workflow requires an absolute workspace path",
      );
    }
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#proposalIdFactory =
      options.proposalIdFactory ?? (() => `roadmap-proposal-${randomUUID()}`);
    this.#eventIdFactory = options.eventIdFactory ?? (() => `event-${randomUUID()}`);
    this.#mutations = new RoadmapMutationService(database, {
      workspacePath: options.workspacePath,
      now: this.#now,
      ...(options.revisionIdFactory === undefined
        ? {}
        : { revisionIdFactory: options.revisionIdFactory }),
      ...(options.mutationEventIdFactory === undefined
        ? {}
        : { eventIdFactory: options.mutationEventIdFactory }),
    });
  }

  async propose(
    projectIdInput: ProjectId,
    requestInput: ProposeRoadmapRevisionRequest,
  ): Promise<RoadmapRevisionWorkflowResult> {
    const projectId = projectIdSchema.parse(projectIdInput);
    const request = this.#validateProposalRequest(requestInput);
    const preview = this.#mutations.preview(projectId, request.operations, request.classification);
    const approvalRequired = this.#approvalRequired(projectId, preview.classification);
    const activeTaskIds = this.#activeAffectedTasks(projectId, preview.affectedTaskIds);
    const occurredAt = isoTimestampSchema.parse(this.#now());
    const proposalId = roadmapRevisionProposalIdSchema.parse(this.#proposalIdFactory());
    const proposalEventId = eventIdSchema.parse(this.#eventIdFactory());
    const status = approvalRequired
      ? "awaiting_approval"
      : activeTaskIds.length > 0
        ? "waiting_for_safe_boundary"
        : "ready_to_apply";
    const proposal = roadmapRevisionProposalSchema.parse({
      id: proposalId,
      proposalEventId,
      projectId,
      baseRevisionNumber: preview.baseRevisionNumber,
      classification: preview.classification,
      rationale: request.rationale,
      actor: request.actor,
      sessionId: request.sessionId,
      operations: request.operations,
      beforeValue: jsonObjectSchema.parse(preview.before),
      afterValue: jsonObjectSchema.parse(preview.roadmap),
      affectedPhaseIds: preview.affectedPhaseIds,
      affectedTaskIds: preview.affectedTaskIds,
      activeTaskIds,
      approvalRequired,
      status,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    });
    const event = eventSchema.parse({
      id: proposalEventId,
      projectId,
      type: "ROADMAP_REVISION_PROPOSED",
      eventVersion: 1,
      occurredAt,
      actor: request.actor,
      payload: {
        proposalId,
        baseRevisionNumber: preview.baseRevisionNumber,
        classification: preview.classification,
        rationale: request.rationale,
        sessionId: request.sessionId,
        operationKinds: request.operations.map(({ kind }) => kind),
        affectedPhaseIds: [...preview.affectedPhaseIds],
        affectedTaskIds: [...preview.affectedTaskIds],
        activeTaskIds: [...activeTaskIds],
        approvalRequired,
        status,
      },
    });
    const persistedEvent = this.database.persistRoadmapRevisionProposal({ proposal, event });
    if (status === "awaiting_approval") {
      return Object.freeze({
        status: "AWAITING_USER_APPROVAL" as const,
        proposal,
        event: persistedEvent,
      });
    }
    if (status === "waiting_for_safe_boundary") {
      return Object.freeze({
        status: "WAITING_FOR_SAFE_BOUNDARY" as const,
        proposal,
        event: persistedEvent,
      });
    }
    return await this.applyProposal({ proposalEventId });
  }

  async applyProposal(
    request: ApplyRoadmapRevisionProposalRequest,
  ): Promise<RoadmapRevisionWorkflowResult> {
    const proposalEventId = eventIdSchema.parse(request.proposalEventId);
    const proposal =
      this.database.repositories.roadmapRevisionProposals.findByEventId(proposalEventId);
    if (proposal === undefined) {
      throw new MasterRoadmapRevisionWorkflowError(
        "USER_CONFIGURATION_ERROR",
        `Roadmap revision proposal event ${proposalEventId} does not exist`,
      );
    }
    if (proposal.status === "applied") {
      const portableSync = await this.#mutations.synchronizePortableProjection(proposal.projectId, {
        actor: proposal.actor,
        reason: `Regenerate the portable projection for applied proposal ${proposal.id}`,
        ...(proposal.approvalDecisionId === undefined
          ? {}
          : {
              approvalDecisionId: proposal.approvalDecisionId,
              approvalCategory: `roadmap.revision.approval.${proposal.id}`,
            }),
      });
      return Object.freeze({ status: "APPLIED" as const, proposal, portableSync });
    }
    if (proposal.status === "rejected") {
      return Object.freeze({ status: "REJECTED" as const, proposal });
    }
    if (proposal.status === "stale") {
      return Object.freeze({ status: "STALE" as const, proposal });
    }
    const current = this.database.repositories.masterRoadmaps.findByProjectId(proposal.projectId);
    if (current === undefined || current.revisionNumber !== proposal.baseRevisionNumber) {
      return this.#markStale(proposal);
    }
    const preview = this.#mutations.preview(
      proposal.projectId,
      proposal.operations,
      proposal.classification,
    );
    if (
      JSON.stringify(preview.before) !== JSON.stringify(proposal.beforeValue) ||
      JSON.stringify(preview.roadmap) !== JSON.stringify(proposal.afterValue)
    ) {
      return this.#markStale(proposal);
    }

    const approval = this.#approval(proposal, request.approval);
    const activeTaskIds = this.#activeAffectedTasks(proposal.projectId, proposal.affectedTaskIds);
    if (activeTaskIds.length > 0) {
      const updatedAt = isoTimestampSchema.parse(this.#now());
      const updated = roadmapRevisionProposalSchema.parse({
        ...proposal,
        status: "waiting_for_safe_boundary",
        activeTaskIds,
        updatedAt,
        ...(approval === undefined ? {} : { approvalDecisionId: approval.decisionId }),
      });
      const event = eventSchema.parse({
        id: eventIdSchema.parse(this.#eventIdFactory()),
        projectId: proposal.projectId,
        type: "ROADMAP_REVISION_DEFERRED",
        eventVersion: 1,
        occurredAt: updatedAt,
        actor: proposal.actor,
        payload: {
          proposalId: proposal.id,
          proposalEventId: proposal.proposalEventId,
          activeTaskIds: [...activeTaskIds],
          reason: "Affected task context is active; apply only after a safe boundary",
          ...(approval === undefined ? {} : { approvalDecisionId: approval.decisionId }),
        },
      });
      const persistedEvent = this.database.transaction((repositories) => {
        repositories.roadmapRevisionProposals.replace(updated, proposal.status);
        return repositories.events.append(event);
      });
      return Object.freeze({
        status: "WAITING_FOR_SAFE_BOUNDARY" as const,
        proposal: updated,
        event: persistedEvent,
      });
    }
    if (proposal.approvalRequired && approval === undefined) {
      return Object.freeze({ status: "AWAITING_USER_APPROVAL" as const, proposal });
    }

    const mutation = await this.#mutations.applyBatch(
      proposal.projectId,
      {
        operations: proposal.operations,
        classification: proposal.classification,
        rationale: proposal.rationale,
        actor: proposal.actor,
        sessionId: proposal.sessionId,
        applicationMode: proposal.approvalRequired ? "approved" : "automatic",
        ...(approval === undefined ? {} : { approval }),
        proposalEventId: proposal.proposalEventId,
      },
      { proposal, expectedStatus: proposal.status },
    );
    const appliedProposal = mutation.proposal;
    if (appliedProposal === undefined) {
      throw new MasterRoadmapRevisionWorkflowError(
        "PERSISTENCE_FAILURE",
        `Roadmap proposal ${proposal.id} applied without a resolved proposal record`,
      );
    }
    return Object.freeze({
      status: "APPLIED" as const,
      proposal: appliedProposal,
      event: mutation.event,
      mutation,
      portableSync: mutation.portableSync,
    });
  }

  reject(request: RejectRoadmapRevisionProposalRequest): RoadmapRevisionWorkflowResult {
    const proposalEventId = eventIdSchema.parse(request.proposalEventId);
    const proposal =
      this.database.repositories.roadmapRevisionProposals.findByEventId(proposalEventId);
    if (proposal === undefined) {
      throw new MasterRoadmapRevisionWorkflowError(
        "USER_CONFIGURATION_ERROR",
        `Roadmap revision proposal event ${proposalEventId} does not exist`,
      );
    }
    if (proposal.status === "applied") {
      throw new MasterRoadmapRevisionWorkflowError(
        "USER_CONFIGURATION_ERROR",
        `Applied roadmap revision proposal ${proposal.id} cannot be rejected`,
      );
    }
    if (proposal.status === "rejected") {
      return Object.freeze({ status: "REJECTED" as const, proposal });
    }
    if (proposal.status === "stale") {
      return Object.freeze({ status: "STALE" as const, proposal });
    }
    const occurredAt = isoTimestampSchema.parse(this.#now());
    const actor = cleanText(request.actor, "actor", MAX_ACTOR_BYTES);
    const rationale = cleanText(request.rationale, "rationale", MAX_RATIONALE_BYTES);
    const rejected = roadmapRevisionProposalSchema.parse({
      ...proposal,
      status: "rejected",
      activeTaskIds: [],
      updatedAt: occurredAt,
      resolvedAt: occurredAt,
    });
    const event = eventSchema.parse({
      id: eventIdSchema.parse(this.#eventIdFactory()),
      projectId: proposal.projectId,
      type: "ROADMAP_REVISION_REJECTED",
      eventVersion: 1,
      occurredAt,
      actor,
      payload: {
        proposalId: proposal.id,
        proposalEventId: proposal.proposalEventId,
        rationale,
      },
    });
    const persistedEvent = this.database.persistRoadmapRevisionProposalResolution({
      proposal: rejected,
      expectedStatus: proposal.status,
      event,
    });
    return Object.freeze({
      status: "REJECTED" as const,
      proposal: rejected,
      event: persistedEvent,
    });
  }

  #validateProposalRequest(input: ProposeRoadmapRevisionRequest): ProposeRoadmapRevisionRequest {
    const operations = input.operations.map((operation) =>
      roadmapMutationOperationSchema.parse(operation),
    );
    if (operations.length === 0 || operations.length > 32) {
      throw new MasterRoadmapRevisionWorkflowError(
        "USER_CONFIGURATION_ERROR",
        "Roadmap revision proposals require between 1 and 32 operations",
      );
    }
    return Object.freeze({
      operations: Object.freeze(operations),
      ...(input.classification === undefined
        ? {}
        : { classification: roadmapMutationClassificationSchema.parse(input.classification) }),
      rationale: cleanText(input.rationale, "rationale", MAX_RATIONALE_BYTES),
      actor: cleanText(input.actor, "actor", MAX_ACTOR_BYTES),
      sessionId: cleanText(input.sessionId, "session ID", MAX_SESSION_ID_BYTES),
    });
  }

  #approvalRequired(projectId: ProjectId, classification: RoadmapMutationClassification): boolean {
    const policy = new PermissionPolicyService(this.database);
    const configuration = policy.getConfiguration(projectId);
    const operations = [
      "write_workspace" as const,
      ...(classification === "minor"
        ? []
        : [
            classification === "scope"
              ? ("roadmap_scope_change" as const)
              : ("roadmap_significant_change" as const),
          ]),
    ];
    let approvalRequired = false;
    for (const operation of operations) {
      const disposition = evaluatePermissionPolicy(configuration, operation).disposition;
      if (disposition === "deny") {
        throw new MasterRoadmapRevisionWorkflowError(
          "PERMISSION_DENIED",
          `${operation} is denied by the current permission policy`,
        );
      }
      approvalRequired ||= disposition === "ask_user";
    }
    return approvalRequired;
  }

  #activeAffectedTasks(projectId: ProjectId, affectedTaskIds: readonly string[]): string[] {
    const affected = new Set(affectedTaskIds);
    return this.database.repositories.tasks
      .listByProjectId(projectId)
      .filter(
        (task) =>
          affected.has(task.id) &&
          (ACTIVE_TASK_STATES.has(task.state) ||
            task.state === "WAITING_FOR_USAGE" ||
            this.database.repositories.attempts
              .listByTaskId(task.id)
              .some((attempt) => attempt.completedAt === undefined)),
      )
      .map(({ id }) => id)
      .sort((left, right) => left.localeCompare(right));
  }

  #approval(
    proposal: RoadmapRevisionProposal,
    supplied?: RoadmapMutationApproval,
  ): RoadmapMutationApproval | undefined {
    const approval =
      supplied === undefined
        ? proposal.approvalDecisionId === undefined
          ? undefined
          : this.#approvalFromDecision(proposal, proposal.approvalDecisionId)
        : roadmapMutationApprovalSchema.parse(supplied);
    if (approval === undefined) return undefined;
    const decision = this.database.repositories.decisions.findById(approval.decisionId);
    if (
      decision?.projectId !== proposal.projectId ||
      decision.source !== "user" ||
      decision.status !== "active" ||
      decision.category !== `roadmap.revision.approval.${proposal.id}` ||
      approval.approvedAt !== decision.createdAt
    ) {
      throw new MasterRoadmapRevisionWorkflowError(
        "PERMISSION_DENIED",
        `Roadmap proposal approval ${approval.decisionId} is not an active user decision for ${proposal.id}`,
      );
    }
    return approval;
  }

  #approvalFromDecision(
    proposal: RoadmapRevisionProposal,
    decisionId: DecisionId,
  ): RoadmapMutationApproval {
    const decision = this.database.repositories.decisions.findById(decisionId);
    if (decision === undefined) {
      throw new MasterRoadmapRevisionWorkflowError(
        "PERMISSION_DENIED",
        `Stored roadmap proposal approval ${decisionId} no longer exists`,
      );
    }
    return roadmapMutationApprovalSchema.parse({
      decisionId: decisionIdSchema.parse(decision.id),
      approvedBy: decision.statement,
      approvedAt: decision.createdAt,
      sessionId: proposal.sessionId,
    });
  }

  #markStale(proposal: RoadmapRevisionProposal): RoadmapRevisionWorkflowResult {
    const occurredAt = isoTimestampSchema.parse(this.#now());
    const stale = roadmapRevisionProposalSchema.parse({
      ...proposal,
      status: "stale",
      activeTaskIds: [],
      updatedAt: occurredAt,
      resolvedAt: occurredAt,
    });
    const event = eventSchema.parse({
      id: eventIdSchema.parse(this.#eventIdFactory()),
      projectId: proposal.projectId,
      type: "ROADMAP_REVISION_STALE",
      eventVersion: 1,
      occurredAt,
      actor: proposal.actor,
      payload: {
        proposalId: proposal.id,
        proposalEventId: proposal.proposalEventId,
        baseRevisionNumber: proposal.baseRevisionNumber,
        reason: "The authoritative roadmap changed after this proposal was prepared",
      },
    });
    const persistedEvent = this.database.persistRoadmapRevisionProposalResolution({
      proposal: stale,
      expectedStatus: proposal.status,
      event,
    });
    return Object.freeze({
      status: "STALE" as const,
      proposal: stale,
      event: persistedEvent,
    });
  }
}

function cleanText(value: string, label: string, maxBytes: number): string {
  const cleaned = redactSensitiveText(value).trim();
  if (cleaned.length === 0 || Buffer.byteLength(cleaned) > maxBytes) {
    throw new MasterRoadmapRevisionWorkflowError(
      "USER_CONFIGURATION_ERROR",
      `Roadmap revision ${label} must contain between 1 and ${String(maxBytes)} bytes`,
    );
  }
  return cleaned;
}
