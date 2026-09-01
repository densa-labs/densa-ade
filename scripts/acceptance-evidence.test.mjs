import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  AcceptanceEvidenceService,
  ValidationPipeline,
  renderAcceptanceReport,
} from "@densa-ade/core";
import { DensaAdeDatabase } from "@densa-ade/core/persistence";

const createdAt = "2026-08-28T01:00:00.000Z";

function clock() {
  let offset = 0;
  return () => new Date(Date.parse(createdAt) + offset++ * 1_000).toISOString();
}

function seed(database, suffix, criteria) {
  const project = {
    id: `project-${suffix}`,
    name: "Acceptance evidence",
    state: "DRAFT",
    executionMode: "guided",
    createdAt,
    updatedAt: createdAt,
  };
  const phase = {
    id: `phase-${suffix}`,
    projectId: project.id,
    title: "Evidence gate",
    state: "PENDING",
    position: 0,
    createdAt,
    updatedAt: createdAt,
  };
  const task = {
    id: `task-${suffix}`,
    projectId: project.id,
    phaseId: phase.id,
    title: "Prove every criterion",
    state: "PENDING",
    position: 0,
    acceptanceCriteria: criteria,
    dependencyIds: [],
    createdAt,
    updatedAt: createdAt,
  };
  database.repositories.projects.create(project);
  database.repositories.phases.create(phase);
  database.repositories.tasks.create(task);
  return { project, phase, task };
}

function validator(id, status) {
  return {
    id,
    version: "1.0.0",
    async validate() {
      return { status, diagnostics: [], retryRelevant: status !== "passed" };
    },
  };
}

test("mixed deterministic, targeted, browser, and independent evidence map per criterion", async () => {
  const database = DensaAdeDatabase.openInMemory();
  try {
    const { project, task } = seed(database, "mixed", [
      "Build succeeds.",
      "Targeted error case passes.",
      "Browser flow works.",
      "Independent review finds no defect.",
    ]);
    const result = await new ValidationPipeline(database, { now: clock() }).execute({
      runId: "validation-mixed",
      projectId: project.id,
      taskId: task.id,
      workspacePath: "/tmp/densa-acceptance-evidence",
      plan: {
        id: "mixed-evidence",
        version: "1",
        validators: [
          {
            validator: validator("build", "passed"),
            evidenceSource: "deterministic_validator",
            policy: "required",
            relatedAcceptanceCriteria: [task.acceptanceCriteria[0]],
          },
          {
            validator: validator("targeted-error", "failed"),
            evidenceSource: "targeted_check",
            policy: "required",
            relatedAcceptanceCriteria: [task.acceptanceCriteria[1]],
          },
          {
            validator: validator("browser-flow", "passed"),
            evidenceSource: "browser_test",
            policy: "required",
            relatedAcceptanceCriteria: [task.acceptanceCriteria[2]],
          },
          {
            validator: validator("fresh-review", "passed"),
            evidenceSource: "independent_review",
            policy: "required",
            relatedAcceptanceCriteria: [task.acceptanceCriteria[3]],
          },
        ],
      },
    });

    assert.deepEqual(
      result.acceptanceReport.criteria.map(({ state, evidence }) => ({
        state,
        source: evidence[0].source,
      })),
      [
        { state: "satisfied", source: "deterministic_validator" },
        { state: "failed", source: "targeted_check" },
        { state: "satisfied", source: "browser_test" },
        { state: "satisfied", source: "independent_review" },
      ],
    );
    assert.equal(result.canComplete, false);
  } finally {
    database.close();
  }
});

