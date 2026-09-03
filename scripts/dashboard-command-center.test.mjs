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
  DASHBOARD_CANONICAL_PHASE_STATES,
  DASHBOARD_CANONICAL_PROJECT_STATES,
  DASHBOARD_CANONICAL_TASK_STATES,
  DASHBOARD_CAPABILITY_METHODS,
  DASHBOARD_COMMAND,
  DASHBOARD_EDITOR_VIEW_TYPE,
  DASHBOARD_LIFECYCLE,
  DASHBOARD_OPEN_REFRESH_METHODS,
  IdeCoreConnection,
  buildDashboardModel,
  dashboardEventIsRefreshHint,
  dashboardPhaseProgressById,
  resolveDashboardDrilldown,
  resolveDashboardReopenRefresh,
} from "../apps/ide-extension/dist/index.js";

const PROJECT_ID = "project-dashboard-m1";
const WORKSPACE = "/tmp/densa-dashboard-m1";
const CREATED_AT = "2026-09-03T00:00:00.000Z";
const UPDATED_AT = "2026-09-03T01:30:00.000Z";
const HEAD_SHA = "abcdef1234567890abcdef1234567890abcdef12";

const PROJECT_STATES = [
  "DRAFT",
  "PLANNING",
  "READY",
  "RUNNING",
  "PAUSED",
  "WAITING_FOR_USER",
  "WAITING_FOR_USAGE",
  "BLOCKED",
  "COMPLETED",
  "FAILED",
];
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

function makeFixture(overrides = {}) {
  const dashboard = {
    project: {
      project: {
        id: PROJECT_ID,
        name: "Dashboard fixture",
        state: "RUNNING",
        executionMode: "phase",
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
      },
      workspacePath: WORKSPACE,
      currentPhaseId: "phase-one",
      completedTaskCount: 0,
      totalTaskCount: 3,
      attentionRequired: false,
    },
    phaseCounts: [
      { state: "RUNNING", count: 1 },
      { state: "PENDING", count: 1 },
    ],
    taskCounts: [
      { state: "RUNNING", count: 1 },
      { state: "PENDING", count: 2 },
    ],
    currentPhase: {
      id: "phase-one",
      projectId: PROJECT_ID,
      title: "Phase one",
      state: "RUNNING",
      position: 0,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    },
    currentTask: {
      id: "task-alpha",
      projectId: PROJECT_ID,
      phaseId: "phase-one",
      title: "Task alpha",
      state: "RUNNING",
      position: 0,
      acceptanceCriteria: ["Alpha criterion is verifiable"],
      dependencyIds: [],
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    },
    pendingApprovals: [],
    recentFailureCount: 1,
    retryCount: 1,
    validation: { passed: 2, failed: 1, incomplete: 1 },
    usage: { status: "available" },
    keepAwake: {
      formatVersion: 1,
      projectId: PROJECT_ID,
      state: "inactive",
      systemSleepPrevented: false,
      displaySleepAllowed: true,
      reasons: [],
      batteryPolicy: { minimumLevelPercent: 20 },
      updatedAt: UPDATED_AT,
    },
    latestEventSequence: 5,
    ...overrides.dashboard,
  };
  const snapshot = {
    summary: dashboard.project,
    phases: [
      {
        id: "phase-one",
        projectId: PROJECT_ID,
        title: "Phase one",
        state: "RUNNING",
        position: 0,
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
      },
      {
        id: "phase-two",
        projectId: PROJECT_ID,
        title: "Phase two",
        state: "PENDING",
        position: 1,
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
      },
    ],
    tasks: [
      {
        id: "task-alpha",
        projectId: PROJECT_ID,
        phaseId: "phase-one",
        title: "Task alpha",
        state: "RUNNING",
        position: 0,
        acceptanceCriteria: ["Alpha criterion is verifiable"],
        dependencyIds: [],
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
      },
      {
        id: "task-beta",
        projectId: PROJECT_ID,
        phaseId: "phase-one",
        title: "Task beta",
        state: "PENDING",
        position: 1,
        acceptanceCriteria: ["Beta criterion is verifiable"],
        dependencyIds: ["task-alpha"],
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
      },
      {
        id: "task-gamma",
        projectId: PROJECT_ID,
        phaseId: "phase-two",
        title: "Task gamma",
        state: "PENDING",
        position: 0,
        acceptanceCriteria: ["Gamma criterion is verifiable"],
        dependencyIds: [],
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
      },
    ],
    pendingApprovals: [],
    usage: dashboard.usage,
    latestEventSequence: 5,
    ...overrides.snapshot,
  };
  const recentEvents = overrides.recentEvents ?? [
    {
      id: "event-4",
      projectId: PROJECT_ID,
      type: "TASK_STARTED",
      eventVersion: 1,
      occurredAt: CREATED_AT,
      actor: "test",
      taskId: "task-alpha",
      payload: {},
      sequenceNumber: 4,
    },
    {
      id: "event-5",
      projectId: PROJECT_ID,
      type: "VALIDATION_FAILED",
      eventVersion: 1,
      occurredAt: UPDATED_AT,
      actor: "test",
      taskId: "task-alpha",
      payload: {},
      sequenceNumber: 5,
    },
  ];
  const gitStatus =
    "gitStatus" in overrides
      ? overrides.gitStatus
      : {
          projectId: PROJECT_ID,
          workspacePath: WORKSPACE,
          available: true,
          headSha: HEAD_SHA,
          branch: "densa-ade/run",
          dirty: true,
          changedPaths: ["src/a.ts", "src/b.ts"],
          observedAt: UPDATED_AT,
        };
  return { dashboard, snapshot, recentEvents, gitStatus };
}

