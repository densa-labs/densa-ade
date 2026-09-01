import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  IndependentReviewService,
  PhaseLifecycleOrchestrator,
  SingleTaskPhaseExecutor,
  StateTransitionService,
  RoadmapMutationService,
} from "@densa-ade/core";

test("manual intervention must be applied before a phase executor starts the worker", async () => {
  let workerStarted = false;
  const executor = new SingleTaskPhaseExecutor(
    {
      async execute() {
        workerStarted = true;
        throw new Error("must not execute");
      },
    },
    {
      async build() {
        return {};
      },
    },
  );
  const result = await executor.execute({
    projectId: "project-phase",
    phaseId: "phase.build",
    taskId: "task.alpha",
    workspacePath: "/tmp/project",
    actor: "phase:test",
    recontextualization: {
      changedPaths: ["src/manual.ts"],
      previousGitHead: "a".repeat(40),
      currentGitHead: "b".repeat(40),
      detectedAt: "2026-08-31T00:00:00.000Z",
    },
  });
  assert.equal(result.status, "STOPPED");
  assert.equal(result.code, "INVALID_REQUEST");
  assert.equal(workerStarted, false);
});
import { DensaAdeDatabase } from "@densa-ade/core/persistence";
import { masterRoadmapSchema } from "@densa-ade/protocol";
import { FakeAgentAdapter } from "@densa-ade/testing";

const baseTime = Date.parse("2026-08-27T10:00:00.000Z");
let globalSequence = 0;

function now() {
  globalSequence += 1;
  return new Date(baseTime + globalSequence * 1_000).toISOString();
}

function roadmapTask(id, dependencyIds = []) {
  return {
    id,
    title: `Deliver ${id}`,
    goal: `Complete ${id}.`,
    executable: true,
    dependencyIds,
    acceptanceCriteria: [`${id} has deterministic evidence.`],
    riskLevel: "medium",
    expectedValidators: ["unit_test"],
  };
}

function roadmap() {
  return masterRoadmapSchema.parse({
    formatVersion: 1,
    projectGoal: "Prove one complete serial phase lifecycle.",
    phases: [
      {
        id: "phase.build",
        title: "Build",
        goal: "Build two dependency-ordered tasks.",
        required: true,
        completionCriteria: ["Both tasks and phase validation pass."],
        tasks: [roadmapTask("task.alpha"), roadmapTask("task.beta", ["task.alpha"])],
      },
      {
        id: "phase.release",
        title: "Release",
        goal: "Prepare the next phase without executing it.",
        required: true,
        completionCriteria: ["Release is ready."],
        tasks: [roadmapTask("task.release", ["task.beta"])],
      },
    ],
  });
}

function transition(database, entityType, entityId, state, reason = "test transition") {
  const service = new StateTransitionService();
  const repository =
    entityType === "project"
      ? database.repositories.projects
      : entityType === "phase"
        ? database.repositories.phases
        : database.repositories.tasks;
  const entity = repository.findById(entityId);
  assert.ok(entity);
  const occurredAt = now();
  const change =
    entityType === "project"
      ? service.transitionProject(entity, state, { actor: "phase:test", occurredAt, reason })
      : entityType === "phase"
        ? service.transitionPhase(entity, state, { actor: "phase:test", occurredAt, reason })
        : service.transitionTask(entity, state, { actor: "phase:test", occurredAt, reason });
  database.persistStateTransition(change, `event-phase-test-${globalSequence}`);
}

function seed(database, executionMode) {
  const persistedRoadmap = roadmap();
  const createdAt = now();
  database.repositories.projects.create({
    id: "project-phase",
    name: "Phase proof",
    state: "DRAFT",
    executionMode,
    createdAt,
    updatedAt: createdAt,
  });
  for (const [phasePosition, phase] of persistedRoadmap.phases.entries()) {
    database.repositories.phases.create({
      id: phase.id,
      projectId: "project-phase",
      title: phase.title,
      state: "PENDING",
      position: phasePosition,
      createdAt,
      updatedAt: createdAt,
    });
    for (const [taskPosition, task] of phase.tasks.entries()) {
      database.repositories.tasks.create({
        id: task.id,
        projectId: "project-phase",
        phaseId: phase.id,
        title: task.title,
        state: "PENDING",
        position: taskPosition,
        acceptanceCriteria: task.acceptanceCriteria,
        dependencyIds: task.dependencyIds,
        createdAt,
        updatedAt: createdAt,
      });
    }
  }
  database.persistInitialMasterRoadmap({
    projectId: "project-phase",
    roadmap: persistedRoadmap,
    revisionNumber: 0,
    createdAt,
    updatedAt: createdAt,
  });
  transition(database, "project", "project-phase", "PLANNING");
  transition(database, "project", "project-phase", "READY");
  transition(database, "project", "project-phase", "RUNNING");
  transition(database, "phase", "phase.build", "READY");
}

