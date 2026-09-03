import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { URL } from "node:url";

import { CoreDaemon, ProjectExecutionControlService } from "../packages/core/dist/index.js";
import { DensaAdeDatabase } from "../packages/core/dist/persistence/index.js";
import { CORE_V1_METHODS, parseCoreV1Payload } from "../packages/protocol/dist/index.js";
import { FakeAgentAdapter } from "../packages/testing/dist/index.js";
import {
  IdeCoreConnection,
  LIVE_RUN_CANONICAL_PROJECT_STATES,
  LIVE_RUN_CANONICAL_TASK_STATES,
  LIVE_RUN_CANCEL_FALLBACK_METHOD,
  LIVE_RUN_CANCEL_TRANSPORT_METHOD,
  LIVE_RUN_CAPABILITY_METHODS,
  LIVE_RUN_LIFECYCLE,
  LIVE_RUN_OPEN_REFRESH_METHODS,
  applyLiveRunControlOutcome,
  buildLiveRunModel,
  liveRunEventIsRefreshHint,
  resolveLiveRunCancel,
  resolveLiveRunDrilldown,
  resolveLiveRunPause,
  resolveLiveRunReopenRefresh,
  resolveLiveRunResume,
  resolveLiveRunStop,
} from "../apps/ide-extension/dist/index.js";

const PROJECT_ID = "project-live-m4";
const PHASE_ID = "phase-live-m4";
const TASK_ID = "task-live-m4";
const WORKSPACE = "/tmp/densa-live-m4";
const TIMESTAMP = "2026-09-03T00:00:00.000Z";
const HEAD_SHA = "abcdef1234567890abcdef1234567890abcdef12";

