import { randomUUID } from "node:crypto";

import {
  eventIdSchema,
  eventSchema,
  isoTimestampSchema,
  jsonObjectSchema,
  masterRoadmapSchema,
  phaseIdSchema,
  projectIdSchema,
  roadmapMutationOperationSchema,
  roadmapMutationBatchRequestSchema,
  roadmapMutationRequestSchema,
  roadmapRevisionIdSchema,
  roadmapRevisionSchema,
  taskIdSchema,
  type ExecutionMode,
  type MasterRoadmap,
  type MasterRoadmapPhase,
  type MasterRoadmapTask,
  type ProjectId,
  type RoadmapMutationClassification,
  type RoadmapMutationBatchRequest,
  type RoadmapMutationOperation,
  type RoadmapMutationRequest,
  type RoadmapRevisionProposal,
} from "@densa-ade/protocol";

import type { PersistedEvent } from "./event-publisher.js";
import type { DensaAdeDatabase } from "./persistence/database.js";
import type { PortableSyncResult } from "./persistence/portable-project.js";
import {
  PermissionPolicyService,
  assertAuthorizedOperation,
  type AuthorizedOperationContext,
} from "./permission-policy.js";

const CLASSIFICATION_RANK: Readonly<Record<RoadmapMutationClassification, number>> = {
  minor: 0,
  significant: 1,
  scope: 2,
};

const MINIMUM_CLASSIFICATION: Readonly<
  Record<RoadmapMutationOperation["kind"], RoadmapMutationClassification>
> = {
  add_task: "minor",
  split_task: "minor",
  reorder_task: "minor",
  change_dependency: "minor",
  modify_acceptance_criteria: "minor",
  add_phase: "significant",
  remove_phase: "scope",
  change_architecture_task_details: "significant",
  mark_task_superseded: "scope",
};

export interface RoadmapMutationPolicy {
  readonly executionMode: ExecutionMode;
  readonly allowSignificantAutoApply: boolean;
}

export interface RoadmapMutationImpact {
  readonly roadmap: MasterRoadmap;
  readonly affectedPhaseIds: readonly string[];
  readonly affectedTaskIds: readonly string[];
}

export interface RoadmapMutationResult extends RoadmapMutationImpact {
  readonly classification: RoadmapMutationClassification;
  readonly revisionNumber: number;
  readonly event: PersistedEvent;
  readonly portableSync: RoadmapPortableSyncOutcome;
}

export interface RoadmapMutationBatchPreview extends RoadmapMutationImpact {
  readonly classification: RoadmapMutationClassification;
  readonly operationClassifications: readonly RoadmapMutationClassification[];
}

export interface RoadmapMutationBatchResult extends RoadmapMutationResult {
  readonly operations: readonly RoadmapMutationOperation[];
  readonly proposal?: RoadmapRevisionProposal;
}

export interface RoadmapMutationProposalResolution {
  readonly proposal: RoadmapRevisionProposal;
  readonly expectedStatus: RoadmapRevisionProposal["status"];
}

export interface RoadmapPortableSyncFailure {
  readonly status: "failed";
  readonly code: "PERSISTENCE_FAILURE" | "WORKSPACE_CONFLICT";
  readonly message: string;
}

export type RoadmapPortableSyncOutcome = PortableSyncResult | RoadmapPortableSyncFailure;

export interface RoadmapMutationServiceOptions {
  readonly workspacePath: string;
  readonly now?: () => string;
  readonly revisionIdFactory?: () => string;
  readonly eventIdFactory?: () => string;
}

export class RoadmapMutationError extends Error {
  readonly code: "USER_CONFIGURATION_ERROR" | "INTERNAL_INVARIANT_VIOLATION";

  constructor(code: RoadmapMutationError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RoadmapMutationError";
    this.code = code;
  }
}