test("dashboard catalog covers canonical states, command, lifecycle, and Core methods", () => {
  assert.deepEqual([...DASHBOARD_CANONICAL_PROJECT_STATES], PROJECT_STATES);
  assert.deepEqual([...DASHBOARD_CANONICAL_PHASE_STATES], PHASE_STATES);
  assert.deepEqual([...DASHBOARD_CANONICAL_TASK_STATES], TASK_STATES);
  assert.equal(DASHBOARD_COMMAND, "densa-ade.showDashboard");
  assert.equal(DASHBOARD_EDITOR_VIEW_TYPE, "densa-ade.dashboard");
  assert.equal(DASHBOARD_LIFECYCLE.optimisticComplete, false);
  assert.equal(DASHBOARD_LIFECYCLE.coreContinuesAfterClose, true);
  assert.equal(DASHBOARD_LIFECYCLE.reopenRefreshesSnapshot, true);
  for (const method of [...DASHBOARD_OPEN_REFRESH_METHODS, ...DASHBOARD_CAPABILITY_METHODS]) {
    assert.ok(CORE_V1_METHODS.includes(method), method);
  }
  assert.ok(DASHBOARD_OPEN_REFRESH_METHODS.includes("dashboard.get"));
  assert.ok(DASHBOARD_OPEN_REFRESH_METHODS.includes("projects.get"));
  assert.ok(DASHBOARD_OPEN_REFRESH_METHODS.includes("events.replay"));
  assert.ok(DASHBOARD_CAPABILITY_METHODS.includes("attempts.list"));
  assert.ok(DASHBOARD_CAPABILITY_METHODS.includes("validation.list"));
  assert.ok(DASHBOARD_CAPABILITY_METHODS.includes("validation.get"));
  assert.ok(DASHBOARD_CAPABILITY_METHODS.includes("git.status"));
  assert.ok(DASHBOARD_CAPABILITY_METHODS.includes("git.commit.get"));
  assert.ok(DASHBOARD_CAPABILITY_METHODS.includes("events.replay"));
  assert.ok(DASHBOARD_CAPABILITY_METHODS.includes("events.subscribe"));
  assert.ok(DASHBOARD_CAPABILITY_METHODS.includes("logs.list"));
  assert.ok(DASHBOARD_CAPABILITY_METHODS.includes("usage.get"));
  assert.ok(DASHBOARD_CAPABILITY_METHODS.includes("phases.report.get"));
});