function completingExecutor(database, order) {
  let active = 0;
  return {
    async execute(request) {
      active += 1;
      assert.equal(active, 1, "phase execution must remain serial");
      order.push(request.taskId);
      const attemptId = `attempt-${request.taskId}`;
      const validationId = `validation-${request.taskId}`;
      const commitSha = `commit-${request.taskId}`;
      const startedAt = now();
      database.repositories.attempts.create({
        id: attemptId,
        taskId: request.taskId,
        number: 1,
        startedAt,
      });
      transition(database, "task", request.taskId, "RUNNING");
      transition(database, "task", request.taskId, "VALIDATING");
      database.repositories.validationRuns.create({
        id: validationId,
        taskId: request.taskId,
        attemptId,
        validatorId: "fake-task-validator",
        startedAt,
      });
      database.repositories.validationRuns.recordCompleted(validationId, now(), true);
      database.repositories.attempts.recordCommit(attemptId, request.taskId, commitSha);
      database.repositories.attempts.recordCompleted(attemptId, now());
      database.repositories.events.append({
        id: `event-commit-${request.taskId}`,
        projectId: request.projectId,
        phaseId: request.phaseId,
        taskId: request.taskId,
        type: "TASK_COMMITTED",
        eventVersion: 1,
        occurredAt: now(),
        actor: request.actor,
        payload: { commitSha, intendedPaths: [`src/${request.taskId}.ts`] },
      });
      transition(database, "task", request.taskId, "COMPLETED");
      active -= 1;
      return { status: "COMPLETED", taskId: request.taskId, attemptCount: 1, commitSha };
    },
  };
}

async function recordPhaseReview(
  database,
  projectId,
  phaseId,
  validationEventId,
  workspacePath,
  verdict = "pass",
) {
  const id = `review-confirmed-${phaseId}`;
  if (database.repositories.independentReviews.findById(id) !== undefined) return id;
  const roadmapPhase = database.repositories.masterRoadmaps
    .findByProjectId(projectId)
    .roadmap.phases.find((entry) => entry.id === phaseId);
  assert.ok(roadmapPhase);
  const reviewOutput = {
    verdict,
    summary: verdict === "fail" ? "Independent review failed." : "Independent review passed.",
    findings:
      verdict === "advisory"
        ? [
            {
              severity: "warning",
              title: "Bounded observation",
              detail: "Follow up after phase completion.",
              criterionPosition: 0,
            },
          ]
        : [],
    criteria: [
      {
        criterionPosition: 0,
        assessment: verdict === "fail" ? "failed" : "satisfied",
        rationale: "The fake reviewer inspected the structured phase evidence.",
      },
    ],
    confidence: 0.9,
    unknowns: [],
  };
  await new IndependentReviewService(database, {
    now,
    workspaceFingerprint: async () => "unchanged",
  }).execute({
    id,
    projectId,
    phaseId,
    validationEventId,
    workspacePath,
    goal: roadmapPhase.goal,
    acceptanceCriteria: roadmapPhase.completionCriteria,
    relevantDiff: "+ phase fixture",
    deterministicResults: [
      {
        validatorId: "fake-phase-suite",
        status: "passed",
        required: true,
        summary: "The deterministic phase suite passed.",
      },
    ],
    architectureConstraints: ["Densa ADE Core owns the phase verdict."],
    adapter: new FakeAgentAdapter({ finalMessage: JSON.stringify(reviewOutput) }),
    reviewerRunId: `reviewer-run-confirmed-${phaseId}`,
  });
  return id;
}

