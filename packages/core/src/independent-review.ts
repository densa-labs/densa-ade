import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, readFile, readlink } from "node:fs/promises";
import { resolve, sep } from "node:path";

import { isTerminalAgentEvent, type AgentAdapter } from "@densa/agent-sdk";
import {
  independentReviewOutputJsonSchema,
  independentReviewOutputSchema,
  isoTimestampSchema,
  type IndependentReview,
  type IndependentReviewId,
  type IndependentReviewOutput,
  type EventId,
  type JsonObject,
  type PhaseId,
  type ProjectId,
  type RoadmapRiskLevel,
  type TaskId,
  type ValidationRunId,
  type ValidatorOutcome,
} from "@densa/protocol";

import type { DensaDatabase } from "./persistence/database.js";
import { redactPortableText } from "./persistence/portable-project.js";
import type {
  PhaseLifecycleValidator,
  PhaseValidationProvider,
  PhaseValidationOutcome,
  PhaseValidationRequest,
} from "./phase-orchestrator.js";
import type { ValidationPlan, Validator, ValidatorContext } from "./validation-pipeline.js";
import type {
  TaskLifecycleValidationOutcome,
  TaskLifecycleValidationRequest,
  TaskLifecycleValidator,
} from "./task-orchestrator.js";

export const MAX_INDEPENDENT_REVIEW_CONTEXT_BYTES = 128 * 1_024;
const MAX_REVIEW_TEXT_BYTES = 48 * 1_024;

export interface DeterministicReviewEvidence {
  readonly validatorId: string;
  readonly status: "passed" | "failed" | "error" | "skipped";
  readonly required: boolean;
  readonly summary: string;
}

export interface ExecuteIndependentReviewRequest {
  readonly id: IndependentReviewId;
  readonly reviewerRunId: string;
  readonly projectId: ProjectId;
  readonly taskId?: TaskId;
  readonly phaseId?: PhaseId;
  readonly validationRunId?: ValidationRunId;
  readonly validationEventId?: EventId;
  readonly workspacePath: string;
  readonly goal: string;
  readonly acceptanceCriteria: readonly string[];
  readonly relevantDiff: string;
  readonly deterministicResults: readonly DeterministicReviewEvidence[];
  readonly architectureConstraints: readonly string[];
  readonly adapter: AgentAdapter;
  readonly implementingWorkerRunId?: string;
  readonly signal?: AbortSignal;
}

export interface IndependentReviewServiceOptions {
  readonly now?: () => string;
  readonly workspaceFingerprint?: (workspacePath: string) => Promise<string>;
}

const MAX_FINGERPRINT_BYTES = 64 * 1_024 * 1_024;

async function gitBytes(cwd: string, args: readonly string[]): Promise<Buffer> {
  return await new Promise<Buffer>((resolveOutput, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    const child = spawn("git", ["-c", "core.fsmonitor=false", ...args], {
      cwd,
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        LC_ALL: "C",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
      },
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.stdout.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > MAX_FINGERPRINT_BYTES) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0 && length <= MAX_FINGERPRINT_BYTES) resolveOutput(Buffer.concat(chunks));
      else reject(new Error("Workspace fingerprint could not be bounded or read"));
    });
  });
}