test("fixture project renders PROJECT, CURRENT, HEALTH, CHANGES, AGENTS/USAGE, and EVENTS", () => {
  const { dashboard, snapshot, recentEvents, gitStatus } = makeFixture();
  const model = buildDashboardModel({ dashboard, snapshot, recentEvents, gitStatus });

  assert.equal(model.projectId, PROJECT_ID);
  assert.equal(model.optimisticComplete, false);
  assert.equal(model.enabled, true);
  assert.equal(model.reason, undefined);

  // PROJECT
  assert.equal(model.project.id, PROJECT_ID);
  assert.equal(model.project.name, "Dashboard fixture");
  assert.equal(model.project.state, "RUNNING");
  assert.equal(model.project.executionMode, "phase");
  assert.equal(model.project.workspacePath, WORKSPACE);
  assert.equal(model.project.completedTaskCount, 0);
  assert.equal(model.project.totalTaskCount, 3);
  assert.equal(model.project.attentionRequired, false);
  assert.equal(model.project.elapsedKnown, true);
  assert.equal(model.project.elapsedMs, 5_400_000);
  assert.ok(model.project.phaseCounts.some((entry) => entry.state === "RUNNING"));
  assert.ok(model.project.taskCounts.some((entry) => entry.state === "RUNNING"));

  // CURRENT
  assert.equal(model.current.lifecycleState, "RUNNING");
  assert.equal(model.current.phaseId, "phase-one");
  assert.equal(model.current.phaseState, "RUNNING");
  assert.equal(model.current.taskId, "task-alpha");
  assert.equal(model.current.taskState, "RUNNING");
  assert.equal(model.current.hasCurrentWork, true);
  assert.equal(model.current.pendingApprovalCount, 0);

  // HEALTH
  assert.equal(model.health.passed, 2);
  assert.equal(model.health.failed, 1);
  assert.equal(model.health.incomplete, 1);
  assert.equal(model.health.recentFailureCount, 1);
  assert.equal(model.health.retryCount, 1);
  assert.equal(model.health.hasFailures, true);

  // CHANGES
  assert.equal(model.changes.gitObserved, true);
  assert.equal(model.changes.available, true);
  assert.equal(model.changes.headSha, HEAD_SHA);
  assert.equal(model.changes.branch, "densa-ade/run");
  assert.equal(model.changes.dirty, true);
  assert.deepEqual([...model.changes.changedPaths], ["src/a.ts", "src/b.ts"]);
  assert.equal(model.changes.changedPathCount, 2);
  assert.equal(model.changes.additionsDeletionsAvailable, false);

  // AGENTS/USAGE
  assert.equal(model.agentsUsage.backend, "unknown");
  assert.deepEqual(model.agentsUsage.usage, { status: "available" });
  assert.equal(model.agentsUsage.usageResetKnown, false);
  assert.equal(model.agentsUsage.usageResetAt, undefined);
  assert.equal(model.agentsUsage.retryCount, 1);
  assert.equal(model.agentsUsage.recentFailureCount, 1);

  // EVENTS
  assert.equal(model.events.latestEventSequence, 5);
  assert.equal(model.events.recentEventCount, 2);
  assert.equal(model.events.recentEvents[0].sequenceNumber, 4);
  assert.equal(model.events.recentEvents[1].type, "VALIDATION_FAILED");

  // Phase progress is drillable per phase.
  assert.equal(model.phases.length, 2);
  assert.equal(dashboardPhaseProgressById(model, "phase-one").state, "RUNNING");
  assert.equal(dashboardPhaseProgressById(model, "phase-one").totalTaskCount, 2);
  assert.equal(dashboardPhaseProgressById(model, "phase-two").completedTaskCount, 0);
  assert.throws(() => dashboardPhaseProgressById(model, "nope"), /Unknown dashboard phase/u);

  // Status banner for a healthy running project.
  assert.equal(model.statusBanner.kind, "ok");
  assert.ok(model.statusBanner.nextActions.length >= 1);

  // Rebuilding from identical snapshots yields identical facts.
  const rebuilt = buildDashboardModel({ dashboard, snapshot, recentEvents, gitStatus });
  assert.deepEqual(JSON.parse(JSON.stringify(rebuilt)), JSON.parse(JSON.stringify(model)));

  // Event notifications are refresh hints only, never direct edits.
  assert.equal(dashboardEventIsRefreshHint("TASK_STARTED"), true);
  assert.equal(dashboardEventIsRefreshHint("USAGE_LIMIT_REACHED"), true);
});

