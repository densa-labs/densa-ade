import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  eventIdSchema,
  executionModeSchema,
  isoTimestampSchema,
  keepAwakeBatteryPolicySchema,
  masterAgentProposalSchema,
  masterRoadmapSchema,
  permissionPolicyConfigurationSchema,
  phaseIdSchema,
  projectIdSchema,
  projectSpecificationSchema,
  taskIdSchema,
  type CoreV1Method,
  type MasterRoadmap,
  type PhaseId,
  type ProjectId,
} from "@densa-ade/protocol";
import type { KeepAwakeManager } from "./keep-awake.js";
import { ExecutionModeService } from "./execution-modes.js";
import { DatabaseMasterProjectContextReader } from "./master-agent.js";
import { assertSpecificationReady } from "./master-roadmap.js";
import { PermissionPolicyService } from "./permission-policy.js";
import { ProjectDecisionService } from "./project-decisions.js";
import { RoadmapMutationService } from "./roadmap-mutations.js";
import { MasterRoadmapRevisionWorkflow } from "./roadmap-revision-workflow.js";
import { ProjectRundownService, renderProjectRundown } from "./rundown.js";
import { redactSensitiveText } from "./secret-redaction.js";
import { stateTransitionService } from "./state-transitions.js";
import { CoreRuntimeError, CoreRuntimeStore, canonicalWorkspace } from "./core-runtime-state.js";
import type { CoreRuntimeViews } from "./core-runtime-views.js";
import type { DensaAdeDatabase } from "./persistence/database.js";

function nowIso(now: () => string): string {
  return isoTimestampSchema.parse(now());
}

function cleanActor(actor: string): string {
  const cleaned = redactSensitiveText(actor).trim();
  if (cleaned.length === 0 || cleaned.length > 256) {
    throw new CoreRuntimeError("USER_CONFIGURATION_ERROR", "Actor must contain 1-256 characters");
  }
  return cleaned;
}

function cleanReason(reason: string): string {
  const cleaned = redactSensitiveText(reason).trim();
  if (cleaned.length === 0 || Buffer.byteLength(cleaned, "utf8") > 64 * 1024) {
    throw new CoreRuntimeError("USER_CONFIGURATION_ERROR", "Reason must contain bounded text");
  }
  return cleaned;
}

function sanitizeId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

async function ensureWorkspace(path: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw new CoreRuntimeError("USER_CONFIGURATION_ERROR", "Workspace must be absolute");
  }
  const resolved = resolve(path);
  await mkdir(resolved, { recursive: true });
  return await canonicalWorkspace(resolved);
}

function deterministicRoadmap(
  projectId: ProjectId,
  goal: string,
  features: readonly string[],
): MasterRoadmap {
  const safeGoal = goal.trim();
  if (safeGoal.length === 0) {
    throw new CoreRuntimeError("USER_CONFIGURATION_ERROR", "Project goal must not be empty");
  }
  const items = features.filter((f) => f.trim().length > 0);
  const tasks = (items.length > 0 ? items : [safeGoal]).map((feature, index) => {
    const id = `${String(projectId)}-task-${String(index + 1)}`.replace(/[^A-Za-z0-9._-]+/gu, "-");
    return {
      id,
      title: feature.slice(0, 120).trim() || `Task ${String(index + 1)}`,
      goal: feature.trim(),
      executable: true as const,
      dependencyIds:
        index === 0
          ? []
          : [`${String(projectId)}-task-${String(index)}`.replace(/[^A-Za-z0-9._-]+/gu, "-")],
      acceptanceCriteria: [feature.trim()],
      riskLevel: "low" as const,
      expectedValidators: ["unit_test" as const],
    };
  });
  const phaseId = `${String(projectId)}-phase-1`.replace(/[^A-Za-z0-9._-]+/gu, "-");
  return masterRoadmapSchema.parse({
    formatVersion: 1,
    projectGoal: safeGoal,
    phases: [
      {
        id: phaseId,
        title: "Phase 1 — Deliver the specified scope",
        goal: safeGoal,
        required: true,
        completionCriteria: ["Every task completes with passing validation"],
        tasks,
      },
    ],
  });
}

/** Production mutation boundary for every state-changing Core v1 operation. */
export class CoreRuntimeMutations {
  constructor(
    readonly store: CoreRuntimeStore,
    readonly views: CoreRuntimeViews,
    readonly keepAwake: KeepAwakeManager,
    readonly now: () => string,
    readonly instanceId: string,
  ) {}

  get db(): DensaAdeDatabase {
    return this.store.database;
  }

