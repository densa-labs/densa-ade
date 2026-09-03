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
  ROADMAP_CANONICAL_PHASE_STATES,
  ROADMAP_CANONICAL_TASK_STATES,
  ROADMAP_CAPABILITY_METHODS,
  ROADMAP_COMMAND,
  ROADMAP_EDITOR_VIEW_TYPE,
  ROADMAP_LIFECYCLE,
  ROADMAP_OPEN_REFRESH_METHODS,
  buildRoadmapModel,
  isRoadmapStaleOutcome,
  reconcileRoadmapStaleOutcome,
  resolveRoadmapDrilldown,
  resolveRoadmapPhaseApproval,
  resolveRoadmapPropose,
  resolveRoadmapResolve,
  resolveRoadmapTaskApproval,
  roadmapPhaseById,
  roadmapRevisionById,
  roadmapTaskById,
} from "../apps/ide-extension/dist/index.js";

const TIMESTAMP = "2026-09-03T00:00:00.000Z";
const PROJECT_ID = "project-roadmap-m0";
const WORKSPACE = "/tmp/densa-roadmap-m0";

const PHASE_STATES = [
  "PENDING",
  "READY",
  "RUNNING",
  "VALIDATING",
  "AWAITING_APPROVAL",
  "COMPLETED",
  "BLOCKED",
];
const TASK_STATES = [
  "PENDING",
  "READY",
  "RUNNING",
  "VALIDATING",
  "RETRYING",
  "WAITING_FOR_USER",
  "WAITING_FOR_USAGE",
  "BLOCKED",
  "INTERRUPTED",
  "COMPLETED",
  "CANCELLED",
];
// One task per canonical state, distributed across the seven phases so every
// required phase is non-empty and every position matches its runtime row.
const TASK_DISTRIBUTION = [
  ["task-pending"],
  ["task-ready"],
  ["task-running", "task-validating"],
  ["task-retrying", "task-waiting-user"],
  ["task-waiting-usage", "task-blocked"],
  ["task-interrupted", "task-completed"],
  ["task-cancelled"],
];
const TASK_STATE_BY_ID = {
  "task-pending": "PENDING",
  "task-ready": "READY",
  "task-running": "RUNNING",
  "task-validating": "VALIDATING",
  "task-retrying": "RETRYING",
  "task-waiting-user": "WAITING_FOR_USER",
  "task-waiting-usage": "WAITING_FOR_USAGE",
  "task-blocked": "BLOCKED",
  "task-interrupted": "INTERRUPTED",
  "task-completed": "COMPLETED",
  "task-cancelled": "CANCELLED",
};

function phaseId(index) {
  return `phase-${PHASE_STATES[index].toLowerCase().replaceAll("_", "-")}`;
}