test("dashboard without optional Git observation degrades explicitly", () => {
  const { dashboard, snapshot, recentEvents } = makeFixture({ gitStatus: undefined });
  const model = buildDashboardModel({ dashboard, snapshot, recentEvents });
  assert.equal(model.changes.gitObserved, false);
  assert.equal(model.changes.available, undefined);
  assert.equal(model.changes.headSha, undefined);
  assert.equal(model.changes.additionsDeletionsAvailable, false);
  const status = resolveDashboardDrilldown(model, { kind: "git-status" });
  assert.equal(status.method, "git.status");
  assert.equal(status.workspacePath, WORKSPACE);
});

test("every meaningful metric resolves to a Core drill-down operation", () => {
  const { dashboard, snapshot, recentEvents, gitStatus } = makeFixture();
  const model = buildDashboardModel({ dashboard, snapshot, recentEvents, gitStatus });

  const refresh = resolveDashboardDrilldown(model, { kind: "dashboard-refresh" });
  assert.equal(refresh.method, "dashboard.get");
  assert.equal(refresh.projectId, PROJECT_ID);

  const snap = resolveDashboardDrilldown(model, { kind: "project-snapshot" });
  assert.equal(snap.method, "projects.get");

  const events = resolveDashboardDrilldown(model, { kind: "events" });
  assert.equal(events.method, "events.replay");
  assert.equal(events.afterSequence, 5);

  const logs = resolveDashboardDrilldown(model, {
    kind: "run-logs",
    taskId: "task-alpha",
  });
  assert.equal(logs.method, "logs.list");
  assert.equal(logs.taskId, "task-alpha");

  const attempts = resolveDashboardDrilldown(model, { kind: "attempts", taskId: "task-alpha" });
  assert.equal(attempts.method, "attempts.list");
  assert.equal(attempts.taskId, "task-alpha");

  const runs = resolveDashboardDrilldown(model, {
    kind: "validation-runs",
    taskId: "task-alpha",
  });
  assert.equal(runs.method, "validation.list");

  const detail = resolveDashboardDrilldown(model, {
    kind: "validation-detail",
    validationRunId: "validation-v1",
  });
  assert.equal(detail.method, "validation.get");
  assert.equal(detail.validationRunId, "validation-v1");

  const git = resolveDashboardDrilldown(model, { kind: "git-status" });
  assert.equal(git.method, "git.status");

  const commit = resolveDashboardDrilldown(model, { kind: "git-commit", sha: HEAD_SHA });
  assert.equal(commit.method, "git.commit.get");
  assert.equal(commit.sha, HEAD_SHA);

  const usage = resolveDashboardDrilldown(model, { kind: "usage" });
  assert.equal(usage.method, "usage.get");

  const report = resolveDashboardDrilldown(model, { kind: "phase-report", phaseId: "phase-one" });
  assert.equal(report.method, "phases.report.get");
  assert.equal(report.phaseId, "phase-one");

  const decisions = resolveDashboardDrilldown(model, { kind: "decisions" });
  assert.equal(decisions.method, "decisions.list");

  assert.throws(
    () => resolveDashboardDrilldown(model, { kind: "attempts", taskId: "   " }),
    /persisted taskId/u,
  );
  assert.throws(
    () => resolveDashboardDrilldown(model, { kind: "validation-detail", validationRunId: "" }),
    /persisted validationRunId/u,
  );
  assert.throws(
    () => resolveDashboardDrilldown(model, { kind: "phase-report", phaseId: "nope" }),
    /Unknown dashboard phase/u,
  );
  assert.throws(
    () => resolveDashboardDrilldown(model, { kind: "git-commit", sha: "  " }),
    /persisted commit SHA/u,
  );

  const reopen = resolveDashboardReopenRefresh(PROJECT_ID);
  assert.equal(reopen.action, "refresh-before-render");
  assert.ok(reopen.refreshMethods.includes("dashboard.get"));
  assert.ok(reopen.refreshMethods.includes("projects.get"));
  assert.ok(reopen.refreshMethods.includes("events.replay"));
  assert.match(reopen.reason, /hints to refresh/iu);
  assert.throws(() => resolveDashboardReopenRefresh("   "), /persisted projectId/u);
});