  async createProject(input: {
    name: string;
    workspacePath: string;
    idea: string;
    executionMode: string;
    actor: string;
  }): Promise<unknown> {
    const actor = cleanActor(input.actor);
    const name = redactSensitiveText(input.name).trim();
    if (name.length === 0 || name.length > 256) {
      throw new CoreRuntimeError(
        "USER_CONFIGURATION_ERROR",
        "Project name must contain 1-256 characters",
      );
    }
    const idea = redactSensitiveText(input.idea).trim();
    if (idea.length === 0 || Buffer.byteLength(idea, "utf8") > 64 * 1024) {
      throw new CoreRuntimeError(
        "USER_CONFIGURATION_ERROR",
        "Project idea must contain bounded text",
      );
    }
    const executionMode = executionModeSchema.parse(input.executionMode);
    const workspacePath = await ensureWorkspace(input.workspacePath);
    const occurredAt = nowIso(this.now);
    const projectId = projectIdSchema.parse(sanitizeId("project"));
    const project = {
      id: projectId,
      name,
      state: "DRAFT" as const,
      executionMode,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    };
    this.db.repositories.projects.create(project as never);
    this.store.write(projectId, {
      formatVersion: 1,
      workspacePath,
      initialIdea: idea,
      actor,
      initialization: "pending",
    });
    this.store.transition(
      projectId,
      "PLANNING",
      actor,
      "Core v1 project creation entered planning",
    );
    const specification = projectSpecificationSchema.parse({
      formatVersion: 1,
      projectGoal: idea,
      targetUsers: [],
      coreUserJourneys: [],
      requiredFeatures: [],
      nonGoals: [],
      architectureConstraints: [],
      platformRuntimeConstraints: [],
      integrations: [],
      dataStorageNeeds: [],
      securityPrivacyRequirements: [],
      uxConstraints: [],
      deploymentIntent: [],
      explicitUserDecisions: [],
      unresolvedQuestions: [],
    });
    this.db.repositories.specifications.set({
      projectId,
      specification,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    });
    this.store.event(projectId, "PROJECT_CREATED", actor, {
      source: "core-v1",
      ideaAccepted: true,
    });
    const stored = this.store.project(projectId);
    return { project: stored, workspacePath, interviewQuestions: [] };
  }

  async answerInterview(input: {
    projectId: string;
    sessionId: string;
    answers: readonly { questionId: string; answer: string }[];
  }): Promise<unknown> {
    const id = this.store.project(input.projectId).id;
    const sessionId = redactSensitiveText(input.sessionId).trim();
    if (sessionId.length === 0)
      throw new CoreRuntimeError(
        "USER_CONFIGURATION_ERROR",
        "Interview session ID must not be empty",
      );
    if (input.answers.length === 0)
      throw new CoreRuntimeError("USER_CONFIGURATION_ERROR", "Interview answers must not be empty");
    const record = this.db.repositories.specifications.findByProjectId(id);
    if (record === undefined)
      throw new CoreRuntimeError("USER_CONFIGURATION_ERROR", "Project interview has not started");
    const occurredAt = nowIso(this.now);
    const unresolved = new Map(record.specification.unresolvedQuestions.map((q) => [q.id, q]));
    const explicit = [...record.specification.explicitUserDecisions];
    const seen = new Set(explicit.map((d) => d.questionId).filter(Boolean));
    for (const answer of input.answers) {
      const questionId = answer.questionId.trim();
      const text = redactSensitiveText(answer.answer).trim();
      if (questionId.length === 0 || text.length === 0) {
        throw new CoreRuntimeError(
          "USER_CONFIGURATION_ERROR",
          "Interview answers require IDs and text",
        );
      }
      if (seen.has(questionId)) {
        throw new CoreRuntimeError(
          "USER_CONFIGURATION_ERROR",
          `Question ${questionId} was answered more than once`,
        );
      }
      seen.add(questionId);
      const pending = unresolved.get(questionId);
      explicit.push({ topic: pending?.question ?? questionId, decision: text, questionId });
      unresolved.delete(questionId);
    }
    const specification = projectSpecificationSchema.parse({
      ...record.specification,
      explicitUserDecisions: explicit,
      unresolvedQuestions: [...unresolved.values()],
    });
    this.db.repositories.specifications.set({
      projectId: id,
      specification,
      createdAt: record.createdAt,
      updatedAt: occurredAt,
    });
    this.store.event(id, "INTERVIEW_ANSWERED", sessionId, { answerCount: input.answers.length });
    const blocking = specification.unresolvedQuestions.filter(
      (q) =>
        q.impact === "high" || (q.impact === "medium" && q.defaultCanBeUsedWithoutAnswer !== true),
    );
    const nextQuestions = specification.unresolvedQuestions.map((q) => ({
      id: q.id,
      question: q.question,
      category: q.category,
      impact: q.impact,
      batchKey: q.batchKey ?? q.id,
      ...(q.context === undefined ? {} : { context: q.context }),
      ...(q.proposedDefault === undefined ? {} : { proposedDefault: q.proposedDefault }),
      ...(q.defaultRationale === undefined ? {} : { defaultRationale: q.defaultRationale }),
      ...(q.defaultCanBeUsedWithoutAnswer === undefined
        ? {}
        : { defaultCanBeUsedWithoutAnswer: q.defaultCanBeUsedWithoutAnswer }),
    }));
    return { projectId: id, specification, nextQuestions, readyForRoadmap: blocking.length === 0 };
  }