async function gitWorkspaceFingerprint(workspacePath: string): Promise<string> {
  const [head, index, trackedDiff, untracked, ignored] = await Promise.all([
    gitBytes(workspacePath, ["rev-parse", "--verify", "HEAD"]),
    gitBytes(workspacePath, ["ls-files", "--stage", "-z", "--"]),
    gitBytes(workspacePath, ["diff", "--binary", "--full-index", "HEAD", "--"]),
    gitBytes(workspacePath, ["ls-files", "--others", "--exclude-standard", "-z", "--"]),
    gitBytes(workspacePath, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
      "--",
    ]),
  ]);
  const hash = createHash("sha256")
    .update("head\0")
    .update(head)
    .update("index\0")
    .update(index)
    .update("tracked\0")
    .update(trackedDiff);
  const root = `${resolve(workspacePath)}${sep}`;
  let retainedBytes =
    head.length + index.length + trackedDiff.length + untracked.length + ignored.length;
  for (const entry of untracked.toString("utf8").split("\0").filter(Boolean).sort()) {
    const absolute = resolve(workspacePath, entry);
    if (!absolute.startsWith(root)) throw new Error("Untracked fingerprint path escaped workspace");
    const metadata = await lstat(absolute);
    const content = metadata.isSymbolicLink()
      ? Buffer.from(await readlink(absolute), "utf8")
      : await readFile(absolute);
    retainedBytes += content.length;
    if (retainedBytes > MAX_FINGERPRINT_BYTES) {
      throw new Error("Workspace fingerprint exceeds the 64 MiB boundary");
    }
    hash.update("\0").update(entry).update("\0").update(content);
  }
  for (const entry of ignored.toString("utf8").split("\0").filter(Boolean).sort()) {
    const absolute = resolve(workspacePath, entry);
    if (!absolute.startsWith(root)) throw new Error("Ignored fingerprint path escaped workspace");
    const metadata = await lstat(absolute, { bigint: true });
    const description = [
      entry,
      metadata.mode.toString(),
      metadata.size.toString(),
      metadata.mtimeNs.toString(),
      metadata.ctimeNs.toString(),
    ].join("\0");
    retainedBytes += Buffer.byteLength(description, "utf8");
    if (retainedBytes > MAX_FINGERPRINT_BYTES) {
      throw new Error("Workspace fingerprint exceeds the 64 MiB boundary");
    }
    hash.update("\0ignored\0").update(description);
    if (metadata.isSymbolicLink()) hash.update("\0").update(await readlink(absolute));
  }
  return hash.digest("hex");
}

function clean(value: string): string {
  return redactPortableText(value).replace(/\s+/gu, " ").trim();
}

function bounded(value: string, maximumBytes = MAX_REVIEW_TEXT_BYTES): string {
  const redacted = redactPortableText(value);
  const bytes = Buffer.from(redacted, "utf8");
  if (bytes.length <= maximumBytes) return redacted;
  return `${bytes.subarray(0, maximumBytes - 32).toString("utf8")}\n...[truncated by Densa]`;
}

function reviewContext(request: ExecuteIndependentReviewRequest): Readonly<JsonObject> {
  return Object.freeze({
    role: "independent_reviewer",
    scope: request.taskId === undefined ? "phase" : "task",
    validationBoundaryId: request.validationRunId ?? request.validationEventId ?? "missing",
    goal: bounded(request.goal),
    acceptanceCriteria: request.acceptanceCriteria.map((criterion, criterionPosition) => ({
      criterionPosition,
      criterion: bounded(criterion, 4_096),
    })),
    relevantDiff: bounded(request.relevantDiff),
    deterministicResults: request.deterministicResults.map((result) => ({
      validatorId: clean(result.validatorId),
      status: result.status,
      required: result.required,
      summary: bounded(result.summary, 4_096),
    })),
    architectureConstraints: request.architectureConstraints.map((constraint) =>
      bounded(constraint, 4_096),
    ),
  });
}

function failedOutput(
  criteria: readonly string[],
  title: string,
  detail: string,
): IndependentReviewOutput {
  const safeTitle = clean(title) || "Independent review failed";
  const safeDetail = clean(detail) || "Reviewer failure provided no safe diagnostic detail.";
  return independentReviewOutputSchema.parse({
    verdict: "fail",
    summary: safeTitle,
    findings: [{ severity: "error", title: safeTitle, detail: safeDetail }],
    criteria: criteria.map((criterion, criterionPosition) => ({
      criterionPosition,
      criterion: bounded(criterion, 4_096),
      assessment: "unknown",
      rationale: "The reviewer did not return trustworthy structured evidence.",
    })),
    confidence: 0,
    unknowns: [safeDetail],
  });
}

function validateCriterionMapping(
  output: IndependentReviewOutput,
  acceptanceCriteria: readonly string[],
): IndependentReviewOutput {
  const mapped = output.criteria.map((entry) => entry.criterionPosition);
  if (
    new Set(mapped).size !== mapped.length ||
    mapped.length !== acceptanceCriteria.length ||
    mapped.some((position) => position < 0 || position >= acceptanceCriteria.length)
  ) {
    throw new Error("Reviewer criterion mapping must cover every supplied criterion exactly once");
  }
  return independentReviewOutputSchema.parse({
    ...output,
    criteria: output.criteria.map((entry) => ({
      ...entry,
      criterion: bounded(acceptanceCriteria[entry.criterionPosition] ?? "Unknown criterion", 4_096),
    })),
  });
}

