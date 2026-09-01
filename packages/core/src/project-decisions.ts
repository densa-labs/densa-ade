import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

import {
  decisionIdSchema,
  decisionKindSchema,
  decisionScopeSchema,
  decisionSourceSchema,
  eventIdSchema,
  isoTimestampSchema,
  projectIdSchema,
  type Decision,
  type DecisionId,
  type DecisionKind,
  type DecisionScope,
  type DecisionSource,
  type PhaseId,
  type ProjectId,
  type TaskId,
} from "@densa-ade/protocol";

import { PermissionPolicyService } from "./permission-policy.js";
import type { PersistedEvent } from "./event-publisher.js";
import type { DensaAdeDatabase } from "./persistence/database.js";
import type { PortableSyncResult } from "./persistence/portable-project.js";
import { redactSensitiveText } from "./secret-redaction.js";

const MAX_DECISION_TEXT_BYTES = 64 * 1_024;
const MAX_DECISION_CATEGORY_BYTES = 512;
const MAX_AFFECTED_REFERENCES = 256;

export interface RecordProjectDecisionRequest {
  readonly projectId: ProjectId;
  readonly kind: DecisionKind;
  readonly statement: string;
  readonly title: string;
  readonly rationale: string;
  readonly category: string;
  readonly source: DecisionSource;
  readonly scope: DecisionScope;
  readonly affectedPhaseIds?: readonly PhaseId[];
  readonly affectedTaskIds?: readonly TaskId[];
  readonly supersedesId?: DecisionId;
  readonly actor: string;
  readonly approvalDecisionId?: DecisionId;
}

export type ProjectDecisionResult =
  | Readonly<{
      status: "RECORDED";
      decision: Decision;
      event: PersistedEvent;
      portableSync: PortableSyncResult | ProjectDecisionPortableSyncFailure;
    }>
  | Readonly<{
      status: "UNCHANGED";
      decision: Decision;
    }>
  | Readonly<{
      status: "CONFLICT_REQUIRES_USER_DECISION";
      conflictDecisionIds: readonly DecisionId[];
      event: PersistedEvent;
    }>;

export interface ProjectDecisionPortableSyncFailure {
  readonly status: "failed";
  readonly code: "PERSISTENCE_FAILURE" | "WORKSPACE_CONFLICT";
  readonly message: string;
}

export interface ProjectDecisionServiceOptions {
  readonly workspacePath: string;
  readonly now?: () => string;
  readonly decisionIdFactory?: () => string;
  readonly eventIdFactory?: () => string;
}

export class ProjectDecisionError extends Error {
  readonly code: "USER_CONFIGURATION_ERROR" | "INTERNAL_INVARIANT_VIOLATION" | "PERMISSION_DENIED";

  constructor(code: ProjectDecisionError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProjectDecisionError";
    this.code = code;
  }
}

/** Core-owned mutation boundary for durable project decisions and constraints. */
export class ProjectDecisionService {
  readonly #now: () => string;
  readonly #decisionIdFactory: () => string;
  readonly #eventIdFactory: () => string;

  constructor(
    private readonly database: DensaAdeDatabase,
    private readonly options: ProjectDecisionServiceOptions,
  ) {
    if (!isAbsolute(options.workspacePath)) {
      throw new ProjectDecisionError(
        "USER_CONFIGURATION_ERROR",
        "Project decision workspace path must be absolute",
      );
    }
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#decisionIdFactory = options.decisionIdFactory ?? (() => `decision-${randomUUID()}`);
    this.#eventIdFactory = options.eventIdFactory ?? (() => `event-${randomUUID()}`);
  }