  async generateRoadmap(input: {
    projectId: string;
    sessionId: string;
    actor: string;
  }): Promise<unknown> {
    const id = this.store.project(input.projectId).id;
    const actor = cleanActor(input.actor);
    const sessionId = redactSensitiveText(input.sessionId).trim();
    if (sessionId.length === 0)
      throw new CoreRuntimeError("USER_CONFIGURATION_ERROR", "Session ID must not be empty");
    const existing = this.db.repositories.masterRoadmaps.findByProjectId(id);
    if (existing !== undefined) return existing;
    const specRecord = this.db.repositories.specifications.findByProjectId(id);
    if (specRecord === undefined)
      throw new CoreRuntimeError("USER_CONFIGURATION_ERROR", "Project interview has not completed");
    assertSpecificationReady(specRecord.specification);
    const workspacePath = this.store.state(id).workspacePath;
    const roadmap = deterministicRoadmap(
      id,
      specRecord.specification.projectGoal,
      specRecord.specification.requiredFeatures,
    );
    const service = new RoadmapMutationService(this.db, { workspacePath, now: this.now });
    await service.storeInitialRoadmap(String(id), roadmap);
    const project = this.store.project(id);
    if (project.state === "PLANNING") {
      this.store.transition(id, "READY", actor, "Core v1 roadmap generation completed planning");
    }
    this.store.event(id, "ROADMAP_GENERATED", actor, {
      phaseCount: roadmap.phases.length,
      sessionId,
    });
    const stored = this.db.repositories.masterRoadmaps.findByProjectId(id);
    if (stored === undefined)
      throw new CoreRuntimeError("PERSISTENCE_FAILURE", "Generated roadmap did not persist");
    return stored;
  }

  async startProject(input: {
    projectId: string;
    workspacePath: string;
    actor: string;
  }): Promise<unknown> {
    const id = this.store.project(input.projectId).id;
    const actor = cleanActor(input.actor);
    const workspacePath = await this.store.workspace(id, input.workspacePath);
    const roadmap = this.db.repositories.masterRoadmaps.findByProjectId(id);
    if (roadmap === undefined)
      throw new CoreRuntimeError("USER_CONFIGURATION_ERROR", "Project has no approved roadmap");
    const phases = this.db.repositories.phases
      .listByProjectId(id)
      .slice()
      .sort((a, b) => a.position - b.position);
    if (phases.length === 0)
      throw new CoreRuntimeError("PERSISTENCE_FAILURE", "Stored roadmap has no runtime phases");
    const first = phases[0];
    if (first === undefined)
      throw new CoreRuntimeError("PERSISTENCE_FAILURE", "First phase is missing");
    const occurredAt = nowIso(this.now);
    let project = this.store.project(id);
    if (project.state === "RUNNING") {
      return { projectId: id, state: "RUNNING" as const, firstPhaseId: first.id };
    }
    if (project.state === "PLANNING") {
      this.store.transition(id, "READY", actor, "Core v1 start completed planning");
    }
    if (first.state === "PENDING") {
      this.db.persistStateTransition(
        stateTransitionService.transitionPhase(first, "READY", {
          actor,
          occurredAt,
          reason: "Core v1 start made the first phase eligible",
        }),
        eventIdSchema.parse(`runtime-${randomUUID()}`),
      );
    }
    project = this.store.project(id);
    if (project.state === "READY") {
      this.store.transition(id, "RUNNING", actor, "Core v1 start entered execution");
      project = this.store.project(id);
    } else if (project.state === "WAITING_FOR_USER" || project.state === "BLOCKED") {
      return { projectId: id, state: project.state, firstPhaseId: first.id };
    } else if (project.state !== "RUNNING") {
      throw new CoreRuntimeError(
        "USER_CONFIGURATION_ERROR",
        `Project state ${project.state} cannot start execution`,
      );
    }
    const runtime = this.store.state(id);
    this.store.write(id, { ...runtime, executionRequested: true, initialization: "complete" });
    this.store.event(id, "PROJECT_STARTED", actor, { firstPhaseId: String(first.id) });
    void workspacePath;
    void occurredAt;
    return { projectId: id, state: project.state, firstPhaseId: first.id };
  }