function passingValidator(calls, database, verdict = "pass") {
  return {
    validatorId: "fake-phase-validator",
    providesIndependentReview: true,
    async validate({ projectId, phase, tasks, validationEventId, workspacePath }) {
      calls.push(tasks.map((task) => task.id));
      const independentReviewId = await recordPhaseReview(
        database,
        projectId,
        phase.id,
        validationEventId,
        workspacePath,
        verdict,
      );
      return {
        passed: true,
        independentReviewId,
        summary: "All phase acceptance checks passed.",
        checks: [
          {
            validatorId: "fake-phase-suite",
            passed: true,
            summary: "The deterministic phase suite passed.",
          },
        ],
      };
    },
  };
}

function emptyGates() {
  return { outstandingUserDecisionIds: [], permissionBlockers: [] };
}

test("phase execution reloads accepted roadmap additions at serial task boundaries", async () => {
  await withFixture("continuous", async ({ database, workspace }) => {
    const order = [];
    const validationCalls = [];
    const original = completingExecutor(database, order);
    const mutations = new RoadmapMutationService(database, { workspacePath: workspace, now });
    const result = await new PhaseLifecycleOrchestrator(database, { now }).execute({
      projectId: "project-phase",
      phaseId: "phase.build",
      workspacePath: workspace,
      gates: emptyGates(),
      actor: "phase:test",
      taskExecutor: {
        async execute(request) {
          const outcome = await original.execute(request);
          if (request.taskId === "task.beta")
            await mutations.apply("project-phase", {
              operation: {
                kind: "add_task",
                phaseId: "phase.build",
                position: 2,
                task: roadmapTask("task.added", ["task.beta"]),
              },
              actor: "master:test",
              sessionId: "session",
              rationale: "Add missing verification at the idle task boundary",
              applicationMode: "automatic",
            });
          return outcome;
        },
      },
      validator: passingValidator(validationCalls, database),
    });
    assert.equal(result.status, "COMPLETED");
    assert.deepEqual(order, ["task.alpha", "task.beta", "task.added"]);
    assert.deepEqual(validationCalls, [order]);
    assert.equal(result.report.tasksCompleted.length, 3);
  });
});

test("roadmap insertion cannot strand new work before an active or completed phase", async () => {
  await withFixture("continuous", async ({ database, workspace }) => {
    transition(database, "phase", "phase.build", "RUNNING");
    database.repositories.projectSettings.set({
      projectId: "project-phase",
      values: { allowSignificantRoadmapMutationAutoApply: true },
      updatedAt: now(),
    });
    const mutations = new RoadmapMutationService(database, { workspacePath: workspace, now });
    await assert.rejects(
      mutations.apply("project-phase", {
        operation: {
          kind: "add_phase",
          position: 0,
          phase: {
            id: "inserted",
            title: "Inserted",
            goal: "Never strand this work",
            required: true,
            completionCriteria: ["Inserted done"],
            tasks: [roadmapTask("task.inserted")],
          },
        },
        actor: "master:test",
        sessionId: "session",
        rationale: "Insert before active phase",
        applicationMode: "automatic",
      }),
      /active or completed|safe boundary/u,
    );
    assert.equal(
      database.repositories.masterRoadmaps.findByProjectId("project-phase").revisionNumber,
      0,
    );
    assert.equal(database.repositories.phases.findById("phase.build").position, 0);
    assert.equal(database.repositories.phases.findById("inserted"), undefined);
  });
});

async function withFixture(executionMode, work) {
  const workspace = mkdtempSync(join(tmpdir(), "densa-p5m3-"));
  const database = DensaAdeDatabase.openInMemory();
  try {
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: workspace });
    writeFileSync(join(workspace, ".gitignore"), ".densa/\n.densa-ade/\n", "utf8");
    execFileSync("git", ["add", "--all"], { cwd: workspace });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Densa ADE Fixture",
        "-c",
        "user.email=densa-fixture@localhost",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        "fixture: phase workspace",
      ],
      { cwd: workspace },
    );
    seed(database, executionMode);
    return await work({ database, workspace });
  } finally {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  }
}

