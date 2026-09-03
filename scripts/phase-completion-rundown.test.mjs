import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { URL } from "node:url";

import { CoreDaemon } from "../packages/core/dist/index.js";
import { DensaAdeDatabase } from "../packages/core/dist/persistence/index.js";
import { CORE_V1_METHODS } from "../packages/protocol/dist/index.js";
import {
  IdeCoreConnection,
  PHASE_COMPLETION_ACTIONS,
  PHASE_COMPLETION_CAPABILITY_METHODS,
  PHASE_COMPLETION_LIFECYCLE,
  PHASE_COMPLETION_NAVIGATION_COMMANDS,
  PHASE_COMPLETION_OPEN_REFRESH_METHODS,
  buildPhaseCompletionModel,
  phaseCompletionEventIsRefreshHint,
  resolvePhaseCompletionDrilldown,
  resolvePhaseCompletionInspectChanges,
  resolvePhaseCompletionMasterAsk,
  resolvePhaseCompletionOpenRoadmap,
  resolvePhaseCompletionPhaseApproval,
  resolvePhaseCompletionReopenRefresh,
} from "../apps/ide-extension/dist/index.js";

const PROJECT_ID = "project-phase-m3";
const PHASE_ONE = "phase-one";
const PHASE_TWO = "phase-two";
const WORKSPACE = "/tmp/densa-phase-m3";
const STARTED_AT = "2026-09-03T00:00:00.000Z";
const GENERATED_AT = "2026-09-03T01:30:00.000Z";
const HEAD_SHA = "abcdef1234567890abcdef1234567890abcdef12";