  async proposeRevision(input: {
    projectId: string;
    baseRevisionNumber: number;
    operations: readonly unknown[];
    rationale: string;
    actor: string;
    sessionId: string;
  }): Promise<unknown> {
    const id = this.store.project(input.projectId).id;
    const actor = cleanActor(input.actor);
    const rationale = cleanReason(input.rationale);
    const sessionId = redactSensitiveText(input.sessionId).trim();
    if (sessionId.length === 0)
      throw new CoreRuntimeError("USER_CONFIGURATION_ERROR", "Session ID must not be empty");
    const workspacePath = this.store.state(id).workspacePath;
    const workflow = new MasterRoadmapRevisionWorkflow(this.db, { workspacePath, now: this.now });
    let result;
    try {
      result = await workflow.propose(id, {
        operations: input.operations as never,
        rationale,
        actor,
        sessionId,
      });
    } catch (error) {
      throw this.asRuntimeError(error);
    }
    return { proposal: result.proposal, outcome: result.status };
  }

  async resolveRevision(input: {
    projectId: string;
    proposalEventId: string;
    resolution: "approve" | "reject";
    rationale: string;
    actor: string;
    sessionId: string;
  }): Promise<unknown> {
    const id = this.store.project(input.projectId).id;
    const actor = cleanActor(input.actor);
    const rationale = cleanReason(input.rationale);
    const sessionId = redactSensitiveText(input.sessionId).trim();
    const workspacePath = this.store.state(id).workspacePath;
    const workflow = new MasterRoadmapRevisionWorkflow(this.db, { workspacePath, now: this.now });
    const proposal = this.db.repositories.roadmapRevisionProposals.findByEventId(
      input.proposalEventId as never,
    );
    if (proposal?.projectId !== id)
      throw new CoreRuntimeError(
        "USER_CONFIGURATION_ERROR",
        "Roadmap proposal does not exist in this project",
      );
    if (input.resolution === "reject") {
      try {
        const result = workflow.reject({
          proposalEventId: input.proposalEventId as never,
          actor,
          rationale,
        });
        const outcome =
          result.status === "REJECTED"
            ? "REJECTED"
            : result.status === "STALE"
              ? "STALE"
              : "REJECTED";
        return { proposal: result.proposal, outcome };
      } catch (error) {
        throw this.asRuntimeError(error);
      }
    }
    try {
      if (proposal.status === "applied") return { proposal, outcome: "APPLIED" as const };
      if (proposal.status === "rejected") return { proposal, outcome: "REJECTED" as const };
      if (proposal.status === "stale") return { proposal, outcome: "STALE" as const };
      if (proposal.approvalRequired && proposal.approvalDecisionId === undefined) {
        const decision = await new ProjectDecisionService(this.db, {
          workspacePath,
          now: this.now,
        }).record({
          projectId: id,
          kind: "decision",
          statement: `User approved roadmap revision proposal ${proposal.id}`,
          title: `Approve roadmap revision ${proposal.id}`,
          rationale,
          category: `roadmap.revision.approval.${proposal.id}`,
          source: "user",
          scope: "project",
          affectedPhaseIds: [...proposal.affectedPhaseIds] as never,
          affectedTaskIds: [...proposal.affectedTaskIds] as never,
          actor,
        });
        if (decision.status === "CONFLICT_REQUIRES_USER_DECISION") {
          throw new CoreRuntimeError(
            "USER_CONFIGURATION_ERROR",
            "Conflicting constraints require an explicit user decision",
          );
        }
        if (decision.status !== "UNCHANGED" && decision.status !== "RECORDED") {
          throw new CoreRuntimeError("PERSISTENCE_FAILURE", "Approval decision did not persist");
        }
        const approval = {
          decisionId: decision.decision.id,
          approvedBy: decision.decision.statement,
          approvedAt: decision.decision.createdAt,
          sessionId,
        };
        const result = await workflow.applyProposal({
          proposalEventId: input.proposalEventId as never,
          approval,
        });
        return { proposal: result.proposal, outcome: result.status };
      }
      const result = await workflow.applyProposal({
        proposalEventId: input.proposalEventId as never,
      });
      return { proposal: result.proposal, outcome: result.status };
    } catch (error) {
      throw this.asRuntimeError(error);
    }
  }