function makeSnapshot(overrides = {}) {
  const snapshot = {
    summary: {
      project: {
        id: PROJECT_ID,
        name: "Live fixture",
        state: "RUNNING",
        executionMode: "continuous",
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
      workspacePath: WORKSPACE,
      currentPhaseId: PHASE_ID,
      completedTaskCount: 0,
      totalTaskCount: 1,
      attentionRequired: false,
    },
    phases: [
      {
        id: PHASE_ID,
        projectId: PROJECT_ID,
        title: "Live phase",
        goal: "Prove live-run UX reflects Core truth",
        position: 0,
        state: "RUNNING",
        required: true,
        completionCriteria: ["Every task completes with passing validation"],
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
    ],
    tasks: [
      {
        id: TASK_ID,
        projectId: PROJECT_ID,
        phaseId: PHASE_ID,
        title: "Live task",
        goal: "Do the live work",
        executable: true,
        dependencyIds: [],
        acceptanceCriteria: ["work is validated"],
        riskLevel: "low",
        expectedValidators: ["unit_test"],
        state: "RUNNING",
        position: 0,
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
    ],
    pendingApprovals: [],
    usage: { status: "available" },
    latestEventSequence: 7,
    ...overrides,
  };
  return snapshot;
}

function withTaskState(state) {
  const snapshot = makeSnapshot();
  return {
    ...snapshot,
    tasks: snapshot.tasks.map((task) => ({ ...task, state })),
  };
}

function withProjectState(state) {
  const snapshot = makeSnapshot();
  return {
    ...snapshot,
    summary: {
      ...snapshot.summary,
      project: { ...snapshot.summary.project, state },
    },
  };
}

function makeDashboard(overrides = {}) {
  const snapshot = makeSnapshot();
  return {
    project: snapshot.summary,
    phaseCounts: [{ state: "RUNNING", count: 1 }],
    taskCounts: [{ state: "RUNNING", count: 1 }],
    currentPhase: snapshot.phases[0],
    currentTask: snapshot.tasks[0],
    pendingApprovals: [],
    recentFailureCount: 0,
    retryCount: 0,
    validation: { passed: 0, failed: 0, incomplete: 1 },
    usage: { status: "available" },
    latestEventSequence: 7,
    ...overrides,
  };
}

function makeGitStatus(overrides = {}) {
  return {
    projectId: PROJECT_ID,
    workspacePath: WORKSPACE,
    available: true,
    headSha: HEAD_SHA,
    branch: "densa-ade/run/project-live-m4",
    dirty: false,
    changedPaths: [],
    observedAt: TIMESTAMP,
    ...overrides,
  };
}

test("live-run catalog methods exist in the frozen Core v1 protocol", () => {
  for (const method of [...LIVE_RUN_OPEN_REFRESH_METHODS, ...LIVE_RUN_CAPABILITY_METHODS]) {
    assert.ok(CORE_V1_METHODS.includes(method), method);
  }
  assert.ok(LIVE_RUN_CAPABILITY_METHODS.includes("projects.pause"));
  assert.ok(LIVE_RUN_CAPABILITY_METHODS.includes("projects.resume"));
  assert.ok(LIVE_RUN_CAPABILITY_METHODS.includes("projects.stop"));
  assert.ok(LIVE_RUN_CAPABILITY_METHODS.includes("logs.list"));
  assert.ok(LIVE_RUN_CAPABILITY_METHODS.includes("git.status"));
  assert.equal(LIVE_RUN_LIFECYCLE.optimisticComplete, false);
  assert.equal(LIVE_RUN_LIFECYCLE.closeDisposes, "view-handle-only");
  assert.equal(LIVE_RUN_LIFECYCLE.coreContinuesAfterClose, true);
});

test("live-run renders every canonical project and task state verbatim", () => {
  assert.deepEqual(
    [...LIVE_RUN_CANONICAL_PROJECT_STATES],
    [
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
    ],
  );
  assert.deepEqual(
    [...LIVE_RUN_CANONICAL_TASK_STATES],
    [
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
    ],
  );
  for (const state of LIVE_RUN_CANONICAL_PROJECT_STATES) {
    const model = buildLiveRunModel({ snapshot: withProjectState(state) });
    assert.equal(model.lifecycle.projectState, state);
    assert.equal(model.projectState, state);
  }
  for (const state of LIVE_RUN_CANONICAL_TASK_STATES) {
    const model = buildLiveRunModel({ snapshot: withTaskState(state) });
    assert.ok(model.currentTask === undefined || model.currentTask.state === state);
  }
});

test("live-run lifecycle distinguishes running, validating, and retrying", () => {
  const running = buildLiveRunModel({ snapshot: withTaskState("RUNNING") });
  assert.equal(running.lifecycle.kind, "running");
  assert.equal(running.lifecycle.taskState, "RUNNING");
  assert.match(running.lifecycle.detail, /safe boundary/u);

  const validating = buildLiveRunModel({ snapshot: withTaskState("VALIDATING") });
  assert.equal(validating.lifecycle.kind, "validating");
  assert.match(validating.lifecycle.detail, /Only the validation pipeline/u);

  const retrying = buildLiveRunModel({ snapshot: withTaskState("RETRYING") });
  assert.equal(retrying.lifecycle.kind, "retrying");
  assert.match(retrying.lifecycle.detail, /new evidence|diagnostics/u);

  const paused = buildLiveRunModel({ snapshot: withProjectState("PAUSED") });
  assert.equal(paused.lifecycle.kind, "paused");
  assert.equal(paused.controls.pause.enabled, false);
  assert.equal(paused.controls.resume.enabled, true);

  const waitingUsage = buildLiveRunModel({
    snapshot: withProjectState("WAITING_FOR_USAGE"),
  });
  assert.equal(waitingUsage.lifecycle.kind, "waiting-for-usage");

  const waitingUser = buildLiveRunModel({
    snapshot: withProjectState("WAITING_FOR_USER"),
  });
  assert.equal(waitingUser.lifecycle.kind, "waiting-for-user");

  const blocked = buildLiveRunModel({ snapshot: withProjectState("BLOCKED") });
  assert.equal(blocked.lifecycle.kind, "blocked");

  const idle = buildLiveRunModel({ snapshot: withProjectState("READY") });
  assert.equal(idle.lifecycle.kind, "idle");
  assert.equal(idle.controls.pause.enabled, false);
  assert.equal(idle.controls.stop.enabled, false);
});

test("live-run prefers the dashboard current task and validates it against the snapshot", () => {
  const model = buildLiveRunModel({ snapshot: makeSnapshot(), dashboard: makeDashboard() });
  assert.equal(model.currentTask?.id, TASK_ID);
  assert.equal(model.currentTask?.state, "RUNNING");
  assert.equal(model.retryCount, 0);

  const mismatch = makeDashboard({
    currentTask: { ...makeSnapshot().tasks[0], id: "task-unknown" },
  });
  assert.throws(
    () => buildLiveRunModel({ snapshot: makeSnapshot(), dashboard: mismatch }),
    /has no runtime row/u,
  );

  const crossed = makeDashboard({
    project: {
      ...makeSnapshot().summary,
      project: { ...makeSnapshot().summary.project, id: "other" },
    },
  });
  assert.throws(
    () => buildLiveRunModel({ snapshot: makeSnapshot(), dashboard: crossed }),
    /disagree on projectId/u,
  );
});

test("live-run control availability matches Core control boundaries", () => {
  const running = buildLiveRunModel({ snapshot: withProjectState("RUNNING") });
  assert.equal(running.controls.pause.enabled, true);
  assert.equal(running.controls.cancel.enabled, true);
  assert.equal(running.controls.stop.enabled, true);
  assert.equal(running.controls.resume.enabled, false);

  const paused = buildLiveRunModel({ snapshot: withProjectState("PAUSED") });
  assert.equal(paused.controls.pause.enabled, false);
  assert.match(paused.controls.pause.reason, /already paused/u);
  assert.equal(paused.controls.cancel.enabled, false);
  assert.equal(paused.controls.stop.enabled, true);
  assert.equal(paused.controls.resume.enabled, true);

  const completed = buildLiveRunModel({ snapshot: withProjectState("COMPLETED") });
  assert.equal(completed.controls.stop.enabled, false);
  assert.equal(completed.controls.resume.enabled, false);
});

test("live-run resolvers address Core truth and require an actor", () => {
  const model = buildLiveRunModel({ snapshot: makeSnapshot() });

  const pause = resolveLiveRunPause(model, { actor: "operator" });
  assert.equal(pause.method, "projects.pause");
  assert.equal(pause.projectId, PROJECT_ID);
  assert.equal(pause.workspacePath, WORKSPACE);
  assert.equal(pause.actor, "operator");
  parseCoreV1Payload("projects.pause", {
    projectId: pause.projectId,
    workspacePath: pause.workspacePath,
    actor: pause.actor,
  });

  const stop = resolveLiveRunStop(model, { actor: "operator" });
  assert.equal(stop.method, "projects.stop");
  parseCoreV1Payload("projects.stop", {
    projectId: stop.projectId,
    workspacePath: stop.workspacePath,
    actor: stop.actor,
  });

  const resume = resolveLiveRunResume(model, { actor: "operator" });
  assert.equal(resume.method, "projects.resume");
  assert.equal(resume.acknowledgeIntervention, undefined);
  const acked = resolveLiveRunResume(model, {
    actor: "operator",
    acknowledgeIntervention: true,
  });
  assert.equal(acked.acknowledgeIntervention, true);
  parseCoreV1Payload("projects.resume", {
    projectId: acked.projectId,
    workspacePath: acked.workspacePath,
    actor: acked.actor,
    acknowledgeIntervention: true,
  });

  assert.throws(() => resolveLiveRunPause(model, { actor: "  " }), /requires an actor/u);
  assert.throws(() => resolveLiveRunStop(model, { actor: "" }), /requires an actor/u);
  assert.throws(() => resolveLiveRunResume(model, { actor: "" }), /requires an actor/u);
});

test("live-run cancel resolves to the daemon alias with a frozen fallback", () => {
  const model = buildLiveRunModel({ snapshot: makeSnapshot() });
  const cancel = resolveLiveRunCancel(model, { actor: "operator" });
  assert.equal(cancel.transportMethod, LIVE_RUN_CANCEL_TRANSPORT_METHOD);
  assert.equal(cancel.transportMethod, "project.cancel");
  assert.equal(cancel.fallbackMethod, LIVE_RUN_CANCEL_FALLBACK_METHOD);
  assert.equal(cancel.fallbackMethod, "projects.pause");
  // The daemon parses project.cancel with the projects.pause contract.
  parseCoreV1Payload("projects.pause", {
    projectId: cancel.projectId,
    workspacePath: cancel.workspacePath,
    actor: cancel.actor,
  });
  assert.throws(() => resolveLiveRunCancel(model, { actor: "" }), /requires an actor/u);
});

test("live-run control effects never invent state and stay idempotent", () => {
  const model = buildLiveRunModel({ snapshot: makeSnapshot() });

  const unchanged = applyLiveRunControlOutcome(model, {
    projectId: PROJECT_ID,
    status: "UNCHANGED",
    reason: "Requested control boundary is already durable",
  });
  assert.equal(unchanged.idempotent, true);
  assert.match(unchanged.notice, /already durable|no new fact/u);

  const requested = applyLiveRunControlOutcome(model, {
    projectId: PROJECT_ID,
    status: "REQUESTED",
    reason: "Pause will take effect at the current safe boundary",
  });
  assert.equal(requested.idempotent, false);
  assert.match(requested.notice, /safe boundary/u);
  assert.ok(requested.refreshMethods.includes("events.replay"));

  const pausedEffect = applyLiveRunControlOutcome(model, {
    projectId: PROJECT_ID,
    status: "PAUSED",
    reason: "Project paused",
  });
  assert.ok(pausedEffect.refreshMethods.includes("projects.get"));
  assert.ok(pausedEffect.refreshMethods.includes("dashboard.get"));

  const intervention = applyLiveRunControlOutcome(model, {
    projectId: PROJECT_ID,
    status: "INTERVENTION_REQUIRED",
    changedPaths: ["src/manual.ts"],
  });
  assert.deepEqual([...intervention.changedPaths], ["src/manual.ts"]);
  assert.match(intervention.notice, /acknowledgeIntervention/u);

  const rejected = applyLiveRunControlOutcome(model, {
    projectId: PROJECT_ID,
    status: "REJECTED",
    reason: "Project state DRAFT cannot be controlled",
  });
  assert.equal(rejected.idempotent, false);
  assert.match(rejected.notice, /never retry blindly/u);

  assert.throws(
    () =>
      applyLiveRunControlOutcome(model, {
        projectId: "other-project",
        status: "PAUSED",
        reason: "crossed",
      }),
    /crossed the requested project boundary/u,
  );
});

test("live-run shows detected paused workspace changes before resume", () => {
  const clean = buildLiveRunModel({
    snapshot: withProjectState("PAUSED"),
    gitStatus: makeGitStatus(),
  });
  assert.equal(clean.intervention.detected, false);
  assert.equal(clean.intervention.resumeRequiresAck, false);

  const dirty = buildLiveRunModel({
    snapshot: withProjectState("PAUSED"),
    gitStatus: makeGitStatus({ dirty: true, changedPaths: ["src/manual.ts"] }),
  });
  assert.equal(dirty.intervention.detected, true);
  assert.deepEqual([...dirty.intervention.changedPaths], ["src/manual.ts"]);
  assert.equal(dirty.intervention.resumeRequiresAck, true);
  assert.match(dirty.intervention.message, /recontextualizes|revalidate/u);
  assert.match(dirty.intervention.message, /never overwritten|preserved/u);

  // Workspace changes while RUNNING are observed facts, not an intervention gate.
  const runningDirty = buildLiveRunModel({
    snapshot: withTaskState("RUNNING"),
    gitStatus: makeGitStatus({ dirty: true, changedPaths: ["src/manual.ts"] }),
  });
  assert.equal(runningDirty.intervention.detected, false);

  // A Core INTERVENTION_REQUIRED outcome surfaces even before git.status refreshes.
  const outcomeModel = buildLiveRunModel({
    snapshot: withProjectState("PAUSED"),
    lastControl: {
      projectId: PROJECT_ID,
      status: "INTERVENTION_REQUIRED",
      changedPaths: ["src/manual.ts"],
    },
  });
  assert.equal(outcomeModel.intervention.detected, true);
  assert.deepEqual([...outcomeModel.intervention.changedPaths], ["src/manual.ts"]);
});

test("live-run drill-downs carry persisted IDs to Core operations", () => {
  const model = buildLiveRunModel({ snapshot: makeSnapshot(), dashboard: makeDashboard() });

  const current = resolveLiveRunDrilldown(model, { kind: "current-task" });
  assert.equal(current.method, "attempts.list");
  assert.equal(current.taskId, TASK_ID);

  const agentRun = resolveLiveRunDrilldown(model, { kind: "agent-run" });
  assert.equal(agentRun.method, "logs.list");
  assert.equal(agentRun.taskId, TASK_ID);

  const scoped = resolveLiveRunDrilldown(model, {
    kind: "agent-run",
    taskId: TASK_ID,
    attemptId: "attempt-1",
  });
  assert.equal(scoped.attemptId, "attempt-1");

  const changes = resolveLiveRunDrilldown(model, { kind: "changes" });
  assert.equal(changes.method, "git.status");
  assert.equal(changes.workspacePath, WORKSPACE);

  const commit = resolveLiveRunDrilldown(model, { kind: "git-commit", sha: HEAD_SHA });
  assert.equal(commit.method, "git.commit.get");

  const usage = resolveLiveRunDrilldown(model, { kind: "usage" });
  assert.equal(usage.method, "usage.get");

  const events = resolveLiveRunDrilldown(model, { kind: "events" });
  assert.equal(events.method, "events.replay");
  assert.equal(events.afterSequence, 7);

  assert.throws(
    () => resolveLiveRunDrilldown(model, { kind: "events", afterSequence: -1 }),
    /non-negative afterSequence/u,
  );
  assert.throws(
    () => resolveLiveRunDrilldown(model, { kind: "git-commit", sha: "  " }),
    /requires a persisted commit SHA/u,
  );

  const idle = buildLiveRunModel({ snapshot: withProjectState("READY") });
  const unscoped = { ...idle, currentTask: undefined };
  assert.throws(
    () => resolveLiveRunDrilldown(unscoped, { kind: "current-task" }),
    /requires a known current task/u,
  );
  assert.throws(
    () => resolveLiveRunDrilldown(unscoped, { kind: "agent-run" }),
    /never fetches unscoped run logs/u,
  );
});

test("live-run reopen recipe and event hints follow the reconnect contract", () => {
  const reopen = resolveLiveRunReopenRefresh(PROJECT_ID);
  assert.equal(reopen.action, "refresh-before-render");
  assert.ok(reopen.refreshMethods.includes("projects.get"));
  assert.ok(reopen.refreshMethods.includes("dashboard.get"));
  assert.ok(reopen.refreshMethods.includes("events.replay"));
  assert.throws(() => resolveLiveRunReopenRefresh("  "), /persisted projectId/u);

  assert.equal(liveRunEventIsRefreshHint("core.event"), true);
  assert.equal(liveRunEventIsRefreshHint("run.log.appended"), true);
  assert.equal(liveRunEventIsRefreshHint("  "), false);
  assert.equal(liveRunEventIsRefreshHint(undefined), false);
});

test("live-run rejects cross-boundary and unknown-state facts instead of inventing", () => {
  assert.throws(
    () =>
      buildLiveRunModel({
        snapshot: makeSnapshot(),
        gitStatus: makeGitStatus({ projectId: "other-project" }),
      }),
    /Git status crossed/u,
  );
  assert.throws(
    () =>
      buildLiveRunModel({
        snapshot: makeSnapshot(),
        lastControl: { projectId: "other-project", status: "PAUSED", reason: "crossed" },
      }),
    /control outcome crossed/u,
  );
  const unknown = withProjectState("RUNNING");
  unknown.summary.project.state = "TIME_TRAVEL";
  assert.throws(() => buildLiveRunModel({ snapshot: unknown }), /unknown state/u);

  const disconnected = buildLiveRunModel({
    snapshot: makeSnapshot(),
    connectionState: "disconnected",
  });
  assert.equal(disconnected.enabled, false);
  assert.match(disconnected.reason, /densa-ade core start/u);
  assert.equal(disconnected.projectState, "RUNNING");
});

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function withLiveDaemon(run) {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "densa-live-m4-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "densa-live-ws-"));
  const workspace = join(workspaceRoot, "workspace");
  git(workspaceRoot, ["init", "--quiet", "--initial-branch=main", workspace]);
  git(workspace, ["config", "user.name", "Densa ADE Live M4 Fixture"]);
  git(workspace, ["config", "user.email", "densa-live-m4@localhost"]);
  git(workspace, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(workspace, "baseline.txt"), "baseline\n", "utf8");
  git(workspace, ["add", "--all"]);
  git(workspace, ["commit", "--quiet", "-m", "baseline"]);
  const database = DensaAdeDatabase.openInMemory();
  const daemon = await CoreDaemon.start({ runtimeDirectory, database });
  let requestNumber = 0;
  const connection = new IdeCoreConnection({
    runtimeDirectory,
    createRequestId: () => `live-m4-${String((requestNumber += 1))}`,
  });
  try {
    await connection.connect();
    await run({ connection, database, workspace });
  } finally {
    connection.dispose();
    await daemon.stop().catch(() => undefined);
    database.close();
    await rm(runtimeDirectory, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function createLiveProject(connection, workspace, name) {
  const created = await connection.request("projects.create", {
    name,
    workspacePath: workspace,
    idea: "Prove pause, intervention, and stop flow through Core truth",
    executionMode: "continuous",
    actor: "test",
  });
  await connection.request("projects.interview.answer", {
    projectId: created.project.id,
    sessionId: "session-live-m4",
    answers: [{ questionId: "scope", answer: "Deterministic live-run proof" }],
  });
  await connection.request("roadmaps.generate", {
    projectId: created.project.id,
    sessionId: "session-live-m4",
    actor: "test",
  });
  await connection.request("projects.start", {
    projectId: created.project.id,
    workspacePath: workspace,
    actor: "test",
  });
  return created.project.id;
}

async function readLiveModel(connection, projectId, lastControl) {
  const snapshot = await connection.request("projects.get", { projectId });
  const dashboard = await connection.request("dashboard.get", { projectId });
  const gitStatus = await connection.request("git.status", {
    projectId,
    workspacePath: snapshot.summary.workspacePath,
  });
  return buildLiveRunModel({
    snapshot,
    dashboard,
    gitStatus,
    ...(lastControl === undefined ? {} : { lastControl }),
  });
}

test("live pause, idempotent pause, stop, and Core-acknowledged state only", async () => {
  await withLiveDaemon(async ({ connection, workspace }) => {
    const projectId = await createLiveProject(connection, workspace, "Live controls");
    let model = await readLiveModel(connection, projectId);
    assert.equal(model.projectState, "RUNNING");
    assert.equal(model.controls.pause.enabled, true);

    const pause = resolveLiveRunPause(model, { actor: "test" });
    const { method: pauseMethod, ...pausePayload } = pause;
    assert.equal(pauseMethod, "projects.pause");
    const paused = await connection.request(pauseMethod, pausePayload);
    assert.equal(paused.projectId, projectId);
    assert.equal(paused.status, "PAUSED");
    const pausedEffect = applyLiveRunControlOutcome(model, paused);
    assert.equal(pausedEffect.idempotent, false);

    model = await readLiveModel(connection, projectId, paused);
    assert.equal(model.projectState, "PAUSED");
    assert.equal(model.lifecycle.kind, "paused");
    assert.equal(model.lastControl?.status, "PAUSED");

    // Repeating pause is an idempotent no-op: Core returns UNCHANGED and the
    // surface keeps showing the last refreshed snapshot.
    const repeat = await connection.request(pauseMethod, pausePayload);
    assert.equal(repeat.status, "UNCHANGED");
    const repeatEffect = applyLiveRunControlOutcome(model, repeat);
    assert.equal(repeatEffect.idempotent, true);

    const stop = resolveLiveRunStop(model, { actor: "test" });
    const { method: stopMethod, ...stopPayload } = stop;
    const stopped = await connection.request(stopMethod, stopPayload);
    assert.equal(stopped.status, "STOPPED");
    model = await readLiveModel(connection, projectId, stopped);
    assert.equal(model.projectState, "PAUSED");
    assert.equal(model.lastControl?.status, "STOPPED");

    const restop = await connection.request(stopMethod, stopPayload);
    assert.equal(restop.status, "UNCHANGED");

    // A stopped project cannot resume without an explicit new start decision.
    const resume = resolveLiveRunResume(model, { actor: "test" });
    const { method: resumeMethod, ...resumePayload } = resume;
    const refused = await connection.request(resumeMethod, resumePayload);
    assert.equal(refused.status, "STOPPED");
  });
});

test("live paused manual edits surface intervention and resume recontextualizes", async () => {
  await withLiveDaemon(async ({ connection, workspace }) => {
    const projectId = await createLiveProject(connection, workspace, "Live intervention");
    let model = await readLiveModel(connection, projectId);

    const pause = resolveLiveRunPause(model, { actor: "test" });
    const { method: pauseMethod, ...pausePayload } = pause;
    const paused = await connection.request(pauseMethod, pausePayload);
    assert.equal(paused.status, "PAUSED");

    // The user edits files while paused, outside Densa ADE control.
    await writeFile(join(workspace, "user-note.txt"), "manual work must survive\n", "utf8");

    // Resume without acknowledgement schedules no worker: Core reports
    // INTERVENTION_REQUIRED with the changed paths.
    const resume = resolveLiveRunResume(model, { actor: "test" });
    const { method: resumeMethod, ...resumePayload } = resume;
    const intervention = await connection.request(resumeMethod, resumePayload);
    assert.equal(intervention.status, "INTERVENTION_REQUIRED");
    // Core reports every path changed since the pause snapshot, including
    // its own portable .densa-ade projection alongside the manual edit.
    assert.ok((intervention.changedPaths ?? []).includes("user-note.txt"));

    // The surface shows the detected changes and requires acknowledgement.
    model = await readLiveModel(connection, projectId, intervention);
    assert.equal(model.projectState, "PAUSED");
    assert.equal(model.intervention.detected, true);
    assert.ok(model.intervention.changedPaths.includes("user-note.txt"));
    assert.equal(model.intervention.resumeRequiresAck, true);
    assert.match(model.intervention.message, /recontextualizes/u);
    const interventionEffect = applyLiveRunControlOutcome(model, intervention);
    assert.match(interventionEffect.notice, /acknowledgeIntervention/u);

    // Acknowledged resume revalidates, preserves the manual edit, and the
    // project runs again. Only the Core outcome changes what is shown.
    const acked = resolveLiveRunResume(model, {
      actor: "test",
      acknowledgeIntervention: true,
    });
    const { method: ackMethod, ...ackPayload } = acked;
    assert.equal(ackMethod, "projects.resume");
    const resumed = await connection.request(ackMethod, ackPayload);
    assert.equal(resumed.status, "RESUMED");

    model = await readLiveModel(connection, projectId, resumed);
    assert.equal(model.projectState, "RUNNING");
    assert.equal(model.lifecycle.kind, "running");
    assert.equal(
      readFileSync(join(workspace, "user-note.txt"), "utf8"),
      "manual work must survive\n",
    );

    // Drill-downs resolve against the live Core project. The fresh project
    // has no active task yet, so View Agent Run carries an explicit
    // persisted task scope from the snapshot.
    const liveSnapshot = await connection.request("projects.get", { projectId });
    const liveTaskId = liveSnapshot.tasks[0].id;
    const agentRun = resolveLiveRunDrilldown(model, {
      kind: "agent-run",
      taskId: liveTaskId,
    });
    assert.equal(agentRun.method, "logs.list");
    const runLogs = await connection.request("logs.list", {
      projectId: agentRun.projectId,
      taskId: agentRun.taskId,
    });
    assert.ok(Array.isArray(runLogs.entries));

    const changes = resolveLiveRunDrilldown(model, { kind: "changes" });
    const status = await connection.request("git.status", {
      projectId: changes.projectId,
      workspacePath: changes.workspacePath,
    });
    assert.equal(status.projectId, projectId);
    assert.ok(status.changedPaths.includes("user-note.txt"));
  });
});

test("cancel through the live-run resolver aborts the FakeAgent worker with no orphan", async () => {
  const database = DensaAdeDatabase.openInMemory();
  const createdAt = "2026-09-03T00:00:00.000Z";
  database.repositories.projects.create({
    id: "project-live-cancel",
    name: "Live cancel proof",
    state: "DRAFT",
    executionMode: "continuous",
    createdAt,
    updatedAt: createdAt,
  });
  const { stateTransitionService } = await import("../packages/core/dist/index.js");
  for (const next of ["PLANNING", "READY", "RUNNING"]) {
    const current = database.repositories.projects.findById("project-live-cancel");
    database.persistStateTransition(
      stateTransitionService.transitionProject(current, next, {
        actor: "test",
        occurredAt: createdAt,
      }),
      `live-cancel-${next.toLowerCase()}`,
    );
  }

  // The IDE model resolves Cancel; Core drives the abort; the FakeAgent
  // worker observes cancellation and reaches a terminal event.
  const model = buildLiveRunModel({
    snapshot: {
      ...makeSnapshot(),
      summary: {
        ...makeSnapshot().summary,
        project: { ...makeSnapshot().summary.project, id: "project-live-cancel" },
      },
    },
  });
  const cancel = resolveLiveRunCancel(model, { actor: "test" });
  assert.equal(cancel.projectId, "project-live-cancel");

  const fake = new FakeAgentAdapter({ holdOpen: true });
  const runId = "run-live-cancel-m4";
  let liveFakeWorkers = 0;
  let workerStartedResolve;
  const workerStarted = new Promise((resolve) => {
    workerStartedResolve = resolve;
  });
  let terminalOutcome;
  const service = new ProjectExecutionControlService(database, {
    now: () => createdAt,
    runner: {
      async execute(runRequest) {
        liveFakeWorkers += 1;
        const onAbort = () => {
          void fake.cancel(runId);
        };
        runRequest.signal.addEventListener("abort", onAbort, { once: true });
        try {
          for await (const event of fake.execute({
            runId,
            cwd: WORKSPACE,
            prompt: "Do the live work",
          })) {
            if (event.type === "run.started") workerStartedResolve();
            if (event.type === "run.terminal") {
              terminalOutcome = event.outcome;
              break;
            }
          }
          return { status: "STOPPED", projectId: "project-live-cancel", reason: "interrupted" };
        } finally {
          runRequest.signal.removeEventListener("abort", onAbort);
          liveFakeWorkers -= 1;
        }
      },
    },
    workspaceProbe: {
      async inspect() {
        return {
          status: "available",
          snapshot: { gitHead: HEAD_SHA, gitStatus: "", fingerprint: "live-cancel" },
        };
      },
    },
  });

  const execution = service.execute({
    projectId: cancel.projectId,
    workspacePath: cancel.workspacePath,
    actor: cancel.actor,
    gates: { outstandingUserDecisionIds: [], permissionBlockers: [] },
    taskExecutor: {
      async execute() {
        throw new Error("runner owns this fixture");
      },
    },
    validator: {
      validatorId: "fixture",
      async validate() {
        throw new Error("unused");
      },
    },
  });
  await workerStarted;
  assert.equal(liveFakeWorkers, 1);

  const cancelled = await service.cancelCurrentAgent({
    projectId: cancel.projectId,
    workspacePath: cancel.workspacePath,
    actor: cancel.actor,
  });
  assert.equal(cancelled.status, "REQUESTED");
  assert.equal((await execution).status, "PAUSED");

  assert.equal(terminalOutcome, "cancelled");
  assert.deepEqual([...fake.cancelledRunIds], [runId]);
  assert.equal(liveFakeWorkers, 0);
  assert.equal(database.repositories.projects.findById("project-live-cancel").state, "PAUSED");
  database.close();
});

test("live-run extension sources stay protocol-only", () => {
  const extensionDir = new URL("../apps/ide-extension/src/", import.meta.url);
  const sources = ["index.ts", "live-run.ts"]
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
