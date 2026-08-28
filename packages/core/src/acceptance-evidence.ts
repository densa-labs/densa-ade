import {
  acceptanceReportSchema,
  eventIdSchema,
  isoTimestampSchema,
  manualAcceptanceReviewSchema,
  manualAcceptanceReviewIdSchema,
  type AcceptanceCriterionEvaluation,
  type AcceptanceEvidence,
  type AcceptanceReport,
  type EventId,
  type ManualAcceptanceReview,
  type ManualAcceptanceReviewId,
  type ProjectId,
  type PhaseId,
  type Task,
  type TaskId,
  type ValidationResult,
  type ValidationRun,
  type ValidationRunId,
} from "@densa/protocol";

import type { DensaDatabase } from "./persistence/database.js";
import { redactPortableText } from "./persistence/portable-project.js";

export interface AcceptanceEvidenceSnapshot {
  readonly task: Task;
  readonly run: ValidationRun;
  readonly results: readonly ValidationResult[];
  readonly manualReviews: readonly ManualAcceptanceReview[];
  readonly generatedAt: string;
}

export interface RecordManualAcceptanceReviewRequest {
  readonly id: ManualAcceptanceReviewId;
  readonly projectId: ProjectId;
  readonly taskId: TaskId;
  readonly validationRunId: ValidationRunId;
  readonly criterion: string;
  readonly decision: "approved" | "rejected";
  readonly actor: string;
  readonly reason: string;
  readonly occurredAt?: string;
  readonly eventId?: EventId;
}

export interface EvaluatePhaseAcceptanceRequest {
  readonly projectId: ProjectId;
  readonly phaseId: PhaseId;
  readonly validationRunIdsByTask: Readonly<Record<string, ValidationRunId>>;
}

export interface PhaseAcceptanceBlocker {
  readonly taskId: TaskId;
  readonly reason: string;
}

export interface PhaseAcceptanceGate {
  readonly canComplete: boolean;
  readonly taskReports: readonly AcceptanceReport[];
  readonly blockers: readonly PhaseAcceptanceBlocker[];
}

function resultEvidence(result: ValidationResult): AcceptanceEvidence {
  const status =
    result.evidenceSource === "legacy_unspecified"
      ? "inconclusive"
      : result.status === "passed"
        ? "supports"
        : result.status === "skipped"
          ? "inconclusive"
          : "contradicts";
  return Object.freeze({
    source: result.evidenceSource,
    status,
    validatorId: result.validatorId,
    validationResultId: result.id,
    summary: `${result.validatorId}@${result.validatorVersion} returned ${result.status}.`,
  });
}

function manualEvidence(review: ManualAcceptanceReview): AcceptanceEvidence {
  return Object.freeze({
    source: "manual_review",
    status: review.decision === "approved" ? "supports" : "contradicts",
    manualReviewId: review.id,
    summary: `Manual review ${review.decision}: ${review.reason}`,
  });
}

function criterionState(
  manualReviewRequired: boolean,
  results: readonly ValidationResult[],
  review: ManualAcceptanceReview | undefined,
): AcceptanceCriterionEvaluation["state"] {
  if (manualReviewRequired) {
    if (review?.decision === "approved") return "satisfied";
    if (review?.decision === "rejected") return "failed";
    return "manual_review_required";
  }

  const required = results.filter(
    (result) => result.policy === "required" && result.evidenceSource !== "legacy_unspecified",
  );
  if (required.some((result) => result.status === "failed" || result.status === "error")) {
    return "failed";
  }
  if (required.length === 0 || required.some((result) => result.status === "skipped")) {
    return "not_evaluated";
  }
  return required.every((result) => result.status === "passed") ? "satisfied" : "not_evaluated";
}

/**
 * Deterministically derives criterion state from durable Core-owned evidence. Worker prose has no
 * representation in this input, so it cannot satisfy a criterion.
 */
export function buildAcceptanceReport(snapshot: AcceptanceEvidenceSnapshot): AcceptanceReport {
  const { task, run, results, manualReviews } = snapshot;
  isoTimestampSchema.parse(snapshot.generatedAt);
  if (run.taskId !== task.id) throw new Error("Acceptance evidence run belongs to another task");
  if (results.some((result) => result.validationRunId !== run.id)) {
    throw new Error("Acceptance evidence contains a result from another run");
  }
  if (manualReviews.some((review) => review.validationRunId !== run.id)) {
    throw new Error("Acceptance evidence contains a manual review from another run");
  }

  const manualCriteria = new Set(run.manualReviewCriteria);
  if (
    new Set(task.acceptanceCriteria).size !== task.acceptanceCriteria.length ||
    manualCriteria.size !== run.manualReviewCriteria.length ||
    run.manualReviewCriteria.some((criterion) => !task.acceptanceCriteria.includes(criterion))
  ) {
    throw new Error("Validation run records invalid manual-review criteria");
  }

  const criteria = task.acceptanceCriteria.map((criterion, position) => {
    const linkedResults = results.filter((result) =>
      result.relatedAcceptanceCriteria.includes(criterion),
    );
    if (manualCriteria.has(criterion) && linkedResults.length > 0) {
      throw new Error("A manual criterion cannot also consume automatic validator evidence");
    }
    const review = manualReviews.find((candidate) => candidate.criterionPosition === position);
    if (review !== undefined && review.criterion !== criterion) {
      throw new Error("Manual acceptance review no longer matches its criterion");
    }
    const evidence = [
      ...linkedResults.map(resultEvidence),
      ...(review === undefined ? [] : [manualEvidence(review)]),
    ];
    return Object.freeze({
      position,
      criterion,
      state: criterionState(manualCriteria.has(criterion), linkedResults, review),
      evidence: Object.freeze(evidence),
    });
  });

  return acceptanceReportSchema.parse({
    formatVersion: 1,
    taskId: task.id,
    validationRunId: run.id,
    generatedAt: snapshot.generatedAt,
    canComplete: criteria.every((criterion) => criterion.state === "satisfied"),
    criteria,
  });
}

