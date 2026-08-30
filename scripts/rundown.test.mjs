import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ProjectRundownError,
  ProjectRundownService,
  StateTransitionService,
  presentProjectRundown,
  renderProjectRundown,
} from "@densa-ade/core";
import { DensaAdeDatabase } from "@densa-ade/core/persistence";

const workspacePath = "/tmp/densa-rundown-fixture";
const baseTime = Date.parse("2026-08-30T00:00:00.000Z");

function clock() {
  let tick = 0;
  return () => new Date(baseTime + tick++ * 1_000).toISOString();
}

function transition(database, now, entityType, id, state) {
  const transitions = new StateTransitionService();
  const repository =
    entityType === "project"
      ? database.repositories.projects
      : entityType === "phase"
        ? database.repositories.phases
        : database.repositories.tasks;
  const entity = repository.findById(id);
  assert.ok(entity);
  const occurredAt = now();
  const context = { actor: "rundown:test", occurredAt, reason: `Move to ${state}` };
  const result =
    entityType === "project"
      ? transitions.transitionProject(entity, state, context)
      : entityType === "phase"
        ? transitions.transitionPhase(entity, state, context)
        : transitions.transitionTask(entity, state, context);
  database.persistStateTransition(result, `event-${entityType}-${id}-${state}`);
}

function seedBase() {
  const database = DensaAdeDatabase.openInMemory();
  const now = clock();
  const createdAt = now();
  database.repositories.projects.create({
    id: "project-rundown",
    name: "Rundown facts",
    state: "DRAFT",
    executionMode: "phase",
    createdAt,
    updatedAt: createdAt,
  });
  database.repositories.phases.create({
    id: "phase-build",
    projectId: "project-rundown",
    title: "Build",
    state: "PENDING",
    position: 0,
    createdAt,
    updatedAt: createdAt,
  });
  database.repositories.tasks.create({
    id: "task-build",
    projectId: "project-rundown",
    phaseId: "phase-build",
    title: "Build exact facts",
    state: "PENDING",
    position: 0,
    acceptanceCriteria: ["The rundown uses persisted facts."],
    dependencyIds: [],
    createdAt,
    updatedAt: createdAt,
  });
  transition(database, now, "project", "project-rundown", "PLANNING");
  transition(database, now, "project", "project-rundown", "READY");
  transition(database, now, "project", "project-rundown", "RUNNING");
  transition(database, now, "phase", "phase-build", "READY");
  const phaseStartedAt = now();
  const phase = database.repositories.phases.findById("phase-build");
  assert.ok(phase);
  const phaseStart = new StateTransitionService().transitionPhase(phase, "RUNNING", {
    actor: "rundown:test",
    occurredAt: phaseStartedAt,
    reason: "Start the phase",
  });
  database.persistStateTransition(phaseStart, "event-phase-phase-build-RUNNING");
  transition(database, now, "task", "task-build", "READY");
  transition(database, now, "task", "task-build", "RUNNING");
  return { database, now, phaseStartedAt };
}

function fakeGit(status = "reachable") {
  return {
    async inspect(_workspace, commitShas) {
      return {
        status: "available",
        headSha: "fedcba9876543210",
        branch: "densa-ade/run/rundown",
        dirty: false,
        commits: commitShas.map((sha) => ({ sha, status })),
      };
    },
  };
}

