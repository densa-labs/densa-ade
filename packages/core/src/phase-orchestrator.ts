import { createHash } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import {
  eventIdSchema,
  isoTimestampSchema,
  phaseReportSchema,
  type EventId,
  type JsonObject,
  type MasterRoadmapPhase,
  type Phase,
  type PhaseId,
  type PhaseReport,
  type PhaseReportValidationCheck,
  type ProjectId,
  type Task,
  type TaskId,
} from "@densa/protocol";

import { type DensaDatabase } from "./persistence/database.js";
import { atomicReplaceFile, redactPortableText } from "./persistence/portable-project.js";
import { DependencyScheduler, type SchedulerGateSnapshot } from "./scheduler.js";
import { stateTransitionService } from "./state-transitions.js";
import {
  type ExecuteTaskLifecycleRequest,
  SingleTaskOrchestrator,
  type TaskLifecycleResult,
} from "./task-orchestrator.js";

export interface ExecutePhaseTaskRequest {
  readonly projectId: ProjectId;
  readonly phaseId: PhaseId;
  readonly taskId: TaskId;
  readonly workspacePath: string;
  readonly actor: string;
  readonly signal?: AbortSignal;
}

export interface PhaseTaskExecutor {
  execute(request: ExecutePhaseTaskRequest): Promise<TaskLifecycleResult>;
}

export type PhaseTaskExecutionDetails = Pick<
  ExecuteTaskLifecycleRequest,
  | "workerPrompt"
  | "ownedPaths"
  | "intendedPaths"
  | "temporaryPaths"
  | "adapter"
  | "validator"
  | "onAgentEvent"
>;

export interface PhaseTaskExecutionDetailsProvider {
  build(request: ExecutePhaseTaskRequest): Promise<PhaseTaskExecutionDetails>;
}

/** Adapts task-specific packet/path/validator inputs to the existing P5M2 lifecycle. */
export class SingleTaskPhaseExecutor implements PhaseTaskExecutor {
  constructor(
    private readonly orchestrator: SingleTaskOrchestrator,
    private readonly details: PhaseTaskExecutionDetailsProvider,
  ) {}