export function renderAcceptanceReport(report: AcceptanceReport): string {
  const satisfied = report.criteria.filter((criterion) => criterion.state === "satisfied").length;
  const lines = [
    `Acceptance: ${String(satisfied)}/${String(report.criteria.length)} satisfied; task completion ${report.canComplete ? "allowed" : "blocked"}.`,
  ];
  for (const criterion of report.criteria) {
    const label = criterion.state.toUpperCase().replaceAll("_", " ");
    const sources = [...new Set(criterion.evidence.map((evidence) => evidence.source))];
    lines.push(
      `- [${label}] ${criterion.criterion}${sources.length === 0 ? "" : ` (${sources.join(", ")})`}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export class AcceptanceEvidenceService {
  readonly #now: () => string;

  constructor(
    private readonly database: DensaDatabase,
    options: { readonly now?: () => string } = {},
  ) {
    const clock = options.now ?? (() => new Date().toISOString());
    this.#now = () => isoTimestampSchema.parse(clock());
  }

  evaluateTask(validationRunId: ValidationRunId): AcceptanceReport {
    const run = this.database.repositories.validationRuns.findById(validationRunId);
    if (run === undefined) throw new Error("Acceptance evidence validation run is missing");
    const task = this.database.repositories.tasks.findById(run.taskId);
    if (task === undefined) throw new Error("Acceptance evidence task is missing");
    return buildAcceptanceReport({
      task,
      run,
      results: this.database.repositories.validationResults.listByRunId(run.id),
      manualReviews: this.database.repositories.manualAcceptanceReviews.listByRunId(run.id),
      generatedAt: this.#now(),
    });
  }

  recordManualReview(request: RecordManualAcceptanceReviewRequest): AcceptanceReport {
    const occurredAt = isoTimestampSchema.parse(request.occurredAt ?? this.#now());
    const actor = request.actor.trim();
    const reason = redactPortableText(request.reason.trim());
    const run = this.database.repositories.validationRuns.findById(request.validationRunId);
    const task = this.database.repositories.tasks.findById(request.taskId);
    if (
      run === undefined ||
      task === undefined ||
      run.taskId !== task.id ||
      task.projectId !== request.projectId ||
      run.completedAt === undefined
    ) {
      throw new Error("Manual review requires a completed validation run for the requested task");
    }
    const criterionPosition = task.acceptanceCriteria.indexOf(request.criterion);
    if (
      criterionPosition < 0 ||
      !run.manualReviewCriteria.includes(request.criterion) ||
      actor.length === 0 ||
      reason.length === 0
    ) {
      throw new Error("Manual review requires an explicitly manual criterion, actor, and reason");
    }
    const review = manualAcceptanceReviewSchema.parse({
      id: manualAcceptanceReviewIdSchema.parse(request.id),
      validationRunId: run.id,
      criterionPosition,
      criterion: request.criterion,
      decision: request.decision,
      actor,
      reason,
      occurredAt,
    });
    const existing = this.database.repositories.manualAcceptanceReviews.findById(review.id);
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(review)) {
        throw new Error("Manual review ID already records different evidence");
      }
      return this.evaluateTask(run.id);
    }

    this.database.transaction((repositories) => {
      repositories.manualAcceptanceReviews.create(review);
      repositories.events.append({
        id: request.eventId ?? eventIdSchema.parse(`${review.id}:event`),
        projectId: task.projectId,
        phaseId: task.phaseId,
        taskId: task.id,
        type: "MANUAL_ACCEPTANCE_REVIEW_RECORDED",
        eventVersion: 1,
        occurredAt,
        actor,
        payload: {
          manualReviewId: review.id,
          validationRunId: run.id,
          criterionPosition,
          criterion: request.criterion,
          decision: request.decision,
          reason,
        },
      });
    });
    return this.evaluateTask(run.id);
  }

  evaluatePhase(request: EvaluatePhaseAcceptanceRequest): PhaseAcceptanceGate {
    const phase = this.database.repositories.phases.findById(request.phaseId);
    if (phase?.projectId !== request.projectId) {
      throw new Error("Acceptance phase does not belong to the requested project");
    }
    const tasks = this.database.repositories.tasks
      .listByProjectId(request.projectId)
      .filter((task) => task.phaseId === phase.id);
    const taskReports: AcceptanceReport[] = [];
    const blockers: PhaseAcceptanceBlocker[] = [];
    for (const task of tasks) {
      const runId = request.validationRunIdsByTask[task.id];
      if (runId === undefined) {
        blockers.push(Object.freeze({ taskId: task.id, reason: "No validation run selected." }));
        continue;
      }
      const report = this.evaluateTask(runId);
      if (report.taskId !== task.id) {
        throw new Error("Selected phase validation run belongs to another task");
      }
      taskReports.push(report);
      const run = this.database.repositories.validationRuns.findById(runId);
      if (run?.passed !== true) {
        blockers.push(
          Object.freeze({
            taskId: task.id,
            reason: "The selected validation plan did not pass.",
          }),
        );
      } else if (!report.canComplete) {
        blockers.push(
          Object.freeze({
            taskId: task.id,
            reason: "Required acceptance criteria are unresolved.",
          }),
        );
      }
    }
    return Object.freeze({
      canComplete: blockers.length === 0,
      taskReports: Object.freeze(taskReports),
      blockers: Object.freeze(blockers),
    });
  }
}