function completePhaseFixture() {
  const { database, now, phaseStartedAt } = seedBase();
  const startedAt = now();
  database.repositories.attempts.create({
    id: "attempt-build-1",
    taskId: "task-build",
    number: 1,
    startedAt,
  });
  transition(database, now, "task", "task-build", "VALIDATING");
  database.repositories.validationRuns.create({
    id: "validation-build-1",
    taskId: "task-build",
    attemptId: "attempt-build-1",
    validatorId: "unit-test",
    planId: "task-plan",
    planVersion: "1",
    manualReviewCriteria: [],
    startedAt,
  });
  database.repositories.validationResults.create({
    id: "validation-result-build-1",
    validationRunId: "validation-build-1",
    position: 0,
    validatorId: "unit-test",
    validatorVersion: "1",
    evidenceSource: "deterministic_validator",
    policy: "required",
    status: "passed",
    startedAt,
    completedAt: now(),
    diagnostics: [],
    relatedAcceptanceCriteria: ["The rundown uses persisted facts."],
    retryRelevant: false,
  });
  const validationCompletedAt = now();
  database.repositories.validationRuns.recordCompleted(
    "validation-build-1",
    validationCompletedAt,
    true,
  );
  database.repositories.attempts.recordCommit("attempt-build-1", "task-build", "abc1234567890def");
  database.repositories.attempts.recordCompleted("attempt-build-1", now());
  transition(database, now, "task", "task-build", "COMPLETED");
  transition(database, now, "phase", "phase-build", "VALIDATING");
  transition(database, now, "phase", "phase-build", "COMPLETED");
  database.repositories.decisions.create({
    id: "decision-core-facts",
    projectId: "project-rundown",
    kind: "decision",
    statement: "Core owns rundown facts.",
    title: "Core owns facts",
    rationale: "A Master may not replace counts.",
    category: "rundown.authority",
    source: "system",
    scope: "project",
    status: "active",
    affectedPhaseIds: [],
    affectedTaskIds: [],
    createdAt: now(),
  });
  const reportGeneratedAt = now();
  database.repositories.events.append({
    id: "event-phase-validation-passed",
    projectId: "project-rundown",
    phaseId: "phase-build",
    type: "PHASE_VALIDATION_PASSED",
    eventVersion: 1,
    occurredAt: reportGeneratedAt,
    actor: "rundown:test",
    payload: { status: "passed", validatorId: "phase-suite" },
  });
  database.repositories.events.append({
    id: "event-phase-report-generated",
    projectId: "project-rundown",
    phaseId: "phase-build",
    type: "PHASE_REPORT_GENERATED",
    eventVersion: 1,
    occurredAt: reportGeneratedAt,
    actor: "rundown:test",
    payload: { outcome: "completed", reportPath: ".densa-ade/reports/phase-build.md" },
  });
  database.repositories.phaseReports.create({
    formatVersion: 1,
    projectId: "project-rundown",
    phaseId: "phase-build",
    phaseTitle: "Build",
    outcome: "completed",
    executionMode: "phase",
    roadmapRevisionNumber: 0,
    phaseStartedAt,
    generatedAt: reportGeneratedAt,
    reportPath: ".densa-ade/reports/phase-build.md",
    tasksCompleted: [{ taskId: "task-build", title: "Build exact facts", attemptCount: 1 }],
    validations: [
      {
        scope: "task",
        taskId: "task-build",
        validatorId: "unit-test",
        validationRunId: "validation-build-1",
        validationResultIds: ["validation-result-build-1"],
        passed: true,
        summary: "Task validation passed.",
        startedAt,
        completedAt: validationCompletedAt,
      },
      {
        scope: "phase",
        validatorId: "phase-suite",
        validationResultIds: [],
        passed: true,
        summary: "Phase validation passed.",
      },
    ],
    independentReviews: [],
    commits: [{ taskId: "task-build", sha: "abc1234567890def" }],
    filesChanged: [{ taskId: "task-build", paths: ["src/rundown.ts"] }],
    importantDecisions: [
      {
        id: "decision-core-facts",
        title: "Core owns facts",
        rationale: "A Master may not replace counts.",
      },
    ],
    roadmapChanges: [],
    retriesAndFailures: [],
    unresolvedIssues: [],
    phaseValidation: {
      status: "passed",
      validatorId: "phase-suite",
      summary: "Phase validation passed.",
    },
  });
  return { database, now };
}

test("project and phase rundowns retain exact DB, validator, Git, decision, and drill-down facts", async () => {
  const { database, now } = completePhaseFixture();
  try {
    const service = new ProjectRundownService(database, { now, git: fakeGit() });
    const project = await service.generate({
      kind: "project_status",
      projectId: "project-rundown",
      workspacePath,
    });
    assert.deepEqual(project.phaseStateCounts, [{ state: "COMPLETED", count: 1 }]);
    assert.deepEqual(project.taskStateCounts, [{ state: "COMPLETED", count: 1 }]);
    assert.deepEqual(project.validation, {
      runCount: 1,
      passedCount: 1,
      failedCount: 0,
      incompleteCount: 0,
      resultCount: 1,
      runs: [
        {
          id: "validation-build-1",
          taskId: "task-build",
          validatorId: "unit-test",
          status: "passed",
          resultIds: ["validation-result-build-1"],
        },
      ],
    });
    assert.ok(
      project.drillDownReferences.some(
        (entry) => entry.kind === "validation_result" && entry.id === "validation-result-build-1",
      ),
    );
    assert.deepEqual(project.activeDecisionIds, ["decision-core-facts"]);

    const phase = await service.generate({
      kind: "phase_completion",
      projectId: "project-rundown",
      phaseId: "phase-build",
      workspacePath,
    });
    assert.deepEqual(phase.phaseReport, {
      phaseId: "phase-build",
      reportPath: ".densa-ade/reports/phase-build.md",
      outcome: "completed",
      generatedAt: phase.phaseReport.generatedAt,
      verification: "verified",
      taskIds: ["task-build"],
      validationRunIds: ["validation-build-1"],
      commitShas: ["abc1234567890def"],
    });
    assert.match(renderProjectRundown(phase), /DB\/Git\/validation facts verified/u);
    assert.match(
      renderProjectRundown(phase),
      /1 completed tasks, 1 validation runs, 1 Git commits/u,
    );
  } finally {
    database.close();
  }
});

test("phase rundown fails closed when persisted commits are not reachable from Git HEAD", async () => {
  const { database, now } = completePhaseFixture();
  try {
    const service = new ProjectRundownService(database, {
      now,
      git: fakeGit("unreachable"),
    });
    await assert.rejects(
      service.generate({
        kind: "phase_completion",
        projectId: "project-rundown",
        phaseId: "phase-build",
        workspacePath,
      }),
      (error) =>
        error instanceof ProjectRundownError &&
        error.code === "INTERNAL_INVARIANT_VIOLATION" &&
        /not reachable/u.test(error.message),
    );
  } finally {
    database.close();
  }
});