function makeReport(overrides = {}) {
  return {
    formatVersion: 1,
    projectId: PROJECT_ID,
    phaseId: PHASE_ONE,
    phaseTitle: "Phase one",
    outcome: "awaiting_approval",
    executionMode: "phase",
    roadmapRevisionNumber: 0,
    phaseStartedAt: STARTED_AT,
    generatedAt: GENERATED_AT,
    reportPath: ".densa-ade/reports/phase-one.md",
    tasksCompleted: [{ taskId: "task-alpha", title: "Task alpha", attemptCount: 1 }],
    validations: [
      {
        scope: "task",
        validatorId: "unit-test",
        taskId: "task-alpha",
        validationRunId: "validation-1",
        validationResultIds: ["result-1"],
        passed: true,
        summary: "Task validation passed.",
        startedAt: STARTED_AT,
        completedAt: GENERATED_AT,
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
    commits: [{ taskId: "task-alpha", sha: HEAD_SHA }],
    filesChanged: [{ taskId: "task-alpha", paths: ["src/a.ts", "src/b.ts"] }],
    importantDecisions: [
      { id: "decision-1", title: "Core owns facts", rationale: "A Master may not replace counts." },
    ],
    roadmapChanges: [
      {
        id: "revision-1",
        classification: "minor",
        reason: "Add a missing test task",
        createdAt: GENERATED_AT,
      },
    ],
    retriesAndFailures: [
      {
        taskId: "task-alpha",
        attemptCount: 1,
        failedValidationCount: 0,
        summary: "No retries were needed.",
      },
    ],
    unresolvedIssues: [],
    phaseValidation: {
      status: "passed",
      validatorId: "phase-suite",
      summary: "Phase validation passed.",
    },
    nextPhase: {
      phaseId: PHASE_TWO,
      title: "Phase two",
      goal: "Continue the project arc",
      state: "PENDING",
    },
    ...overrides,
  };
}

function makeSnapshot(overrides = {}) {
  const snapshot = {
    summary: {
      project: {
        id: PROJECT_ID,
        name: "Phase fixture",
        state: "RUNNING",
        executionMode: "phase",
        createdAt: STARTED_AT,
        updatedAt: GENERATED_AT,
      },
      workspacePath: WORKSPACE,
      currentPhaseId: PHASE_ONE,
      completedTaskCount: 1,
      totalTaskCount: 2,
      attentionRequired: true,
    },
    phases: [
      {
        id: PHASE_ONE,
        projectId: PROJECT_ID,
        title: "Phase one",
        state: "AWAITING_APPROVAL",
        position: 0,
        createdAt: STARTED_AT,
        updatedAt: GENERATED_AT,
      },
      {
        id: PHASE_TWO,
        projectId: PROJECT_ID,
        title: "Phase two",
        state: "PENDING",
        position: 1,
        createdAt: STARTED_AT,
        updatedAt: GENERATED_AT,
      },
    ],
    tasks: [
      {
        id: "task-alpha",
        projectId: PROJECT_ID,
        phaseId: PHASE_ONE,
        title: "Task alpha",
        state: "COMPLETED",
        position: 0,
        acceptanceCriteria: ["Alpha criterion is verifiable"],
        dependencyIds: [],
        createdAt: STARTED_AT,
        updatedAt: GENERATED_AT,
      },
      {
        id: "task-beta",
        projectId: PROJECT_ID,
        phaseId: PHASE_TWO,
        title: "Task beta",
        state: "PENDING",
        position: 0,
        acceptanceCriteria: ["Beta criterion is verifiable"],
        dependencyIds: [],
        createdAt: STARTED_AT,
        updatedAt: GENERATED_AT,
      },
    ],
    pendingApprovals: [
      {
        kind: "phase",
        projectId: PROJECT_ID,
        phaseId: PHASE_ONE,
        requestedAt: GENERATED_AT,
        summary: "Phase validation passed; approve to continue",
      },
    ],
    usage: { status: "available" },
    latestEventSequence: 9,
    ...overrides,
  };
  return snapshot;
}

test("phase-completion catalog uses Core methods, lifecycle, and navigation only", () => {
  assert.deepEqual(
    [...PHASE_COMPLETION_OPEN_REFRESH_METHODS],
    ["phases.report.get", "projects.get"],
  );
  for (const method of [
    ...PHASE_COMPLETION_OPEN_REFRESH_METHODS,
    ...PHASE_COMPLETION_CAPABILITY_METHODS,
  ]) {
    assert.ok(CORE_V1_METHODS.includes(method), method);
  }
  assert.ok(PHASE_COMPLETION_CAPABILITY_METHODS.includes("phases.approve"));
  assert.ok(PHASE_COMPLETION_CAPABILITY_METHODS.includes("roadmaps.get"));
  assert.ok(PHASE_COMPLETION_CAPABILITY_METHODS.includes("master.send"));
  assert.ok(PHASE_COMPLETION_CAPABILITY_METHODS.includes("git.status"));
  assert.ok(PHASE_COMPLETION_CAPABILITY_METHODS.includes("git.commit.get"));
  assert.ok(PHASE_COMPLETION_CAPABILITY_METHODS.includes("attempts.list"));
  assert.ok(PHASE_COMPLETION_CAPABILITY_METHODS.includes("validation.list"));
  assert.ok(PHASE_COMPLETION_CAPABILITY_METHODS.includes("validation.get"));
  assert.ok(PHASE_COMPLETION_CAPABILITY_METHODS.includes("decisions.list"));
  assert.ok(PHASE_COMPLETION_CAPABILITY_METHODS.includes("roadmaps.revisions.list"));
  assert.ok(PHASE_COMPLETION_CAPABILITY_METHODS.includes("events.replay"));
  assert.equal(PHASE_COMPLETION_LIFECYCLE.optimisticComplete, false);
  assert.equal(PHASE_COMPLETION_LIFECYCLE.coreContinuesAfterClose, true);
  assert.equal(PHASE_COMPLETION_LIFECYCLE.reopenRefreshesSnapshot, true);
  assert.equal(PHASE_COMPLETION_LIFECYCLE.closeDisposes, "view-handle-only");
  assert.equal(PHASE_COMPLETION_ACTIONS.inspectChanges, "inspect-changes");
  assert.equal(PHASE_COMPLETION_ACTIONS.openRoadmap, "open-roadmap");
  assert.equal(PHASE_COMPLETION_ACTIONS.askMasterAgent, "ask-master-agent");
  assert.equal(PHASE_COMPLETION_ACTIONS.startNextPhase, "start-next-phase");
  assert.equal(PHASE_COMPLETION_NAVIGATION_COMMANDS.openRoadmap, "densa-ade.showRoadmap");
  assert.equal(PHASE_COMPLETION_NAVIGATION_COMMANDS.askMasterAgent, "densa-ade.showMasterAgent");
});

test("fixture rundown renders every required section from persisted state", () => {
  const model = buildPhaseCompletionModel({ report: makeReport(), snapshot: makeSnapshot() });

  assert.equal(model.projectId, PROJECT_ID);
  assert.equal(model.phaseId, PHASE_ONE);
  assert.equal(model.phaseTitle, "Phase one");
  assert.equal(model.runtimePhaseState, "AWAITING_APPROVAL");
  assert.equal(model.outcome, "awaiting_approval");
  assert.equal(model.reportExecutionMode, "phase");
  assert.equal(model.liveExecutionMode, "phase");
  assert.equal(model.workspacePath, WORKSPACE);
  assert.equal(model.reportPath, ".densa-ade/reports/phase-one.md");
  assert.equal(model.roadmapRevisionNumber, 0);
  assert.equal(model.optimisticComplete, false);
  assert.equal(model.enabled, true);
  assert.equal(model.reason, undefined);

  // Title and duration where determinable.
  assert.equal(model.durationKnown, true);
  assert.equal(model.durationMs, 5_400_000);

  // Tasks completed.
  assert.equal(model.tasksCompleted.length, 1);
  assert.equal(model.tasksCompleted[0].taskId, "task-alpha");
  assert.equal(model.tasksCompleted[0].attemptCount, 1);

  // Validator/test summary.
  assert.deepEqual(model.validationSummary, { passed: 2, failed: 0, total: 2 });
  assert.equal(model.validations.length, 2);
  assert.equal(model.phaseValidation.status, "passed");
  assert.equal(model.phaseValidation.validatorId, "phase-suite");

  // Commits/files changed.
  assert.equal(model.commits.length, 1);
  assert.equal(model.commits[0].sha, HEAD_SHA);
  assert.deepEqual([...model.filesChanged[0].paths], ["src/a.ts", "src/b.ts"]);

  // Key decisions, roadmap changes, retries/issues, blockers.
  assert.equal(model.importantDecisions.length, 1);
  assert.equal(model.importantDecisions[0].id, "decision-1");
  assert.equal(model.roadmapChanges.length, 1);
  assert.equal(model.roadmapChanges[0].classification, "minor");
  assert.equal(model.retriesAndFailures.length, 1);
  assert.equal(model.retriesAndFailures[0].taskId, "task-alpha");
  assert.deepEqual([...model.unresolvedIssues], []);
  assert.equal(model.hasUnresolvedBlockers, false);

  // Next-phase summary (reported verbatim plus live row).
  assert.equal(model.reportedNextPhase.phaseId, PHASE_TWO);
  assert.equal(model.reportedNextPhase.title, "Phase two");
  assert.equal(model.liveNextPhase.id, PHASE_TWO);
  assert.equal(model.liveNextPhase.state, "PENDING");

  // Phase-mode stopping point blocks; Start Next Phase is available.
  assert.equal(model.blocksForApproval, true);
  assert.equal(model.continuousStored, false);
  assert.equal(model.canStartNextPhase, true);
  assert.equal(model.startNextPhaseBlockedReason, undefined);
  assert.equal(model.latestEventSequence, 9);

  // Rebuilding from identical inputs yields identical facts.
  const rebuilt = buildPhaseCompletionModel({ report: makeReport(), snapshot: makeSnapshot() });
  assert.deepEqual(JSON.parse(JSON.stringify(rebuilt)), JSON.parse(JSON.stringify(model)));

  // Event notifications are refresh hints only, never direct edits.
  assert.equal(phaseCompletionEventIsRefreshHint("PHASE_REPORT_GENERATED"), true);
  assert.equal(phaseCompletionEventIsRefreshHint("core.event"), true);
  assert.equal(phaseCompletionEventIsRefreshHint("   "), false);
  assert.equal(phaseCompletionEventIsRefreshHint("run.log.appended"), false);
});

test("rundown actions resolve to Core operations only, never optimistic applies", () => {
  const model = buildPhaseCompletionModel({ report: makeReport(), snapshot: makeSnapshot() });

  const changes = resolvePhaseCompletionInspectChanges(model);
  assert.equal(changes.method, "git.status");
  assert.equal(changes.projectId, PROJECT_ID);
  assert.equal(changes.workspacePath, WORKSPACE);

  const roadmap = resolvePhaseCompletionOpenRoadmap(model);
  assert.equal(roadmap.method, "roadmaps.get");
  assert.equal(roadmap.projectId, PROJECT_ID);
  assert.equal(roadmap.command, "densa-ade.showRoadmap");

  const ask = resolvePhaseCompletionMasterAsk(model, {
    message: "What changed in this phase?",
    sessionId: "session-m3",
  });
  assert.equal(ask.method, "master.send");
  assert.equal(ask.projectId, PROJECT_ID);
  assert.equal(ask.workspacePath, WORKSPACE);
  assert.equal(ask.sessionId, "session-m3");
  assert.equal(ask.command, "densa-ade.showMasterAgent");
  assert.throws(
    () => resolvePhaseCompletionMasterAsk(model, { message: "   ", sessionId: "s" }),
    /non-empty message/u,
  );
  assert.throws(
    () => resolvePhaseCompletionMasterAsk(model, { message: "hi", sessionId: "  " }),
    /sessionId/u,
  );

  const approval = resolvePhaseCompletionPhaseApproval(model, {
    decision: "approve",
    actor: "user",
    reason: "Validation passed",
  });
  assert.equal(approval.method, "phases.approve");
  assert.equal(approval.phaseId, PHASE_ONE);

  const drillRefresh = resolvePhaseCompletionDrilldown(model, { kind: "report-refresh" });
  assert.equal(drillRefresh.method, "phases.report.get");
  const drillSnapshot = resolvePhaseCompletionDrilldown(model, { kind: "project-snapshot" });
  assert.equal(drillSnapshot.method, "projects.get");
  const drillRoadmap = resolvePhaseCompletionDrilldown(model, { kind: "open-roadmap" });
  assert.equal(drillRoadmap.method, "roadmaps.get");
  const drillChanges = resolvePhaseCompletionDrilldown(model, { kind: "inspect-changes" });
  assert.equal(drillChanges.method, "git.status");
  const drillCommit = resolvePhaseCompletionDrilldown(model, {
    kind: "git-commit",
    sha: HEAD_SHA,
  });
  assert.equal(drillCommit.method, "git.commit.get");
  assert.throws(
    () => resolvePhaseCompletionDrilldown(model, { kind: "git-commit", sha: "deadbeef" }),
    /Unknown phase-report commit/u,
  );
  const drillAttempts = resolvePhaseCompletionDrilldown(model, {
    kind: "attempts",
    taskId: "task-alpha",
  });
  assert.equal(drillAttempts.method, "attempts.list");
  assert.throws(
    () => resolvePhaseCompletionDrilldown(model, { kind: "attempts", taskId: "nope" }),
    /Unknown phase-report task/u,
  );
  const drillRuns = resolvePhaseCompletionDrilldown(model, {
    kind: "validation-runs",
    taskId: "task-alpha",
  });
  assert.equal(drillRuns.method, "validation.list");
  const drillDetail = resolvePhaseCompletionDrilldown(model, {
    kind: "validation-detail",
    validationRunId: "validation-1",
  });
  assert.equal(drillDetail.method, "validation.get");
  assert.throws(
    () =>
      resolvePhaseCompletionDrilldown(model, { kind: "validation-detail", validationRunId: "" }),
    /persisted validationRunId/u,
  );
  const drillDecisions = resolvePhaseCompletionDrilldown(model, { kind: "decisions" });
  assert.equal(drillDecisions.method, "decisions.list");
  const drillRevisions = resolvePhaseCompletionDrilldown(model, { kind: "revisions" });
  assert.equal(drillRevisions.method, "roadmaps.revisions.list");
  const drillEvents = resolvePhaseCompletionDrilldown(model, { kind: "events" });
  assert.equal(drillEvents.method, "events.replay");
  assert.equal(drillEvents.afterSequence, 9);
  const drillLogs = resolvePhaseCompletionDrilldown(model, { kind: "run-logs" });
  assert.equal(drillLogs.method, "logs.list");

  const reopen = resolvePhaseCompletionReopenRefresh(PROJECT_ID, PHASE_ONE);
  assert.equal(reopen.action, "refresh-before-render");
  assert.ok(reopen.refreshMethods.includes("phases.report.get"));
  assert.ok(reopen.refreshMethods.includes("projects.get"));
  assert.match(reopen.reason, /survives close/iu);
  assert.throws(() => resolvePhaseCompletionReopenRefresh("   ", PHASE_ONE), /projectId/u);
  assert.throws(() => resolvePhaseCompletionReopenRefresh(PROJECT_ID, "  "), /phaseId/u);
});

test("Start Next Phase is unavailable until phase validation passed", () => {
  const awaiting = makeSnapshot();
  const failedValidation = buildPhaseCompletionModel({
    report: makeReport({ phaseValidation: { status: "failed", summary: "Phase suite failed." } }),
    snapshot: awaiting,
  });
  assert.equal(failedValidation.canStartNextPhase, false);
  assert.match(failedValidation.startNextPhaseBlockedReason, /not passed/u);
  assert.equal(failedValidation.hasUnresolvedBlockers, true);
  assert.throws(
    () =>
      resolvePhaseCompletionPhaseApproval(failedValidation, {
        decision: "approve",
        actor: "user",
        reason: "Try anyway",
      }),
    /unavailable until phase validation passed/u,
  );
  // Rejecting at the boundary stays available so the user can refuse a bad phase.
  const rejected = resolvePhaseCompletionPhaseApproval(failedValidation, {
    decision: "reject",
    actor: "user",
    reason: "Validation failed",
  });
  assert.equal(rejected.method, "phases.approve");
  assert.equal(rejected.decision, "reject");

  const runningSnapshot = makeSnapshot({
    phases: [{ ...makeSnapshot().phases[0], state: "RUNNING" }, makeSnapshot().phases[1]],
  });
  const running = buildPhaseCompletionModel({ report: makeReport(), snapshot: runningSnapshot });
  assert.equal(running.blocksForApproval, false);
  assert.equal(running.canStartNextPhase, false);
  assert.match(running.startNextPhaseBlockedReason, /not AWAITING_APPROVAL/u);
  assert.throws(
    () =>
      resolvePhaseCompletionPhaseApproval(running, {
        decision: "approve",
        actor: "user",
        reason: "Too early",
      }),
    /not AWAITING_APPROVAL/u,
  );
});

test("Continuous mode stores the same report without blocking", () => {
  const continuousSnapshot = makeSnapshot({
    summary: {
      ...makeSnapshot().summary,
      project: { ...makeSnapshot().summary.project, executionMode: "continuous" },
    },
    phases: [
      { ...makeSnapshot().phases[0], state: "COMPLETED" },
      { ...makeSnapshot().phases[1], state: "RUNNING" },
    ],
  });
  const model = buildPhaseCompletionModel({
    report: makeReport({ outcome: "completed", executionMode: "continuous" }),
    snapshot: continuousSnapshot,
  });
  assert.equal(model.liveExecutionMode, "continuous");
  assert.equal(model.continuousStored, true);
  assert.equal(model.blocksForApproval, false);
  assert.equal(model.canStartNextPhase, false);
  // Identical report facts remain viewable without the approval block.
  assert.equal(model.phaseTitle, "Phase one");
  assert.equal(model.tasksCompleted.length, 1);
  assert.equal(model.commits.length, 1);
  assert.equal(model.reportedNextPhase.phaseId, PHASE_TWO);
});

test("duration is unknown when persisted timestamps do not order", () => {
  const model = buildPhaseCompletionModel({
    report: makeReport({ phaseStartedAt: GENERATED_AT, generatedAt: STARTED_AT }),
    snapshot: makeSnapshot(),
  });
  assert.equal(model.durationKnown, false);
  assert.equal(model.durationMs, undefined);
});

test("blocked outcome surfaces unresolved blockers from persisted state", () => {
  const model = buildPhaseCompletionModel({
    report: makeReport({
      outcome: "blocked",
      unresolvedIssues: ["task-alpha needs a decision before the next phase."],
      phaseValidation: { status: "failed", summary: "Phase suite failed." },
    }),
    snapshot: makeSnapshot({
      phases: [{ ...makeSnapshot().phases[0], state: "BLOCKED" }, makeSnapshot().phases[1]],
    }),
  });
  assert.equal(model.hasUnresolvedBlockers, true);
  assert.deepEqual(
    [...model.unresolvedIssues],
    ["task-alpha needs a decision before the next phase."],
  );
  assert.equal(model.blocksForApproval, false);
  assert.equal(model.canStartNextPhase, false);
});

test("report and snapshot disagreement never invents state", () => {
  assert.throws(
    () =>
      buildPhaseCompletionModel({
        report: makeReport({ projectId: "project-elsewhere" }),
        snapshot: makeSnapshot(),
      }),
    /disagree on projectId/u,
  );
  assert.throws(
    () =>
      buildPhaseCompletionModel({
        report: makeReport(),
        snapshot: makeSnapshot({
          phases: [makeSnapshot().phases[1]],
        }),
      }),
    /has no runtime state/u,
  );
});

test("unconnected rundown explains what is needed", () => {
  const disconnected = buildPhaseCompletionModel({
    report: makeReport(),
    snapshot: makeSnapshot(),
    connectionState: "disconnected",
  });
  assert.equal(disconnected.enabled, false);
  assert.match(disconnected.reason, /densa-ade core start/u);
  // Facts still come from Core; only interaction is disabled.
  assert.equal(disconnected.phaseTitle, "Phase one");
  const mismatch = buildPhaseCompletionModel({
    report: makeReport(),
    snapshot: makeSnapshot(),
    connectionState: "version-mismatch",
  });
  assert.match(mismatch.reason, /protocol mismatch/iu);
});

async function withPhaseDaemon(run) {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "densa-phase-m3-"));
  const workspace = await mkdtemp(join(tmpdir(), "densa-phase-ws-"));
  const database = DensaAdeDatabase.openInMemory();
  const daemon = await CoreDaemon.start({ runtimeDirectory, database });
  let requestNumber = 0;
  const connection = new IdeCoreConnection({
    runtimeDirectory,
    createRequestId: () => `phase-m3-${String((requestNumber += 1))}`,
  });
  try {
    await connection.connect();
    await run({ connection, database, daemon, workspace, runtimeDirectory });
  } finally {
    connection.dispose();
    await daemon.stop().catch(() => undefined);
    database.close();
    await rm(runtimeDirectory, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
}

async function createLiveProject(connection, workspace, name) {
  const created = await connection.request("projects.create", {
    name,
    workspacePath: workspace,
    idea: "Prove the phase-completion rundown reflects Core truth",
    executionMode: "phase",
    actor: "test",
  });
  await connection.request("projects.interview.answer", {
    projectId: created.project.id,
    sessionId: "session-m3",
    answers: [{ questionId: "scope", answer: "Deterministic phase rundown" }],
  });
  const generated = await connection.request("roadmaps.generate", {
    projectId: created.project.id,
    sessionId: "session-m3",
    actor: "test",
  });
  await connection.request("projects.start", {
    projectId: created.project.id,
    workspacePath: workspace,
    actor: "test",
  });
  return { projectId: created.project.id, generated };
}

test("live Start Next Phase executes through Core and the report survives reconnect", async () => {
  await withPhaseDaemon(async ({ connection, database, workspace, runtimeDirectory }) => {
    const { projectId, generated } = await createLiveProject(
      connection,
      workspace,
      "Phase rundown live",
    );
    const livePhaseId = generated.roadmap.phases[0].id;
    const liveTaskId = generated.roadmap.phases[0].tasks[0].id;
    const liveNext = generated.roadmap.phases[1];

    const { stateTransitionService } = await import("../packages/core/dist/index.js");
    const timestamp = new Date().toISOString();
    for (const next of ["READY", "RUNNING", "VALIDATING", "AWAITING_APPROVAL"]) {
      const current = database.repositories.phases.findById(livePhaseId);
      if (current.state === next) continue;
      database.persistStateTransition(
        stateTransitionService.transitionPhase(current, next, {
          actor: "test",
          occurredAt: timestamp,
          reason: "phase rundown test advances phase",
        }),
        `phase-advance-${next}`,
      );
    }

    database.repositories.phaseReports.create({
      formatVersion: 1,
      projectId,
      phaseId: livePhaseId,
      phaseTitle: generated.roadmap.phases[0].title,
      outcome: "awaiting_approval",
      executionMode: "phase",
      roadmapRevisionNumber: 0,
      phaseStartedAt: timestamp,
      generatedAt: timestamp,
      reportPath: ".densa-ade/reports/phase-live.md",
      tasksCompleted: [{ taskId: liveTaskId, title: "Live task", attemptCount: 1 }],
      validations: [
        {
          scope: "task",
          validatorId: "unit-test",
          taskId: liveTaskId,
          validationRunId: "validation-live-1",
          validationResultIds: [],
          passed: true,
          summary: "Task validation passed.",
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
      commits: [{ taskId: liveTaskId, sha: "abc1234def5678" }],
      filesChanged: [{ taskId: liveTaskId, paths: ["src/live.ts"] }],
      importantDecisions: [],
      roadmapChanges: [],
      retriesAndFailures: [],
      unresolvedIssues: [],
      phaseValidation: {
        status: "passed",
        validatorId: "phase-suite",
        summary: "Phase validation passed.",
      },
      ...(liveNext === undefined
        ? {}
        : {
            nextPhase: {
              phaseId: liveNext.id,
              title: liveNext.title,
              goal: liveNext.goal,
              state: "PENDING",
            },
          }),
    });

    const report = await connection.request("phases.report.get", {
      projectId,
      phaseId: livePhaseId,
    });
    assert.equal(report.projectId, projectId);
    assert.equal(report.phaseId, livePhaseId);
    assert.equal(report.phaseValidation.status, "passed");

    const snapshot = await connection.request("projects.get", { projectId });
    const model = buildPhaseCompletionModel({ report, snapshot });
    assert.equal(model.phaseTitle, generated.roadmap.phases[0].title);
    assert.equal(model.runtimePhaseState, "AWAITING_APPROVAL");
    assert.equal(model.blocksForApproval, true);
    assert.equal(model.canStartNextPhase, true);
    assert.equal(model.optimisticComplete, false);

    // Inspect Changes and Open Roadmap drill-downs execute against Core.
    const inspect = resolvePhaseCompletionInspectChanges(model);
    assert.equal(inspect.method, "git.status");
    const git = await connection.request(inspect.method, {
      projectId: inspect.projectId,
      workspacePath: workspace,
    });
    assert.equal(git.projectId, projectId);

    const openRoadmap = resolvePhaseCompletionOpenRoadmap(model);
    assert.equal(openRoadmap.method, "roadmaps.get");
    const roadmap = await connection.request(openRoadmap.method, {
      projectId: openRoadmap.projectId,
    });
    assert.equal(roadmap.projectId, projectId);

    // Start Next Phase transitions through Core, never optimistically.
    const resolution = resolvePhaseCompletionPhaseApproval(model, {
      decision: "approve",
      actor: "test",
      reason: "Validation passed",
    });
    assert.equal(resolution.method, "phases.approve");
    const { method, ...payload } = resolution;
    const outcome = await connection.request(method, payload);
    assert.equal(outcome.outcome, "APPROVED");
    assert.equal(outcome.phase.state, "COMPLETED");

    // The persisted report remains viewable after approval.
    const rereadReport = await connection.request("phases.report.get", {
      projectId,
      phaseId: livePhaseId,
    });
    const rereadSnapshot = await connection.request("projects.get", { projectId });
    const rebuilt = buildPhaseCompletionModel({ report: rereadReport, snapshot: rereadSnapshot });
    assert.equal(rebuilt.phaseId, livePhaseId);
    assert.equal(rebuilt.reportPath, ".densa-ade/reports/phase-live.md");
    assert.equal(rebuilt.runtimePhaseState, "COMPLETED");
    assert.equal(rebuilt.blocksForApproval, false);

    // Closing the IDE connection leaves Core running; a fresh window rebuilds
    // the same persisted report facts from Core truth.
    const beforeFacts = JSON.stringify({
      projectId: rebuilt.projectId,
      phaseId: rebuilt.phaseId,
      title: rebuilt.phaseTitle,
      path: rebuilt.reportPath,
      tasks: rebuilt.tasksCompleted,
      commits: rebuilt.commits,
    });
    connection.dispose();
    let reopenedNumber = 0;
    const reopened = new IdeCoreConnection({
      runtimeDirectory,
      createRequestId: () => `phase-m3-reopen-${String((reopenedNumber += 1))}`,
    });
    try {
      await reopened.connect();
      const reopen = resolvePhaseCompletionReopenRefresh(projectId, livePhaseId);
      assert.ok(reopen.refreshMethods.includes("phases.report.get"));
      assert.ok(reopen.refreshMethods.includes("projects.get"));
      const afterReport = await reopened.request("phases.report.get", {
        projectId,
        phaseId: livePhaseId,
      });
      const afterSnapshot = await reopened.request("projects.get", { projectId });
      const after = buildPhaseCompletionModel({ report: afterReport, snapshot: afterSnapshot });
      const afterFacts = JSON.stringify({
        projectId: after.projectId,
        phaseId: after.phaseId,
        title: after.phaseTitle,
        path: after.reportPath,
        tasks: after.tasksCompleted,
        commits: after.commits,
      });
      assert.equal(afterFacts, beforeFacts);
    } finally {
      reopened.dispose();
    }
  });
});

test("phase-completion extension sources stay protocol-only", () => {
  const extensionDir = new URL("../apps/ide-extension/src/", import.meta.url);
  const sources = ["index.ts", "phase-completion.ts"]
    .map((file) => readFileSync(new URL(file, extensionDir), "utf8"))
    .join("\n");
  const forbidden = [
    /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']@densa-ade\/core(?:\/[^"']*)?["']/u,
    /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*vs\/workbench[^"']*["']/u,
    /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']vscode["']/u,
    /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*sqlite[^"']*["']/iu,
    /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']@densa-ade\/cli(?:\/[^"']*)?["']/u,
  ];
  for (const pattern of forbidden) {
    assert.ok(!pattern.test(sources), String(pattern));
  }
});
