import { createHash } from "node:crypto";
import { isAbsolute, posix } from "node:path";

import { isTerminalAgentEvent, type AgentAdapter, type AgentEvent } from "@densa-ade/agent-sdk";
import {
  isoTimestampSchema,
  jsonObjectSchema,
  usageStateSchema,
  type AgentRunId,
  type Attempt,
  type AttemptId,
  type CheckpointId,
  type EventId,
  type IndependentReviewId,
  type JsonObject,
  type ProjectId,
  type Task,
  type TaskId,
  type TaskState,
  type UsageState,
  type ValidationRunId,
} from "@densa-ade/protocol";

import { AttemptRollbackService, type AttemptRollbackStopCode } from "./attempt-rollback.js";
import {
  independentReviewCompletedEventId,
  independentReviewSupportsCompletion,
} from "./independent-review.js";
import { type DensaAdeDatabase } from "./persistence/database.js";
import { RunCheckpointService, type RunCheckpointStopCode } from "./run-checkpoint.js";
import { stateTransitionService } from "./state-transitions.js";
import { TaskCommitService, type TaskCommitStopCode } from "./task-commit.js";

export const MAX_TASK_ATTEMPTS = 4;
const RETRY_DIAGNOSTICS_LIMIT_BYTES = 16 * 1024;

export interface TaskLifecycleValidationRequest {
  readonly projectId: ProjectId;
  readonly task: Task;
  readonly attempt: Attempt;
  readonly validationRunId: ValidationRunId;
  readonly workspacePath: string;
  readonly signal?: AbortSignal;
}

export interface TaskLifecycleValidationOutcome {
  readonly passed: boolean;
  readonly diagnostics: Readonly<JsonObject>;
  readonly independentReviewId?: IndependentReviewId;
}

export interface TaskLifecycleValidator {
  readonly validatorId: string;
  readonly providesIndependentReview?: boolean;
  validate(request: TaskLifecycleValidationRequest): Promise<TaskLifecycleValidationOutcome>;
}

export interface ExecuteTaskLifecycleRequest {
  readonly projectId: ProjectId;
  readonly taskId: TaskId;
  readonly workspacePath: string;
  readonly workerPrompt: string;
  readonly ownedPaths: readonly string[];
  readonly intendedPaths: readonly string[];
  readonly temporaryPaths?: readonly string[];
  readonly adapter: AgentAdapter;
  readonly validator: TaskLifecycleValidator;
  readonly actor: string;
  readonly signal?: AbortSignal;
  /** Project-level pause uses interruption so the task can be revalidated and retried on resume. */
  readonly cancellationDisposition?: "cancel" | "interrupt";
  readonly onAgentEvent?: (event: AgentEvent) => void | Promise<void>;
}

export type TaskLifecycleStopCode =
  | "ACTIVE_LIFECYCLE_EXISTS"
  | "INVALID_REQUEST"
  | "RECOVERY_REQUIRED"
  | "TASK_STATE_MISMATCH"
  | "TASK_NOT_FOUND"
  | "PROJECT_PAUSED"
  | `CHECKPOINT_${RunCheckpointStopCode}`
  | `COMMIT_${TaskCommitStopCode}`
  | `ROLLBACK_${AttemptRollbackStopCode}`;

export type TaskLifecycleResult =
  | Readonly<{
      status: "COMPLETED";
      taskId: TaskId;
      attemptCount: number;
      commitSha: string;
    }>
  | Readonly<{
      status: "BLOCKED" | "CANCELLED" | "INTERRUPTED";
      taskId: TaskId;
      attemptCount: number;
      reason: string;
    }>
  | Readonly<{
      status: "WAITING_FOR_USAGE";
      taskId: TaskId;
      attemptCount: number;
      usageState: Extract<UsageState, { status: "limited" }>;
    }>
  | Readonly<{
      status: "STOPPED";
      code: TaskLifecycleStopCode;
      taskId: TaskId;
      attemptCount: number;
      reason: string;
    }>;

export interface TaskOrchestratorOptions {
  readonly now?: () => string;
}

type FailureKind = "agent_failed" | "cancelled" | "interrupted" | "process_crash";

interface AttemptIdentity {
  readonly attempt: Attempt;
  readonly key: string;
}

function lifecycleKey(projectId: ProjectId, taskId: TaskId, attemptNumber: number): string {
  return createHash("sha256")
    .update(projectId)
    .update("\0")
    .update(taskId)
    .update("\0")
    .update(String(attemptNumber))
    .digest("hex")
    .slice(0, 20);
}

type InternalLifecycleId = AttemptId & AgentRunId & CheckpointId & EventId & ValidationRunId;