test("usage-wait rundown says reset unknown and omits unavailable token and cost metrics", async () => {
  const { database, now } = seedBase();
  try {
    transition(database, now, "task", "task-build", "WAITING_FOR_USAGE");
    transition(database, now, "project", "project-rundown", "WAITING_FOR_USAGE");
    database.repositories.events.append({
      id: "event-usage-limited",
      projectId: "project-rundown",
      phaseId: "phase-build",
      taskId: "task-build",
      type: "USAGE_LIMIT_REACHED",
      eventVersion: 1,
      occurredAt: now(),
      actor: "rundown:test",
      payload: { usageState: { status: "limited" } },
    });
    const rundown = await new ProjectRundownService(database, {
      now,
      git: fakeGit(),
    }).generate({
      kind: "usage_waiting",
      projectId: "project-rundown",
      workspacePath,
    });
    assert.deepEqual(rundown.usage, {
      status: "limited",
      sourceEventId: "event-usage-limited",
      taskId: "task-build",
      resetAt: { status: "unknown", reason: "The provider did not report a reset time." },
    });
    assert.doesNotMatch(JSON.stringify(rundown), /token|cost/iu);
    assert.match(renderProjectRundown(rundown), /reset unknown/u);
  } finally {
    database.close();
  }
});

test("blocked and retry/failure rundowns use persisted attempt and validator history", async () => {
  const { database, now } = seedBase();
  try {
    for (const number of [1, 2]) {
      const attemptId = `attempt-failed-${String(number)}`;
      const validationId = `validation-failed-${String(number)}`;
      const startedAt = now();
      database.repositories.attempts.create({
        id: attemptId,
        taskId: "task-build",
        number,
        startedAt,
        completedAt: now(),
      });
      database.repositories.validationRuns.create({
        id: validationId,
        taskId: "task-build",
        attemptId,
        validatorId: "unit-test",
        manualReviewCriteria: [],
        startedAt,
        completedAt: now(),
        passed: false,
      });
      database.repositories.validationResults.create({
        id: `result-failed-${String(number)}`,
        validationRunId: validationId,
        position: 0,
        validatorId: "unit-test",
        validatorVersion: "1",
        evidenceSource: "deterministic_validator",
        policy: "required",
        status: "failed",
        startedAt,
        completedAt: now(),
        diagnostics: [{ severity: "error", message: `Failure ${String(number)}` }],
        relatedAcceptanceCriteria: ["The rundown uses persisted facts."],
        retryRelevant: true,
      });
    }
    transition(database, now, "task", "task-build", "BLOCKED");
    transition(database, now, "phase", "phase-build", "BLOCKED");
    transition(database, now, "project", "project-rundown", "BLOCKED");
    const service = new ProjectRundownService(database, { now, git: fakeGit() });
    for (const kind of ["blocked_project", "retry_failure_history", "recent_changes"]) {
      const rundown = await service.generate({
        kind,
        projectId: "project-rundown",
        workspacePath,
      });
      assert.equal(rundown.project.state, "BLOCKED");
      assert.deepEqual(rundown.retryHistory, [
        {
          taskId: "task-build",
          attemptCount: 2,
          attemptIds: ["attempt-failed-1", "attempt-failed-2"],
          failedValidationCount: 2,
          failedValidationRunIds: ["validation-failed-1", "validation-failed-2"],
          latestFailureSummary: "Failure 2",
        },
      ]);
      assert.ok(rundown.recentChanges.length > 0);
    }
  } finally {
    database.close();
  }
});

test("a fake Master can select drill-downs but cannot replace counts or target stale facts", async () => {
  const { database, now } = completePhaseFixture();
  try {
    const rundown = await new ProjectRundownService(database, {
      now,
      git: fakeGit(),
    }).generate({
      kind: "project_status",
      projectId: "project-rundown",
      workspacePath,
    });
    await assert.rejects(
      presentProjectRundown(rundown, {
        async plan() {
          return {
            formatVersion: 1,
            factsDigest: rundown.factsDigest,
            highlightedReferences: [],
            taskCount: 999,
          };
        },
      }),
    );
    await assert.rejects(
      presentProjectRundown(rundown, {
        async plan() {
          return {
            formatVersion: 1,
            factsDigest: "0".repeat(64),
            highlightedReferences: [],
          };
        },
      }),
      (error) =>
        error instanceof ProjectRundownError && error.code === "INTERNAL_INVARIANT_VIOLATION",
    );
    const rendered = await presentProjectRundown(rundown, {
      async plan() {
        return {
          formatVersion: 1,
          factsDigest: rundown.factsDigest,
          highlightedReferences: [{ kind: "validation_run", id: "validation-build-1" }],
        };
      },
    });
    assert.match(rendered, /Tasks: 1 \(COMPLETED=1\)/u);
    assert.match(rendered, /Master-selected drill-downs/u);
    assert.match(rendered, /validation_run:validation-build-1/u);
    assert.equal(rundown.taskStateCounts[0].count, 1);
  } finally {
    database.close();
  }
});
