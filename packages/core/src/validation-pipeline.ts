import {
  isoTimestampSchema,
  validationResultIdSchema,
  validatorOutcomeSchema,
  type AttemptId,
  type AcceptanceEvidenceSource,
  type AcceptanceReport,
  type JsonObject,
  type ProjectId,
  type TaskId,
  type ValidationDiagnostic,
  type ValidationPolicy,
  type ValidationResult,
  type ValidationRun,
  type ValidationRunId,
  type ValidatorOutcome,
} from "@densa/protocol";

import { buildAcceptanceReport } from "./acceptance-evidence.js";
import type { DensaDatabase } from "./persistence/database.js";

export const MAX_VALIDATION_DIAGNOSTICS_BYTES = 32 * 1_024;
export const MAX_VALIDATION_METADATA_BYTES = 64 * 1_024;

export interface ValidatorContext {
  readonly projectId: ProjectId;
  readonly taskId: TaskId;
  readonly attemptId?: AttemptId;
  readonly validationRunId: ValidationRunId;
  readonly workspacePath: string;
  readonly relatedAcceptanceCriteria: readonly string[];
  /** Immutable evidence persisted for validators earlier in this same plan run. */
  readonly priorResults: readonly ValidationResult[];
  readonly signal?: AbortSignal;
}

/** Provider-neutral validation plugin. Validators return evidence; Core owns the verdict. */
export interface Validator {
  readonly id: string;
  readonly version: string;
  validate(context: ValidatorContext): Promise<ValidatorOutcome>;
}

export interface ValidationPlanEntry {
  readonly validator: Validator;
  readonly evidenceSource: Exclude<
    AcceptanceEvidenceSource,
    "legacy_unspecified" | "manual_review"
  >;
  readonly policy: ValidationPolicy;
  readonly relatedAcceptanceCriteria: readonly string[];
}

export interface ValidationPlan {
  readonly id: string;
  readonly version: string;
  /** Array order is authoritative and is persisted as each result's position. */
  readonly validators: readonly ValidationPlanEntry[];
  /** Criteria unsupported by automatic validators and intentionally routed to audited review. */
  readonly manualReviewCriteria?: readonly string[];
}

export interface ExecuteValidationPlanRequest {
  readonly runId: ValidationRunId;
  readonly projectId: ProjectId;
  readonly taskId: TaskId;
  readonly attemptId?: AttemptId;
  readonly workspacePath: string;
  readonly plan: ValidationPlan;
  readonly signal?: AbortSignal;
}

export interface ValidationPipelineReplay {
  readonly run: ValidationRun;
  readonly results: readonly ValidationResult[];
}

export interface ValidationPipelineOutcome extends ValidationPipelineReplay {
  readonly passed: boolean;
  readonly acceptanceReport: AcceptanceReport;
  readonly canComplete: boolean;
}

export interface ValidationPipelineOptions {
  readonly now?: () => string;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 4_096 ? message : `${message.slice(0, 4_080)}...[truncated]`;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function boundDiagnostics(diagnostics: readonly ValidationDiagnostic[]): ValidationDiagnostic[] {
  const retained: ValidationDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    if (serializedBytes([...retained, diagnostic]) > MAX_VALIDATION_DIAGNOSTICS_BYTES) {
      const truncation = {
        severity: "warning" as const,
        code: "DIAGNOSTICS_TRUNCATED",
        message:
          "Additional validator diagnostics were truncated at the Core persistence boundary.",
      };
      if (serializedBytes([...retained, truncation]) <= MAX_VALIDATION_DIAGNOSTICS_BYTES) {
        retained.push(Object.freeze(truncation));
      }
      break;
    }
    retained.push(Object.freeze({ ...diagnostic }));
  }
  return retained;
}

function normalizeOutcome(input: unknown): ValidatorOutcome {
  const outcome = validatorOutcomeSchema.parse(input);
  const metadata = {
    ...(outcome.command === undefined ? {} : { command: outcome.command }),
    ...(outcome.config === undefined ? {} : { config: outcome.config }),
  };
  if (serializedBytes(metadata) > MAX_VALIDATION_METADATA_BYTES) {
    throw new Error("Validator command/config metadata exceeds the 64 KiB persistence limit");
  }
  return Object.freeze({
    status: outcome.status,
    ...(outcome.command === undefined ? {} : { command: [...outcome.command] }),
    ...(outcome.config === undefined
      ? {}
      : { config: Object.freeze({ ...outcome.config }) as Readonly<JsonObject> }),
    ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
    diagnostics: boundDiagnostics(outcome.diagnostics),
    retryRelevant: outcome.retryRelevant,
  });
}

function providerErrorOutcome(error: unknown): ValidatorOutcome {
  return Object.freeze({
    status: "error" as const,
    diagnostics: [
      Object.freeze({
        severity: "error" as const,
        code: "VALIDATOR_EXECUTION_FAILED",
        message: errorMessage(error),
      }),
    ],
    retryRelevant: true,
  });
}