function invalid(message: string, options?: ErrorOptions): RoadmapMutationError {
  return new RoadmapMutationError("USER_CONFIGURATION_ERROR", message, options);
}

function cloneRoadmap(roadmap: MasterRoadmap): MasterRoadmap {
  return masterRoadmapSchema.parse(JSON.parse(JSON.stringify(roadmap)));
}

function findTask(
  roadmap: MasterRoadmap,
  taskId: string,
): { readonly phaseIndex: number; readonly taskIndex: number; readonly task: MasterRoadmapTask } {
  for (const [phaseIndex, phase] of roadmap.phases.entries()) {
    const taskIndex = phase.tasks.findIndex((task) => task.id === taskId);
    const task = phase.tasks[taskIndex];
    if (taskIndex !== -1 && task !== undefined) return { phaseIndex, taskIndex, task };
  }
  throw invalid(`Roadmap mutation references missing task ${taskId}`);
}

function findPhaseIndex(roadmap: MasterRoadmap, phaseId: string): number {
  const index = roadmap.phases.findIndex((phase) => phase.id === phaseId);
  if (index === -1) throw invalid(`Roadmap mutation references missing phase ${phaseId}`);
  return index;
}

function replacePhase(
  roadmap: MasterRoadmap,
  phaseIndex: number,
  phase: MasterRoadmapPhase,
): MasterRoadmap {
  return {
    ...roadmap,
    phases: roadmap.phases.map((candidate, index) => (index === phaseIndex ? phase : candidate)),
  };
}

function replaceTask(
  roadmap: MasterRoadmap,
  phaseIndex: number,
  taskIndex: number,
  task: MasterRoadmapTask,
): MasterRoadmap {
  const phase = roadmap.phases[phaseIndex];
  if (phase === undefined) throw invalid(`Roadmap phase index ${phaseIndex} is unavailable`);
  return replacePhase(roadmap, phaseIndex, {
    ...phase,
    tasks: phase.tasks.map((candidate, index) => (index === taskIndex ? task : candidate)),
  });
}