  async execute(request: ExecutePhaseTaskRequest): Promise<TaskLifecycleResult> {
    const details = await this.details.build(request);
    return this.orchestrator.execute({
      projectId: request.projectId,
      taskId: request.taskId,
      workspacePath: request.workspacePath,
      actor: request.actor,
      ...details,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
  }
}

export interface PhaseValidationRequest {
  readonly projectId: ProjectId;
  readonly phase: Phase;
  readonly tasks: readonly Task[];
  readonly workspacePath: string;
}

export interface PhaseValidationCheck {
  readonly validatorId: string;
  readonly passed: boolean;
  readonly summary: string;
}

export interface PhaseValidationOutcome {
  readonly passed: boolean;
  readonly summary: string;
  readonly checks: readonly PhaseValidationCheck[];
}

export interface PhaseLifecycleValidator {
  readonly validatorId: string;
  validate(request: PhaseValidationRequest): Promise<PhaseValidationOutcome>;
}

export interface ExecutePhaseLifecycleRequest {
  readonly projectId: ProjectId;
  readonly phaseId: PhaseId;
  readonly workspacePath: string;
  readonly gates: SchedulerGateSnapshot;
  readonly taskExecutor: PhaseTaskExecutor;
  readonly validator: PhaseLifecycleValidator;
  readonly actor: string;
  readonly guidedTaskApproval?: Readonly<{ taskId: TaskId }>;
  readonly signal?: AbortSignal;
}

export type PhaseLifecycleStopCode =
  | "ACTIVE_PHASE_LIFECYCLE_EXISTS"
  | "INVALID_REQUEST"
  | "PERSISTED_STATE_INCONSISTENT"
  | "PHASE_NOT_FOUND"
  | "PHASE_STATE_MISMATCH"
  | "POLICY_GATE_BLOCKED"
  | "PROJECT_NOT_RUNNABLE"
  | "REPORT_SYNC_FAILED"
  | "SCHEDULER_NO_WORK"
  | "TASK_EXECUTION_STOPPED";

export type PhaseLifecycleResult =
  | Readonly<{
      status: "AWAITING_APPROVAL" | "BLOCKED" | "COMPLETED";
      phaseId: PhaseId;
      report: PhaseReport;
    }>
  | Readonly<{
      status: "AWAITING_TASK_APPROVAL";
      phaseId: PhaseId;
      taskId: TaskId;
    }>
  | Readonly<{
      status: "STOPPED";
      code: PhaseLifecycleStopCode;
      phaseId: PhaseId;
      reason: string;
      report?: PhaseReport;
    }>;

export interface PhaseOrchestratorOptions {
  readonly now?: () => string;
}

function phaseKey(projectId: ProjectId, phaseId: PhaseId): string {
  return createHash("sha256")
    .update(projectId)
    .update("\0")
    .update(phaseId)
    .digest("hex")
    .slice(0, 20);
}

function phaseEventId(key: string, scope: string): EventId {
  return eventIdSchema.parse(`phase-lifecycle-${key}-${scope}`);
}

function taskReadyEventId(key: string, taskId: TaskId): EventId {
  const taskKey = createHash("sha256").update(taskId).digest("hex").slice(0, 12);
  return phaseEventId(key, `task-${taskKey}-ready`);
}

function taskBoundaryEventId(key: string, taskId: TaskId, scope: string): EventId {
  const taskKey = createHash("sha256").update(taskId).digest("hex").slice(0, 12);
  return phaseEventId(key, `guided-${taskKey}-${scope}`);
}

function reportPathFor(phaseId: PhaseId): string {
  const slug = phaseId.replace(/[^A-Za-z0-9._-]+/gu, "-").slice(0, 72) || "phase";
  const digest = createHash("sha256").update(phaseId).digest("hex").slice(0, 12);
  return `.densa/reports/phase-${slug}-${digest}.md`;
}

function stopped(
  code: PhaseLifecycleStopCode,
  request: ExecutePhaseLifecycleRequest,
  reason: string,
  report?: PhaseReport,
): PhaseLifecycleResult {
  return Object.freeze({
    status: "STOPPED" as const,
    code,
    phaseId: request.phaseId,
    reason,
    ...(report === undefined ? {} : { report }),
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cleanText(value: string): string {
  return redactPortableText(value).replace(/\s+/gu, " ").trim();
}

function markdownText(value: string): string {
  return cleanText(value).replace(/[\\`*_{}[\]()#+.!|>-]/gu, "\\$&");
}

function bulletLines(values: readonly string[], empty: string): readonly string[] {
  return values.length === 0 ? [`- ${empty}`] : values.map((value) => `- ${value}`);
}

export function renderPhaseReportMarkdown(report: PhaseReport): string {
  const lines = [
    `# Phase report: ${markdownText(report.phaseTitle)}`,
    "",
    `- Phase: \`${report.phaseId}\``,
    `- Outcome: \`${report.outcome}\``,
    `- Execution mode: \`${report.executionMode}\``,
    `- Started: ${report.phaseStartedAt}`,
    `- Generated: ${report.generatedAt}`,
    `- Roadmap revision: ${String(report.roadmapRevisionNumber)}`,
    "",
    "## Tasks completed",
    "",
    ...bulletLines(
      report.tasksCompleted.map(
        (task) =>
          `\`${task.taskId}\` — ${markdownText(task.title)} (${String(task.attemptCount)} attempt${task.attemptCount === 1 ? "" : "s"})`,
      ),
      "No tasks completed.",
    ),
    "",
    "## Tests and validators",
    "",
    `- Phase validation: **${report.phaseValidation.status}** — ${markdownText(report.phaseValidation.summary)}`,
    ...bulletLines(
      report.validations.map(
        (validation) =>
          `${validation.scope === "task" ? `\`${validation.taskId}\`` : "Phase"} / \`${validation.validatorId}\`: **${validation.passed ? "PASS" : "FAIL"}** — ${markdownText(validation.summary)}`,
      ),
      "No validator records.",
    ),
    "",
    "## Commits",
    "",
    ...bulletLines(
      report.commits.map((commit) => `\`${commit.taskId}\` — \`${commit.sha}\``),
      "No task commits recorded.",
    ),
    "",
    "## Files changed",
    "",
    ...bulletLines(
      report.filesChanged.flatMap((entry) =>
        entry.paths.map((path) => `\`${entry.taskId}\` — \`${path}\``),
      ),
      "No changed-file paths recorded.",
    ),
    "",
    "## Important decisions",
    "",
    ...bulletLines(
      report.importantDecisions.map(
        (decision) =>
          `\`${decision.id}\` — ${markdownText(decision.title)}: ${markdownText(decision.rationale)}`,
      ),
      "No decisions recorded during this phase.",
    ),
    "",
    "## Roadmap changes",
    "",
    ...bulletLines(
      report.roadmapChanges.map(
        (change) => `\`${change.id}\` (${change.classification}) — ${markdownText(change.reason)}`,
      ),
      "No roadmap changes affected this phase.",
    ),
    "",
    "## Retries and failures",
    "",
    ...bulletLines(
      report.retriesAndFailures.map(
        (entry) =>
          `\`${entry.taskId}\` — ${markdownText(entry.summary)} (attempts: ${String(entry.attemptCount)}, failed validations: ${String(entry.failedValidationCount)})`,
      ),
      "No retries or failures recorded.",
    ),
    "",
    "## Unresolved issues",
    "",
    ...bulletLines(report.unresolvedIssues.map(markdownText), "No unresolved issues."),
    "",
    "## Next phase",
    "",
    ...(report.nextPhase === undefined
      ? ["No later phase is present in the current roadmap."]
      : [
          `- \`${report.nextPhase.phaseId}\` — ${markdownText(report.nextPhase.title)}`,
          `- State: \`${report.nextPhase.state}\``,
          `- Goal: ${markdownText(report.nextPhase.goal)}`,
        ]),
    "",
  ];
  return lines.join("\n");
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`${path} must be a real directory`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(path, { mode: 0o700 });
  }
}

async function synchronizePhaseReport(workspacePath: string, report: PhaseReport): Promise<void> {
  const densaDirectory = join(workspacePath, ".densa");
  const reportsDirectory = join(densaDirectory, "reports");
  await ensureDirectory(workspacePath);
  await ensureDirectory(densaDirectory);
  await ensureDirectory(reportsDirectory);
  const outputPath = join(workspacePath, report.reportPath);
  const content = renderPhaseReportMarkdown(report);
  try {
    const metadata = await lstat(outputPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("Existing phase report path is not a regular file");
    }
    const current = await readFile(outputPath, "utf8");
    if (current !== content) {
      throw new Error("Existing phase report differs from the authoritative immutable report");
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await atomicReplaceFile(outputPath, content);
}

function validGateSnapshot(
  gates: SchedulerGateSnapshot | undefined,
): gates is SchedulerGateSnapshot {
  return (
    gates !== undefined &&
    Array.isArray(gates.outstandingUserDecisionIds) &&
    Array.isArray(gates.permissionBlockers)
  );
}

function committedPaths(
  events: readonly {
    readonly taskId?: TaskId | undefined;
    readonly payload: Readonly<JsonObject>;
  }[],
): ReadonlyMap<TaskId, readonly string[]> {
  const result = new Map<TaskId, readonly string[]>();
  for (const event of events) {
    const paths = event.payload["intendedPaths"];
    if (
      event.taskId !== undefined &&
      Array.isArray(paths) &&
      paths.every((path): path is string => typeof path === "string" && path.length > 0)
    ) {
      result.set(event.taskId, Object.freeze([...new Set(paths)].sort()));
    }
  }
  return result;
}

/** P5M3/P5M4 editor-independent serial phase lifecycle with durable mode boundaries. */
export class PhaseLifecycleOrchestrator {
  readonly #now: () => string;
  #active = false;

  constructor(
    private readonly database: DensaDatabase,
    options: PhaseOrchestratorOptions = {},
  ) {
    const clock = options.now ?? (() => new Date().toISOString());
    this.#now = () => isoTimestampSchema.parse(clock());
  }

  async execute(request: ExecutePhaseLifecycleRequest): Promise<PhaseLifecycleResult> {
    if (this.#active) {
      return stopped(
        "ACTIVE_PHASE_LIFECYCLE_EXISTS",
        request,
        "This orchestrator already owns the serial phase lifecycle slot",
      );
    }
    this.#active = true;
    try {
      return await this.#execute(request);
    } finally {
      this.#active = false;
    }
  }

  async #execute(request: ExecutePhaseLifecycleRequest): Promise<PhaseLifecycleResult> {
    if (
      request.actor.trim().length === 0 ||
      !isAbsolute(request.workspacePath) ||
      request.validator.validatorId.trim().length === 0 ||
      !validGateSnapshot(request.gates)
    ) {
      return stopped(
        "INVALID_REQUEST",
        request,
        "Phase execution requires an absolute workspace, actor, validator, and complete gate snapshot",
      );
    }
    const project = this.database.repositories.projects.findById(request.projectId);
    const phase = this.database.repositories.phases.findById(request.phaseId);
    if (phase?.projectId !== request.projectId) {
      return stopped("PHASE_NOT_FOUND", request, "Phase does not belong to the requested project");
    }
    if (project?.state !== "RUNNING") {
      return stopped("PROJECT_NOT_RUNNABLE", request, "Project must already be RUNNING");
    }
    const existingReport = this.database.repositories.phaseReports.findByPhaseId(phase.id);
    if (existingReport !== undefined)
      return this.#returnPersistedReport(request, phase, existingReport);
    if (phase.state !== "READY" && phase.state !== "RUNNING" && phase.state !== "VALIDATING") {
      return stopped(
        "PHASE_STATE_MISMATCH",
        request,
        `Phase must be READY, RUNNING, or VALIDATING, not ${phase.state}`,
      );
    }

    const roadmapRecord = this.database.repositories.masterRoadmaps.findByProjectId(project.id);
    const roadmapPhase = roadmapRecord?.roadmap.phases.find((entry) => entry.id === phase.id);
    if (roadmapRecord === undefined || roadmapPhase === undefined) {
      return stopped(
        "PERSISTED_STATE_INCONSISTENT",
        request,
        "Authoritative roadmap does not contain the persisted phase",
      );
    }
    const key = phaseKey(project.id, phase.id);
    let phaseStartedAt: string;
    if (phase.state === "READY") {
      const startedAt = this.#now();
      const transition = stateTransitionService.transitionPhase(phase, "RUNNING", {
        actor: request.actor,
        occurredAt: startedAt,
        reason: "Starting serial phase execution",
      });
      this.database.persistStateTransition(transition, phaseEventId(key, "phase-running"));
      phaseStartedAt = startedAt;
    } else {
      const started = this.database.eventJournal.findById(phaseEventId(key, "phase-running"));
      if (started === undefined) {
        return stopped(
          "PERSISTED_STATE_INCONSISTENT",
          request,
          "Running phase has no durable phase-start fact",
        );
      }
      phaseStartedAt = started.occurredAt;
    }

    if (phase.state !== "VALIDATING") {
      const taskResult = await this.#executeTasks(request, roadmapPhase, key);
      if (taskResult !== undefined) {
        if (taskResult.status === "awaiting_task_approval") {
          return Object.freeze({
            status: "AWAITING_TASK_APPROVAL" as const,
            phaseId: request.phaseId,
            taskId: taskResult.taskId,
          });
        }
        if (taskResult.status === "blocked") {
          return await this.#finish(
            request,
            roadmapPhase,
            phaseStartedAt,
            {
              status: "not_run",
              summary: "Phase validation did not run because required work is unresolved.",
            },
            [],
            taskResult.issues,
          );
        }
        return stopped(taskResult.code, request, taskResult.reason);
      }
    }

    const policyGate = this.#policyGateReason(request);
    if (policyGate !== undefined) {
      return stopped("POLICY_GATE_BLOCKED", request, policyGate);
    }

    let currentPhase = this.database.repositories.phases.findById(phase.id);
    if (currentPhase === undefined) {
      return stopped("PHASE_NOT_FOUND", request, "Phase disappeared before validation");
    }
    if (currentPhase.state === "RUNNING") {
      const validatingAt = this.#now();
      const validatingPhase = currentPhase;
      this.database.transaction((repositories) => {
        this.database.persistStateTransition(
          stateTransitionService.transitionPhase(validatingPhase, "VALIDATING", {
            actor: request.actor,
            occurredAt: validatingAt,
            reason:
              "Every executable phase task is complete; starting independent phase validation",
          }),
          phaseEventId(key, "phase-validating"),
        );
        repositories.events.append({
          id: phaseEventId(key, "validation-started"),
          projectId: request.projectId,
          phaseId: request.phaseId,
          type: "PHASE_VALIDATION_STARTED",
          eventVersion: 1,
          occurredAt: validatingAt,
          actor: request.actor,
          payload: { validatorId: request.validator.validatorId },
        });
      });
      currentPhase = this.database.repositories.phases.findById(phase.id);
    }
    if (currentPhase?.state !== "VALIDATING") {
      return stopped(
        "PHASE_STATE_MISMATCH",
        request,
        "Phase did not reach the VALIDATING boundary",
      );
    }

    const tasks = this.#phaseTasks(request.projectId, roadmapPhase);
    const validation = await this.#validate(request, currentPhase, tasks);
    return await this.#finish(
      request,
      roadmapPhase,
      phaseStartedAt,
      {
        status: validation.passed ? "passed" : "failed",
        validatorId: request.validator.validatorId,
        summary: validation.summary,
      },
      validation.checks,
      validation.passed ? [] : [`Phase validation failed: ${validation.summary}`],
    );
  }

  async #executeTasks(
    request: ExecutePhaseLifecycleRequest,
    roadmapPhase: MasterRoadmapPhase,
    key: string,
  ): Promise<
    | { readonly status: "blocked"; readonly issues: readonly string[] }
    | { readonly status: "awaiting_task_approval"; readonly taskId: TaskId }
    | { readonly status: "stopped"; readonly code: PhaseLifecycleStopCode; readonly reason: string }
    | undefined
  > {
    const executableIds = new Set(
      roadmapPhase.tasks.filter((task) => task.executable).map((task) => task.id),
    );
    for (;;) {
      const guidedBoundary = this.#handleGuidedBoundary(request, key);
      if (guidedBoundary !== undefined) return guidedBoundary;
      if (request.signal?.aborted === true) {
        return {
          status: "stopped",
          code: "TASK_EXECUTION_STOPPED",
          reason: "Phase execution was cancelled",
        };
      }
      const tasks = this.#phaseTasks(request.projectId, roadmapPhase);
      if (tasks.every((task) => task.state === "COMPLETED")) return undefined;
      const policyGate = this.#policyGateReason(request);
      if (policyGate !== undefined) {
        return { status: "stopped", code: "POLICY_GATE_BLOCKED", reason: policyGate };
      }
      this.#promoteReadyTasks(request, tasks, key);

      const selection = new DependencyScheduler(this.database.repositories).selectNext({
        projectId: request.projectId,
        gates: request.gates,
      });
      if (selection.status === "selected") {
        if (selection.phase.id !== request.phaseId || !executableIds.has(selection.task.id)) {
          return {
            status: "stopped",
            code: "PERSISTED_STATE_INCONSISTENT",
            reason: `Scheduler selected ${selection.task.id} outside the active phase`,
          };
        }
        const result = await request.taskExecutor.execute({
          projectId: request.projectId,
          phaseId: request.phaseId,
          taskId: selection.task.id,
          workspacePath: request.workspacePath,
          actor: request.actor,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        const persisted = this.database.repositories.tasks.findById(selection.task.id);
        if (result.status === "COMPLETED") {
          const attempts = this.database.repositories.attempts.listByTaskId(selection.task.id);
          if (
            persisted?.state !== "COMPLETED" ||
            !attempts.some((attempt) => attempt.commitSha === result.commitSha)
          ) {
            return {
              status: "stopped",
              code: "PERSISTED_STATE_INCONSISTENT",
              reason:
                "Task executor claimed completion without matching persisted state and commit",
            };
          }
          continue;
        }
        if (result.status === "STOPPED") {
          return {
            status: "stopped",
            code: "TASK_EXECUTION_STOPPED",
            reason: `${result.code}: ${result.reason}`,
          };
        }
        if (
          persisted?.state !== "BLOCKED" &&
          persisted?.state !== "CANCELLED" &&
          persisted?.state !== "INTERRUPTED"
        ) {
          return {
            status: "stopped",
            code: "PERSISTED_STATE_INCONSISTENT",
            reason: `Task executor returned ${result.status} without a matching persisted task state`,
          };
        }
        continue;
      }

      const current = this.#phaseTasks(request.projectId, roadmapPhase);
      const terminalIssues = current
        .filter((task) => task.state === "BLOCKED" || task.state === "CANCELLED")
        .map((task) => `Required task ${task.id} is ${task.state}.`);
      if (terminalIssues.length > 0) return { status: "blocked", issues: terminalIssues };
      return {
        status: "stopped",
        code: "SCHEDULER_NO_WORK",
        reason: selection.reasons.map((reason) => `${reason.code}: ${reason.message}`).join("; "),
      };
    }
  }

  #policyGateReason(request: ExecutePhaseLifecycleRequest): string | undefined {
    if (request.gates.outstandingUserDecisionIds.length > 0) {
      return `Mandatory user decisions remain unresolved: ${request.gates.outstandingUserDecisionIds.join(", ")}`;
    }
    if (request.gates.permissionBlockers.length > 0) {
      return `Non-overridable permission or safety blockers remain: ${request.gates.permissionBlockers.map((blocker) => blocker.id).join(", ")}`;
    }
    return undefined;
  }

  #handleGuidedBoundary(
    request: ExecutePhaseLifecycleRequest,
    key: string,
  ): { readonly status: "awaiting_task_approval"; readonly taskId: TaskId } | undefined {
    const project = this.database.repositories.projects.findById(request.projectId);
    if (project === undefined) return undefined;
    const events = this.database.eventJournal.replay({
      projectId: request.projectId,
      phaseId: request.phaseId,
      types: [
        "TASK_STATE_CHANGED",
        "GUIDED_TASK_APPROVAL_REQUIRED",
        "GUIDED_TASK_APPROVED",
        "GUIDED_TASK_APPROVAL_SUPERSEDED",
      ],
      limit: 1_000,
    });
    const modeEvents = this.database.eventJournal.replay({
      projectId: request.projectId,
      types: ["EXECUTION_MODE_CHANGED"],
      limit: 1_000,
    });
    const terminalTaskIds = new Set(
      events
        .filter(
          (event) =>
            event.type === "GUIDED_TASK_APPROVED" ||
            event.type === "GUIDED_TASK_APPROVAL_SUPERSEDED",
        )
        .flatMap((event) =>
          typeof event.payload["taskId"] === "string" ? [event.payload["taskId"]] : [],
        ),
    );
    const pendingRequired = [...events]
      .reverse()
      .find(
        (event) =>
          event.type === "GUIDED_TASK_APPROVAL_REQUIRED" &&
          typeof event.payload["taskId"] === "string" &&
          !terminalTaskIds.has(event.payload["taskId"]),
      );
    let pendingTaskId =
      typeof pendingRequired?.payload["taskId"] === "string"
        ? (pendingRequired.payload["taskId"] as TaskId)
        : undefined;

    if (pendingTaskId === undefined && project.executionMode === "guided") {
      const lastGuidedModeChange = [...modeEvents]
        .reverse()
        .find(
          (event) => event.type === "EXECUTION_MODE_CHANGED" && event.payload["mode"] === "guided",
        );
      const guidedSince = lastGuidedModeChange?.sequenceNumber ?? 0;
      const unacknowledgedCompletion = [...events]
        .reverse()
        .find(
          (event) =>
            event.sequenceNumber > guidedSince &&
            event.type === "TASK_STATE_CHANGED" &&
            event.payload["state"] === "COMPLETED" &&
            event.taskId !== undefined &&
            !terminalTaskIds.has(event.taskId),
        );
      if (unacknowledgedCompletion?.taskId !== undefined) {
        pendingTaskId = unacknowledgedCompletion.taskId;
        const occurredAt = this.#now();
        this.database.repositories.events.append({
          id: taskBoundaryEventId(key, pendingTaskId, "required"),
          projectId: request.projectId,
          phaseId: request.phaseId,
          taskId: pendingTaskId,
          type: "GUIDED_TASK_APPROVAL_REQUIRED",
          eventVersion: 1,
          occurredAt,
          actor: request.actor,
          payload: { taskId: pendingTaskId },
        });
      }
    }

    if (pendingTaskId === undefined) {
      return undefined;
    }

    if (project.executionMode !== "guided") {
      this.database.repositories.events.append({
        id: taskBoundaryEventId(key, pendingTaskId, "superseded"),
        projectId: request.projectId,
        phaseId: request.phaseId,
        taskId: pendingTaskId,
        type: "GUIDED_TASK_APPROVAL_SUPERSEDED",
        eventVersion: 1,
        occurredAt: this.#now(),
        actor: request.actor,
        payload: { taskId: pendingTaskId, mode: project.executionMode },
      });
      return undefined;
    }
    if (request.guidedTaskApproval?.taskId !== pendingTaskId) {
      return { status: "awaiting_task_approval", taskId: pendingTaskId };
    }
    this.database.repositories.events.append({
      id: taskBoundaryEventId(key, pendingTaskId, "approved"),
      projectId: request.projectId,
      phaseId: request.phaseId,
      taskId: pendingTaskId,
      type: "GUIDED_TASK_APPROVED",
      eventVersion: 1,
      occurredAt: this.#now(),
      actor: request.actor,
      payload: { taskId: pendingTaskId },
    });
    return undefined;
  }

  #promoteReadyTasks(
    request: ExecutePhaseLifecycleRequest,
    tasks: readonly Task[],
    key: string,
  ): void {
    const allTasks = this.database.repositories.tasks.listByProjectId(request.projectId);
    const byId = new Map(allTasks.map((task) => [task.id, task]));
    const promotable = tasks.filter(
      (task) =>
        task.state === "PENDING" &&
        task.dependencyIds.every((dependencyId) => byId.get(dependencyId)?.state === "COMPLETED"),
    );
    if (promotable.length === 0) return;
    const occurredAt = this.#now();
    this.database.transaction(() => {
      for (const task of promotable) {
        this.database.persistStateTransition(
          stateTransitionService.transitionTask(task, "READY", {
            actor: request.actor,
            occurredAt,
            reason: "Every hard dependency is complete and the active phase may schedule this task",
          }),
          taskReadyEventId(key, task.id),
        );
      }
    });
  }

  #phaseTasks(projectId: ProjectId, roadmapPhase: MasterRoadmapPhase): readonly Task[] {
    const executableIds = new Set(
      roadmapPhase.tasks.filter((task) => task.executable).map((task) => task.id),
    );
    return Object.freeze(
      this.database.repositories.tasks
        .listByProjectId(projectId)
        .filter((task) => task.phaseId === roadmapPhase.id && executableIds.has(task.id))
        .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id)),
    );
  }

  async #validate(
    request: ExecutePhaseLifecycleRequest,
    phase: Phase,
    tasks: readonly Task[],
  ): Promise<PhaseValidationOutcome> {
    try {
      const outcome = await request.validator.validate({
        projectId: request.projectId,
        phase,
        tasks,
        workspacePath: request.workspacePath,
      });
      const checks = outcome.checks.map((check) => ({
        validatorId: cleanText(check.validatorId),
        passed: check.passed,
        summary: cleanText(check.summary),
      }));
      if (
        cleanText(outcome.summary).length === 0 ||
        checks.length === 0 ||
        checks.some((check) => check.validatorId.length === 0 || check.summary.length === 0) ||
        (outcome.passed && checks.some((check) => !check.passed))
      ) {
        return {
          passed: false,
          summary: "Phase validator returned incomplete or contradictory structured evidence.",
          checks: [
            {
              validatorId: request.validator.validatorId,
              passed: false,
              summary: "Invalid structured phase validation outcome.",
            },
          ],
        };
      }
      return Object.freeze({
        passed: outcome.passed,
        summary: cleanText(outcome.summary),
        checks: Object.freeze(checks),
      });
    } catch (error) {
      return Object.freeze({
        passed: false,
        summary: `Phase validator failed: ${cleanText(errorMessage(error))}`,
        checks: Object.freeze([
          Object.freeze({
            validatorId: request.validator.validatorId,
            passed: false,
            summary: "The phase validation hook did not return a confirmed outcome.",
          }),
        ]),
      });
    }
  }

  async #finish(
    request: ExecutePhaseLifecycleRequest,
    roadmapPhase: MasterRoadmapPhase,
    phaseStartedAt: string,
    phaseValidation: PhaseReport["phaseValidation"],
    phaseChecks: readonly PhaseValidationCheck[],
    unresolvedIssues: readonly string[],
  ): Promise<PhaseLifecycleResult> {
    const phase = this.database.repositories.phases.findById(request.phaseId);
    const project = this.database.repositories.projects.findById(request.projectId);
    const roadmapRecord = this.database.repositories.masterRoadmaps.findByProjectId(
      request.projectId,
    );
    if (phase === undefined || project === undefined || roadmapRecord === undefined) {
      return stopped("PERSISTED_STATE_INCONSISTENT", request, "Phase report inputs disappeared");
    }
    const outcome =
      phaseValidation.status !== "passed"
        ? "blocked"
        : project.executionMode === "phase"
          ? "awaiting_approval"
          : "completed";
    const targetState =
      outcome === "blocked"
        ? "BLOCKED"
        : outcome === "awaiting_approval"
          ? "AWAITING_APPROVAL"
          : "COMPLETED";
    const generatedAt = this.#now();
    const tasks = this.#phaseTasks(request.projectId, roadmapPhase);
    const report = this.#buildReport(
      request,
      roadmapPhase,
      tasks,
      phaseStartedAt,
      generatedAt,
      outcome,
      phaseValidation,
      phaseChecks,
      unresolvedIssues,
    );
    const key = phaseKey(request.projectId, request.phaseId);
    const nextRoadmapPhase = roadmapRecord.roadmap.phases[phase.position + 1];
    const nextPersistedPhase =
      nextRoadmapPhase === undefined
        ? undefined
        : this.database.repositories.phases.findById(nextRoadmapPhase.id as PhaseId);
    if (
      outcome === "completed" &&
      nextPersistedPhase !== undefined &&
      nextPersistedPhase.state !== "PENDING"
    ) {
      return stopped(
        "PERSISTED_STATE_INCONSISTENT",
        request,
        "Continuous mode may only make a PENDING next phase eligible",
      );
    }

    this.database.transaction((repositories) => {
      repositories.phaseReports.create(report);
      repositories.events.append({
        id: phaseEventId(key, `validation-${phaseValidation.status}`),
        projectId: request.projectId,
        phaseId: request.phaseId,
        type:
          phaseValidation.status === "passed"
            ? "PHASE_VALIDATION_PASSED"
            : phaseValidation.status === "failed"
              ? "PHASE_VALIDATION_FAILED"
              : "PHASE_VALIDATION_SKIPPED",
        eventVersion: 1,
        occurredAt: generatedAt,
        actor: request.actor,
        payload: {
          status: phaseValidation.status,
          ...(phaseValidation.validatorId === undefined
            ? {}
            : { validatorId: phaseValidation.validatorId }),
        },
      });
      repositories.events.append({
        id: phaseEventId(key, "report-generated"),
        projectId: request.projectId,
        phaseId: request.phaseId,
        type: "PHASE_REPORT_GENERATED",
        eventVersion: 1,
        occurredAt: generatedAt,
        actor: request.actor,
        payload: { outcome, reportPath: report.reportPath },
      });
      this.database.persistStateTransition(
        stateTransitionService.transitionPhase(phase, targetState, {
          actor: request.actor,
          occurredAt: generatedAt,
          reason:
            outcome === "blocked"
              ? "Required phase work or validation remains unresolved"
              : outcome === "awaiting_approval"
                ? "Phase validation passed; phase-by-phase mode requires user approval"
                : `Phase validation passed in ${project.executionMode} mode`,
        }),
        phaseEventId(key, `phase-${targetState.toLowerCase()}`),
      );
      if (outcome === "completed" && nextPersistedPhase !== undefined) {
        this.database.persistStateTransition(
          stateTransitionService.transitionPhase(nextPersistedPhase, "READY", {
            actor: request.actor,
            occurredAt: generatedAt,
            reason: `Previous phase ${phase.id} completed with passing validation`,
          }),
          phaseEventId(key, "next-phase-ready"),
        );
      }
    });

    try {
      await synchronizePhaseReport(request.workspacePath, report);
    } catch (error) {
      return stopped(
        "REPORT_SYNC_FAILED",
        request,
        `Authoritative report is durable but portable report synchronization failed: ${errorMessage(error)}`,
        report,
      );
    }
    return Object.freeze({
      status:
        outcome === "blocked"
          ? ("BLOCKED" as const)
          : outcome === "awaiting_approval"
            ? ("AWAITING_APPROVAL" as const)
            : ("COMPLETED" as const),
      phaseId: request.phaseId,
      report,
    });
  }

  #buildReport(
    request: ExecutePhaseLifecycleRequest,
    roadmapPhase: MasterRoadmapPhase,
    tasks: readonly Task[],
    phaseStartedAt: string,
    generatedAt: string,
    outcome: PhaseReport["outcome"],
    phaseValidation: PhaseReport["phaseValidation"],
    phaseChecks: readonly PhaseValidationCheck[],
    unresolvedIssues: readonly string[],
  ): PhaseReport {
    const roadmapRecord = this.database.repositories.masterRoadmaps.findByProjectId(
      request.projectId,
    );
    const project = this.database.repositories.projects.findById(request.projectId);
    if (roadmapRecord === undefined || project === undefined)
      throw new Error("Report source disappeared");
    const attempts = new Map(
      tasks.map((task) => [task.id, this.database.repositories.attempts.listByTaskId(task.id)]),
    );
    const taskValidations: PhaseReportValidationCheck[] = [];
    for (const task of tasks) {
      for (const validation of this.database.repositories.validationRuns.listByTaskId(task.id)) {
        if (validation.passed === undefined) continue;
        taskValidations.push({
          scope: "task",
          taskId: task.id,
          validatorId: validation.validatorId,
          passed: validation.passed,
          summary: validation.passed ? "Task validation passed." : "Task validation failed.",
          startedAt: validation.startedAt,
          ...(validation.completedAt === undefined ? {} : { completedAt: validation.completedAt }),
        });
      }
    }
    const phaseValidationChecks: PhaseReportValidationCheck[] = phaseChecks.map((check) => ({
      scope: "phase",
      validatorId: check.validatorId,
      passed: check.passed,
      summary: cleanText(check.summary),
    }));
    const committedEvents = this.database.eventJournal.replay({
      projectId: request.projectId,
      phaseId: request.phaseId,
      types: ["TASK_COMMITTED"],
      limit: 1_000,
    });
    const pathsByTask = new Map(committedPaths(committedEvents));
    for (const task of tasks) {
      const persistedPaths = (attempts.get(task.id) ?? []).flatMap((attempt) => {
        const intent = this.database.repositories.taskCommitIntents.findByAttemptId(attempt.id);
        return intent !== undefined && intent.commitSha === attempt.commitSha
          ? intent.intendedPaths
          : [];
      });
      if (persistedPaths.length > 0) {
        pathsByTask.set(task.id, Object.freeze([...new Set(persistedPaths)].sort()));
      }
    }
    const revisions = this.database.repositories.roadmapRevisions
      .listByProjectId(request.projectId)
      .filter(
        (revision) =>
          revision.createdAt >= phaseStartedAt &&
          revision.affectedPhaseIds.includes(request.phaseId),
      );
    const phases = this.database.repositories.phases.listByProjectId(request.projectId);
    const persistedPhase = phases.find((entry) => entry.id === request.phaseId);
    const nextRoadmapPhase =
      persistedPhase === undefined
        ? undefined
        : roadmapRecord.roadmap.phases[persistedPhase.position + 1];
    const nextPhase =
      nextRoadmapPhase === undefined
        ? undefined
        : phases.find((entry) => entry.id === nextRoadmapPhase.id);
    return phaseReportSchema.parse({
      formatVersion: 1,
      projectId: request.projectId,
      phaseId: request.phaseId,
      phaseTitle: cleanText(roadmapPhase.title),
      outcome,
      executionMode: project.executionMode,
      roadmapRevisionNumber: roadmapRecord.revisionNumber,
      phaseStartedAt,
      generatedAt,
      reportPath: reportPathFor(request.phaseId),
      tasksCompleted: tasks
        .filter((task) => task.state === "COMPLETED")
        .map((task) => ({
          taskId: task.id,
          title: cleanText(task.title),
          attemptCount: attempts.get(task.id)?.length ?? 0,
        })),
      validations: [...taskValidations, ...phaseValidationChecks],
      commits: tasks.flatMap((task) =>
        (attempts.get(task.id) ?? []).flatMap((attempt) =>
          attempt.commitSha === undefined ? [] : [{ taskId: task.id, sha: attempt.commitSha }],
        ),
      ),
      filesChanged: tasks.flatMap((task) => {
        const paths = pathsByTask.get(task.id);
        return paths === undefined ? [] : [{ taskId: task.id, paths }];
      }),
      importantDecisions: this.database.repositories.decisions
        .listByProjectId(request.projectId)
        .filter((decision) => decision.createdAt >= phaseStartedAt)
        .map((decision) => ({
          id: decision.id,
          title: cleanText(decision.title),
          rationale: cleanText(decision.rationale),
        })),
      roadmapChanges: revisions.map((revision) => ({
        id: revision.id,
        classification: revision.classification,
        reason: cleanText(revision.reason),
        createdAt: revision.createdAt,
      })),
      retriesAndFailures: tasks.flatMap((task) => {
        const taskAttempts = attempts.get(task.id) ?? [];
        const failedValidationCount = this.database.repositories.validationRuns
          .listByTaskId(task.id)
          .filter((validation) => validation.passed === false).length;
        if (taskAttempts.length <= 1 && failedValidationCount === 0 && task.state === "COMPLETED") {
          return [];
        }
        return [
          {
            taskId: task.id,
            attemptCount: taskAttempts.length,
            failedValidationCount,
            summary:
              task.state === "COMPLETED"
                ? "Task completed after retry or prior validation failure."
                : `Task remains ${task.state}.`,
          },
        ];
      }),
      unresolvedIssues: unresolvedIssues.map(cleanText),
      phaseValidation,
      ...(nextRoadmapPhase === undefined || nextPhase === undefined
        ? {}
        : {
            nextPhase: {
              phaseId: nextPhase.id,
              title: cleanText(nextRoadmapPhase.title),
              goal: cleanText(nextRoadmapPhase.goal),
              state: outcome === "completed" ? "READY" : nextPhase.state,
            },
          }),
    });
  }

  async #returnPersistedReport(
    request: ExecutePhaseLifecycleRequest,
    phase: Phase,
    report: PhaseReport,
  ): Promise<PhaseLifecycleResult> {
    const expectedState =
      report.outcome === "blocked"
        ? "BLOCKED"
        : report.outcome === "awaiting_approval"
          ? "AWAITING_APPROVAL"
          : "COMPLETED";
    const releasedApproval =
      report.outcome === "awaiting_approval" &&
      phase.state === "COMPLETED" &&
      this.database.eventJournal
        .replay({
          projectId: request.projectId,
          phaseId: request.phaseId,
          types: ["PHASE_APPROVED", "PHASE_APPROVAL_SUPERSEDED"],
          limit: 2,
        })
        .some(() => true);
    if (phase.state !== expectedState && !releasedApproval) {
      return stopped(
        "PERSISTED_STATE_INCONSISTENT",
        request,
        "Persisted phase report and phase state disagree",
        report,
      );
    }
    try {
      await synchronizePhaseReport(request.workspacePath, report);
    } catch (error) {
      return stopped("REPORT_SYNC_FAILED", request, errorMessage(error), report);
    }
    return Object.freeze({
      status: releasedApproval
        ? ("COMPLETED" as const)
        : report.outcome === "blocked"
          ? ("BLOCKED" as const)
          : report.outcome === "awaiting_approval"
            ? ("AWAITING_APPROVAL" as const)
            : ("COMPLETED" as const),
      phaseId: request.phaseId,
      report,
    });
  }
}