function validatePlan(
  request: ExecuteValidationPlanRequest,
  acceptanceCriteria: readonly string[],
): void {
  const plan = request.plan;
  if (
    request.workspacePath.trim().length === 0 ||
    plan.id.trim().length === 0 ||
    plan.version.trim().length === 0 ||
    plan.validators.length === 0
  ) {
    throw new Error(
      "Validation plans require a workspace, ID, version, and at least one validator",
    );
  }
  const seen = new Set<string>();
  const accepted = new Set(acceptanceCriteria);
  const manual = new Set(plan.manualReviewCriteria ?? []);
  if (
    accepted.size !== acceptanceCriteria.length ||
    manual.size !== (plan.manualReviewCriteria?.length ?? 0) ||
    [...manual].some((criterion) => !accepted.has(criterion))
  ) {
    throw new Error("Manual-review criteria must be unique task-owned acceptance criteria");
  }
  for (const entry of plan.validators) {
    const key = `${entry.validator.id}\0${entry.validator.version}`;
    if (
      (entry.policy !== "required" && entry.policy !== "advisory") ||
      entry.validator.id.trim().length === 0 ||
      entry.validator.version.trim().length === 0 ||
      typeof entry.validator.validate !== "function" ||
      !(
        ["deterministic_validator", "targeted_check", "browser_test", "independent_review"] as const
      ).includes(entry.evidenceSource) ||
      seen.has(key) ||
      new Set(entry.relatedAcceptanceCriteria).size !== entry.relatedAcceptanceCriteria.length ||
      entry.relatedAcceptanceCriteria.some((criterion) => !accepted.has(criterion)) ||
      entry.relatedAcceptanceCriteria.some((criterion) => manual.has(criterion))
    ) {
      throw new Error(
        "Validation plan entries require unique versioned validators and task-owned acceptance criteria",
      );
    }
    seen.add(key);
  }
}

/**
 * Runs validators serially in plan order and persists each result before moving to the next plugin.
 * Required validators pass only with an explicit `passed` result; advisory results never change the
 * aggregate verdict. An interrupted process therefore leaves a replayable partial run.
 */
export class ValidationPipeline {
  readonly #now: () => string;

  constructor(
    private readonly database: DensaDatabase,
    options: ValidationPipelineOptions = {},
  ) {
    const clock = options.now ?? (() => new Date().toISOString());
    this.#now = () => isoTimestampSchema.parse(clock());
  }

  async execute(request: ExecuteValidationPlanRequest): Promise<ValidationPipelineOutcome> {
    const task = this.database.repositories.tasks.findById(request.taskId);
    if (task?.projectId !== request.projectId) {
      throw new Error("Validation task does not belong to the requested project");
    }
    if (
      request.attemptId !== undefined &&
      this.database.repositories.attempts.findById(request.attemptId)?.taskId !== task.id
    ) {
      throw new Error("Validation attempt does not belong to the requested task");
    }
    validatePlan(request, task.acceptanceCriteria);

    const startedAt = this.#now();
    this.database.repositories.validationRuns.create({
      id: request.runId,
      taskId: task.id,
      ...(request.attemptId === undefined ? {} : { attemptId: request.attemptId }),
      validatorId: request.plan.id,
      planId: request.plan.id,
      planVersion: request.plan.version,
      manualReviewCriteria: [...(request.plan.manualReviewCriteria ?? [])],
      startedAt,
    });

    for (const [position, entry] of request.plan.validators.entries()) {
      const resultStartedAt = this.#now();
      let outcome: ValidatorOutcome;
      try {
        const priorResults = this.database.repositories.validationResults.listByRunId(
          request.runId,
        );
        outcome = normalizeOutcome(
          await entry.validator.validate({
            projectId: request.projectId,
            taskId: request.taskId,
            validationRunId: request.runId,
            ...(request.attemptId === undefined ? {} : { attemptId: request.attemptId }),
            workspacePath: request.workspacePath,
            relatedAcceptanceCriteria: Object.freeze([...entry.relatedAcceptanceCriteria]),
            priorResults: Object.freeze(priorResults),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          }),
        );
      } catch (error) {
        outcome = providerErrorOutcome(error);
      }
      const result = Object.freeze({
        id: validationResultIdSchema.parse(`${request.runId}:result:${String(position)}`),
        validationRunId: request.runId,
        position,
        validatorId: entry.validator.id,
        validatorVersion: entry.validator.version,
        evidenceSource: entry.evidenceSource,
        policy: entry.policy,
        status: outcome.status,
        startedAt: resultStartedAt,
        completedAt: this.#now(),
        ...(outcome.command === undefined ? {} : { command: outcome.command }),
        ...(outcome.config === undefined ? {} : { config: outcome.config }),
        ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
        diagnostics: outcome.diagnostics,
        relatedAcceptanceCriteria: [...entry.relatedAcceptanceCriteria],
        retryRelevant: outcome.retryRelevant,
      });
      this.database.repositories.validationResults.create(result);
    }

    const results = this.database.repositories.validationResults.listByRunId(request.runId);
    const passed = results.every(
      (result) => result.policy === "advisory" || result.status === "passed",
    );
    this.database.repositories.validationRuns.recordCompleted(request.runId, this.#now(), passed);
    const replay = this.replay(request.runId);
    if (replay === undefined || replay.run.passed === undefined) {
      throw new Error("Completed validation run could not be replayed");
    }
    const acceptanceReport = buildAcceptanceReport({
      task,
      run: replay.run,
      results: replay.results,
      manualReviews: this.database.repositories.manualAcceptanceReviews.listByRunId(request.runId),
      generatedAt: this.#now(),
    });
    return Object.freeze({
      ...replay,
      passed: replay.run.passed,
      acceptanceReport,
      canComplete: replay.run.passed && acceptanceReport.canComplete,
    });
  }

  replay(runId: ValidationRunId): ValidationPipelineReplay | undefined {
    const run = this.database.repositories.validationRuns.findById(runId);
    if (run === undefined) return undefined;
    return Object.freeze({
      run,
      results: this.database.repositories.validationResults.listByRunId(runId),
    });
  }
}