test("phase-by-phase mode executes a multi-task phase serially and persists its durable report", async () => {
  await withFixture("phase", async ({ database, workspace }) => {
    const order = [];
    const validationCalls = [];
    const orchestrator = new PhaseLifecycleOrchestrator(database, { now });
    const request = {
      projectId: "project-phase",
      phaseId: "phase.build",
      workspacePath: workspace,
      gates: emptyGates(),
      taskExecutor: completingExecutor(database, order),
      validator: passingValidator(validationCalls, database, "advisory"),
      actor: "phase:test",
    };

    const result = await orchestrator.execute(request);

    assert.equal(result.status, "AWAITING_APPROVAL");
    assert.deepEqual(order, ["task.alpha", "task.beta"]);
    assert.deepEqual(validationCalls, [["task.alpha", "task.beta"]]);
    assert.equal(database.repositories.phases.findById("phase.build").state, "AWAITING_APPROVAL");
    assert.equal(database.repositories.phases.findById("phase.release").state, "PENDING");
    assert.equal(result.report.tasksCompleted.length, 2);
    assert.deepEqual(
      result.report.commits.map((entry) => entry.sha),
      ["commit-task.alpha", "commit-task.beta"],
    );
    assert.deepEqual(result.report.filesChanged, [
      { taskId: "task.alpha", paths: ["src/task.alpha.ts"] },
      { taskId: "task.beta", paths: ["src/task.beta.ts"] },
    ]);
    assert.deepEqual(
      database.repositories.phaseReports.findByPhaseId("phase.build"),
      result.report,
    );
    assert.equal(result.report.independentReviews[0].output.verdict, "advisory");
    const markdown = readFileSync(join(workspace, result.report.reportPath), "utf8");
    assert.match(markdown, /## Tasks completed/u);
    assert.match(markdown, /## Tests and validators/u);
    assert.match(markdown, /## Independent reviews/u);
    assert.match(markdown, /ADVISORY/u);
    assert.match(markdown, /Finding \*\*WARNING\*\*/u);
    assert.match(markdown, /Criterion #1 \*\*SATISFIED\*\*/u);
    assert.match(markdown, /## Next phase/u);

    const resumed = await orchestrator.execute(request);
    assert.equal(resumed.status, "AWAITING_APPROVAL");
    assert.deepEqual(order, ["task.alpha", "task.beta"], "recovery must not rerun completed tasks");
  });
});

test("continuous mode completes the validated phase and only then makes the next phase READY", async () => {
  await withFixture("continuous", async ({ database, workspace }) => {
    const order = [];
    const result = await new PhaseLifecycleOrchestrator(database, { now }).execute({
      projectId: "project-phase",
      phaseId: "phase.build",
      workspacePath: workspace,
      gates: emptyGates(),
      taskExecutor: completingExecutor(database, order),
      validator: passingValidator([], database),
      actor: "phase:test",
    });

    assert.equal(result.status, "COMPLETED");
    assert.equal(database.repositories.phases.findById("phase.build").state, "COMPLETED");
    assert.equal(database.repositories.phases.findById("phase.release").state, "READY");
    const events = database.eventJournal.replay({ projectId: "project-phase", limit: 1_000 });
    const validationIndex = events.findIndex((event) => event.type === "PHASE_VALIDATION_PASSED");
    const nextReadyIndex = events.findIndex(
      (event) =>
        event.type === "PHASE_STATE_CHANGED" &&
        event.phaseId === "phase.release" &&
        event.payload.state === "READY",
    );
    assert.ok(validationIndex >= 0 && nextReadyIndex > validationIndex);
  });
});

test("a blocked required task blocks the phase, skips phase validation, and records unresolved work", async () => {
  await withFixture("phase", async ({ database, workspace }) => {
    const validationCalls = [];
    const completing = completingExecutor(database, []);
    const taskExecutor = {
      async execute(request) {
        if (request.taskId === "task.alpha") return completing.execute(request);
        transition(database, "task", request.taskId, "BLOCKED", "fake task blocker");
        return {
          status: "BLOCKED",
          taskId: request.taskId,
          attemptCount: 0,
          reason: "Required fixture task is blocked.",
        };
      },
    };
    const result = await new PhaseLifecycleOrchestrator(database, { now }).execute({
      projectId: "project-phase",
      phaseId: "phase.build",
      workspacePath: workspace,
      gates: emptyGates(),
      taskExecutor,
      validator: passingValidator(validationCalls, database),
      actor: "phase:test",
    });

    assert.equal(result.status, "BLOCKED");
    assert.equal(database.repositories.phases.findById("phase.build").state, "BLOCKED");
    assert.equal(database.repositories.phases.findById("phase.release").state, "PENDING");
    assert.deepEqual(validationCalls, []);
    assert.equal(result.report.phaseValidation.status, "not_run");
    assert.match(result.report.unresolvedIssues[0], /task\.beta is BLOCKED/u);
    assert.equal(readFileSync(join(workspace, result.report.reportPath), "utf8").length > 0, true);
  });
});

test("failed phase validation blocks completion and never unlocks the next phase", async () => {
  await withFixture("continuous", async ({ database, workspace }) => {
    const result = await new PhaseLifecycleOrchestrator(database, { now }).execute({
      projectId: "project-phase",
      phaseId: "phase.build",
      workspacePath: workspace,
      gates: emptyGates(),
      taskExecutor: completingExecutor(database, []),
      validator: {
        validatorId: "failing-phase-validator",
        providesIndependentReview: true,
        async validate({ projectId, phase, validationEventId, workspacePath }) {
          const independentReviewId = await recordPhaseReview(
            database,
            projectId,
            phase.id,
            validationEventId,
            workspacePath,
          );
          return {
            passed: false,
            independentReviewId,
            summary: "Integration acceptance failed.",
            checks: [
              {
                validatorId: "integration",
                passed: false,
                summary: "The integration check failed.",
              },
            ],
          };
        },
      },
      actor: "phase:test",
    });

    assert.equal(result.status, "BLOCKED");
    assert.equal(result.report.phaseValidation.status, "failed");
    assert.equal(database.repositories.phases.findById("phase.release").state, "PENDING");
  });
});

test("phase validation cannot certify a workspace it mutates", async () => {
  await withFixture("continuous", async ({ database, workspace }) => {
    const result = await new PhaseLifecycleOrchestrator(database, { now }).execute({
      projectId: "project-phase",
      phaseId: "phase.build",
      workspacePath: workspace,
      gates: emptyGates(),
      taskExecutor: completingExecutor(database, []),
      validator: {
        validatorId: "mutating-phase-validator",
        providesIndependentReview: true,
        async validate({ projectId, phase, validationEventId, workspacePath }) {
          const independentReviewId = await recordPhaseReview(
            database,
            projectId,
            phase.id,
            validationEventId,
            workspacePath,
          );
          writeFileSync(join(workspacePath, "validation-mutated.txt"), "not validated\n", "utf8");
          return {
            passed: true,
            independentReviewId,
            summary: "The mutating validator claimed success.",
            checks: [{ validatorId: "suite", passed: true, summary: "Suite passed." }],
          };
        },
      },
      actor: "phase:test",
    });

    assert.equal(result.status, "BLOCKED");
    assert.match(result.report.phaseValidation.summary, /workspace changed|mutated/iu);
    assert.equal(database.repositories.phases.findById("phase.release").state, "PENDING");
  });
});

test("phase completion fails closed without a durable fresh-context review", async () => {
  await withFixture("continuous", async ({ database, workspace }) => {
    const result = await new PhaseLifecycleOrchestrator(database, { now }).execute({
      projectId: "project-phase",
      phaseId: "phase.build",
      workspacePath: workspace,
      gates: emptyGates(),
      taskExecutor: completingExecutor(database, []),
      validator: {
        validatorId: "deterministic-only",
        providesIndependentReview: true,
        async validate() {
          return {
            passed: true,
            summary: "Deterministic checks passed.",
            checks: [{ validatorId: "suite", passed: true, summary: "Suite passed." }],
          };
        },
      },
      actor: "phase:test",
    });

    assert.equal(result.status, "BLOCKED");
    assert.match(result.report.phaseValidation.summary, /did not persist/u);
    assert.equal(database.repositories.phases.findById("phase.release").state, "PENDING");
  });
});

test("a phase review from before final validation cannot satisfy phase completion", async () => {
  await withFixture("continuous", async ({ database, workspace }) => {
    const staleValidationEventId = "event-stale-phase-validation";
    database.repositories.events.append({
      id: staleValidationEventId,
      projectId: "project-phase",
      phaseId: "phase.build",
      type: "PHASE_VALIDATION_STARTED",
      eventVersion: 1,
      occurredAt: now(),
      actor: "phase:test",
      payload: { validatorId: "stale-review-validator" },
    });
    const staleReviewId = await recordPhaseReview(
      database,
      "project-phase",
      "phase.build",
      staleValidationEventId,
      workspace,
      "pass",
    );
    const result = await new PhaseLifecycleOrchestrator(database, { now }).execute({
      projectId: "project-phase",
      phaseId: "phase.build",
      workspacePath: workspace,
      gates: emptyGates(),
      taskExecutor: completingExecutor(database, []),
      validator: {
        validatorId: "stale-review-validator",
        providesIndependentReview: true,
        async validate() {
          return {
            passed: true,
            independentReviewId: staleReviewId,
            summary: "Deterministic checks passed.",
            checks: [{ validatorId: "suite", passed: true, summary: "Suite passed." }],
          };
        },
      },
      actor: "phase:test",
    });

    assert.equal(result.status, "BLOCKED");
    assert.match(result.report.phaseValidation.summary, /did not persist/u);
  });
});

test("phase lifecycle propagates its cancellation signal into final validation", async () => {
  await withFixture("continuous", async ({ database, workspace }) => {
    const controller = new globalThis.AbortController();
    const result = await new PhaseLifecycleOrchestrator(database, { now }).execute({
      projectId: "project-phase",
      phaseId: "phase.build",
      workspacePath: workspace,
      gates: emptyGates(),
      taskExecutor: completingExecutor(database, []),
      validator: {
        validatorId: "signal-aware-validator",
        providesIndependentReview: true,
        async validate({ projectId, phase, signal, validationEventId, workspacePath }) {
          assert.equal(signal, controller.signal);
          const independentReviewId = await recordPhaseReview(
            database,
            projectId,
            phase.id,
            validationEventId,
            workspacePath,
          );
          return {
            passed: true,
            independentReviewId,
            summary: "Validation received the lifecycle signal.",
            checks: [{ validatorId: "suite", passed: true, summary: "Suite passed." }],
          };
        },
      },
      actor: "phase:test",
      signal: controller.signal,
    });

    assert.equal(result.status, "COMPLETED");
  });
});

test("a persisted failing Reviewer cannot be overridden by passing deterministic phase prose", async () => {
  await withFixture("continuous", async ({ database, workspace }) => {
    const result = await new PhaseLifecycleOrchestrator(database, { now }).execute({
      projectId: "project-phase",
      phaseId: "phase.build",
      workspacePath: workspace,
      gates: emptyGates(),
      taskExecutor: completingExecutor(database, []),
      validator: {
        validatorId: "contradictory-composite",
        providesIndependentReview: true,
        async validate({ projectId, phase, validationEventId, workspacePath }) {
          const independentReviewId = await recordPhaseReview(
            database,
            projectId,
            phase.id,
            validationEventId,
            workspacePath,
            "fail",
          );
          return {
            passed: true,
            independentReviewId,
            summary: "The validator claims the phase passed.",
            checks: [{ validatorId: "suite", passed: true, summary: "Suite passed." }],
          };
        },
      },
      actor: "phase:test",
    });

    assert.equal(result.status, "BLOCKED");
    assert.match(result.report.phaseValidation.summary, /Independent phase review failed/u);
  });
});

test("phase report and state outcomes roll back together when an audit fact cannot persist", async () => {
  await withFixture("continuous", async ({ database, workspace }) => {
    const key = createHash("sha256")
      .update("project-phase")
      .update("\0")
      .update("phase.build")
      .digest("hex")
      .slice(0, 20);
    database.repositories.events.append({
      id: `phase-lifecycle-${key}-report-generated`,
      projectId: "project-phase",
      phaseId: "phase.build",
      type: "INJECTED_COLLISION",
      eventVersion: 1,
      occurredAt: now(),
      actor: "phase:test",
      payload: {},
    });

    await assert.rejects(() =>
      new PhaseLifecycleOrchestrator(database, { now }).execute({
        projectId: "project-phase",
        phaseId: "phase.build",
        workspacePath: workspace,
        gates: emptyGates(),
        taskExecutor: completingExecutor(database, []),
        validator: passingValidator([], database),
        actor: "phase:test",
      }),
    );

    assert.equal(database.repositories.phaseReports.findByPhaseId("phase.build"), undefined);
    assert.equal(database.repositories.phases.findById("phase.build").state, "VALIDATING");
    assert.equal(database.repositories.phases.findById("phase.release").state, "PENDING");
  });
});