function lifecycleId(key: string, scope: string): InternalLifecycleId {
  return `task-lifecycle-${key}-${scope}` as InternalLifecycleId;
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function taskRiskLevel(
  database: DensaAdeDatabase,
  projectId: ProjectId,
  taskId: TaskId,
): "low" | "medium" | "high" | "critical" | undefined {
  const roadmap = database.repositories.masterRoadmaps.findByProjectId(projectId)?.roadmap;
  return roadmap?.phases.flatMap((phase) => phase.tasks).find((task) => task.id === taskId)
    ?.riskLevel;
}

function boundedDiagnostics(value: Readonly<JsonObject>): string {
  const serialized = JSON.stringify(value, null, 2);
  const bytes = Buffer.from(serialized, "utf8");
  if (bytes.byteLength <= RETRY_DIAGNOSTICS_LIMIT_BYTES) return serialized;
  return `${bytes.subarray(0, RETRY_DIAGNOSTICS_LIMIT_BYTES).toString("utf8")}\n...[truncated]`;
}

function retryPrompt(
  basePrompt: string,
  attempt: Attempt,
  diagnostics: Readonly<JsonObject>,
): string {
  return [
    basePrompt,
    "",
    "## Required retry evidence",
    `This is attempt ${String(attempt.number)}. The immediately preceding attempt failed.`,
    "Revise the implementation strategy using this persisted validation or process evidence:",
    "```json",
    boundedDiagnostics(diagnostics),
    "```",
  ].join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const NON_RETRYABLE_AGENT_ERROR_CODES = new Set([
  "AGENT_UNAVAILABLE",
  "AUTHENTICATION_REQUIRED",
  "PERMISSION_DENIED",
  "PROTOCOL_VERSION_MISMATCH",
  "USER_CONFIGURATION_ERROR",
]);

function nonRetryableAgentErrorCode(diagnostics: Readonly<JsonObject>): string | undefined {
  const errorCode = diagnostics["errorCode"];
  return typeof errorCode === "string" && NON_RETRYABLE_AGENT_ERROR_CODES.has(errorCode)
    ? errorCode
    : undefined;
}

function normalizePaths(paths: readonly string[]): readonly string[] | undefined {
  if (paths.length === 0) return undefined;
  const normalized = [...new Set(paths)].sort((left, right) => left.localeCompare(right));
  return normalized.every(
    (path) =>
      path.length > 0 &&
      !isAbsolute(path) &&
      !path.includes("\\") &&
      posix.normalize(path) === path &&
      path !== "." &&
      path !== ".." &&
      !path.startsWith("../") &&
      path !== ".git" &&
      !path.startsWith(".git/") &&
      [...path].every((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint > 31 && codePoint !== 127;
      }),
  )
    ? Object.freeze(normalized)
    : undefined;
}

function stopped(
  code: TaskLifecycleStopCode,
  request: ExecuteTaskLifecycleRequest,
  attemptCount: number,
  reason: string,
): TaskLifecycleResult {
  return Object.freeze({
    status: "STOPPED" as const,
    code,
    taskId: request.taskId,
    attemptCount,
    reason,
  });
}

function usageStateJson(
  usageState: Extract<UsageState, { status: "limited" }>,
): Readonly<JsonObject> {
  return Object.freeze(
    usageState.resetAt === undefined
      ? { status: "limited" }
      : { status: "limited", resetAt: usageState.resetAt },
  );
}

/**
 * P5M2 editor-independent boundary for one serial, persistent task lifecycle.
 *
 * Agent termination only opens the validation gate. A passing validator plus a verified task
 * commit is the sole path to COMPLETED.
 */
export class SingleTaskOrchestrator {
  readonly #now: () => string;
  #active = false;

  constructor(
    private readonly database: DensaAdeDatabase,
    options: TaskOrchestratorOptions = {},
  ) {
    const clock = options.now ?? (() => new Date().toISOString());
    this.#now = () => isoTimestampSchema.parse(clock());
  }

  async execute(request: ExecuteTaskLifecycleRequest): Promise<TaskLifecycleResult> {
    if (this.#active) {
      return stopped(
        "ACTIVE_LIFECYCLE_EXISTS",
        request,
        this.database.repositories.attempts.listByTaskId(request.taskId).length,
        "This orchestrator already has an active implementation worker",
      );
    }
    this.#active = true;
    try {
      return await this.#execute(request);
    } finally {
      this.#active = false;
    }
  }

  async #execute(request: ExecuteTaskLifecycleRequest): Promise<TaskLifecycleResult> {
    const ownedPaths = normalizePaths(request.ownedPaths);
    const intendedPaths = normalizePaths(request.intendedPaths);
    const requestedTemporaryPaths = request.temporaryPaths ?? [];
    const temporaryPaths =
      requestedTemporaryPaths.length === 0
        ? Object.freeze([])
        : normalizePaths(requestedTemporaryPaths);
    if (
      request.actor.trim().length === 0 ||
      request.workerPrompt.trim().length === 0 ||
      request.validator.validatorId.trim().length === 0 ||
      ownedPaths === undefined ||
      intendedPaths === undefined ||
      temporaryPaths === undefined ||
      intendedPaths.some((path) => !ownedPaths.includes(path)) ||
      temporaryPaths.some((path) => !ownedPaths.includes(path))
    ) {
      return stopped(
        "INVALID_REQUEST",
        request,
        this.database.repositories.attempts.listByTaskId(request.taskId).length,
        "Lifecycle paths, prompt, actor, and validator must be explicit and internally consistent",
      );
    }

    let task = this.database.repositories.tasks.findById(request.taskId);
    if (task?.projectId !== request.projectId) {
      return stopped("TASK_NOT_FOUND", request, 0, "Task does not belong to the requested project");
    }
    if (task.state === "COMPLETED") {
      const attempts = this.database.repositories.attempts.listByTaskId(task.id);
      const commitSha = attempts.findLast((attempt) => attempt.commitSha !== undefined)?.commitSha;
      if (commitSha === undefined) {
        return stopped(
          "RECOVERY_REQUIRED",
          request,
          attempts.length,
          "Completed task is missing its verified task commit",
        );
      }
      return Object.freeze({
        status: "COMPLETED" as const,
        taskId: task.id,
        attemptCount: attempts.length,
        commitSha,
      });
    }
    if (task.state !== "READY" && task.state !== "RETRYING") {
      return stopped(
        task.state === "RUNNING" || task.state === "VALIDATING"
          ? "RECOVERY_REQUIRED"
          : "TASK_STATE_MISMATCH",
        request,
        this.database.repositories.attempts.listByTaskId(task.id).length,
        `Task must be READY or RETRYING, not ${task.state}`,
      );
    }
    const configuredRiskLevel = taskRiskLevel(this.database, request.projectId, request.taskId);
    if (
      (configuredRiskLevel === "high" || configuredRiskLevel === "critical") &&
      request.validator.providesIndependentReview !== true
    ) {
      return stopped(
        "INVALID_REQUEST",
        request,
        this.database.repositories.attempts.listByTaskId(task.id).length,
        "High/critical-risk tasks require independent-review validation before worker execution",
      );
    }

    for (;;) {
      task = this.database.repositories.tasks.findById(request.taskId);
      if (task === undefined) {
        return stopped("TASK_NOT_FOUND", request, 0, "Task disappeared during execution");
      }
      const attempts = this.database.repositories.attempts.listByTaskId(task.id);
      if (attempts.length >= MAX_TASK_ATTEMPTS) {
        return await this.#blockWithoutNewAttempt(
          request,
          task,
          attempts.length,
          `Task exhausted its ${String(MAX_TASK_ATTEMPTS)} persisted attempts`,
        );
      }

      const incomplete = attempts.findLast((attempt) => attempt.completedAt === undefined);
      let identity: AttemptIdentity;
      if (incomplete !== undefined) {
        if (
          incomplete !== attempts.at(-1) ||
          this.database.repositories.agentRuns.findByAttemptId(incomplete.id) !== undefined
        ) {
          return stopped(
            "RECOVERY_REQUIRED",
            request,
            attempts.length,
            "An earlier worker side effect has an unknown outcome and requires recovery inspection",
          );
        }
        identity = Object.freeze({
          attempt: incomplete,
          key: lifecycleKey(request.projectId, request.taskId, incomplete.number),
        });
      } else {
        const number = attempts.length + 1;
        const key = lifecycleKey(request.projectId, request.taskId, number);
        const startedAt = this.#now();
        const currentTask = task;
        const attempt = this.database.transaction((repositories) => {
          const created = repositories.attempts.create({
            id: lifecycleId(key, "attempt"),
            taskId: currentTask.id,
            number,
            startedAt,
          });
          repositories.events.append({
            id: lifecycleId(key, "attempt-started"),
            projectId: request.projectId,
            phaseId: currentTask.phaseId,
            taskId: currentTask.id,
            type: "ATTEMPT_STARTED",
            eventVersion: 1,
            occurredAt: startedAt,
            actor: request.actor,
            payload: { attemptId: created.id, attemptNumber: number },
          });
          return created;
        });
        identity = Object.freeze({ attempt, key });
      }

      const outcome = await this.#runAttempt(
        request,
        task,
        identity,
        ownedPaths,
        intendedPaths,
        temporaryPaths,
      );
      if (outcome !== undefined) return outcome;
    }
  }

  async #runAttempt(
    request: ExecuteTaskLifecycleRequest,
    taskSnapshot: Task,
    identity: AttemptIdentity,
    ownedPaths: readonly string[],
    intendedPaths: readonly string[],
    temporaryPaths: readonly string[],
  ): Promise<TaskLifecycleResult | undefined> {
    const { attempt, key } = identity;
    const checkpointAt = this.#now();
    const checkpoint = await new RunCheckpointService(this.database).prepareTask({
      projectId: request.projectId,
      taskId: request.taskId,
      attemptId: attempt.id,
      checkpointId: lifecycleId(key, "checkpoint"),
      runActivatedEventId: lifecycleId(key, "run-activated"),
      checkpointEventId: lifecycleId(key, "checkpoint-created"),
      workspacePath: request.workspacePath,
      createdAt: checkpointAt,
      actor: request.actor,
    });
    if (checkpoint.status === "STOPPED") {
      return await this.#finishBlocked(
        request,
        attempt,
        `Checkpoint stopped: ${checkpoint.reason}`,
        `CHECKPOINT_${checkpoint.code}`,
      );
    }

    let task = this.database.repositories.tasks.findById(request.taskId);
    if (task === undefined || (task.state !== "READY" && task.state !== "RETRYING")) {
      return stopped(
        "TASK_STATE_MISMATCH",
        request,
        attempt.number,
        "Task state changed before worker execution",
      );
    }
    if (signalAborted(request.signal)) {
      if (request.cancellationDisposition === "interrupt") {
        return stopped(
          "PROJECT_PAUSED",
          request,
          attempt.number,
          "Project pause was requested before worker execution",
        );
      }
      return this.#completeWithTransition(
        request,
        attempt,
        task,
        "CANCELLED",
        "cancelled",
        "Cancellation was requested before worker execution",
      );
    }

    const runningAt = this.#now();
    this.database.persistStateTransition(
      stateTransitionService.transitionTask(task, "RUNNING", {
        actor: request.actor,
        occurredAt: runningAt,
        reason: `Starting persisted attempt ${String(attempt.number)}`,
      }),
      lifecycleId(key, "task-running") as EventId,
    );
    task = this.database.repositories.tasks.findById(request.taskId);
    if (task === undefined) throw new Error("Persisted task disappeared after RUNNING transition");
    const runningTask = task;

    const previousFailure = this.#previousFailure(task, attempt);
    if (attempt.number > 1 && previousFailure === undefined) {
      return await this.#finishBlocked(
        request,
        attempt,
        "Retry attempt has no persisted new failure evidence",
        "RECOVERY_REQUIRED",
      );
    }
    const prompt =
      previousFailure === undefined
        ? request.workerPrompt
        : retryPrompt(request.workerPrompt, attempt, previousFailure);
    const agentRunId = lifecycleId(key, "agent-run");
    const agentStartedAt = this.#now();
    this.database.transaction((repositories) => {
      repositories.agentRuns.create({
        id: agentRunId,
        attemptId: attempt.id,
        adapterId: request.adapter.adapterId,
        adapterRunId: agentRunId,
        startedAt: agentStartedAt,
      });
      repositories.events.append({
        id: lifecycleId(key, "agent-started"),
        projectId: request.projectId,
        phaseId: runningTask.phaseId,
        taskId: runningTask.id,
        type: "AGENT_STARTED",
        eventVersion: 1,
        occurredAt: agentStartedAt,
        actor: request.actor,
        payload: { attemptId: attempt.id, agentRunId, adapterId: request.adapter.adapterId },
      });
    });

    let terminal: Extract<AgentEvent, { type: "run.terminal" }> | undefined;
    let processFailure: string | undefined;
    let cancellationFailure: string | undefined;
    const cancel = (): void => {
      void request.adapter.cancel(agentRunId).catch((error: unknown) => {
        cancellationFailure = errorMessage(error);
      });
    };
    request.signal?.addEventListener("abort", cancel, { once: true });
    try {
      for await (const event of request.adapter.execute({
        runId: agentRunId,
        cwd: request.workspacePath,
        prompt,
      })) {
        try {
          await request.onAgentEvent?.(event);
        } catch {
          // Observers cannot mutate the authoritative worker outcome.
        }
        if (isTerminalAgentEvent(event)) terminal = event;
      }
    } catch (error) {
      processFailure = errorMessage(error);
    } finally {
      request.signal?.removeEventListener("abort", cancel);
    }
    if (terminal === undefined && processFailure === undefined) {
      processFailure = "Agent event stream closed without a terminal event";
    }

    const agentFinishedAt = this.#now();
    this.database.repositories.events.append({
      id: lifecycleId(key, "agent-finished"),
      projectId: request.projectId,
      phaseId: task.phaseId,
      taskId: task.id,
      type: "AGENT_FINISHED",
      eventVersion: 1,
      occurredAt: agentFinishedAt,
      actor: request.actor,
      payload: {
        attemptId: attempt.id,
        agentRunId,
        outcome: processFailure === undefined ? (terminal?.outcome ?? "unknown") : "process_crash",
      },
    });

    const capture = await new AttemptRollbackService(this.database).captureAttemptOutput({
      projectId: request.projectId,
      taskId: request.taskId,
      attemptId: attempt.id,
      agentRunId,
      workspacePath: request.workspacePath,
      ownedPaths,
      ...(temporaryPaths.length === 0 ? {} : { temporaryPaths }),
      recordedAt: agentFinishedAt,
      actor: request.actor,
      eventId: lifecycleId(key, "attempt-output-captured"),
    });
    if (capture.status === "STOPPED") {
      return await this.#finishBlocked(
        request,
        attempt,
        `Attempt output capture stopped: ${capture.reason}`,
        `ROLLBACK_${capture.code}`,
      );
    }

    if (signalAborted(request.signal) || terminal?.outcome === "cancelled") {
      const interruption = request.cancellationDisposition === "interrupt";
      return await this.#handleWorkerFailure(
        request,
        task,
        identity,
        interruption ? "interrupted" : "cancelled",
        {
          kind: "cancellation",
          message:
            cancellationFailure ??
            (interruption
              ? "Worker was interrupted for a project pause"
              : "Worker cancellation was requested"),
        },
      );
    }
    if (processFailure !== undefined) {
      return await this.#handleWorkerFailure(request, task, identity, "process_crash", {
        kind: "process_crash",
        message: processFailure,
      });
    }
    const usageState = await this.#limitedUsageState(request.adapter, terminal);
    if (usageState !== undefined) {
      return await this.#handleUsageLimit(request, task, identity, agentRunId, usageState);
    }
    if (terminal?.outcome !== "succeeded") {
      return await this.#handleWorkerFailure(request, task, identity, "agent_failed", {
        kind: "agent_failure",
        outcome: terminal?.outcome ?? "unknown",
        ...(terminal?.exitCode === undefined ? {} : { exitCode: terminal.exitCode }),
        ...(terminal?.error === undefined
          ? {}
          : { errorCode: terminal.error.code, message: terminal.error.message }),
      });
    }

    const validatingAt = this.#now();
    this.database.persistStateTransition(
      stateTransitionService.transitionTask(task, "VALIDATING", {
        actor: request.actor,
        occurredAt: validatingAt,
        reason: "Worker terminated successfully; independent validation is authoritative",
      }),
      lifecycleId(key, "task-validating") as EventId,
    );
    task = this.database.repositories.tasks.findById(request.taskId);
    if (task === undefined) throw new Error("Persisted task disappeared before validation");

    const validationId = lifecycleId(key, "validation");
    this.database.transaction((repositories) => {
      repositories.validationRuns.create({
        id: validationId,
        taskId: task.id,
        attemptId: attempt.id,
        validatorId: request.validator.validatorId,
        manualReviewCriteria: [],
        startedAt: validatingAt,
      });
      repositories.events.append({
        id: lifecycleId(key, "validation-started"),
        projectId: request.projectId,
        phaseId: task.phaseId,
        taskId: task.id,
        type: "VALIDATION_STARTED",
        eventVersion: 1,
        occurredAt: validatingAt,
        actor: request.actor,
        payload: { attemptId: attempt.id, validationRunId: validationId },
      });
    });

    let validation: TaskLifecycleValidationOutcome;
    try {
      const result = await request.validator.validate({
        projectId: request.projectId,
        task,
        attempt,
        validationRunId: validationId,
        workspacePath: request.workspacePath,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      validation = Object.freeze({
        passed: result.passed,
        diagnostics: Object.freeze(jsonObjectSchema.parse(result.diagnostics)),
        ...(result.independentReviewId === undefined
          ? {}
          : { independentReviewId: result.independentReviewId }),
      });
    } catch (error) {
      validation = Object.freeze({
        passed: false,
        diagnostics: Object.freeze({
          kind: "validation_process_failure",
          message: errorMessage(error),
        }),
      });
    }
    const riskLevel = taskRiskLevel(this.database, request.projectId, request.taskId);
    if (validation.passed && (riskLevel === "high" || riskLevel === "critical")) {
      const review =
        validation.independentReviewId === undefined
          ? undefined
          : this.database.repositories.independentReviews.findById(validation.independentReviewId);
      const reviewCompletedEvent =
        review === undefined
          ? undefined
          : this.database.eventJournal.findById(independentReviewCompletedEventId(review.id));
      if (
        review?.taskId !== task.id ||
        review.validationRunId !== validationId ||
        review.completedAt === undefined ||
        review.output === undefined ||
        reviewCompletedEvent?.type !== "INDEPENDENT_REVIEW_COMPLETED" ||
        reviewCompletedEvent.taskId !== task.id ||
        reviewCompletedEvent.payload["contextHash"] !== review.contextHash ||
        Date.parse(review.requestedAt) < Date.parse(validatingAt) ||
        !independentReviewSupportsCompletion(review.output)
      ) {
        validation = Object.freeze({
          passed: false,
          diagnostics: Object.freeze({
            kind: "required_independent_review_missing_or_blocking",
            riskLevel,
          }),
        });
      }
    }
    const validationCompletedAt = this.#now();
    this.database.transaction((repositories) => {
      repositories.validationRuns.recordCompleted(
        validationId,
        validationCompletedAt,
        validation.passed,
      );
      repositories.events.append({
        id: lifecycleId(key, "validation-finished"),
        projectId: request.projectId,
        phaseId: task.phaseId,
        taskId: task.id,
        type: validation.passed ? "VALIDATION_PASSED" : "VALIDATION_FAILED",
        eventVersion: 1,
        occurredAt: validationCompletedAt,
        actor: request.actor,
        payload: { attemptId: attempt.id, validationRunId: validationId },
      });
    });

    if (validation.passed) {
      const committed = await new TaskCommitService(this.database).commitPassingTask({
        projectId: request.projectId,
        taskId: request.taskId,
        attemptId: attempt.id,
        validationRunId: validationId,
        workspacePath: request.workspacePath,
        intendedPaths,
        committedAt: this.#now(),
        actor: request.actor,
        commitRecordedEventId: lifecycleId(key, "task-committed"),
        completionEventId: lifecycleId(key, "task-completed"),
        attemptCompletedEventId: lifecycleId(key, "attempt-completed"),
      });
      if (committed.status === "STOPPED") {
        return await this.#finishBlocked(
          request,
          attempt,
          `Passing task commit stopped: ${committed.reason}`,
          `COMMIT_${committed.code}`,
        );
      }
      return Object.freeze({
        status: "COMPLETED" as const,
        taskId: request.taskId,
        attemptCount: attempt.number,
        commitSha: committed.commitSha,
      });
    }

    const failure = await this.#recordAndRollback(request, task, identity, validation.diagnostics);
    if (failure !== undefined) return failure;
    const latestTask = this.database.repositories.tasks.findById(request.taskId);
    if (latestTask === undefined) throw new Error("Task disappeared after failed validation");
    if (attempt.number >= MAX_TASK_ATTEMPTS) {
      return this.#completeWithTransition(
        request,
        attempt,
        latestTask,
        "BLOCKED",
        "blocked",
        `Validation failed on all ${String(MAX_TASK_ATTEMPTS)} attempts`,
      );
    }
    this.#completeWithTransition(
      request,
      attempt,
      latestTask,
      "RETRYING",
      "retrying",
      "Validation failed and scoped rollback completed",
    );
    return undefined;
  }

  #previousFailure(task: Task, attempt: Attempt): Readonly<JsonObject> | undefined {
    const priorAttempts = this.database.repositories.attempts
      .listByTaskId(task.id)
      .filter((candidate) => candidate.number < attempt.number)
      .sort((left, right) => right.number - left.number);
    for (const candidate of priorAttempts) {
      const plan = this.database.repositories.attemptRollbackPlans.findByAttemptId(candidate.id);
      if (plan?.failureRecordedAt !== undefined) return plan.diagnostics;
    }
    return undefined;
  }

  async #limitedUsageState(
    adapter: AgentAdapter,
    terminal: Extract<AgentEvent, { type: "run.terminal" }> | undefined,
  ): Promise<Extract<UsageState, { status: "limited" }> | undefined> {
    if (terminal?.outcome !== "failed" || terminal.error?.code !== "USAGE_LIMITED") {
      return undefined;
    }
    try {
      const parsed = usageStateSchema.safeParse(await adapter.getUsageState());
      return parsed.success && parsed.data.status === "limited" ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  async #handleUsageLimit(
    request: ExecuteTaskLifecycleRequest,
    taskSnapshot: Task,
    identity: AttemptIdentity,
    agentRunId: AgentRunId,
    usageState: Extract<UsageState, { status: "limited" }>,
  ): Promise<TaskLifecycleResult> {
    const { attempt, key } = identity;
    let task = this.database.repositories.tasks.findById(taskSnapshot.id);
    if (task?.state !== "RUNNING") {
      return stopped(
        "TASK_STATE_MISMATCH",
        request,
        attempt.number,
        "Usage-limit classification no longer matches a RUNNING task",
      );
    }
    const interruptedAt = this.#now();
    this.database.persistStateTransition(
      stateTransitionService.transitionTask(task, "INTERRUPTED", {
        actor: request.actor,
        occurredAt: interruptedAt,
        reason: "Worker stopped after a reliable usage-limit signal",
      }),
      lifecycleId(key, "task-usage-interrupted") as EventId,
    );
    task = this.database.repositories.tasks.findById(task.id);
    if (task === undefined) throw new Error("Task disappeared after usage-limit interruption");
    const rollbackFailure = await this.#recordAndRollback(request, task, identity, {
      kind: "usage_limited",
      usageState: usageStateJson(usageState),
    });
    if (rollbackFailure !== undefined) return rollbackFailure;

    task = this.database.repositories.tasks.findById(task.id);
    const project = this.database.repositories.projects.findById(request.projectId);
    if (
      task?.state !== "INTERRUPTED" ||
      project === undefined ||
      !stateTransitionService.canTransitionProject(project.state, "WAITING_FOR_USAGE")
    ) {
      return stopped(
        "RECOVERY_REQUIRED",
        request,
        attempt.number,
        "Authoritative project/task state changed before usage waiting could persist",
      );
    }

    const occurredAt = this.#now();
    const taskTransition = stateTransitionService.transitionTask(task, "WAITING_FOR_USAGE", {
      actor: request.actor,
      occurredAt,
      reason: "The agent backend reported a reliable usage-limit condition",
    });
    const projectTransition = stateTransitionService.transitionProject(
      project,
      "WAITING_FOR_USAGE",
      {
        actor: request.actor,
        occurredAt,
        reason: `Task ${task.id} is waiting for agent usage availability`,
      },
    );
    this.database.transaction((repositories) => {
      repositories.events.append({
        id: lifecycleId(key, "usage-limit-reached"),
        projectId: request.projectId,
        phaseId: task.phaseId,
        taskId: task.id,
        type: "USAGE_LIMIT_REACHED",
        eventVersion: 1,
        occurredAt,
        actor: request.actor,
        payload: { attemptId: attempt.id, agentRunId, usageState: usageStateJson(usageState) },
      });
      this.database.persistAttemptCompletion({
        attemptId: attempt.id,
        completedAt: occurredAt,
        outcome: "interrupted",
        eventId: lifecycleId(key, "attempt-completed"),
        actor: request.actor,
        transition: taskTransition,
      });
      this.database.persistStateTransition(
        projectTransition,
        lifecycleId(key, "project-waiting-for-usage") as EventId,
      );
    });

    return Object.freeze({
      status: "WAITING_FOR_USAGE" as const,
      taskId: task.id,
      attemptCount: attempt.number,
      usageState,
    });
  }

  async #handleWorkerFailure(
    request: ExecuteTaskLifecycleRequest,
    taskSnapshot: Task,
    identity: AttemptIdentity,
    kind: FailureKind,
    diagnostics: Readonly<JsonObject>,
  ): Promise<TaskLifecycleResult | undefined> {
    const { attempt, key } = identity;
    let task = this.database.repositories.tasks.findById(taskSnapshot.id);
    if (task?.state !== "RUNNING") {
      return stopped(
        "TASK_STATE_MISMATCH",
        request,
        attempt.number,
        "Worker failure no longer matches a RUNNING task",
      );
    }
    const interim: TaskState = kind === "agent_failed" ? "RETRYING" : "INTERRUPTED";
    const transitionedAt = this.#now();
    this.database.persistStateTransition(
      stateTransitionService.transitionTask(task, interim, {
        actor: request.actor,
        occurredAt: transitionedAt,
        reason: `Worker ended with ${kind}`,
      }),
      lifecycleId(key, `task-${interim.toLowerCase()}`) as EventId,
    );
    task = this.database.repositories.tasks.findById(task.id);
    if (task === undefined) throw new Error("Task disappeared after worker failure transition");

    const rollbackFailure = await this.#recordAndRollback(request, task, identity, diagnostics);
    if (rollbackFailure !== undefined) return rollbackFailure;
    task = this.database.repositories.tasks.findById(task.id);
    if (task === undefined) throw new Error("Task disappeared after worker rollback");

    if (kind === "cancelled") {
      return this.#completeWithTransition(
        request,
        attempt,
        task,
        "CANCELLED",
        "cancelled",
        "Worker cancellation was confirmed and scoped output was rolled back",
      );
    }
    if (kind === "process_crash" || kind === "interrupted") {
      const completedAt = this.#now();
      this.database.persistAttemptCompletion({
        attemptId: attempt.id,
        completedAt,
        outcome: "interrupted",
        eventId: lifecycleId(key, "attempt-completed"),
        actor: request.actor,
      });
      return Object.freeze({
        status: "INTERRUPTED" as const,
        taskId: request.taskId,
        attemptCount: attempt.number,
        reason:
          kind === "interrupted"
            ? "Worker cancellation was confirmed for project pause; task remains resumable"
            : "Worker process outcome was not confirmed; task remains interrupted",
      });
    }
    const terminalErrorCode = nonRetryableAgentErrorCode(diagnostics);
    if (terminalErrorCode !== undefined) {
      return this.#completeWithTransition(
        request,
        attempt,
        task,
        "BLOCKED",
        "blocked",
        `Worker reported non-retryable ${terminalErrorCode}`,
      );
    }
    if (attempt.number >= MAX_TASK_ATTEMPTS) {
      return this.#completeWithTransition(
        request,
        attempt,
        task,
        "BLOCKED",
        "blocked",
        `Worker failed on all ${String(MAX_TASK_ATTEMPTS)} attempts`,
      );
    }
    const completedAt = this.#now();
    this.database.persistAttemptCompletion({
      attemptId: attempt.id,
      completedAt,
      outcome: "retrying",
      eventId: lifecycleId(key, "attempt-completed"),
      actor: request.actor,
    });
    return undefined;
  }

  async #recordAndRollback(
    request: ExecuteTaskLifecycleRequest,
    task: Task,
    identity: AttemptIdentity,
    diagnostics: Readonly<JsonObject>,
  ): Promise<TaskLifecycleResult | undefined> {
    const { attempt, key } = identity;
    const rollbackService = new AttemptRollbackService(this.database);
    const recordedAt = this.#now();
    const recorded = await rollbackService.recordFailedAttempt({
      projectId: request.projectId,
      taskId: request.taskId,
      attemptId: attempt.id,
      diagnostics,
      recordedAt,
      actor: request.actor,
      eventId: lifecycleId(key, "rollback-planned"),
    });
    if (recorded.status === "STOPPED") {
      return await this.#finishBlocked(
        request,
        attempt,
        `Failure evidence could not be persisted: ${recorded.reason}`,
        `ROLLBACK_${recorded.code}`,
      );
    }
    const rolledBack = await rollbackService.rollbackFailedAttempt({
      projectId: request.projectId,
      taskId: request.taskId,
      attemptId: attempt.id,
      workspacePath: request.workspacePath,
      rolledBackAt: this.#now(),
      actor: request.actor,
      appliedEventId: lifecycleId(key, "rollback-applied"),
      conflictEventId: lifecycleId(key, "rollback-conflict"),
    });
    if (rolledBack.status === "STOPPED") {
      return await this.#finishBlocked(
        request,
        attempt,
        `Scoped rollback stopped: ${rolledBack.reason}`,
        `ROLLBACK_${rolledBack.code}`,
      );
    }
    if (!rolledBack.workspaceReadyForRetry) {
      return await this.#finishBlocked(
        request,
        attempt,
        "Scoped rollback preserved workspace changes that require a user decision",
        "RECOVERY_REQUIRED",
      );
    }
    return undefined;
  }

  #completeWithTransition(
    request: ExecuteTaskLifecycleRequest,
    attempt: Attempt,
    task: Task,
    target: Extract<TaskState, "BLOCKED" | "CANCELLED" | "RETRYING">,
    outcome: "blocked" | "cancelled" | "retrying",
    reason: string,
  ): TaskLifecycleResult {
    const completedAt = this.#now();
    const key = lifecycleKey(request.projectId, request.taskId, attempt.number);
    const transition = stateTransitionService.transitionTask(task, target, {
      actor: request.actor,
      occurredAt: completedAt,
      reason,
    });
    this.database.persistAttemptCompletion({
      attemptId: attempt.id,
      completedAt,
      outcome,
      eventId: lifecycleId(key, "attempt-completed"),
      actor: request.actor,
      transition,
    });
    if (target === "RETRYING") {
      return Object.freeze({
        status: "STOPPED" as const,
        code: "RECOVERY_REQUIRED" as const,
        taskId: request.taskId,
        attemptCount: attempt.number,
        reason: "Retry transition persisted without continuing the loop",
      });
    }
    return Object.freeze({
      status: target as "BLOCKED" | "CANCELLED",
      taskId: request.taskId,
      attemptCount: attempt.number,
      reason,
    });
  }

  async #finishBlocked(
    request: ExecuteTaskLifecycleRequest,
    attempt: Attempt,
    reason: string,
    code: TaskLifecycleStopCode,
  ): Promise<TaskLifecycleResult> {
    const task = this.database.repositories.tasks.findById(request.taskId);
    if (task === undefined) return stopped("TASK_NOT_FOUND", request, attempt.number, reason);
    if (task.state !== "BLOCKED" && task.state !== "COMPLETED" && task.state !== "CANCELLED") {
      if (stateTransitionService.canTransitionTask(task.state, "BLOCKED")) {
        this.#completeWithTransition(request, attempt, task, "BLOCKED", "blocked", reason);
      }
    }
    return stopped(code, request, attempt.number, reason);
  }

  async #blockWithoutNewAttempt(
    request: ExecuteTaskLifecycleRequest,
    task: Task,
    attemptCount: number,
    reason: string,
  ): Promise<TaskLifecycleResult> {
    if (
      task.state !== "BLOCKED" &&
      stateTransitionService.canTransitionTask(task.state, "BLOCKED")
    ) {
      const occurredAt = this.#now();
      this.database.persistStateTransition(
        stateTransitionService.transitionTask(task, "BLOCKED", {
          actor: request.actor,
          occurredAt,
          reason,
        }),
        lifecycleId(
          lifecycleKey(request.projectId, request.taskId, attemptCount),
          "task-blocked",
        ) as EventId,
      );
    }
    return Object.freeze({
      status: "BLOCKED" as const,
      taskId: request.taskId,
      attemptCount,
      reason,
    });
  }
}