  async record(requestInput: RecordProjectDecisionRequest): Promise<ProjectDecisionResult> {
    const occurredAt = isoTimestampSchema.parse(this.#now());
    const request = this.#validateRequest(requestInput);
    const active = this.database.repositories.decisions
      .listByProjectId(request.projectId)
      .filter((decision) => decision.status === "active");
    const target =
      request.supersedesId === undefined
        ? undefined
        : active.find((decision) => decision.id === request.supersedesId);
    if (request.supersedesId !== undefined && target === undefined) {
      throw new ProjectDecisionError(
        "USER_CONFIGURATION_ERROR",
        `Superseded decision ${request.supersedesId} is missing or no longer active`,
      );
    }
    if (
      target !== undefined &&
      (target.projectId !== request.projectId || target.category !== request.category)
    ) {
      throw new ProjectDecisionError(
        "USER_CONFIGURATION_ERROR",
        "A replacement must use the same project and category as the active record it supersedes",
      );
    }

    const overlapping =
      request.kind === "constraint"
        ? active.filter(
            (decision) =>
              decision.kind === "constraint" &&
              decision.category === request.category &&
              scopesOverlap(decision, request, this.database),
          )
        : [];
    const duplicate = overlapping.find(
      (decision) =>
        normalizedStatement(decision.statement) === normalizedStatement(request.statement) &&
        sameReferences(decision.affectedPhaseIds, request.affectedPhaseIds) &&
        sameReferences(decision.affectedTaskIds, request.affectedTaskIds) &&
        decision.scope === request.scope,
    );
    if (request.supersedesId === undefined && duplicate !== undefined) {
      return Object.freeze({ status: "UNCHANGED" as const, decision: duplicate });
    }
    const conflicts = overlapping.filter(
      (decision) =>
        decision.id !== request.supersedesId &&
        normalizedStatement(decision.statement) !== normalizedStatement(request.statement),
    );
    if (request.supersedesId === undefined && conflicts.length > 0) {
      const event = this.database.repositories.events.append({
        id: eventIdSchema.parse(this.#eventIdFactory()),
        projectId: request.projectId,
        type: "PROJECT_CONSTRAINT_CONFLICT_DETECTED",
        eventVersion: 1,
        occurredAt,
        actor: request.actor,
        payload: {
          category: request.category,
          scope: request.scope,
          proposedStatement: request.statement,
          conflictDecisionIds: conflicts.map(({ id }) => id),
          resolutionRequired: true,
        },
      });
      return Object.freeze({
        status: "CONFLICT_REQUIRES_USER_DECISION" as const,
        conflictDecisionIds: Object.freeze(conflicts.map(({ id }) => id)),
        event,
      });
    }

    const permission = new PermissionPolicyService(this.database).authorize({
      projectId: request.projectId,
      operation: "write_workspace",
      actor: request.actor,
      reason: request.rationale,
      occurredAt,
      ...(request.approvalDecisionId === undefined
        ? {}
        : {
            approvalDecisionId: request.approvalDecisionId,
            approvalCategory: "approval.write-workspace",
          }),
    });
    if (permission.authorization === undefined) {
      throw new ProjectDecisionError(
        "PERMISSION_DENIED",
        `Project decision mutation requires user authorization: ${permission.decision.disposition}`,
      );
    }

    const decision = {
      id: decisionIdSchema.parse(this.#decisionIdFactory()),
      projectId: request.projectId,
      kind: request.kind,
      statement: request.statement,
      title: request.title,
      rationale: request.rationale,
      category: request.category,
      source: request.source,
      scope: request.scope,
      status: "active" as const,
      ...(request.supersedesId === undefined ? {} : { supersedesId: request.supersedesId }),
      affectedPhaseIds: [...request.affectedPhaseIds],
      affectedTaskIds: [...request.affectedTaskIds],
      createdAt: occurredAt,
    } satisfies Decision;
    const eventId = eventIdSchema.parse(this.#eventIdFactory());
    const event = this.database.transaction((repositories) => {
      if (target !== undefined) repositories.decisions.markSuperseded(target.id, occurredAt);
      const stored = repositories.decisions.create(decision);
      return repositories.events.append({
        id: eventId,
        projectId: request.projectId,
        type: target === undefined ? "PROJECT_DECISION_RECORDED" : "PROJECT_DECISION_SUPERSEDED",
        eventVersion: 1,
        occurredAt,
        actor: request.actor,
        payload: {
          decisionId: stored.id,
          kind: stored.kind,
          category: stored.category,
          source: stored.source,
          scope: stored.scope,
          status: stored.status,
          affectedPhaseIds: [...stored.affectedPhaseIds],
          affectedTaskIds: [...stored.affectedTaskIds],
          ...(stored.supersedesId === undefined ? {} : { supersedesId: stored.supersedesId }),
        },
      });
    });
    const portableSync = await this.#synchronize(request.projectId);
    return Object.freeze({ status: "RECORDED" as const, decision, event, portableSync });
  }

  #validateRequest(
    input: RecordProjectDecisionRequest,
  ): Required<Omit<RecordProjectDecisionRequest, "supersedesId" | "approvalDecisionId">> &
    Pick<RecordProjectDecisionRequest, "supersedesId" | "approvalDecisionId"> {
    const projectId = projectIdSchema.parse(input.projectId);
    if (this.database.repositories.projects.findById(projectId) === undefined) {
      throw new ProjectDecisionError(
        "USER_CONFIGURATION_ERROR",
        `Project decision project ${projectId} does not exist`,
      );
    }
    const affectedPhaseIds = uniqueSorted(input.affectedPhaseIds ?? []).map((id) => id as PhaseId);
    const affectedTaskIds = uniqueSorted(input.affectedTaskIds ?? []).map((id) => id as TaskId);
    for (const phaseId of affectedPhaseIds) {
      if (this.database.repositories.phases.findById(phaseId)?.projectId !== projectId) {
        throw new ProjectDecisionError(
          "USER_CONFIGURATION_ERROR",
          `Affected phase ${phaseId} is not part of project ${projectId}`,
        );
      }
    }
    for (const taskId of affectedTaskIds) {
      if (this.database.repositories.tasks.findById(taskId)?.projectId !== projectId) {
        throw new ProjectDecisionError(
          "USER_CONFIGURATION_ERROR",
          `Affected task ${taskId} is not part of project ${projectId}`,
        );
      }
    }
    const request = {
      ...input,
      projectId,
      kind: decisionKindSchema.parse(input.kind),
      source: decisionSourceSchema.parse(input.source),
      scope: decisionScopeSchema.parse(input.scope),
      statement: clean(input.statement, "statement", MAX_DECISION_TEXT_BYTES),
      title: clean(input.title, "title", MAX_DECISION_CATEGORY_BYTES),
      rationale: clean(input.rationale, "rationale", MAX_DECISION_TEXT_BYTES),
      category: clean(input.category, "category", MAX_DECISION_CATEGORY_BYTES),
      actor: clean(input.actor, "actor", MAX_DECISION_CATEGORY_BYTES),
      affectedPhaseIds,
      affectedTaskIds,
      ...(input.supersedesId === undefined
        ? {}
        : { supersedesId: decisionIdSchema.parse(input.supersedesId) }),
      ...(input.approvalDecisionId === undefined
        ? {}
        : { approvalDecisionId: decisionIdSchema.parse(input.approvalDecisionId) }),
    };
    if (request.scope === "phase" && request.affectedPhaseIds.length === 0) {
      throw new ProjectDecisionError(
        "USER_CONFIGURATION_ERROR",
        "Phase-scoped decisions require at least one affected phase",
      );
    }
    if (request.scope === "task" && request.affectedTaskIds.length === 0) {
      throw new ProjectDecisionError(
        "USER_CONFIGURATION_ERROR",
        "Task-scoped decisions require at least one affected task",
      );
    }
    if (
      request.affectedPhaseIds.length > MAX_AFFECTED_REFERENCES ||
      request.affectedTaskIds.length > MAX_AFFECTED_REFERENCES
    ) {
      throw new ProjectDecisionError(
        "USER_CONFIGURATION_ERROR",
        `Project decisions support at most ${String(MAX_AFFECTED_REFERENCES)} affected references of each kind`,
      );
    }
    return request;
  }

  async #synchronize(
    projectId: ProjectId,
  ): Promise<PortableSyncResult | ProjectDecisionPortableSyncFailure> {
    try {
      const { PortableProjectSynchronizer } = await import("./persistence/portable-project.js");
      return await new PortableProjectSynchronizer(this.database.repositories).synchronize(
        this.options.workspacePath,
        projectId,
      );
    } catch (error) {
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "WORKSPACE_CONFLICT"
          ? "WORKSPACE_CONFLICT"
          : "PERSISTENCE_FAILURE";
      return Object.freeze({
        status: "failed" as const,
        code,
        message:
          error instanceof Error
            ? error.message
            : "Portable decision regeneration failed after the authoritative commit",
      });
    }
  }
}

function clean(value: string, field: string, maximumBytes: number): string {
  const cleaned = redactSensitiveText(value).trim();
  if (cleaned.length === 0 || Buffer.byteLength(cleaned) > maximumBytes) {
    throw new ProjectDecisionError(
      "USER_CONFIGURATION_ERROR",
      `Project decision ${field} must contain text within ${String(maximumBytes)} bytes`,
    );
  }
  return cleaned;
}

function normalizedStatement(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort((left, right) => left.localeCompare(right)));
}

function sameReferences(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function scopesOverlap(
  existing: Decision,
  proposed: Pick<RecordProjectDecisionRequest, "scope" | "affectedPhaseIds" | "affectedTaskIds">,
  database: DensaAdeDatabase,
): boolean {
  if (existing.scope === "project" || proposed.scope === "project") return true;
  if (existing.scope === "phase" && proposed.scope === "phase") {
    return existing.affectedPhaseIds.some((id) => proposed.affectedPhaseIds?.includes(id) === true);
  }
  if (existing.scope === "task" && proposed.scope === "task") {
    return existing.affectedTaskIds.some((id) => proposed.affectedTaskIds?.includes(id) === true);
  }
  if (existing.scope === "phase" && proposed.scope === "task") {
    return (proposed.affectedTaskIds ?? []).some((id) => {
      const task = database.repositories.tasks.findById(id);
      return task !== undefined && existing.affectedPhaseIds.includes(task.phaseId);
    });
  }
  if (existing.scope === "task" && proposed.scope === "phase") {
    return existing.affectedTaskIds.some((id) => {
      const task = database.repositories.tasks.findById(id);
      return task !== undefined && proposed.affectedPhaseIds?.includes(task.phaseId) === true;
    });
  }
  return false;
}