test("dashboard never fabricates token, cost, reset, backend, or elapsed metrics", () => {
  const { dashboard, snapshot, recentEvents, gitStatus } = makeFixture();
  const model = buildDashboardModel({ dashboard, snapshot, recentEvents, gitStatus });
  const serialized = JSON.stringify(model);
  assert.doesNotMatch(serialized, /token/iu);
  assert.doesNotMatch(serialized, /"cost"/iu);

  // Limited usage without an observed reset carries no countdown.
  const limitedUnknown = buildDashboardModel({
    dashboard: { ...dashboard, usage: { status: "limited" } },
    snapshot: { ...snapshot, usage: { status: "limited" } },
    recentEvents,
    gitStatus,
  });
  assert.equal(limitedUnknown.agentsUsage.usageResetKnown, false);
  assert.equal(limitedUnknown.agentsUsage.usageResetAt, undefined);

  // Limited usage with an observed reset echoes it verbatim.
  const resetAt = "2026-09-03T06:00:00.000Z";
  const limitedKnown = buildDashboardModel({
    dashboard: { ...dashboard, usage: { status: "limited", resetAt } },
    snapshot: { ...snapshot, usage: { status: "limited", resetAt } },
    recentEvents,
    gitStatus,
  });
  assert.equal(limitedKnown.agentsUsage.usageResetKnown, true);
  assert.equal(limitedKnown.agentsUsage.usageResetAt, resetAt);

  // Unknown usage preserves the provider reason verbatim.
  const unknown = buildDashboardModel({
    dashboard: {
      ...dashboard,
      usage: { status: "unknown", reason: "No current provider availability observation" },
    },
    snapshot: {
      ...snapshot,
      usage: { status: "unknown", reason: "No current provider availability observation" },
    },
    recentEvents,
    gitStatus,
  });
  assert.equal(unknown.agentsUsage.usage.status, "unknown");

  // Backend is always unknown: Core v1 exposes no adapter version here.
  assert.equal(model.agentsUsage.backend, "unknown");

  // Elapsed time is omitted when persisted timestamps are not deterministic.
  const badTime = buildDashboardModel({
    dashboard: {
      ...dashboard,
      project: {
        ...dashboard.project,
        project: {
          ...dashboard.project.project,
          createdAt: UPDATED_AT,
          updatedAt: CREATED_AT,
        },
      },
    },
    snapshot,
    recentEvents,
    gitStatus,
  });
  assert.equal(badTime.project.elapsedKnown, false);
  assert.equal(badTime.project.elapsedMs, undefined);
});