function sanitizedOutput(output: IndependentReviewOutput): IndependentReviewOutput {
  const safe = (value: string, fallback: string): string =>
    bounded(value, 4_096).trim() || fallback;
  return independentReviewOutputSchema.parse({
    ...output,
    summary: safe(output.summary, "Reviewer summary was fully redacted."),
    findings: output.findings.map((finding) => ({
      ...finding,
      title: safe(finding.title, "Reviewer finding was fully redacted"),
      detail: safe(finding.detail, "Reviewer finding detail was fully redacted."),
    })),
    criteria: output.criteria.map((criterion) => ({
      ...criterion,
      ...(criterion.criterion === undefined
        ? {}
        : { criterion: safe(criterion.criterion, "Acceptance criterion was fully redacted.") }),
      rationale: safe(criterion.rationale, "Reviewer rationale was fully redacted."),
    })),
    unknowns: output.unknowns.map((unknown) =>
      safe(unknown, "Reviewer unknown was fully redacted."),
    ),
  });
}

export function independentReviewSupportsCompletion(output: IndependentReviewOutput): boolean {
  return (
    output.verdict !== "fail" &&
    output.criteria.every((criterion) => criterion.assessment === "satisfied") &&
    output.findings.every(
      (finding) => finding.severity !== "error" && finding.severity !== "critical",
    )
  );
}

export interface IndependentReviewIdentity {
  readonly id: IndependentReviewId;
  readonly reviewerRunId: string;
}

export function independentReviewStartedEventId(id: IndependentReviewId): EventId {
  return `${id}:started` as EventId;
}

export function independentReviewCompletedEventId(id: IndependentReviewId): EventId {
  return `${id}:completed` as EventId;
}

function createIndependentReviewIdentity(): IndependentReviewIdentity {
  const nonce = randomUUID();
  return {
    id: `independent-review-${nonce}` as IndependentReviewId,
    reviewerRunId: `independent-review-run-${nonce}`,
  };
}

/** Executes a Reviewer through AgentAdapter as a distinct, constrained, fresh logical run. */
export class IndependentReviewService {
  readonly #now: () => string;
  readonly #workspaceFingerprint: (workspacePath: string) => Promise<string>;

  constructor(
    private readonly database: DensaDatabase,
    options: IndependentReviewServiceOptions = {},
  ) {
    const clock = options.now ?? (() => new Date().toISOString());
    this.#now = () => isoTimestampSchema.parse(clock());
    this.#workspaceFingerprint = options.workspaceFingerprint ?? gitWorkspaceFingerprint;
  }