  async masterSend(input: {
    projectId: string;
    workspacePath: string;
    sessionId: string;
    message: string;
  }): Promise<unknown> {
    const id = this.store.project(input.projectId).id;
    const workspacePath = await this.store.workspace(id, input.workspacePath);
    const sessionId = redactSensitiveText(input.sessionId).trim();
    const message = redactSensitiveText(input.message).trim();
    if (sessionId.length === 0 || message.length === 0) {
      throw new CoreRuntimeError(
        "USER_CONFIGURATION_ERROR",
        "Master requests require a session and message",
      );
    }
    const reader = new DatabaseMasterProjectContextReader(this.db);
    const context = reader.read(id);
    void sessionId;
    const rundown = await new ProjectRundownService(this.db).generate({
      kind: "project_status",
      projectId: id,
      workspacePath,
    });
    const response = renderProjectRundown(rundown);
    const proposal = masterAgentProposalSchema.parse({
      formatVersion: 1,
      intent: "explain_project_status",
      response:
        response.slice(0, 8000) || `Project ${String(id)} status: ${context.project.state}.`,
      citations: [{ kind: "project", id: String(id) }],
      action: { kind: "respond" },
    });
    void message;
    return { proposal };
  }

  async approveTask(input: {
    projectId: string;
    phaseId: string;
    taskId: string;
    decision: "approve" | "reject";
    actor: string;
    reason: string;
  }): Promise<unknown> {
    const id = this.store.project(input.projectId).id;
    this.store.state(id);
    const actor = cleanActor(input.actor);
    const reason = cleanReason(input.reason);
    const phaseId = phaseIdSchema.parse(input.phaseId);
    const taskId = taskIdSchema.parse(input.taskId);
    const task = this.views.assertTask(id, String(taskId));
    if (task.phaseId !== phaseId)
      throw new CoreRuntimeError(
        "USER_CONFIGURATION_ERROR",
        "Task does not belong to the selected phase",
      );
    const project = this.store.project(id);
    if (project.executionMode !== "guided") {
      return { projectId: id, phaseId, task, outcome: "UNCHANGED" as const };
    }
    const occurredAt = nowIso(this.now);
    const required = this.db.eventJournal
      .replay({ projectId: id, taskId, types: ["GUIDED_TASK_APPROVAL_REQUIRED"], limit: 1000 })
      .at(-1);
    const terminal = this.db.eventJournal
      .replay({
        projectId: id,
        taskId,
        types: ["GUIDED_TASK_APPROVED", "GUIDED_TASK_APPROVAL_SUPERSEDED"],
        limit: 1000,
      })
      .at(-1);
    if (
      terminal !== undefined &&
      (required === undefined || terminal.sequenceNumber > required.sequenceNumber)
    ) {
      return { projectId: id, phaseId, task, outcome: "UNCHANGED" as const };
    }
    if (input.decision === "approve") {
      this.db.repositories.events.append({
        id: eventIdSchema.parse(`runtime-${randomUUID()}`),
        projectId: id,
        phaseId,
        taskId,
        type: "GUIDED_TASK_APPROVED",
        eventVersion: 1,
        occurredAt,
        actor,
        payload: { taskId: String(taskId), reason },
      });
      const updated = this.db.repositories.tasks.findById(taskId);
      if (updated === undefined)
        throw new CoreRuntimeError("PERSISTENCE_FAILURE", "Approved task disappeared");
      const runtime = this.store.state(id);
      this.store.write(id, { ...runtime, taskApproval: String(taskId) });
      return { projectId: id, phaseId, task: updated, outcome: "APPROVED" as const };
    }
    try {
      if (stateTransitionService.canTransitionTask(task.state, "BLOCKED")) {
        this.db.persistStateTransition(
          stateTransitionService.transitionTask(task, "BLOCKED", { actor, occurredAt, reason }),
          eventIdSchema.parse(`runtime-${randomUUID()}`),
        );
      } else if (stateTransitionService.canTransitionProject(project.state, "BLOCKED")) {
        this.store.transition(id, "BLOCKED", actor, reason);
      } else {
        this.db.repositories.events.append({
          id: eventIdSchema.parse(`runtime-${randomUUID()}`),
          projectId: id,
          phaseId,
          taskId,
          type: "GUIDED_TASK_APPROVAL_SUPERSEDED",
          eventVersion: 1,
          occurredAt,
          actor,
          payload: { taskId: String(taskId), reason, rejected: true },
        });
      }
    } catch (error) {
      throw this.asRuntimeError(error);
    }
    const updated = this.db.repositories.tasks.findById(taskId);
    if (updated === undefined)
      throw new CoreRuntimeError("PERSISTENCE_FAILURE", "Rejected task disappeared");
    return { projectId: id, phaseId, task: updated, outcome: "REJECTED" as const };
  }