test("WAITING_FOR_USAGE and BLOCKED states are clear and actionable", () => {
  const { snapshot, recentEvents, gitStatus } = makeFixture();

  const waitingKnown = buildDashboardModel({
    dashboard: {
      project: {
        project: {
          id: PROJECT_ID,
          name: "Dashboard fixture",
          state: "WAITING_FOR_USAGE",
          executionMode: "phase",
          createdAt: CREATED_AT,
          updatedAt: UPDATED_AT,
        },
        workspacePath: WORKSPACE,
        completedTaskCount: 0,
        totalTaskCount: 3,
        attentionRequired: true,
      },
      phaseCounts: [{ state: "RUNNING", count: 1 }],
      taskCounts: [{ state: "WAITING_FOR_USAGE", count: 1 }],
      pendingApprovals: [],
      recentFailureCount: 0,
      retryCount: 0,
      validation: { passed: 0, failed: 0, incomplete: 1 },
      usage: { status: "limited", resetAt: "2026-09-03T06:00:00.000Z" },
      latestEventSequence: 5,
    },
    snapshot: {
      ...snapshot,
      summary: {
        ...snapshot.summary,
        project: { ...snapshot.summary.project, state: "WAITING_FOR_USAGE" },
      },
      latestEventSequence: 5,
    },
    recentEvents,
    gitStatus,
  });
  assert.equal(waitingKnown.statusBanner.kind, "waiting-for-usage");
  assert.match(waitingKnown.statusBanner.detail, /limited/iu);
  assert.match(waitingKnown.statusBanner.detail, /2026-09-03T06:00:00/u);
  assert.ok(waitingKnown.statusBanner.nextActions.length >= 2);

  const waitingUnknown = buildDashboardModel({
    dashboard: {
      project: {
        project: {
          id: PROJECT_ID,
          name: "Dashboard fixture",
          state: "WAITING_FOR_USAGE",
          executionMode: "phase",
          createdAt: CREATED_AT,
          updatedAt: UPDATED_AT,
        },
        workspacePath: WORKSPACE,
        completedTaskCount: 0,
        totalTaskCount: 3,
        attentionRequired: true,
      },
      phaseCounts: [{ state: "RUNNING", count: 1 }],
      taskCounts: [{ state: "WAITING_FOR_USAGE", count: 1 }],
      pendingApprovals: [],
      recentFailureCount: 0,
      retryCount: 0,
      validation: { passed: 0, failed: 0, incomplete: 1 },
      usage: { status: "limited" },
      latestEventSequence: 5,
    },
    snapshot: {
      ...snapshot,
      summary: {
        ...snapshot.summary,
        project: { ...snapshot.summary.project, state: "WAITING_FOR_USAGE" },
      },
      latestEventSequence: 5,
    },
    recentEvents,
    gitStatus,
  });
  assert.equal(waitingUnknown.statusBanner.kind, "waiting-for-usage");
  assert.match(waitingUnknown.statusBanner.detail, /no.*countdown|unknown/iu);
  assert.doesNotMatch(JSON.stringify(waitingUnknown.agentsUsage), /countdown/iu);

  const blocked = buildDashboardModel({
    dashboard: {
      project: {
        project: {
          id: PROJECT_ID,
          name: "Dashboard fixture",
          state: "BLOCKED",
          executionMode: "phase",
          createdAt: CREATED_AT,
          updatedAt: UPDATED_AT,
        },
        workspacePath: WORKSPACE,
        completedTaskCount: 0,
        totalTaskCount: 3,
        attentionRequired: true,
      },
      phaseCounts: [{ state: "BLOCKED", count: 1 }],
      taskCounts: [{ state: "BLOCKED", count: 1 }],
      pendingApprovals: [],
      recentFailureCount: 2,
      retryCount: 4,
      validation: { passed: 0, failed: 2, incomplete: 0 },
      usage: { status: "available" },
      latestEventSequence: 5,
    },
    snapshot: {
      ...snapshot,
      summary: {
        ...snapshot.summary,
        project: { ...snapshot.summary.project, state: "BLOCKED" },
      },
      latestEventSequence: 5,
    },
    recentEvents,
    gitStatus,
  });
  assert.equal(blocked.statusBanner.kind, "blocked");
  assert.match(blocked.statusBanner.detail, /intervention/iu);
  assert.match(blocked.statusBanner.detail, /4 retries/iu);
  assert.ok(
    blocked.statusBanner.nextActions.some((action) => action.includes("attempts.list")),
    "blocked banner points at attempt diagnostics",
  );
  assert.ok(
    blocked.statusBanner.nextActions.some((action) => action.includes("validation")),
    "blocked banner points at validation evidence",
  );
});