function makeFixture() {
  const roadmapPhases = PHASE_STATES.map((phaseState, index) => {
    const id = phaseId(index);
    const taskIds = TASK_DISTRIBUTION[index];
    return {
      id,
      title: `Phase ${index + 1} ${phaseState}`,
      goal: `Demonstrate phase state ${phaseState}`,
      required: true,
      completionCriteria: [`Phase ${id} completion is observed`],
      tasks: taskIds.map((taskId) => ({
        id: taskId,
        title: `Task ${taskId}`,
        goal: `Demonstrate task state ${TASK_STATE_BY_ID[taskId]}`,
        executable: true,
        dependencyIds: taskId === "task-ready" ? ["task-pending"] : [],
        acceptanceCriteria: [`Criterion for ${taskId} is verifiable`],
        riskLevel: "medium",
        expectedValidators: ["unit_test"],
      })),
    };
  });
  const roadmap = {
    projectId: PROJECT_ID,
    roadmap: {
      formatVersion: 1,
      projectGoal: "Render the complete roadmap truthfully",
      phases: roadmapPhases,
    },
    revisionNumber: 3,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
  const phases = PHASE_STATES.map((state, index) => ({
    id: phaseId(index),
    projectId: PROJECT_ID,
    title: `Phase ${index + 1} ${state}`,
    state,
    position: index,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  }));
  const tasks = [];
  for (const [phaseIndex, taskIds] of TASK_DISTRIBUTION.entries()) {
    for (const [position, taskId] of taskIds.entries()) {
      tasks.push({
        id: taskId,
        projectId: PROJECT_ID,
        phaseId: phaseId(phaseIndex),
        title: `Task ${taskId}`,
        state: TASK_STATE_BY_ID[taskId],
        position,
        acceptanceCriteria: [`Criterion for ${taskId} is verifiable`],
        dependencyIds: taskId === "task-ready" ? ["task-pending"] : [],
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      });
    }
  }
  const snapshot = {
    summary: {
      project: {
        id: PROJECT_ID,
        name: "Roadmap fixture",
        state: "RUNNING",
        executionMode: "phase",
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
      workspacePath: WORKSPACE,
      currentPhaseId: phaseId(2),
      completedTaskCount: 1,
      totalTaskCount: tasks.length,
      attentionRequired: true,
    },
    phases,
    tasks,
    pendingApprovals: [
      {
        kind: "phase",
        projectId: PROJECT_ID,
        phaseId: phaseId(4),
        requestedAt: TIMESTAMP,
        summary: "Phase validation passed; approve to continue",
      },
    ],
    usage: { status: "available" },
    latestEventSequence: 42,
  };
  const revisions = [
    {
      id: "roadmap-revision-1",
      projectId: PROJECT_ID,
      classification: "minor",
      reason: "Add a missing test task",
      actor: "user",
      sessionId: "session-m0",
      createdAt: TIMESTAMP,
      affectedPhaseIds: [phaseId(0)],
      affectedTaskIds: ["task-pending"],
      oldValue: { revisionNumber: 2 },
      newValue: { revisionNumber: 3 },
      operation: {
        kind: "modify_acceptance_criteria",
        taskId: "task-pending",
        acceptanceCriteria: ["Criterion for task-pending is verifiable"],
      },
    },
    {
      id: "roadmap-revision-2",
      projectId: PROJECT_ID,
      classification: "significant",
      reason: "Tighten architecture validation",
      actor: "master",
      sessionId: "session-m0",
      createdAt: TIMESTAMP,
      affectedPhaseIds: [phaseId(2)],
      affectedTaskIds: ["task-running"],
      oldValue: { revisionNumber: 1 },
      newValue: { revisionNumber: 2 },
      operation: {
        kind: "change_architecture_task_details",
        taskId: "task-running",
        riskLevel: "high",
      },
      approval: {
        decisionId: "decision-m0",
        approvedBy: "user",
        approvedAt: TIMESTAMP,
        sessionId: "session-m0",
      },
    },
  ];
  return { roadmap, snapshot, revisions };
}

test("roadmap catalog covers every canonical phase and task state verbatim", () => {
  assert.deepEqual([...ROADMAP_CANONICAL_PHASE_STATES], PHASE_STATES);
  assert.deepEqual([...ROADMAP_CANONICAL_TASK_STATES], TASK_STATES);
  assert.equal(ROADMAP_COMMAND, "densa-ade.showRoadmap");
  assert.equal(ROADMAP_EDITOR_VIEW_TYPE, "densa-ade.roadmap");
  assert.equal(ROADMAP_LIFECYCLE.optimisticComplete, false);
  assert.equal(ROADMAP_LIFECYCLE.coreContinuesAfterClose, true);
  assert.equal(ROADMAP_LIFECYCLE.reopenRefreshesSnapshot, true);
  for (const method of [...ROADMAP_OPEN_REFRESH_METHODS, ...ROADMAP_CAPABILITY_METHODS]) {
    assert.ok(CORE_V1_METHODS.includes(method), method);
  }
  assert.ok(ROADMAP_OPEN_REFRESH_METHODS.includes("roadmaps.get"));
  assert.ok(ROADMAP_OPEN_REFRESH_METHODS.includes("projects.get"));
  assert.ok(ROADMAP_OPEN_REFRESH_METHODS.includes("roadmaps.revisions.list"));
});

test("fixture project renders structure, states, dependencies, criteria, and audit history", () => {
  const { roadmap, snapshot, revisions } = makeFixture();
  const model = buildRoadmapModel({ roadmap, snapshot, revisions });

  assert.equal(model.projectId, PROJECT_ID);
  assert.equal(model.projectState, "RUNNING");
  assert.equal(model.executionMode, "phase");
  assert.equal(model.projectGoal, "Render the complete roadmap truthfully");
  assert.equal(model.revisionNumber, 3);
  assert.equal(model.phases.length, 7);
  assert.equal(model.tasks.length, 11);
  assert.equal(model.optimisticComplete, false);
  assert.equal(model.enabled, true);
  assert.equal(model.reason, undefined);

  for (const [index, state] of PHASE_STATES.entries()) {
    const phase = roadmapPhaseById(model, phaseId(index));
    assert.equal(phase.state, state);
    assert.equal(phase.position, index);
    assert.ok(phase.title.length > 0);
    assert.ok(phase.goal.length > 0);
    assert.equal(phase.required, true);
    assert.ok(phase.completionCriteria.length >= 1);
    assert.ok(phase.taskIds.length >= 1);
  }
  for (const state of TASK_STATES) {
    assert.ok(
      model.tasks.some((task) => task.state === state),
      `renders task state ${state}`,
    );
  }
  for (const task of model.tasks) {
    assert.ok(task.acceptanceCriteria.length >= 1, task.id);
    assert.ok(task.expectedValidators.length >= 1, task.id);
    assert.ok(task.goal.length > 0, task.id);
  }

  const ready = roadmapTaskById(model, "task-ready");
  assert.deepEqual([...ready.dependencyIds], ["task-pending"]);
  assert.deepEqual([...ready.blockedBy], ["task-pending"]);
  const running = roadmapTaskById(model, "task-running");
  assert.deepEqual([...running.dependencyIds], []);
  assert.deepEqual([...running.blockedBy], []);

  assert.equal(model.currentPhaseId, phaseId(0));
  assert.equal(model.currentTaskId, "task-running");
  assert.ok(roadmapTaskById(model, "task-running").isCurrent);
  assert.equal(roadmapTaskById(model, "task-ready").isCurrent, false);

  assert.deepEqual([...model.awaitingApprovalPhaseIds], [phaseId(4)]);
  assert.equal(model.pendingPhaseApprovals.length, 1);
  assert.equal(model.pendingPhaseApprovals[0].phaseId, phaseId(4));

  assert.equal(model.revisions.length, 2);
  const first = roadmapRevisionById(model, "roadmap-revision-1");
  assert.equal(first.classification, "minor");
  assert.equal(first.reason, "Add a missing test task");
  assert.equal(first.actor, "user");
  assert.deepEqual([...first.operationKinds], ["modify_acceptance_criteria"]);
  assert.equal(first.hasApproval, false);
  const second = roadmapRevisionById(model, "roadmap-revision-2");
  assert.equal(second.hasApproval, true);

  assert.equal(model.latestEventSequence, 42);
});

test("selection, drill-downs, and mutation requests resolve to Core operations only", () => {
  const { roadmap, snapshot, revisions } = makeFixture();
  const selected = buildRoadmapModel({
    roadmap,
    snapshot,
    revisions,
    selection: { taskId: "task-running" },
  });
  assert.equal(selected.selectedTaskId, "task-running");
  assert.equal(selected.selectedPhaseId, phaseId(2));

  const phaseOnly = buildRoadmapModel({
    roadmap,
    snapshot,
    revisions,
    selection: { phaseId: phaseId(4) },
  });
  assert.equal(phaseOnly.selectedPhaseId, phaseId(4));
  assert.equal(phaseOnly.selectedTaskId, undefined);

  assert.throws(
    () => buildRoadmapModel({ roadmap, snapshot, revisions, selection: { taskId: "nope" } }),
    /not in the current roadmap/u,
  );
  assert.throws(
    () =>
      buildRoadmapModel({
        roadmap,
        snapshot,
        revisions,
        selection: { phaseId: phaseId(0), taskId: "task-running" },
      }),
    /does not own task/u,
  );

  const attempts = resolveRoadmapDrilldown(selected, { kind: "attempts", taskId: "task-running" });
  assert.equal(attempts.method, "attempts.list");
  assert.equal(attempts.projectId, PROJECT_ID);
  const runs = resolveRoadmapDrilldown(selected, {
    kind: "validation-runs",
    taskId: "task-running",
  });
  assert.equal(runs.method, "validation.list");
  const detail = resolveRoadmapDrilldown(selected, {
    kind: "validation-detail",
    taskId: "task-running",
    validationRunId: "validation-v1",
  });
  assert.equal(detail.method, "validation.get");
  assert.equal(detail.validationRunId, "validation-v1");
  const report = resolveRoadmapDrilldown(selected, { kind: "phase-report", phaseId: phaseId(4) });
  assert.equal(report.method, "phases.report.get");
  assert.throws(
    () => resolveRoadmapDrilldown(selected, { kind: "attempts", taskId: "nope" }),
    /Unknown roadmap task/u,
  );
  assert.throws(
    () => resolveRoadmapDrilldown(selected, { kind: "phase-report", phaseId: "nope" }),
    /Unknown roadmap phase/u,
  );

  const propose = resolveRoadmapPropose(selected, {
    operations: [
      {
        kind: "modify_acceptance_criteria",
        taskId: "task-pending",
        acceptanceCriteria: ["Tightened criterion"],
      },
    ],
    rationale: "Tighten the acceptance wording",
    actor: "user",
    sessionId: "session-m0",
  });
  assert.equal(propose.method, "roadmaps.revisions.propose");
  assert.equal(propose.baseRevisionNumber, 3);
  assert.throws(
    () =>
      resolveRoadmapPropose(selected, {
        operations: [],
        rationale: "Empty",
        actor: "user",
        sessionId: "session-m0",
      }),
    /1 to 32/u,
  );

  const resolve = resolveRoadmapResolve(selected, {
    proposalEventId: "proposal-event-1",
    resolution: "approve",
    rationale: "The revision is correct",
    actor: "user",
    sessionId: "session-m0",
  });
  assert.equal(resolve.method, "roadmaps.revisions.resolve");

  const approval = resolveRoadmapPhaseApproval(selected, {
    phaseId: phaseId(4),
    decision: "approve",
    actor: "user",
    reason: "Validation passed",
  });
  assert.equal(approval.method, "phases.approve");
  assert.throws(
    () =>
      resolveRoadmapPhaseApproval(selected, {
        phaseId: phaseId(0),
        decision: "approve",
        actor: "user",
        reason: "Too early",
      }),
    /not AWAITING_APPROVAL/u,
  );

  const taskApproval = resolveRoadmapTaskApproval(selected, {
    taskId: "task-running",
    decision: "approve",
    actor: "user",
    reason: "Guided step looks correct",
  });
  assert.equal(taskApproval.method, "tasks.approve");
  assert.equal(taskApproval.phaseId, phaseId(2));

  assert.equal(isRoadmapStaleOutcome("STALE"), true);
  assert.equal(isRoadmapStaleOutcome("APPLIED"), false);
  const reconciled = reconcileRoadmapStaleOutcome({
    baseRevisionNumber: 3,
    latestRevisionNumber: 4,
  });
  assert.equal(reconciled.action, "refresh-before-retry");
  assert.ok(reconciled.refreshMethods.includes("roadmaps.get"));
  assert.ok(reconciled.refreshMethods.includes("projects.get"));
  assert.ok(reconciled.refreshMethods.includes("roadmaps.revisions.list"));
  assert.match(reconciled.reason, /stale/iu);
});

test("roadmap and snapshot disagreement never invents state", () => {
  const { roadmap, snapshot, revisions } = makeFixture();
  const other = { ...snapshot, summary: { ...snapshot.summary } };
  assert.throws(
    () =>
      buildRoadmapModel({
        roadmap: { ...roadmap, projectId: "project-elsewhere" },
        snapshot,
        revisions,
      }),
    /disagree on projectId/u,
  );
  assert.throws(
    () =>
      buildRoadmapModel({
        roadmap,
        snapshot,
        revisions: [{ ...revisions[0], projectId: "project-elsewhere" }],
      }),
    /crossed the requested project boundary/u,
  );
  const missingPhase = {
    ...snapshot,
    phases: snapshot.phases.filter((phase) => phase.id !== phaseId(0)),
  };
  assert.throws(
    () => buildRoadmapModel({ roadmap, snapshot: missingPhase, revisions }),
    /has no runtime state/u,
  );
  void other;
});

test("unconnected roadmap explains what is needed", () => {
  const { roadmap, snapshot, revisions } = makeFixture();
  const disconnected = buildRoadmapModel({
    roadmap,
    snapshot,
    revisions,
    connectionState: "disconnected",
  });
  assert.equal(disconnected.enabled, false);
  assert.match(disconnected.reason, /densa-ade core start/u);
  const mismatch = buildRoadmapModel({
    roadmap,
    snapshot,
    revisions,
    connectionState: "version-mismatch",
  });
  assert.match(mismatch.reason, /protocol mismatch/iu);
});

async function withRoadmapDaemon(run) {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "densa-roadmap-m0-"));
  const workspace = await mkdtemp(join(tmpdir(), "densa-roadmap-ws-"));
  const database = DensaAdeDatabase.openInMemory();
  const daemon = await CoreDaemon.start({ runtimeDirectory, database });
  let requestNumber = 0;
  const connection = new IdeCoreConnection({
    runtimeDirectory,
    createRequestId: () => `roadmap-m0-${String((requestNumber += 1))}`,
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
    idea: "Prove the Roadmap surface reflects Core truth",
    executionMode: "phase",
    actor: "test",
  });
  await connection.request("projects.interview.answer", {
    projectId: created.project.id,
    sessionId: "session-m0",
    answers: [{ questionId: "scope", answer: "Deterministic roadmap surface" }],
  });
  const generated = await connection.request("roadmaps.generate", {
    projectId: created.project.id,
    sessionId: "session-m0",
    actor: "test",
  });
  await connection.request("projects.start", {
    projectId: created.project.id,
    workspacePath: workspace,
    actor: "test",
  });
  return { projectId: created.project.id, generated };
}