function assertInsertPosition(position: number, length: number, target: string): void {
  if (position > length) {
    throw invalid(`Roadmap mutation position ${position} exceeds ${target} length ${length}`);
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function highestClassification(
  values: readonly RoadmapMutationClassification[],
): RoadmapMutationClassification {
  return values.reduce<RoadmapMutationClassification>(
    (highest, value) =>
      CLASSIFICATION_RANK[value] > CLASSIFICATION_RANK[highest] ? value : highest,
    "minor",
  );
}

function validateMutationResult(roadmap: MasterRoadmap): MasterRoadmap {
  const result = masterRoadmapSchema.safeParse(roadmap);
  if (!result.success) {
    const details = result.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join(".") || "roadmap"}: ${issue.message}`)
      .join("; ");
    throw invalid(`Roadmap mutation would make the dependency graph invalid: ${details}`, {
      cause: result.error,
    });
  }
  return result.data;
}

/** Applies one operation in memory and rejects the complete result unless it remains graph-valid. */
export function applyRoadmapMutation(
  input: MasterRoadmap,
  operationInput: RoadmapMutationOperation,
): RoadmapMutationImpact {
  const operation = roadmapMutationOperationSchema.parse(operationInput);
  let roadmap = cloneRoadmap(input);
  let affectedPhaseIds: readonly string[] = [];
  let affectedTaskIds: readonly string[] = [];

  switch (operation.kind) {
    case "add_task": {
      const phaseIndex = findPhaseIndex(roadmap, operation.phaseId);
      const phase = roadmap.phases[phaseIndex];
      if (phase === undefined) throw invalid(`Roadmap phase ${operation.phaseId} is unavailable`);
      assertInsertPosition(operation.position, phase.tasks.length, `phase ${phase.id}`);
      const tasks = [...phase.tasks];
      tasks.splice(operation.position, 0, operation.task);
      roadmap = replacePhase(roadmap, phaseIndex, { ...phase, tasks });
      affectedPhaseIds = [phase.id];
      affectedTaskIds = [operation.task.id];
      break;
    }
    case "split_task": {
      const source = findTask(roadmap, operation.taskId);
      if (operation.replacementTasks.some((task) => task.id === operation.taskId)) {
        throw invalid(`Split task replacements must not reuse source ID ${operation.taskId}`);
      }
      const sourcePhase = roadmap.phases[source.phaseIndex];
      if (sourcePhase === undefined) throw invalid(`Source task phase is unavailable`);
      const replacementIds = operation.replacementTasks.map((task) => task.id);
      const sourceTasks = [...sourcePhase.tasks];
      sourceTasks.splice(source.taskIndex, 1, ...operation.replacementTasks);
      roadmap = replacePhase(roadmap, source.phaseIndex, { ...sourcePhase, tasks: sourceTasks });
      const dependents: string[] = [];
      const dependentPhaseIds: string[] = [];
      roadmap = {
        ...roadmap,
        phases: roadmap.phases.map((phase) => ({
          ...phase,
          tasks: phase.tasks.map((task) => {
            const replacesDependency = task.dependencyIds.includes(operation.taskId);
            const replacesSupersedingTask = (task.supersededByTaskIds ?? []).includes(
              operation.taskId,
            );
            if (!replacesDependency && !replacesSupersedingTask) return task;
            dependents.push(task.id);
            dependentPhaseIds.push(phase.id);
            return {
              ...task,
              dependencyIds: replacesDependency
                ? unique(
                    task.dependencyIds.flatMap((id) =>
                      id === operation.taskId ? replacementIds : [id],
                    ),
                  )
                : task.dependencyIds,
              ...(replacesSupersedingTask
                ? {
                    supersededByTaskIds: unique(
                      (task.supersededByTaskIds ?? []).flatMap((id) =>
                        id === operation.taskId ? replacementIds : [id],
                      ),
                    ),
                  }
                : {}),
            };
          }),
        })),
      };
      affectedPhaseIds = [sourcePhase.id, ...dependentPhaseIds];
      affectedTaskIds = [operation.taskId, ...replacementIds, ...dependents];
      break;
    }
    case "reorder_task": {
      const source = findTask(roadmap, operation.taskId);
      const sourcePhase = roadmap.phases[source.phaseIndex];
      const targetPhaseIndex = findPhaseIndex(roadmap, operation.phaseId);
      const targetPhase = roadmap.phases[targetPhaseIndex];
      if (sourcePhase === undefined || targetPhase === undefined) {
        throw invalid("Roadmap task reorder phase is unavailable");
      }
      const sourceTasks = sourcePhase.tasks.filter((_, index) => index !== source.taskIndex);
      const targetTasks =
        source.phaseIndex === targetPhaseIndex ? sourceTasks : [...targetPhase.tasks];
      assertInsertPosition(operation.position, targetTasks.length, `phase ${targetPhase.id}`);
      targetTasks.splice(operation.position, 0, source.task);
      const phases = [...roadmap.phases];
      phases[source.phaseIndex] = { ...sourcePhase, tasks: sourceTasks };
      phases[targetPhaseIndex] = { ...targetPhase, tasks: targetTasks };
      roadmap = { ...roadmap, phases };
      affectedPhaseIds = unique([sourcePhase.id, targetPhase.id]);
      affectedTaskIds = [source.task.id];
      break;
    }
    case "change_dependency": {
      const found = findTask(roadmap, operation.taskId);
      const phase = roadmap.phases[found.phaseIndex];
      if (phase === undefined) throw invalid("Dependency task phase is unavailable");
      roadmap = replaceTask(roadmap, found.phaseIndex, found.taskIndex, {
        ...found.task,
        dependencyIds: operation.dependencyIds,
      });
      affectedPhaseIds = [phase.id];
      affectedTaskIds = unique([
        found.task.id,
        ...found.task.dependencyIds,
        ...operation.dependencyIds,
      ]);
      break;
    }
    case "modify_acceptance_criteria": {
      const found = findTask(roadmap, operation.taskId);
      const phase = roadmap.phases[found.phaseIndex];
      if (phase === undefined) throw invalid("Acceptance task phase is unavailable");
      roadmap = replaceTask(roadmap, found.phaseIndex, found.taskIndex, {
        ...found.task,
        acceptanceCriteria: operation.acceptanceCriteria,
      });
      affectedPhaseIds = [phase.id];
      affectedTaskIds = [found.task.id];
      break;
    }
    case "add_phase": {
      assertInsertPosition(operation.position, roadmap.phases.length, "roadmap phase list");
      const phases = [...roadmap.phases];
      phases.splice(operation.position, 0, operation.phase);
      roadmap = { ...roadmap, phases };
      affectedPhaseIds = [operation.phase.id];
      affectedTaskIds = operation.phase.tasks.map((task) => task.id);
      break;
    }
    case "remove_phase": {
      const phaseIndex = findPhaseIndex(roadmap, operation.phaseId);
      const phase = roadmap.phases[phaseIndex];
      if (phase === undefined) throw invalid("Removed roadmap phase is unavailable");
      roadmap = {
        ...roadmap,
        phases: roadmap.phases.filter((_, index) => index !== phaseIndex),
      };
      affectedPhaseIds = [phase.id];
      affectedTaskIds = phase.tasks.map((task) => task.id);
      break;
    }
    case "change_architecture_task_details": {
      const found = findTask(roadmap, operation.taskId);
      const phase = roadmap.phases[found.phaseIndex];
      if (phase === undefined) throw invalid("Architecture task phase is unavailable");
      roadmap = replaceTask(roadmap, found.phaseIndex, found.taskIndex, {
        ...found.task,
        ...(operation.title === undefined ? {} : { title: operation.title }),
        ...(operation.goal === undefined ? {} : { goal: operation.goal }),
        ...(operation.riskLevel === undefined ? {} : { riskLevel: operation.riskLevel }),
        ...(operation.expectedValidators === undefined
          ? {}
          : { expectedValidators: operation.expectedValidators }),
      });
      affectedPhaseIds = [phase.id];
      affectedTaskIds = [found.task.id];
      break;
    }
    case "mark_task_superseded": {
      const found = findTask(roadmap, operation.taskId);
      const phase = roadmap.phases[found.phaseIndex];
      if (phase === undefined) throw invalid("Superseded task phase is unavailable");
      roadmap = replaceTask(roadmap, found.phaseIndex, found.taskIndex, {
        ...found.task,
        executable: false,
        supersededByTaskIds: operation.supersededByTaskIds,
      });
      const dependents: string[] = [];
      const dependentPhaseIds: string[] = [];
      roadmap = {
        ...roadmap,
        phases: roadmap.phases.map((candidatePhase) => ({
          ...candidatePhase,
          tasks: candidatePhase.tasks.map((task) => {
            if (!task.dependencyIds.includes(operation.taskId)) return task;
            dependents.push(task.id);
            dependentPhaseIds.push(candidatePhase.id);
            return {
              ...task,
              dependencyIds: unique(
                task.dependencyIds.flatMap((id) =>
                  id === operation.taskId ? operation.supersededByTaskIds : [id],
                ),
              ),
            };
          }),
        })),
      };
      affectedPhaseIds = [phase.id, ...dependentPhaseIds];
      affectedTaskIds = [found.task.id, ...operation.supersededByTaskIds, ...dependents];
      break;
    }
  }

  return Object.freeze({
    roadmap: validateMutationResult(roadmap),
    affectedPhaseIds: unique(affectedPhaseIds),
    affectedTaskIds: unique(affectedTaskIds),
  });
}

/** Previews a complete operation batch; every intermediate and final graph must remain valid. */
export function previewRoadmapMutations(
  input: MasterRoadmap,
  operationInputs: readonly RoadmapMutationOperation[],
  proposed?: RoadmapMutationClassification,
): RoadmapMutationBatchPreview {
  if (operationInputs.length === 0 || operationInputs.length > 32) {
    throw invalid("Roadmap revision proposals require between 1 and 32 operations");
  }
  let roadmap = cloneRoadmap(input);
  const affectedPhaseIds: string[] = [];
  const affectedTaskIds: string[] = [];
  const operationClassifications: RoadmapMutationClassification[] = [];
  for (const operationInput of operationInputs) {
    const operation = roadmapMutationOperationSchema.parse(operationInput);
    operationClassifications.push(classifyAgainstCurrentRoadmap(roadmap, operation));
    const impact = applyRoadmapMutation(roadmap, operation);
    roadmap = impact.roadmap;
    affectedPhaseIds.push(...impact.affectedPhaseIds);
    affectedTaskIds.push(...impact.affectedTaskIds);
  }
  const minimum = highestClassification(operationClassifications);
  if (proposed !== undefined && CLASSIFICATION_RANK[proposed] < CLASSIFICATION_RANK[minimum]) {
    throw invalid(
      `Roadmap revision requires at least ${minimum.toUpperCase()} classification; received ${proposed.toUpperCase()}`,
    );
  }
  if (JSON.stringify(roadmap) === JSON.stringify(input)) {
    throw invalid("Roadmap revision proposal did not change the authoritative roadmap");
  }
  return Object.freeze({
    roadmap,
    affectedPhaseIds: unique(affectedPhaseIds),
    affectedTaskIds: unique(affectedTaskIds),
    classification: proposed ?? minimum,
    operationClassifications: Object.freeze([...operationClassifications]),
  });
}

export function classifyRoadmapMutation(
  operation: RoadmapMutationOperation,
  proposed?: RoadmapMutationClassification,
): RoadmapMutationClassification {
  const minimum = MINIMUM_CLASSIFICATION[operation.kind];
  if (proposed !== undefined && CLASSIFICATION_RANK[proposed] < CLASSIFICATION_RANK[minimum]) {
    throw invalid(
      `${operation.kind} requires at least ${minimum.toUpperCase()} classification; received ${proposed.toUpperCase()}`,
    );
  }
  return proposed ?? minimum;
}

function classifyAgainstCurrentRoadmap(
  roadmap: MasterRoadmap,
  operation: RoadmapMutationOperation,
  proposed?: RoadmapMutationClassification,
): RoadmapMutationClassification {
  let semanticMinimum = MINIMUM_CLASSIFICATION[operation.kind];
  if (operation.kind === "modify_acceptance_criteria") {
    const existing = findTask(roadmap, operation.taskId).task.acceptanceCriteria;
    if (existing.some((criterion) => !operation.acceptanceCriteria.includes(criterion))) {
      semanticMinimum = "scope";
    }
  }
  if (
    proposed !== undefined &&
    CLASSIFICATION_RANK[proposed] < CLASSIFICATION_RANK[semanticMinimum]
  ) {
    throw invalid(
      `${operation.kind} requires at least ${semanticMinimum.toUpperCase()} classification for this change; received ${proposed.toUpperCase()}`,
    );
  }
  return proposed ?? semanticMinimum;
}

export function assertRoadmapMutationPolicy(
  classification: RoadmapMutationClassification,
  request: RoadmapMutationRequest,
  policy: RoadmapMutationPolicy,
): void {
  if (request.applicationMode === "approved") return;
  if (classification === "scope") {
    throw invalid(
      `SCOPE roadmap mutations require explicit user approval in ${policy.executionMode} mode`,
    );
  }
  if (classification === "significant" && !policy.allowSignificantAutoApply) {
    throw invalid(
      "SIGNIFICANT roadmap mutations require approval unless user policy explicitly allows automatic application",
    );
  }
}

/** Authoritative Core boundary for policy-checked, durable, inspectable roadmap evolution. */
export class RoadmapMutationService {
  readonly #now: () => string;
  readonly #revisionIdFactory: () => string;
  readonly #eventIdFactory: () => string;

  constructor(
    private readonly database: DensaAdeDatabase,
    private readonly options: RoadmapMutationServiceOptions,
  ) {
    if (options.workspacePath.trim().length === 0) {
      throw invalid("Roadmap mutation workspace path must not be empty");
    }
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#revisionIdFactory =
      options.revisionIdFactory ?? (() => `roadmap-revision-${randomUUID()}`);
    this.#eventIdFactory = options.eventIdFactory ?? (() => `event-${randomUUID()}`);
  }

  async storeInitialRoadmap(
    projectId: string,
    input: MasterRoadmap,
  ): Promise<{
    readonly roadmap: MasterRoadmap;
    readonly portableSync: RoadmapPortableSyncOutcome;
  }> {
    const parsedProjectId = projectIdSchema.parse(projectId);
    const project = this.database.repositories.projects.findById(parsedProjectId);
    if (project === undefined)
      throw invalid(`Cannot store a roadmap for missing project ${projectId}`);
    const roadmap = masterRoadmapSchema.parse(input);
    const specification = this.database.repositories.specifications.findByProjectId(project.id);
    if (specification === undefined) {
      throw invalid(
        `Cannot store a master roadmap before project ${projectId} has a specification`,
      );
    }
    if (roadmap.projectGoal !== specification.specification.projectGoal) {
      throw invalid("Authoritative master roadmap changed the exact project specification goal");
    }
    const now = isoTimestampSchema.parse(this.#now());
    const permission = new PermissionPolicyService(this.database).authorize({
      projectId: project.id,
      operation: "write_workspace",
      actor: "densa-core:roadmap-initializer",
      reason: "Persist the initial authoritative roadmap and portable projection",
      occurredAt: now,
    });
    if (permission.authorization === undefined) {
      throw invalid(
        `Initial roadmap persistence requires user authorization: ${permission.decision.disposition}`,
      );
    }
    this.database.persistInitialMasterRoadmap({
      projectId: project.id,
      roadmap,
      revisionNumber: 0,
      createdAt: now,
      updatedAt: now,
    });
    const portableSync = await this.#synchronize(project.id, permission.authorization);
    return Object.freeze({ roadmap, portableSync });
  }

  async apply(projectId: string, input: RoadmapMutationRequest): Promise<RoadmapMutationResult> {
    const request = roadmapMutationRequestSchema.parse(input);
    const result = await this.applyBatch(projectId, {
      operations: [request.operation],
      ...(request.classification === undefined ? {} : { classification: request.classification }),
      rationale: request.rationale,
      actor: request.actor,
      sessionId: request.sessionId,
      applicationMode: request.applicationMode,
      ...(request.approval === undefined ? {} : { approval: request.approval }),
    });
    return Object.freeze({
      roadmap: result.roadmap,
      affectedPhaseIds: result.affectedPhaseIds,
      affectedTaskIds: result.affectedTaskIds,
      classification: result.classification,
      revisionNumber: result.revisionNumber,
      event: result.event,
      portableSync: result.portableSync,
    });
  }

  preview(
    projectId: string,
    operations: readonly RoadmapMutationOperation[],
    classification?: RoadmapMutationClassification,
  ): Readonly<{ baseRevisionNumber: number; before: MasterRoadmap }> & RoadmapMutationBatchPreview {
    const parsedProjectId = projectIdSchema.parse(projectId);
    const project = this.database.repositories.projects.findById(parsedProjectId);
    if (project === undefined)
      throw invalid(`Cannot preview a roadmap for missing project ${projectId}`);
    const current = this.database.repositories.masterRoadmaps.findByProjectId(project.id);
    if (current === undefined)
      throw invalid(`Project ${projectId} has no authoritative master roadmap`);
    return Object.freeze({
      baseRevisionNumber: current.revisionNumber,
      before: current.roadmap,
      ...previewRoadmapMutations(current.roadmap, operations, classification),
    });
  }

  async applyBatch(
    projectId: string,
    input: RoadmapMutationBatchRequest,
    proposalResolution?: RoadmapMutationProposalResolution,
  ): Promise<RoadmapMutationBatchResult> {
    const request = roadmapMutationBatchRequestSchema.parse(input);
    const parsedProjectId = projectIdSchema.parse(projectId);
    const project = this.database.repositories.projects.findById(parsedProjectId);
    if (project === undefined)
      throw invalid(`Cannot mutate a roadmap for missing project ${projectId}`);
    const current = this.database.repositories.masterRoadmaps.findByProjectId(project.id);
    if (current === undefined)
      throw invalid(`Project ${projectId} has no authoritative master roadmap`);
    const impact = previewRoadmapMutations(
      current.roadmap,
      request.operations,
      request.classification,
    );
    const classification = impact.classification;
    if (proposalResolution !== undefined) {
      const proposal = proposalResolution.proposal;
      if (
        proposal.projectId !== project.id ||
        proposal.baseRevisionNumber !== current.revisionNumber ||
        request.proposalEventId !== proposal.proposalEventId ||
        proposal.classification !== classification ||
        proposal.rationale !== request.rationale ||
        JSON.stringify(proposal.operations) !== JSON.stringify(request.operations) ||
        JSON.stringify(proposal.beforeValue) !== JSON.stringify(current.roadmap) ||
        JSON.stringify(proposal.afterValue) !== JSON.stringify(impact.roadmap)
      ) {
        throw invalid("Roadmap proposal resolution does not match the inspected base and result");
      }
    }
    if (request.approval !== undefined) {
      const approvalDecision = this.database.repositories.decisions.findById(
        request.approval.decisionId,
      );
      if (approvalDecision?.projectId !== project.id) {
        throw invalid(
          `Roadmap mutation approval decision ${request.approval.decisionId} is not recorded for project ${project.id}`,
        );
      }
    }
    const now = isoTimestampSchema.parse(this.#now());
    const policy = new PermissionPolicyService(this.database);
    const workspacePermission = policy.authorize({
      projectId: project.id,
      operation: "write_workspace",
      actor: request.actor,
      reason: request.rationale,
      occurredAt: now,
      ...(request.approval === undefined
        ? {}
        : { approvalDecisionId: request.approval.decisionId }),
    });
    if (workspacePermission.authorization === undefined) {
      throw invalid(
        `Roadmap workspace mutation requires user authorization: ${workspacePermission.decision.disposition}`,
      );
    }
    if (classification !== "minor") {
      const classifiedPermission = policy.authorize({
        projectId: project.id,
        operation:
          classification === "scope" ? "roadmap_scope_change" : "roadmap_significant_change",
        actor: request.actor,
        reason: request.rationale,
        occurredAt: now,
        ...(request.approval === undefined
          ? {}
          : { approvalDecisionId: request.approval.decisionId }),
      });
      if (classifiedPermission.authorization === undefined) {
        if (
          classification === "scope" &&
          classifiedPermission.decision.disposition === "ask_user"
        ) {
          throw invalid(
            `SCOPE roadmap mutations require explicit user approval in ${project.executionMode} mode`,
          );
        }
        if (
          classification === "significant" &&
          classifiedPermission.decision.disposition === "ask_user"
        ) {
          throw invalid(
            "SIGNIFICANT roadmap mutations require approval unless user policy explicitly allows automatic application",
          );
        }
        throw invalid(
          `${classification.toUpperCase()} roadmap mutation denied by permission policy`,
        );
      }
      assertAuthorizedOperation(
        classifiedPermission.authorization,
        project.id,
        classification === "scope" ? "roadmap_scope_change" : "roadmap_significant_change",
      );
    }
    const revisionId = roadmapRevisionIdSchema.parse(this.#revisionIdFactory());
    const eventId = eventIdSchema.parse(this.#eventIdFactory());
    const revision = roadmapRevisionSchema.parse({
      id: revisionId,
      projectId: project.id,
      classification,
      reason: request.rationale,
      actor: request.actor,
      sessionId: request.sessionId,
      createdAt: now,
      affectedPhaseIds: impact.affectedPhaseIds.map((id) => phaseIdSchema.parse(id)),
      affectedTaskIds: impact.affectedTaskIds.map((id) => taskIdSchema.parse(id)),
      oldValue: jsonObjectSchema.parse(current.roadmap),
      newValue: jsonObjectSchema.parse(impact.roadmap),
      ...(request.operations.length === 1
        ? { operation: request.operations[0] }
        : { operations: request.operations }),
      ...(request.approval === undefined ? {} : { approval: request.approval }),
    });
    const event = eventSchema.parse({
      id: eventId,
      projectId: project.id,
      type: "ROADMAP_CHANGED",
      eventVersion: 1,
      occurredAt: now,
      actor: request.actor,
      payload: {
        revisionId,
        revisionNumber: current.revisionNumber + 1,
        classification,
        ...(request.operations.length === 1
          ? { operation: request.operations[0]?.kind ?? "unknown" }
          : { operations: request.operations.map(({ kind }) => kind) }),
        rationale: request.rationale,
        sessionId: request.sessionId,
        executionMode: project.executionMode,
        applicationMode: request.applicationMode,
        affectedPhaseIds: [...impact.affectedPhaseIds],
        affectedTaskIds: [...impact.affectedTaskIds],
        ...(request.approval === undefined
          ? {}
          : { approvalDecisionId: request.approval.decisionId }),
        ...(request.proposalEventId === undefined
          ? {}
          : { proposalEventId: request.proposalEventId }),
      },
    });
    const resolvedProposal =
      proposalResolution === undefined
        ? undefined
        : {
            ...proposalResolution.proposal,
            status: "applied" as const,
            activeTaskIds: [],
            updatedAt: now,
            resolvedAt: now,
            ...(request.approval === undefined
              ? {}
              : { approvalDecisionId: request.approval.decisionId }),
            appliedRevisionId: revisionId,
          };
    const persistedEvent = this.database.persistRoadmapMutation({
      expectedRevisionNumber: current.revisionNumber,
      roadmap: {
        ...current,
        roadmap: impact.roadmap,
        revisionNumber: current.revisionNumber + 1,
        updatedAt: now,
      },
      revision,
      event,
      ...(resolvedProposal === undefined
        ? {}
        : {
            proposalResolution: {
              proposal: resolvedProposal,
              expectedStatus: proposalResolution?.expectedStatus ?? "ready_to_apply",
            },
          }),
    });
    const portableSync = await this.#synchronize(project.id, workspacePermission.authorization);
    return Object.freeze({
      ...impact,
      classification,
      revisionNumber: current.revisionNumber + 1,
      event: persistedEvent,
      portableSync,
      operations: Object.freeze([...request.operations]),
      ...(resolvedProposal === undefined ? {} : { proposal: resolvedProposal }),
    });
  }

  async #synchronize(
    projectId: ProjectId,
    authorization: AuthorizedOperationContext,
  ): Promise<RoadmapPortableSyncOutcome> {
    assertAuthorizedOperation(authorization, projectId, "write_workspace");
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
      const message =
        error instanceof Error
          ? error.message
          : "Portable roadmap regeneration failed after the authoritative commit";
      return Object.freeze({ status: "failed", code, message });
    }
  }
}