test("dashboard and snapshot disagreement never invents state", () => {
  const { dashboard, snapshot, recentEvents, gitStatus } = makeFixture();
  assert.throws(
    () =>
      buildDashboardModel({
        dashboard,
        snapshot: {
          ...snapshot,
          summary: {
            ...snapshot.summary,
            project: { ...snapshot.summary.project, id: "project-elsewhere" },
          },
        },
        recentEvents,
        gitStatus,
      }),
    /disagree on projectId/u,
  );
  assert.throws(
    () =>
      buildDashboardModel({
        dashboard: {
          ...dashboard,
          project: { ...dashboard.project, workspacePath: "/tmp/elsewhere" },
        },
        snapshot,
        recentEvents,
        gitStatus,
      }),
    /disagree on workspacePath/u,
  );
  assert.throws(
    () =>
      buildDashboardModel({
        dashboard: {
          ...dashboard,
          project: { ...dashboard.project, completedTaskCount: 99 },
        },
        snapshot,
        recentEvents,
        gitStatus,
      }),
    /disagree on task progress/u,
  );
  assert.throws(
    () =>
      buildDashboardModel({
        dashboard,
        snapshot: { ...snapshot, latestEventSequence: 99 },
        recentEvents,
        gitStatus,
      }),
    /disagree on latestEventSequence/u,
  );
  assert.throws(
    () =>
      buildDashboardModel({
        dashboard,
        snapshot,
        recentEvents: [{ ...recentEvents[0], projectId: "project-elsewhere" }],
        gitStatus,
      }),
    /crossed the requested project boundary/u,
  );
  assert.throws(
    () =>
      buildDashboardModel({
        dashboard,
        snapshot,
        recentEvents,
        gitStatus: { ...gitStatus, projectId: "project-elsewhere" },
      }),
    /Git status crossed/u,
  );
});

test("unconnected dashboard explains what is needed", () => {
  const { dashboard, snapshot, recentEvents, gitStatus } = makeFixture();
  const disconnected = buildDashboardModel({
    dashboard,
    snapshot,
    recentEvents,
    gitStatus,
    connectionState: "disconnected",
  });
  assert.equal(disconnected.enabled, false);
  assert.match(disconnected.reason, /densa-ade core start/u);
  const mismatch = buildDashboardModel({
    dashboard,
    snapshot,
    recentEvents,
    gitStatus,
    connectionState: "version-mismatch",
  });
  assert.match(mismatch.reason, /protocol mismatch/iu);
});

async function withDashboardDaemon(run) {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "densa-dashboard-m1-"));
  const workspace = await mkdtemp(join(tmpdir(), "densa-dashboard-ws-"));
  const database = DensaAdeDatabase.openInMemory();
  const daemon = await CoreDaemon.start({ runtimeDirectory, database });
  let requestNumber = 0;
  const connection = new IdeCoreConnection({
    runtimeDirectory,
    createRequestId: () => `dashboard-m1-${String((requestNumber += 1))}`,
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
    idea: "Prove the Dashboard reflects Core truth",
    executionMode: "phase",
    actor: "test",
  });
  await connection.request("projects.interview.answer", {
    projectId: created.project.id,
    sessionId: "session-m1",
    answers: [{ questionId: "scope", answer: "Deterministic dashboard surface" }],
  });
  await connection.request("roadmaps.generate", {
    projectId: created.project.id,
    sessionId: "session-m1",
    actor: "test",
  });
  await connection.request("projects.start", {
    projectId: created.project.id,
    workspacePath: workspace,
    actor: "test",
  });
  return { projectId: created.project.id };
}