  async execute(request: ExecuteIndependentReviewRequest): Promise<IndependentReview> {
    if (
      (request.taskId === undefined) === (request.phaseId === undefined) ||
      (request.taskId !== undefined
        ? request.validationRunId === undefined || request.validationEventId !== undefined
        : request.validationEventId === undefined || request.validationRunId !== undefined) ||
      request.goal.trim().length === 0 ||
      request.acceptanceCriteria.length === 0 ||
      request.relevantDiff.trim().length === 0 ||
      request.deterministicResults.length === 0 ||
      request.deterministicResults.some(
        (result) => result.validatorId.trim().length === 0 || result.summary.trim().length === 0,
      ) ||
      request.architectureConstraints.length === 0 ||
      request.architectureConstraints.some((constraint) => constraint.trim().length === 0) ||
      request.reviewerRunId.trim().length === 0 ||
      request.reviewerRunId === request.implementingWorkerRunId
    ) {
      throw new Error(
        "Independent review requires one validation boundary, complete evidence, and a run distinct from the worker",
      );
    }
    const project = this.database.repositories.projects.findById(request.projectId);
    const task =
      request.taskId === undefined
        ? undefined
        : this.database.repositories.tasks.findById(request.taskId);
    const phase =
      request.phaseId === undefined
        ? undefined
        : this.database.repositories.phases.findById(request.phaseId);
    if (
      project === undefined ||
      (task !== undefined && task.projectId !== project.id) ||
      (phase !== undefined && phase.projectId !== project.id) ||
      (request.taskId !== undefined && task === undefined) ||
      (request.phaseId !== undefined && phase === undefined)
    ) {
      throw new Error("Independent review target does not belong to the requested project");
    }
    const validationRun =
      request.validationRunId === undefined
        ? undefined
        : this.database.repositories.validationRuns.findById(request.validationRunId);
    const validationEvent =
      request.validationEventId === undefined
        ? undefined
        : this.database.eventJournal.findById(request.validationEventId);
    if (
      (task !== undefined && validationRun?.taskId !== task.id) ||
      (phase !== undefined &&
        (validationEvent?.projectId !== project.id ||
          validationEvent.phaseId !== phase.id ||
          validationEvent.type !== "PHASE_VALIDATION_STARTED"))
    ) {
      throw new Error("Independent review is not bound to the authoritative validation boundary");
    }
    const expectedCriteria =
      task?.acceptanceCriteria ??
      this.database.repositories.masterRoadmaps
        .findByProjectId(request.projectId)
        ?.roadmap.phases.find((entry) => entry.id === phase?.id)?.completionCriteria;
    if (
      expectedCriteria !== undefined &&
      (expectedCriteria.length !== request.acceptanceCriteria.length ||
        expectedCriteria.some(
          (criterion, index) => criterion !== request.acceptanceCriteria[index],
        ))
    ) {
      throw new Error("Independent review criteria do not match the authoritative target criteria");
    }

    const context = reviewContext(request);
    const serializedContext = JSON.stringify(context);
    if (Buffer.byteLength(serializedContext, "utf8") > MAX_INDEPENDENT_REVIEW_CONTEXT_BYTES) {
      throw new Error("Independent review context exceeds the 128 KiB boundary");
    }
    const initialWorkspaceFingerprint = await this.#workspaceFingerprint(request.workspacePath);
    const requestedAt = this.#now();
    const contextHash = createHash("sha256").update(serializedContext).digest("hex");
    const intent: IndependentReview = {
      id: request.id,
      projectId: request.projectId,
      ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
      ...(request.phaseId === undefined ? {} : { phaseId: request.phaseId }),
      ...(request.validationRunId === undefined
        ? {}
        : { validationRunId: request.validationRunId }),
      ...(request.validationEventId === undefined
        ? {}
        : { validationEventId: request.validationEventId }),
      adapterId: request.adapter.adapterId,
      reviewerRunId: request.reviewerRunId,
      contextHash,
      requestedAt,
    };
    this.database.transaction((repositories) => {
      repositories.independentReviews.create(intent);
      repositories.events.append({
        id: independentReviewStartedEventId(request.id),
        projectId: request.projectId,
        ...(task === undefined ? {} : { phaseId: task.phaseId, taskId: task.id }),
        ...(phase === undefined ? {} : { phaseId: phase.id }),
        type: "INDEPENDENT_REVIEW_STARTED",
        eventVersion: 1,
        occurredAt: requestedAt,
        actor: "densa-core:independent-review",
        payload: {
          reviewId: request.id,
          reviewerRunId: request.reviewerRunId,
          contextHash,
          validationBoundaryId: request.validationRunId ?? request.validationEventId ?? "missing",
        },
      });
    });

    let output: IndependentReviewOutput | undefined;
    let failure: string | undefined;
    let terminalCount = 0;
    let wasAborted = false;
    const cancel = (): void => {
      wasAborted = true;
      void request.adapter.cancel(request.reviewerRunId).catch(() => undefined);
    };
    try {
      if (request.signal?.aborted === true) {
        failure = "Independent review was cancelled before the Reviewer started";
      } else {
        request.signal?.addEventListener("abort", cancel, { once: true });
      }
      if (failure !== undefined) throw new Error(failure);
      for await (const event of request.adapter.execute({
        runId: request.reviewerRunId,
        cwd: request.workspacePath,
        prompt: [
          "Act only as an independent reviewer. Do not defend or continue the implementing worker.",
          "Assess the supplied goal, criteria, diff, deterministic evidence, and architecture constraints.",
          "Return only the requested structured review. State unknowns instead of guessing.",
          serializedContext,
        ].join("\n\n"),
        outputSchema: independentReviewOutputJsonSchema,
        accessMode: "read-only",
      })) {
        if (!isTerminalAgentEvent(event)) continue;
        terminalCount += 1;
        if (event.runId !== request.reviewerRunId || terminalCount !== 1) {
          failure = "Reviewer emitted a malformed or mismatched terminal stream";
          output = undefined;
          continue;
        }
        if (event.outcome !== "succeeded" || event.finalMessage === undefined) {
          failure = event.error?.message ?? `Reviewer terminated with ${event.outcome}`;
          break;
        }
        try {
          output = sanitizedOutput(
            validateCriterionMapping(
              independentReviewOutputSchema.parse(JSON.parse(event.finalMessage)),
              request.acceptanceCriteria,
            ),
          );
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
      }
      if (terminalCount !== 1) {
        failure = `Reviewer produced ${String(terminalCount)} terminal events; expected exactly one`;
        output = undefined;
      } else if (output === undefined && failure === undefined) {
        failure = "Reviewer ended without a terminal structured response";
      }
      if (wasAborted || request.signal?.aborted === true) {
        failure = "Independent review was cancelled before its result could be accepted";
        output = undefined;
      }
    } catch (error) {
      output = undefined;
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      request.signal?.removeEventListener("abort", cancel);
    }
    try {
      if (
        (await this.#workspaceFingerprint(request.workspacePath)) !== initialWorkspaceFingerprint
      ) {
        output = undefined;
        failure = "Reviewer changed the validated workspace despite read-only access";
      }
    } catch (error) {
      output = undefined;
      failure = error instanceof Error ? error.message : String(error);
    }
    if (failure !== undefined) output = undefined;
    output ??= failedOutput(
      request.acceptanceCriteria,
      "Independent review was not confirmed",
      failure ?? "Unknown reviewer failure",
    );
    output = sanitizedOutput(output);
    const completedAt = this.#now();
    return this.database.transaction((repositories) => {
      const completed = repositories.independentReviews.complete(request.id, completedAt, output);
      repositories.events.append({
        id: independentReviewCompletedEventId(request.id),
        projectId: request.projectId,
        ...(task === undefined ? {} : { phaseId: task.phaseId, taskId: task.id }),
        ...(phase === undefined ? {} : { phaseId: phase.id }),
        type: "INDEPENDENT_REVIEW_COMPLETED",
        eventVersion: 1,
        occurredAt: completedAt,
        actor: "densa-core:independent-review",
        payload: {
          reviewId: request.id,
          reviewerRunId: request.reviewerRunId,
          contextHash,
          verdict: output.verdict,
        },
      });
      return completed;
    });
  }
}

export interface IndependentReviewValidatorOptions extends Omit<
  ExecuteIndependentReviewRequest,
  | "id"
  | "reviewerRunId"
  | "projectId"
  | "taskId"
  | "phaseId"
  | "validationRunId"
  | "validationEventId"
  | "workspacePath"
  | "acceptanceCriteria"
  | "deterministicResults"
  | "signal"
> {
  readonly service: IndependentReviewService;
  readonly createReviewIdentity?: (context: ValidatorContext) => IndependentReviewIdentity;
}

/** Validation plugin adapter for task-scoped independent review. */
export class IndependentReviewValidator implements Validator {
  readonly id = "independent-ai-review";
  readonly version = "1";

  constructor(private readonly options: IndependentReviewValidatorOptions) {}

  async validate(context: ValidatorContext): Promise<ValidatorOutcome> {
    const { service, createReviewIdentity, ...reviewOptions } = this.options;
    const identity = (createReviewIdentity ?? createIndependentReviewIdentity)(context);
    const review = await service.execute({
      ...reviewOptions,
      ...identity,
      projectId: context.projectId,
      taskId: context.taskId,
      validationRunId: context.validationRunId,
      workspacePath: context.workspacePath,
      acceptanceCriteria: context.relatedAcceptanceCriteria,
      deterministicResults: context.priorResults.map((result) => ({
        validatorId: `${result.validatorId}@${result.validatorVersion}`,
        status: result.status,
        required: result.policy === "required",
        summary:
          result.diagnostics[0]?.message ??
          `${result.validatorId} completed with status ${result.status}`,
      })),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    if (review.output === undefined)
      throw new Error("Independent review did not persist an outcome");
    const supportsCompletion = independentReviewSupportsCompletion(review.output);
    return {
      status: supportsCompletion ? "passed" : "failed",
      config: {
        reviewId: review.id,
        verdict: review.output.verdict,
        confidence: review.output.confidence,
      },
      diagnostics: review.output.findings.map((finding) => ({
        severity:
          finding.severity === "critical" || finding.severity === "error"
            ? "error"
            : finding.severity === "warning"
              ? "warning"
              : "info",
        code: `INDEPENDENT_REVIEW_${finding.severity.toUpperCase()}`,
        message: `${finding.title}: ${finding.detail}`,
      })),
      retryRelevant: !supportsCompletion,
    };
  }
}

export interface FreshContextTaskLifecycleValidatorOptions {
  readonly deterministic: TaskLifecycleValidator;
  readonly service: IndependentReviewService;
  readonly adapter: AgentAdapter;
  readonly buildReviewInput: (request: TaskLifecycleValidationRequest) => Readonly<{
    goal: string;
    relevantDiff: string;
    architectureConstraints: readonly string[];
    implementingWorkerRunId?: string;
  }>;
  readonly createReviewIdentity?: (
    request: TaskLifecycleValidationRequest,
  ) => IndependentReviewIdentity;
}

/** Task validator that runs deterministic evidence first, then a fresh read-only Reviewer. */
export class FreshContextTaskLifecycleValidator implements TaskLifecycleValidator {
  readonly validatorId: string;
  readonly providesIndependentReview = true;

  constructor(private readonly options: FreshContextTaskLifecycleValidatorOptions) {
    this.validatorId = `${options.deterministic.validatorId}+independent-review`;
  }

  async validate(request: TaskLifecycleValidationRequest): Promise<TaskLifecycleValidationOutcome> {
    const deterministic = await this.options.deterministic.validate(request);
    const input = this.options.buildReviewInput(request);
    const identity = (this.options.createReviewIdentity ?? createIndependentReviewIdentity)(
      request,
    );
    const review = await this.options.service.execute({
      ...identity,
      projectId: request.projectId,
      taskId: request.task.id,
      validationRunId: request.validationRunId,
      workspacePath: request.workspacePath,
      goal: input.goal,
      acceptanceCriteria: request.task.acceptanceCriteria,
      relevantDiff: input.relevantDiff,
      deterministicResults: [
        {
          validatorId: this.options.deterministic.validatorId,
          status: deterministic.passed ? "passed" : "failed",
          required: true,
          summary: JSON.stringify(deterministic.diagnostics),
        },
      ],
      architectureConstraints: input.architectureConstraints,
      adapter: this.options.adapter,
      ...(input.implementingWorkerRunId === undefined
        ? {}
        : { implementingWorkerRunId: input.implementingWorkerRunId }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (review.output === undefined) throw new Error("Task review did not persist an outcome");
    const reviewPassed = independentReviewSupportsCompletion(review.output);
    return Object.freeze({
      passed: deterministic.passed && reviewPassed,
      independentReviewId: review.id,
      diagnostics: Object.freeze({
        deterministic: deterministic.diagnostics,
        independentReview: {
          id: review.id,
          verdict: review.output.verdict,
          summary: review.output.summary,
        },
      }),
    });
  }
}

export function requiresIndependentReview(input: {
  readonly riskLevel: RoadmapRiskLevel;
  readonly phaseFinal?: boolean;
}): boolean {
  return input.phaseFinal === true || input.riskLevel === "high" || input.riskLevel === "critical";
}

/** Adds required fresh-context review to the default plan for risky or phase-final work. */
export function withDefaultIndependentReview(input: {
  readonly plan: ValidationPlan;
  readonly riskLevel: RoadmapRiskLevel;
  readonly phaseFinal?: boolean;
  readonly reviewer?: Validator;
  readonly relatedAcceptanceCriteria: readonly string[];
}): ValidationPlan {
  if (!requiresIndependentReview(input)) return input.plan;
  const existingIndex = input.plan.validators.findIndex(
    (entry) => entry.evidenceSource === "independent_review",
  );
  if (existingIndex >= 0) {
    const existing = input.plan.validators[existingIndex];
    if (existing === undefined) throw new Error("Independent review plan entry disappeared");
    return Object.freeze({
      ...input.plan,
      validators: Object.freeze([
        ...input.plan.validators.filter((_entry, index) => index !== existingIndex),
        Object.freeze({
          ...existing,
          policy: "required" as const,
          relatedAcceptanceCriteria: Object.freeze([
            ...new Set([...existing.relatedAcceptanceCriteria, ...input.relatedAcceptanceCriteria]),
          ]),
        }),
      ]),
    });
  }
  if (input.reviewer === undefined) {
    throw new Error("Risky and phase-final validation plans require an independent reviewer");
  }
  return Object.freeze({
    ...input.plan,
    validators: Object.freeze([
      ...input.plan.validators,
      Object.freeze({
        validator: input.reviewer,
        evidenceSource: "independent_review" as const,
        policy: "required" as const,
        relatedAcceptanceCriteria: Object.freeze([...input.relatedAcceptanceCriteria]),
      }),
    ]),
  });
}

export interface FreshContextPhaseValidatorOptions {
  readonly deterministic: PhaseValidationProvider;
  readonly service: IndependentReviewService;
  readonly adapter: AgentAdapter;
  readonly buildReviewInput: (request: PhaseValidationRequest) => Readonly<{
    goal: string;
    acceptanceCriteria: readonly string[];
    relevantDiff: string;
    architectureConstraints: readonly string[];
    implementingWorkerRunId?: string;
  }>;
  readonly createReviewIdentity?: (request: PhaseValidationRequest) => IndependentReviewIdentity;
}

/** Phase-final validator whose verdict is the conjunction of deterministic checks and review. */
export class FreshContextPhaseValidator implements PhaseLifecycleValidator {
  readonly validatorId: string;
  readonly providesIndependentReview = true;

  constructor(private readonly options: FreshContextPhaseValidatorOptions) {
    this.validatorId = `${options.deterministic.validatorId}+independent-review`;
  }

  async validate(request: PhaseValidationRequest): Promise<PhaseValidationOutcome> {
    const deterministic = await this.options.deterministic.validate(request);
    const input = this.options.buildReviewInput(request);
    const identity = (this.options.createReviewIdentity ?? createIndependentReviewIdentity)(
      request,
    );
    const review = await this.options.service.execute({
      ...identity,
      projectId: request.projectId,
      phaseId: request.phase.id,
      validationEventId: request.validationEventId,
      workspacePath: request.workspacePath,
      goal: input.goal,
      acceptanceCriteria: input.acceptanceCriteria,
      relevantDiff: input.relevantDiff,
      deterministicResults: deterministic.checks.map((check) => ({
        validatorId: check.validatorId,
        status: check.passed ? "passed" : "failed",
        required: true,
        summary: check.summary,
      })),
      architectureConstraints: input.architectureConstraints,
      adapter: this.options.adapter,
      ...(input.implementingWorkerRunId === undefined
        ? {}
        : { implementingWorkerRunId: input.implementingWorkerRunId }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    const reviewOutput = review.output;
    if (reviewOutput === undefined) throw new Error("Phase review did not persist an outcome");
    const reviewPassed = independentReviewSupportsCompletion(reviewOutput);
    return Object.freeze({
      passed: deterministic.passed && reviewPassed,
      independentReviewId: review.id,
      summary: deterministic.passed
        ? `Deterministic phase validation passed; independent review: ${reviewOutput.summary}`
        : `Deterministic phase validation failed; independent review cannot override it: ${reviewOutput.summary}`,
      checks: Object.freeze([
        ...deterministic.checks,
        Object.freeze({
          validatorId: "independent-ai-review",
          passed: reviewPassed,
          summary: reviewOutput.summary,
        }),
      ]),
    });
  }
}