  async approvePhase(input: {
    projectId: string;
    phaseId: string;
    decision: "approve" | "reject";
    actor: string;
    reason: string;
  }): Promise<unknown> {
    const id = this.store.project(input.projectId).id;
    this.store.state(id);
    const actor = cleanActor(input.actor);
    const reason = cleanReason(input.reason);
    const phaseId = phaseIdSchema.parse(input.phaseId) as PhaseId;
    const phase = this.db.repositories.phases.findById(phaseId);
    if (phase?.projectId !== id)
      throw new CoreRuntimeError(
        "USER_CONFIGURATION_ERROR",
        "Phase does not belong to the selected project",
      );
    if (phase.state !== "AWAITING_APPROVAL") {
      const next = this.nextPhase(id, phase);
      return {
        projectId: id,
        phase,
        ...(next === undefined ? {} : { nextPhase: next }),
        outcome: "UNCHANGED" as const,
      };
    }
    const occurredAt = nowIso(this.now);
    if (input.decision === "reject") {
      try {
        this.db.persistStateTransition(
          stateTransitionService.transitionPhase(phase, "BLOCKED", { actor, occurredAt, reason }),
          eventIdSchema.parse(`runtime-${randomUUID()}`),
        );
      } catch (error) {
        throw this.asRuntimeError(error);
      }
      const updated = this.db.repositories.phases.findById(phaseId);
      if (updated === undefined)
        throw new CoreRuntimeError("PERSISTENCE_FAILURE", "Rejected phase disappeared");
      return { projectId: id, phase: updated, outcome: "REJECTED" as const };
    }
    const phases = this.db.repositories.phases.listByProjectId(id);
    const next = phases.find((p) => p.position === phase.position + 1);
    try {
      this.db.transaction(() => {
        this.db.repositories.events.append({
          id: eventIdSchema.parse(`runtime-${randomUUID()}`),
          projectId: id,
          phaseId,
          type: "PHASE_APPROVED",
          eventVersion: 1,
          occurredAt,
          actor,
          payload: { reason },
        });
        this.db.persistStateTransition(
          stateTransitionService.transitionPhase(phase, "COMPLETED", {
            actor,
            occurredAt,
            reason: "User approved the validated phase boundary",
          }),
          eventIdSchema.parse(`runtime-${randomUUID()}`),
        );
        if (next !== undefined && next.state === "PENDING") {
          this.db.persistStateTransition(
            stateTransitionService.transitionPhase(next, "READY", {
              actor,
              occurredAt,
              reason: `Approved phase ${String(phaseId)} released the next phase`,
            }),
            eventIdSchema.parse(`runtime-${randomUUID()}`),
          );
        }
      });
    } catch (error) {
      throw this.asRuntimeError(error);
    }
    const updated = this.db.repositories.phases.findById(phaseId);
    if (updated === undefined)
      throw new CoreRuntimeError("PERSISTENCE_FAILURE", "Approved phase disappeared");
    const released = next === undefined ? undefined : this.db.repositories.phases.findById(next.id);
    const runtime = this.store.state(id);
    this.store.write(id, { ...runtime, phaseApproval: String(phaseId) });
    return {
      projectId: id,
      phase: updated,
      ...(released === undefined ? {} : { nextPhase: released }),
      outcome: "APPROVED" as const,
    };
  }

  private nextPhase(projectId: ProjectId, phase: { position: number }) {
    return this.db.repositories.phases
      .listByProjectId(projectId)
      .find((p) => p.position === phase.position + 1);
  }