test("reconnect and reload yield the same Dashboard facts through Core only", async () => {
  await withDashboardDaemon(async ({ connection, workspace, runtimeDirectory }) => {
    const { projectId } = await createLiveProject(connection, workspace, "Dashboard live");
    const dashboard = await connection.request("dashboard.get", { projectId });
    const snapshot = await connection.request("projects.get", { projectId });
    assert.equal(dashboard.project.project.id, projectId);
    assert.equal(snapshot.summary.project.id, projectId);
    // The aggregate and snapshot are read back-to-back; a background event
    // between them reconciles by refreshing the lagging side once.
    let freshDashboard = dashboard;
    let freshSnapshot = snapshot;
    if (freshDashboard.latestEventSequence !== freshSnapshot.latestEventSequence) {
      freshSnapshot = await connection.request("projects.get", { projectId });
      if (freshDashboard.latestEventSequence !== freshSnapshot.latestEventSequence) {
        freshDashboard = await connection.request("dashboard.get", { projectId });
      }
    }
    const replayed = await connection.request("events.replay", { projectId });
    const git = await connection.request("git.status", { projectId, workspacePath: workspace });
    const model = buildDashboardModel({
      dashboard: freshDashboard,
      snapshot: freshSnapshot,
      recentEvents: replayed.events,
      gitStatus: git,
    });
    assert.equal(model.projectId, projectId);
    assert.equal(model.optimisticComplete, false);
    assert.ok(model.phases.length >= 1);
    assert.equal(model.events.latestEventSequence, freshDashboard.latestEventSequence);

    // Every drillable metric executes against Core without inventing state.
    // Resolvers return a view `kind` plus the Core `method`; only the Core
    // payload fields travel over IPC.
    const attemptsTarget =
      freshSnapshot.tasks[0] === undefined ? undefined : freshSnapshot.tasks[0].id;
    if (attemptsTarget !== undefined) {
      const attempts = resolveDashboardDrilldown(model, {
        kind: "attempts",
        taskId: attemptsTarget,
      });
      assert.equal(attempts.method, "attempts.list");
      const listed = await connection.request(attempts.method, {
        projectId: attempts.projectId,
        taskId: attempts.taskId,
      });
      assert.ok(Array.isArray(listed.attempts));

      const validations = resolveDashboardDrilldown(model, {
        kind: "validation-runs",
        taskId: attemptsTarget,
      });
      assert.equal(validations.method, "validation.list");
      const runs = await connection.request(validations.method, {
        projectId: validations.projectId,
        taskId: validations.taskId,
      });
      assert.ok(Array.isArray(runs.runs));
    }
    const usage = resolveDashboardDrilldown(model, { kind: "usage" });
    assert.equal(usage.method, "usage.get");
    const observed = await connection.request(usage.method, { projectId: usage.projectId });
    assert.equal(observed.projectId, projectId);

    const logs = resolveDashboardDrilldown(model, { kind: "run-logs" });
    assert.equal(logs.method, "logs.list");
    const entries = await connection.request(logs.method, { projectId: logs.projectId });
    assert.ok(Array.isArray(entries.entries));

    const reopen = resolveDashboardReopenRefresh(projectId);
    assert.ok(reopen.refreshMethods.includes("dashboard.get"));

    // Closing the IDE connection leaves Core running; a fresh window
    // rebuilds the same Dashboard facts from persisted state.
    const beforeFacts = JSON.stringify({
      projectId: model.projectId,
      state: model.project.state,
      mode: model.project.executionMode,
      completed: model.project.completedTaskCount,
      total: model.project.totalTaskCount,
      sequence: model.latestEventSequence,
    });
    connection.dispose();
    let reopenedNumber = 0;
    const reopened = new IdeCoreConnection({
      runtimeDirectory,
      createRequestId: () => `dashboard-m1-reopen-${String((reopenedNumber += 1))}`,
    });
    try {
      await reopened.connect();
      const redashboard = await reopened.request("dashboard.get", { projectId });
      const resnapshot = await reopened.request("projects.get", { projectId });
      let nextDashboard = redashboard;
      let nextSnapshot = resnapshot;
      if (nextDashboard.latestEventSequence !== nextSnapshot.latestEventSequence) {
        nextSnapshot = await reopened.request("projects.get", { projectId });
      }
      const rebuilt = buildDashboardModel({
        dashboard: nextDashboard,
        snapshot: nextSnapshot,
        recentEvents: (await reopened.request("events.replay", { projectId })).events,
        gitStatus: await reopened.request("git.status", {
          projectId,
          workspacePath: workspace,
        }),
      });
      const afterFacts = JSON.stringify({
        projectId: rebuilt.projectId,
        state: rebuilt.project.state,
        mode: rebuilt.project.executionMode,
        completed: rebuilt.project.completedTaskCount,
        total: rebuilt.project.totalTaskCount,
        sequence: rebuilt.latestEventSequence,
      });
      assert.equal(afterFacts, beforeFacts);
    } finally {
      reopened.dispose();
    }
  });
});

test("dashboard extension sources stay protocol-only", () => {
  const extensionDir = new URL("../apps/ide-extension/src/", import.meta.url);
  const sources = ["index.ts", "dashboard.ts"]
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