test("unsupported criteria require an audited manual approval and replay after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "densa-manual-acceptance-"));
  const path = join(directory, "runtime.sqlite");
  try {
    const database = DensaAdeDatabase.open(path);
    const { project, task } = seed(database, "manual", [
      "The build passes.",
      "A human confirms the product language is accurate.",
    ]);
    const pipeline = await new ValidationPipeline(database, { now: clock() }).execute({
      runId: "validation-manual",
      projectId: project.id,
      taskId: task.id,
      workspacePath: "/tmp/densa-acceptance-evidence",
      plan: {
        id: "manual-evidence",
        version: "1",
        manualReviewCriteria: [task.acceptanceCriteria[1]],
        validators: [
          {
            validator: validator("build", "passed"),
            evidenceSource: "deterministic_validator",
            policy: "required",
            relatedAcceptanceCriteria: [task.acceptanceCriteria[0]],
          },
        ],
      },
    });
    assert.deepEqual(
      pipeline.acceptanceReport.criteria.map((criterion) => criterion.state),
      ["satisfied", "manual_review_required"],
    );
    assert.equal(pipeline.canComplete, false);

    const approved = new AcceptanceEvidenceService(database, {
      now: () => "2026-08-28T01:30:00.000Z",
    }).recordManualReview({
      id: "manual-review-1",
      projectId: project.id,
      taskId: task.id,
      validationRunId: pipeline.run.id,
      criterion: task.acceptanceCriteria[1],
      decision: "approved",
      actor: "user:local api_key=actor-secret-fixture",
      reason: "Reviewed the final product copy; api_key=super-secret-fixture.",
    });
    assert.equal(approved.canComplete, true);
    assert.equal(approved.criteria[1].state, "satisfied");
    assert.equal(approved.criteria[1].evidence[0].source, "manual_review");
    assert.match(approved.criteria[1].evidence[0].summary, /api_key=\[REDACTED\]/u);
    assert.doesNotMatch(approved.criteria[1].evidence[0].summary, /super-secret-fixture/u);
    const storedReview = database.repositories.manualAcceptanceReviews.findById("manual-review-1");
    assert.match(storedReview.actor, /api_key=\[REDACTED\]/u);
    assert.doesNotMatch(storedReview.actor, /actor-secret-fixture/u);
    const reviewEvent = database.repositories.events.replay({ projectId: project.id }).at(-1);
    assert.match(reviewEvent.actor, /api_key=\[REDACTED\]/u);
    assert.doesNotMatch(JSON.stringify(reviewEvent), /actor-secret-fixture/u);
    assert.equal(reviewEvent.type, "MANUAL_ACCEPTANCE_REVIEW_RECORDED");
    database.close();

    const reopened = DensaAdeDatabase.open(path);
    const replayed = new AcceptanceEvidenceService(reopened, {
      now: () => "2026-08-28T01:31:00.000Z",
    }).evaluateTask("validation-manual");
    assert.equal(replayed.canComplete, true);
    assert.equal(replayed.criteria[1].state, "satisfied");
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("required unevaluated criteria block task and phase gates and render concisely", async () => {
  const database = DensaAdeDatabase.openInMemory();
  try {
    const { project, phase, task } = seed(database, "unevaluated", [
      "The build passes.",
      "Malformed input returns a structured error.",
    ]);
    const outcome = await new ValidationPipeline(database, { now: clock() }).execute({
      runId: "validation-unevaluated",
      projectId: project.id,
      taskId: task.id,
      workspacePath: "/tmp/densa-acceptance-evidence",
      plan: {
        id: "incomplete-evidence",
        version: "1",
        validators: [
          {
            validator: validator("build", "passed"),
            evidenceSource: "deterministic_validator",
            policy: "required",
            relatedAcceptanceCriteria: [task.acceptanceCriteria[0]],
          },
        ],
      },
    });
    assert.equal(outcome.passed, true);
    assert.equal(outcome.canComplete, false);
    assert.equal(outcome.acceptanceReport.criteria[1].state, "not_evaluated");

    const gate = new AcceptanceEvidenceService(database, {
      now: () => "2026-08-28T01:45:00.000Z",
    }).evaluatePhase({
      projectId: project.id,
      phaseId: phase.id,
      validationRunIdsByTask: { [task.id]: outcome.run.id },
    });
    assert.equal(gate.canComplete, false);
    assert.deepEqual(gate.blockers, [
      { taskId: task.id, reason: "Required acceptance criteria are unresolved." },
    ]);
    assert.equal(
      renderAcceptanceReport(outcome.acceptanceReport),
      "Acceptance: 1/2 satisfied; task completion blocked.\n" +
        "- [SATISFIED] The build passes. (deterministic_validator)\n" +
        "- [NOT EVALUATED] Malformed input returns a structured error.\n",
    );
  } finally {
    database.close();
  }
});

test("manual review cannot be fabricated for an automatically evaluated criterion", async () => {
  const database = DensaAdeDatabase.openInMemory();
  try {
    const { project, task } = seed(database, "manual-boundary", ["The test passes."]);
    const outcome = await new ValidationPipeline(database, { now: clock() }).execute({
      runId: "validation-manual-boundary",
      projectId: project.id,
      taskId: task.id,
      workspacePath: "/tmp/densa-acceptance-evidence",
      plan: {
        id: "automatic-only",
        version: "1",
        validators: [
          {
            validator: validator("test", "passed"),
            evidenceSource: "deterministic_validator",
            policy: "required",
            relatedAcceptanceCriteria: [task.acceptanceCriteria[0]],
          },
        ],
      },
    });
    assert.throws(
      () =>
        new AcceptanceEvidenceService(database).recordManualReview({
          id: "manual-review-forged",
          projectId: project.id,
          taskId: task.id,
          validationRunId: outcome.run.id,
          criterion: task.acceptanceCriteria[0],
          decision: "approved",
          actor: "worker:self",
          reason: "The worker said it is done.",
        }),
      /explicitly manual criterion/u,
    );
  } finally {
    database.close();
  }
});

test("legacy results with an unspecified source stay visible but cannot satisfy acceptance", () => {
  const database = DensaAdeDatabase.openInMemory();
  try {
    const { task } = seed(database, "legacy", ["The behavior is proven."]);
    database.repositories.validationRuns.create({
      id: "validation-legacy",
      taskId: task.id,
      validatorId: "legacy-plan",
      planId: "legacy-plan",
      planVersion: "1",
      manualReviewCriteria: [],
      startedAt: createdAt,
      completedAt: "2026-08-28T01:01:00.000Z",
      passed: true,
    });
    database.repositories.validationResults.create({
      id: "validation-result-legacy",
      validationRunId: "validation-legacy",
      position: 0,
      validatorId: "old-validator",
      validatorVersion: "1",
      evidenceSource: "legacy_unspecified",
      policy: "required",
      status: "passed",
      startedAt: createdAt,
      completedAt: "2026-08-28T01:01:00.000Z",
      diagnostics: [],
      relatedAcceptanceCriteria: [task.acceptanceCriteria[0]],
      retryRelevant: false,
    });

    const report = new AcceptanceEvidenceService(database, {
      now: () => "2026-08-28T01:02:00.000Z",
    }).evaluateTask("validation-legacy");
    assert.equal(report.canComplete, false);
    assert.equal(report.criteria[0].state, "not_evaluated");
    assert.equal(report.criteria[0].evidence[0].status, "inconclusive");
  } finally {
    database.close();
  }
});