  async updateSettings(input: {
    projectId: string;
    actor: string;
    reason: string;
    executionMode?: string;
    permissionPolicy?: unknown;
    keepAwakeBatteryPolicy?: unknown;
  }): Promise<unknown> {
    const id = this.store.project(input.projectId).id;
    this.store.state(id);
    const actor = cleanActor(input.actor);
    const reason = cleanReason(input.reason);
    const occurredAt = nowIso(this.now);
    if (input.executionMode !== undefined) {
      const mode = executionModeSchema.parse(input.executionMode);
      new ExecutionModeService(this.db, { now: this.now }).change(id, mode, actor);
    }
    if (input.permissionPolicy !== undefined) {
      const configuration = permissionPolicyConfigurationSchema.parse(input.permissionPolicy);
      const service = new PermissionPolicyService(this.db);
      const current = service.getConfiguration(id);
      if (current.preset !== configuration.preset) {
        service.setPreset({
          projectId: id,
          preset: configuration.preset,
          actor,
          reason,
          occurredAt,
        });
      }
      const wanted = new Map(configuration.overrides.map((o) => [o.operation, o.disposition]));
      const existing = new Map(current.overrides.map((o) => [o.operation, o.disposition]));
      for (const [operation, disposition] of wanted) {
        if (existing.get(operation) !== disposition) {
          service.setOverride({
            projectId: id,
            operation: operation as never,
            disposition,
            actor,
            reason,
            occurredAt,
          });
        }
      }
      for (const [operation] of existing) {
        if (!wanted.has(operation)) {
          service.clearOverride({
            projectId: id,
            operation: operation as never,
            actor,
            reason,
            occurredAt,
          });
        }
      }
    }
    if (input.keepAwakeBatteryPolicy !== undefined) {
      const policy = keepAwakeBatteryPolicySchema.parse(input.keepAwakeBatteryPolicy);
      const settings = this.db.repositories.projectSettings.findByProjectId(id);
      const raw = settings?.values["keepAwake"];
      const base =
        typeof raw === "object" && raw !== null && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : undefined;
      const preservedReasons =
        base !== undefined && Array.isArray(base["reasons"]) ? (base["reasons"] as unknown) : [];
      const preservedState =
        base?.["state"] === "active" ||
        base?.["state"] === "declined" ||
        base?.["state"] === "unavailable" ||
        base?.["state"] === "recovery_required"
          ? base["state"]
          : "inactive";
      const effectiveReasons = preservedState === "inactive" ? [] : preservedReasons;
      const preserveAssertion =
        (preservedState === "active" || preservedState === "recovery_required") &&
        base?.["assertion"] !== undefined;
      const next = {
        formatVersion: 1,
        projectId: String(id),
        state: preservedState,
        reasons: effectiveReasons,
        batteryPolicy: policy,
        ...(preserveAssertion ? { assertion: base["assertion"] } : {}),
        ...(base?.["batteryState"] === undefined ? {} : { batteryState: base["batteryState"] }),
        updatedAt: occurredAt,
        message: "Battery policy updated through Core v1 settings",
      };
      this.db.transaction((repositories) => {
        repositories.projectSettings.set({
          projectId: id,
          values: { ...(settings?.values ?? {}), keepAwake: next as never },
          updatedAt: occurredAt,
        });
        repositories.events.append({
          id: eventIdSchema.parse(`runtime-${randomUUID()}`),
          projectId: id,
          type: "KEEP_AWAKE_BATTERY_POLICY_CHANGED",
          eventVersion: 1,
          occurredAt,
          actor,
          payload: { reason, minimumLevelPercent: policy.minimumLevelPercent },
        });
      });
    }
    return this.views.settings(id);
  }

  async resolvePermission(input: {
    projectId: string;
    decisionId: string;
    resolution: "approve" | "reject";
    actor: string;
    reason: string;
  }): Promise<unknown> {
    const id = this.store.project(input.projectId).id;
    this.store.state(id);
    const actor = cleanActor(input.actor);
    const reason = cleanReason(input.reason);
    const decisionId = input.decisionId.trim();
    if (decisionId.length === 0)
      throw new CoreRuntimeError(
        "USER_CONFIGURATION_ERROR",
        "Permission decision ID must not be empty",
      );
    const occurredAt = nowIso(this.now);
    const requests = this.db.eventJournal.replay({
      projectId: id,
      types: ["RUNTIME_PERMISSION_REQUESTED", "PERMISSION_DECISION_RECORDED"],
      limit: 1000,
    });
    const request = requests.find(
      (e) => e.id === decisionId || String(e.payload["decisionId"]) === decisionId,
    );
    if (request === undefined) {
      const direct = this.db.repositories.decisions.findById(decisionId as never);
      if (direct === undefined || direct.projectId !== id) {
        return { projectId: id, decisionId, outcome: "STALE" as const };
      }
    }
    const resolutions = this.db.eventJournal.replay({
      projectId: id,
      types: ["RUNTIME_PERMISSION_RESOLVED"],
      limit: 1000,
    });
    const requestAliases =
      request === undefined
        ? [decisionId]
        : [request.id, String(request.payload["decisionId"] ?? request.id)];
    if (
      resolutions.some((e) => {
        const resolvedDecision = String(e.payload["decisionId"] ?? "");
        const resolvedRequest =
          e.payload["requestEventId"] !== undefined
            ? String(e.payload["requestEventId"])
            : String(e.payload["requestId"] ?? "");
        return (
          requestAliases.includes(resolvedDecision) ||
          (resolvedRequest !== "" && requestAliases.includes(resolvedRequest))
        );
      })
    ) {
      return { projectId: id, decisionId, outcome: "UNCHANGED" as const };
    }
    const canonicalDecision =
      request === undefined ? decisionId : String(request.payload["decisionId"] ?? request.id);
    this.db.repositories.events.append({
      id: eventIdSchema.parse(`runtime-${randomUUID()}`),
      projectId: id,
      type: "RUNTIME_PERMISSION_RESOLVED",
      eventVersion: 1,
      occurredAt,
      actor,
      payload: {
        decisionId: canonicalDecision,
        requestEventId: request?.id ?? decisionId,
        resolution: input.resolution,
        reason,
      },
    });
    return {
      projectId: id,
      decisionId,
      outcome: input.resolution === "approve" ? ("APPROVED" as const) : ("REJECTED" as const),
    };
  }