test("phase approval transitions through Core, never optimistically", async () => {
  await withRoadmapDaemon(async ({ connection, database, workspace }) => {
    const { projectId } = await createLiveProject(connection, workspace, "Roadmap approval live");
    const before = await connection.request("projects.get", { projectId });
    const phaseIdLive = before.phases[0].id;

    const { stateTransitionService } = await import("../packages/core/dist/index.js");
    const timestamp = new Date().toISOString();
    for (const next of ["READY", "RUNNING", "VALIDATING", "AWAITING_APPROVAL"]) {
      const current = database.repositories.phases.findById(phaseIdLive);
      if (current.state === next) continue;
      database.persistStateTransition(
        stateTransitionService.transitionPhase(current, next, {
          actor: "test",
          occurredAt: timestamp,
          reason: "roadmap UI test advances phase",
        }),
        `roadmap-advance-${next}`,
      );
    }

    const roadmap = await connection.request("roadmaps.get", { projectId });
    const snapshot = await connection.request("projects.get", { projectId });
    const listed = await connection.request("roadmaps.revisions.list", { projectId });
    const model = buildRoadmapModel({ roadmap, snapshot, revisions: listed.revisions });
    assert.ok(model.awaitingApprovalPhaseIds.includes(phaseIdLive));
    assert.equal(roadmapPhaseById(model, phaseIdLive).state, "AWAITING_APPROVAL");

    const resolution = resolveRoadmapPhaseApproval(model, {
      phaseId: phaseIdLive,
      decision: "approve",
      actor: "test",
      reason: "Validation passed",
    });
    assert.equal(resolution.method, "phases.approve");
    const { method, ...payload } = resolution;
    const outcome = await connection.request(method, payload);
    assert.equal(outcome.outcome, "APPROVED");
    assert.equal(outcome.phase.state, "COMPLETED");

    const reread = await connection.request("projects.get", { projectId });
    const rebuilt = buildRoadmapModel({
      roadmap: await connection.request("roadmaps.get", { projectId }),
      snapshot: reread,
      revisions: (await connection.request("roadmaps.revisions.list", { projectId })).revisions,
    });
    assert.equal(roadmapPhaseById(rebuilt, phaseIdLive).state, "COMPLETED");
  });
});

test("stale roadmap proposals reconcile by refreshing before retry", async () => {
  await withRoadmapDaemon(async ({ connection, workspace }) => {
    const { projectId, generated } = await createLiveProject(
      connection,
      workspace,
      "Roadmap stale live",
    );
    const phaseIdLive = generated.roadmap.phases[0].id;
    const taskId = generated.roadmap.phases[0].tasks[0].id;

    // Proposal A needs approval, so it stays pending against revision 0.
    const pending = await connection.request("roadmaps.revisions.propose", {
      projectId,
      baseRevisionNumber: 0,
      operations: [
        { kind: "modify_acceptance_criteria", taskId, acceptanceCriteria: ["Revised criterion"] },
      ],
      rationale: "Tighten the acceptance wording",
      actor: "test",
      sessionId: "session-m0",
    });
    assert.equal(pending.outcome, "AWAITING_USER_APPROVAL");

    // Proposal B is MINOR and auto-applies, advancing the roadmap to revision 1.
    const advanced = await connection.request("roadmaps.revisions.propose", {
      projectId,
      baseRevisionNumber: 0,
      operations: [
        {
          kind: "add_task",
          phaseId: phaseIdLive,
          position: generated.roadmap.phases[0].tasks.length,
          task: {
            id: "stale-probe-task",
            title: "Probe task",
            goal: "Advance the revision so the pending proposal goes stale",
            executable: true,
            dependencyIds: [],
            acceptanceCriteria: ["The probe task exists"],
            riskLevel: "low",
            expectedValidators: ["unit_test"],
          },
        },
      ],
      rationale: "Advance the revision with a minor addition",
      actor: "test",
      sessionId: "session-m0",
    });
    if (advanced.outcome === "AWAITING_USER_APPROVAL") {
      const applied = await connection.request("roadmaps.revisions.resolve", {
        projectId,
        proposalEventId: advanced.proposal.proposalEventId,
        resolution: "approve",
        rationale: "The addition is correct",
        actor: "test",
        sessionId: "session-m0",
      });
      assert.equal(applied.outcome, "APPLIED");
    } else {
      assert.equal(advanced.outcome, "APPLIED");
    }

    // Resolving the outdated proposal reconciles as STALE instead of
    // overwriting the newer revision.
    const stale = await connection.request("roadmaps.revisions.resolve", {
      projectId,
      proposalEventId: pending.proposal.proposalEventId,
      resolution: "approve",
      rationale: "Approve from an outdated base",
      actor: "test",
      sessionId: "session-m0",
    });
    assert.equal(stale.outcome, "STALE");
    assert.equal(isRoadmapStaleOutcome(stale.outcome), true);

    const freshRoadmap = await connection.request("roadmaps.get", { projectId });
    assert.equal(freshRoadmap.revisionNumber, 1);
    const reconciliation = reconcileRoadmapStaleOutcome({
      baseRevisionNumber: 0,
      latestRevisionNumber: freshRoadmap.revisionNumber,
    });
    assert.equal(reconciliation.action, "refresh-before-retry");
    assert.ok(reconciliation.refreshMethods.includes("roadmaps.get"));
    assert.ok(reconciliation.refreshMethods.includes("projects.get"));
    assert.ok(reconciliation.refreshMethods.includes("roadmaps.revisions.list"));

    const model = buildRoadmapModel({
      roadmap: freshRoadmap,
      snapshot: await connection.request("projects.get", { projectId }),
      revisions: (await connection.request("roadmaps.revisions.list", { projectId })).revisions,
    });
    assert.equal(model.revisionNumber, 1);
    const retry = resolveRoadmapPropose(model, {
      operations: [
        { kind: "modify_acceptance_criteria", taskId, acceptanceCriteria: ["Another criterion"] },
      ],
      rationale: "Retry from the refreshed revision",
      actor: "test",
      sessionId: "session-m0",
    });
    assert.equal(retry.baseRevisionNumber, 1);
    const { method, ...payload } = retry;
    const retried = await connection.request(method, payload);
    assert.notEqual(retried.outcome, "STALE");
  });
});

test("roadmap extension sources stay protocol-only", () => {
  const extensionDir = new URL("../apps/ide-extension/src/", import.meta.url);
  const sources = ["index.ts", "roadmap.ts"]
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