  async dispatch(method: CoreV1Method, payload: unknown): Promise<unknown | undefined> {
    switch (method) {
      case "projects.create": {
        const p = payload as {
          name: string;
          workspacePath: string;
          idea: string;
          executionMode: string;
          actor: string;
        };
        return await this.createProject(p);
      }
      case "projects.interview.answer": {
        const p = payload as {
          projectId: string;
          sessionId: string;
          answers: readonly { questionId: string; answer: string }[];
        };
        return await this.answerInterview(p);
      }
      case "roadmaps.generate": {
        const p = payload as { projectId: string; sessionId: string; actor: string };
        return await this.generateRoadmap(p);
      }
      case "projects.start": {
        const p = payload as { projectId: string; workspacePath: string; actor: string };
        return await this.startProject(p);
      }
      case "roadmaps.revisions.propose": {
        const p = payload as {
          projectId: string;
          baseRevisionNumber: number;
          operations: readonly unknown[];
          rationale: string;
          actor: string;
          sessionId: string;
        };
        return await this.proposeRevision(p);
      }
      case "roadmaps.revisions.resolve": {
        const p = payload as {
          projectId: string;
          proposalEventId: string;
          resolution: "approve" | "reject";
          rationale: string;
          actor: string;
          sessionId: string;
        };
        return await this.resolveRevision(p);
      }
      case "master.send": {
        const p = payload as {
          projectId: string;
          workspacePath: string;
          sessionId: string;
          message: string;
        };
        return await this.masterSend(p);
      }
      case "tasks.approve": {
        const p = payload as {
          projectId: string;
          phaseId: string;
          taskId: string;
          decision: "approve" | "reject";
          actor: string;
          reason: string;
        };
        return await this.approveTask(p);
      }
      case "phases.approve": {
        const p = payload as {
          projectId: string;
          phaseId: string;
          decision: "approve" | "reject";
          actor: string;
          reason: string;
        };
        return await this.approvePhase(p);
      }
      case "settings.update": {
        const p = payload as {
          projectId: string;
          actor: string;
          reason: string;
          executionMode?: string;
          permissionPolicy?: unknown;
          keepAwakeBatteryPolicy?: unknown;
        };
        return await this.updateSettings(p);
      }
      case "permissions.resolve": {
        const p = payload as {
          projectId: string;
          decisionId: string;
          resolution: "approve" | "reject";
          actor: string;
          reason: string;
        };
        return await this.resolvePermission(p);
      }
      default:
        return undefined;
    }
  }

  private asRuntimeError(error: unknown): CoreRuntimeError {
    if (error instanceof CoreRuntimeError) return error;
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof (error as { code: unknown }).code === "string"
        ? String((error as { code: unknown }).code)
        : "INTERNAL_INVARIANT_VIOLATION";
    const valid = [
      "USER_CONFIGURATION_ERROR",
      "PERMISSION_DENIED",
      "PERSISTENCE_FAILURE",
      "WORKSPACE_CONFLICT",
      "GIT_FAILURE",
      "PROCESS_FAILURE",
      "VALIDATION_FAILURE",
      "INVALID_STATE_TRANSITION",
      "INTERNAL_INVARIANT_VIOLATION",
      "AGENT_UNAVAILABLE",
      "AUTHENTICATION_REQUIRED",
      "USAGE_LIMITED",
      "PROTOCOL_VERSION_MISMATCH",
    ] as const;
    const mapped = (valid as readonly string[]).includes(code)
      ? code
      : "INTERNAL_INVARIANT_VIOLATION";
    return new CoreRuntimeError(
      mapped as never,
      error instanceof Error ? error.message : String(error),
    );
  }
}
