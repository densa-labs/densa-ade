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
  MASTER_ACTION_KINDS,
  MASTER_CAPABILITY_METHODS,
  MASTER_COMMAND,
  MASTER_EDITOR_VIEW_TYPE,
  MASTER_EXAMPLE_PROMPTS,
  MASTER_INTENTS,
  MASTER_LIFECYCLE,
  MASTER_OPEN_REFRESH_METHODS,
  MASTER_REOPEN_REFRESH_METHODS,
  buildMasterModel,
  classifyMasterAction,
  isMasterStaleOutcome,
  masterEventIsRefreshHint,
  masterTurnById,
  masterWorkerLogsIncludedByDefault,
  reconcileMasterStaleOutcome,
  resolveMasterCitationDrilldown,
  resolveMasterDrilldown,
  resolveMasterModeChange,
  resolveMasterPause,
  resolveMasterReopenRefresh,
  resolveMasterResume,
  resolveMasterRoadmapResolve,
  resolveMasterSend,
} from "../apps/ide-extension/dist/index.js";

const TIMESTAMP = "2026-09-03T00:00:00.000Z";
const PROJECT_ID = "project-master-m2";
const WORKSPACE = "/tmp/densa-master-m2";
const SESSION = "session-m2";

function makeSnapshot() {
  return {
    summary: {
      project: {
        id: PROJECT_ID,
        name: "Master fixture",
        state: "RUNNING",
        executionMode: "phase",
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
      workspacePath: WORKSPACE,
      currentPhaseId: "phase-one",
      completedTaskCount: 0,
      totalTaskCount: 3,
      attentionRequired: false,
    },
    phases: [
      {
        id: "phase-one",
        projectId: PROJECT_ID,
        title: "Phase one",
        state: "RUNNING",
        position: 0,
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
      {
        id: "phase-two",
        projectId: PROJECT_ID,
        title: "Phase two",
        state: "PENDING",
        position: 1,
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
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
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
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
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
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
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
    ],
    pendingApprovals: [],
    usage: { status: "available" },
    latestEventSequence: 7,
  };
}

function explanationProposal() {
  return {
    formatVersion: 1,
    intent: "explain_project_status",
    response: "The project is RUNNING in phase one with task alpha active.",
    citations: [{ kind: "project", id: PROJECT_ID }],
    action: { kind: "respond" },
  };
}

function roadmapProposal() {
  return {
    formatVersion: 1,
    intent: "propose_roadmap_change",
    response: "Proposing to tighten the alpha acceptance wording.",
    citations: [
      { kind: "task", id: "task-alpha" },
      { kind: "phase", id: "phase-one" },
    ],
    action: {
      kind: "propose_roadmap_change",
      operation: {
        kind: "modify_acceptance_criteria",
        taskId: "task-alpha",
        acceptanceCriteria: ["Tightened alpha criterion"],
      },
      rationale: "Tighten the acceptance wording",
    },
  };
}

function constraintProposal() {
  return {
    formatVersion: 1,
    intent: "propose_project_constraint_change",
    response: "Proposing to record the database constraint.",
    citations: [{ kind: "project", id: PROJECT_ID }],
    action: {
      kind: "propose_project_constraint_change",
      change: { operation: "add", path: "architecture.database", value: "postgres" },
      rationale: "Keep the stack consistent",
    },
  };
}

function resolveProposal() {
  return {
    formatVersion: 1,
    intent: "resolve_roadmap_revision",
    response: "Approving the pending roadmap revision.",
    citations: [{ kind: "event", id: "event-proposal-1" }],
    action: {
      kind: "resolve_roadmap_revision",
      proposalEventId: "event-proposal-1",
      resolution: "approve",
      rationale: "The revision is correct",
    },
  };
}

function pauseProposal() {
  return {
    formatVersion: 1,
    intent: "request_project_control",
    response: "Requesting a pause at the next safe boundary.",
    citations: [{ kind: "project", id: PROJECT_ID }],
    action: { kind: "request_pause" },
  };
}

function modeProposal() {
  return {
    formatVersion: 1,
    intent: "request_project_control",
    response: "Requesting Continuous mode after this phase.",
    citations: [{ kind: "project", id: PROJECT_ID }],
    action: { kind: "request_mode_change", mode: "continuous" },
  };
}

test("master catalog covers intents, command, lifecycle, and Core methods", () => {
  assert.deepEqual(
    [...MASTER_INTENTS],
    [
      "explain_project_status",
      "explain_decision",
      "explain_current_phase",
      "propose_roadmap_change",
      "resolve_roadmap_revision",
      "propose_project_constraint_change",
      "request_project_control",
      "summarize_failures",
    ],
  );
  assert.deepEqual(
    [...MASTER_ACTION_KINDS],
    [
      "respond",
      "propose_roadmap_change",
      "resolve_roadmap_revision",
      "propose_project_constraint_change",
      "request_pause",
      "request_resume",
      "request_mode_change",
    ],
  );
  assert.equal(MASTER_COMMAND, "densa-ade.showMasterAgent");
  assert.equal(MASTER_EDITOR_VIEW_TYPE, "densa-ade.master");
  assert.equal(MASTER_LIFECYCLE.optimisticComplete, false);
  assert.equal(MASTER_LIFECYCLE.coreContinuesAfterClose, true);
  assert.equal(MASTER_LIFECYCLE.reopenRefreshesSnapshot, true);
  assert.equal(MASTER_LIFECYCLE.closeDisposes, "view-handle-only");
  assert.equal(MASTER_LIFECYCLE.workerLogsIncludedByDefault, false);
  assert.equal(masterWorkerLogsIncludedByDefault(), false);
  for (const method of [
    ...MASTER_OPEN_REFRESH_METHODS,
    ...MASTER_CAPABILITY_METHODS,
    ...MASTER_REOPEN_REFRESH_METHODS,
  ]) {
    assert.ok(CORE_V1_METHODS.includes(method), method);
  }
  assert.deepEqual([...MASTER_OPEN_REFRESH_METHODS], ["projects.get"]);
  assert.ok(!MASTER_OPEN_REFRESH_METHODS.includes("master.send"));
  assert.ok(!MASTER_OPEN_REFRESH_METHODS.includes("logs.list"));
  assert.ok(MASTER_CAPABILITY_METHODS.includes("master.send"));
  assert.ok(MASTER_CAPABILITY_METHODS.includes("projects.get"));
  assert.ok(MASTER_CAPABILITY_METHODS.includes("roadmaps.revisions.resolve"));
  assert.ok(MASTER_CAPABILITY_METHODS.includes("decisions.list"));
  assert.ok(MASTER_CAPABILITY_METHODS.includes("projects.pause"));
  assert.ok(MASTER_CAPABILITY_METHODS.includes("projects.resume"));
  assert.ok(MASTER_CAPABILITY_METHODS.includes("settings.update"));
  assert.ok(MASTER_CAPABILITY_METHODS.includes("events.replay"));
  assert.ok(MASTER_REOPEN_REFRESH_METHODS.includes("projects.get"));
  assert.ok(MASTER_REOPEN_REFRESH_METHODS.includes("events.replay"));
  assert.ok(MASTER_REOPEN_REFRESH_METHODS.includes("decisions.list"));
  assert.ok(MASTER_REOPEN_REFRESH_METHODS.includes("roadmaps.revisions.list"));
  assert.equal(MASTER_EXAMPLE_PROMPTS.length, 6);
  assert.ok(
    MASTER_EXAMPLE_PROMPTS.some((entry) => entry.example === "Why did you change the roadmap?"),
  );
  assert.ok(
    MASTER_EXAMPLE_PROMPTS.some((entry) => entry.example === "Don't use Firebase anywhere."),
  );
  assert.ok(
    MASTER_EXAMPLE_PROMPTS.some((entry) => entry.example === "Add mobile support before QA."),
  );
  assert.ok(
    MASTER_EXAMPLE_PROMPTS.some((entry) => entry.example === "Pause after authentication."),
  );
  assert.ok(MASTER_EXAMPLE_PROMPTS.some((entry) => entry.example === "What is blocking us?"));
  assert.ok(
    MASTER_EXAMPLE_PROMPTS.some(
      (entry) => entry.example === "Switch to Continuous after this phase.",
    ),
  );
});

test("explanations render distinctly from proposed state changes", () => {
  const snapshot = makeSnapshot();
  const model = buildMasterModel({
    snapshot,
    sessionId: SESSION,
    turns: [
      { id: "turn-explain", userMessage: "What is happening?", proposal: explanationProposal() },
      {
        id: "turn-roadmap",
        userMessage: "Add mobile support before QA.",
        proposal: roadmapProposal(),
        commandStatus: "AWAITING_USER_APPROVAL",
        commandDetails: {
          proposalEventId: "event-proposal-1",
          affectedPhaseIds: ["phase-one"],
          affectedTaskIds: ["task-alpha"],
        },
      },
      {
        id: "turn-constraint",
        userMessage: "Don't use Firebase anywhere.",
        proposal: constraintProposal(),
        commandStatus: "APPLIED",
        commandDetails: { decisionId: "decision-1" },
      },
      {
        id: "turn-resolve",
        userMessage: "Approve that revision.",
        proposal: resolveProposal(),
        commandStatus: "APPLIED",
        commandDetails: { proposalEventId: "event-proposal-1" },
      },
      {
        id: "turn-pause",
        userMessage: "Pause after authentication.",
        proposal: pauseProposal(),
        commandStatus: "APPLIED",
        commandDetails: {},
      },
      {
        id: "turn-mode",
        userMessage: "Switch to Continuous after this phase.",
        proposal: modeProposal(),
      },
    ],
  });

  assert.equal(model.projectId, PROJECT_ID);
  assert.equal(model.workspacePath, WORKSPACE);
  assert.equal(model.sessionId, SESSION);
  assert.equal(model.projectState, "RUNNING");
  assert.equal(model.executionMode, "phase");
  assert.equal(model.optimisticComplete, false);
  assert.equal(model.workerLogsIncludedByDefault, false);
  assert.equal(model.enabled, true);
  assert.equal(model.reason, undefined);
  assert.equal(model.latestEventSequence, 7);

  const explained = masterTurnById(model, "turn-explain");
  assert.equal(explained.kind, "explanation");
  assert.equal(explained.isExplanation, true);
  assert.equal(explained.requiresApproval, false);
  assert.equal(explained.approvalMethod, undefined);
  assert.equal(explained.outcomeKnown, false);
  assert.equal(explained.stale, false);
  assert.equal(explained.response, "The project is RUNNING in phase one with task alpha active.");

  const roadmap = masterTurnById(model, "turn-roadmap");
  assert.equal(roadmap.kind, "roadmap_proposal");
  assert.equal(roadmap.isExplanation, false);
  assert.equal(roadmap.requiresApproval, true);
  assert.equal(roadmap.approvalMethod, "roadmaps.revisions.resolve");
  assert.equal(roadmap.proposalEventId, "event-proposal-1");
  assert.deepEqual([...roadmap.affectedPhaseIds].sort(), ["phase-one"]);
  assert.deepEqual([...roadmap.affectedTaskIds].sort(), ["task-alpha"]);
  assert.equal(roadmap.outcomeKnown, true);
  assert.equal(roadmap.stale, false);

  const constraint = masterTurnById(model, "turn-constraint");
  assert.equal(constraint.kind, "constraint_proposal");
  assert.equal(constraint.isExplanation, false);
  assert.equal(constraint.requiresApproval, false);

  const resolve = masterTurnById(model, "turn-resolve");
  assert.equal(resolve.kind, "revision_resolution");
  assert.equal(resolve.proposalEventId, "event-proposal-1");

  const pause = masterTurnById(model, "turn-pause");
  assert.equal(pause.kind, "control_request");
  assert.equal(pause.requiresApproval, false);

  const mode = masterTurnById(model, "turn-mode");
  assert.equal(mode.kind, "control_request");
  assert.equal(mode.isExplanation, false);
  assert.equal(mode.requiresApproval, true);
  assert.equal(mode.approvalMethod, "projects.get");
  assert.equal(mode.outcomeKnown, false);

  assert.equal(classifyMasterAction("respond"), "explanation");
  assert.equal(classifyMasterAction("propose_roadmap_change"), "roadmap_proposal");
  assert.equal(classifyMasterAction("propose_project_constraint_change"), "constraint_proposal");
  assert.equal(classifyMasterAction("resolve_roadmap_revision"), "revision_resolution");
  assert.equal(classifyMasterAction("request_pause"), "control_request");
  assert.equal(classifyMasterAction("request_resume"), "control_request");
  assert.equal(classifyMasterAction("request_mode_change"), "control_request");
});

test("sends and approvals resolve to Core operations only, never prose applies", () => {
  const snapshot = makeSnapshot();
  const model = buildMasterModel({
    snapshot,
    sessionId: SESSION,
    turns: [{ id: "t1", userMessage: "Hi", proposal: explanationProposal() }],
  });

  const send = resolveMasterSend(model, { message: "What is blocking us?" });
  assert.equal(send.method, "master.send");
  assert.equal(send.projectId, PROJECT_ID);
  assert.equal(send.workspacePath, WORKSPACE);
  assert.equal(send.sessionId, SESSION);
  assert.equal(send.message, "What is blocking us?");
  assert.throws(() => resolveMasterSend(model, { message: "   " }), /non-empty message/u);

  const resolve = resolveMasterRoadmapResolve(model, {
    proposalEventId: "event-proposal-1",
    resolution: "approve",
    rationale: "The revision is correct",
    actor: "user",
    sessionId: SESSION,
  });
  assert.equal(resolve.method, "roadmaps.revisions.resolve");
  assert.equal(resolve.projectId, PROJECT_ID);
  assert.throws(
    () =>
      resolveMasterRoadmapResolve(model, {
        proposalEventId: "",
        resolution: "approve",
        rationale: "ok",
        actor: "user",
      }),
    /proposalEventId/u,
  );

  const pause = resolveMasterPause(model, { actor: "user" });
  assert.equal(pause.method, "projects.pause");
  assert.equal(pause.workspacePath, WORKSPACE);

  const resume = resolveMasterResume(model, { actor: "user" });
  assert.equal(resume.method, "projects.resume");

  const mode = resolveMasterModeChange(model, {
    mode: "continuous",
    actor: "user",
    reason: "Run continuously after this phase",
  });
  assert.equal(mode.method, "settings.update");
  assert.equal(mode.executionMode, "continuous");
  assert.throws(
    () => resolveMasterModeChange(model, { mode: "turbo", actor: "user", reason: "x" }),
    /guided, phase, or continuous/u,
  );

  const snapshotDrill = resolveMasterDrilldown(model, { kind: "project-snapshot" });
  assert.equal(snapshotDrill.method, "projects.get");
  const revisions = resolveMasterDrilldown(model, { kind: "revisions" });
  assert.equal(revisions.method, "roadmaps.revisions.list");
  const decisions = resolveMasterDrilldown(model, { kind: "decisions" });
  assert.equal(decisions.method, "decisions.list");
  const attempts = resolveMasterDrilldown(model, { kind: "attempts", taskId: "task-alpha" });
  assert.equal(attempts.method, "attempts.list");
  assert.throws(
    () => resolveMasterDrilldown(model, { kind: "attempts", taskId: "nope" }),
    /Unknown Master task/u,
  );

  const citationPhase = resolveMasterCitationDrilldown(model, {
    kind: "phase",
    id: "phase-one",
  });
  assert.equal(citationPhase.method, "phases.report.get");
  const citationTask = resolveMasterCitationDrilldown(model, { kind: "task", id: "task-alpha" });
  assert.equal(citationTask.method, "attempts.list");
  const citationDecision = resolveMasterCitationDrilldown(model, {
    kind: "decision",
    id: "decision-1",
  });
  assert.equal(citationDecision.method, "decisions.list");
  assert.throws(
    () => resolveMasterCitationDrilldown(model, { kind: "task", id: "task-unknown" }),
    /Unknown|refresh|taskId/u,
  );
});

test("stale citations and outcomes reconcile by refreshing before retry", () => {
  const snapshot = makeSnapshot();
  assert.throws(
    () =>
      buildMasterModel({
        snapshot,
        sessionId: SESSION,
        turns: [
          {
            id: "stale-citation",
            userMessage: "Use that task",
            proposal: {
              formatVersion: 1,
              intent: "explain_current_phase",
              response: "That task is active.",
              citations: [{ kind: "task", id: "task-unknown" }],
              action: { kind: "respond" },
            },
          },
        ],
      }),
    /unknown task/u,
  );
  assert.throws(
    () =>
      buildMasterModel({
        snapshot,
        sessionId: SESSION,
        turns: [
          {
            id: "crossed",
            userMessage: "Hi",
            proposal: {
              formatVersion: 1,
              intent: "explain_project_status",
              response: "Elsewhere.",
              citations: [{ kind: "project", id: "project-elsewhere" }],
              action: { kind: "respond" },
            },
          },
        ],
      }),
    /crossed the requested project boundary/u,
  );

  const stale = buildMasterModel({
    snapshot,
    sessionId: SESSION,
    turns: [
      {
        id: "stale-turn",
        userMessage: "Add mobile support before QA.",
        proposal: roadmapProposal(),
        commandStatus: "STALE",
        commandDetails: { proposalEventId: "event-proposal-1" },
      },
    ],
  });
  const view = masterTurnById(stale, "stale-turn");
  assert.equal(view.stale, true);
  assert.equal(view.outcomeKnown, true);
  assert.equal(view.requiresApproval, false);
  assert.equal(isMasterStaleOutcome("STALE"), true);
  assert.equal(isMasterStaleOutcome("APPLIED"), false);
  const reconciled = reconcileMasterStaleOutcome({
    proposalEventId: "event-proposal-1",
    baseRevisionNumber: 0,
    latestRevisionNumber: 1,
  });
  assert.equal(reconciled.action, "refresh-before-retry");
  assert.ok(reconciled.refreshMethods.includes("roadmaps.revisions.list"));
  assert.ok(reconciled.refreshMethods.includes("projects.get"));
  assert.ok(reconciled.refreshMethods.includes("events.replay"));
  assert.ok(reconciled.refreshMethods.includes("decisions.list"));
  assert.match(reconciled.reason, /stale/iu);
});

test("worker logs are never included by default and need explicit opt-in", () => {
  assert.equal(masterEventIsRefreshHint("core.event"), true);
  assert.equal(masterEventIsRefreshHint("   "), false);
  assert.equal(masterEventIsRefreshHint("run.log.appended"), false);
  const snapshot = makeSnapshot();
  const model = buildMasterModel({ snapshot, sessionId: SESSION, turns: [] });
  assert.equal(model.workerLogsIncludedByDefault, false);
  assert.throws(
    () => resolveMasterDrilldown(model, { kind: "worker-logs", confirmed: true }),
    /phaseId, taskId, or attemptId/u,
  );
  assert.throws(
    () =>
      resolveMasterDrilldown(model, {
        kind: "worker-logs",
        taskId: "task-alpha",
        confirmed: false,
      }),
    /confirmation/u,
  );
  const scoped = resolveMasterDrilldown(model, {
    kind: "worker-logs",
    taskId: "task-alpha",
    confirmed: true,
  });
  assert.equal(scoped.method, "logs.list");
  assert.equal(scoped.taskId, "task-alpha");
});

test("unconnected master explains what is needed", () => {
  const snapshot = makeSnapshot();
  const disconnected = buildMasterModel({
    snapshot,
    sessionId: SESSION,
    turns: [],
    connectionState: "disconnected",
  });
  assert.equal(disconnected.enabled, false);
  assert.match(disconnected.reason, /densa-ade core start/u);
  const mismatch = buildMasterModel({
    snapshot,
    sessionId: SESSION,
    turns: [],
    connectionState: "version-mismatch",
  });
  assert.match(mismatch.reason, /protocol mismatch/iu);
});

test("master extension sources stay protocol-only", () => {
  const extensionDir = new URL("../apps/ide-extension/src/", import.meta.url);
  const sources = ["index.ts", "master.ts"]
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

async function withMasterDaemon(run) {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "densa-master-m2-"));
  const workspace = await mkdtemp(join(tmpdir(), "densa-master-ws-"));
  const database = DensaAdeDatabase.openInMemory();
  const daemon = await CoreDaemon.start({ runtimeDirectory, database });
  let requestNumber = 0;
  const connection = new IdeCoreConnection({
    runtimeDirectory,
    createRequestId: () => `master-m2-${String((requestNumber += 1))}`,
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
    idea: "Prove the Master Agent UI reflects Core truth",
    executionMode: "phase",
    actor: "test",
  });
  await connection.request("projects.interview.answer", {
    projectId: created.project.id,
    sessionId: SESSION,
    answers: [{ questionId: "scope", answer: "Deterministic master surface" }],
  });
  await connection.request("roadmaps.generate", {
    projectId: created.project.id,
    sessionId: SESSION,
    actor: "test",
  });
  await connection.request("projects.start", {
    projectId: created.project.id,
    workspacePath: workspace,
    actor: "test",
  });
  return { projectId: created.project.id };
}

test("live master.send round-trip keeps durable decisions across close and reopen", async () => {
  await withMasterDaemon(async ({ connection, workspace }) => {
    const { projectId } = await createLiveProject(connection, workspace, "Master live");
    const snapshot = await connection.request("projects.get", { projectId });
    const empty = buildMasterModel({ snapshot, sessionId: SESSION, turns: [] });
    assert.equal(empty.turns.length, 0);
    assert.equal(empty.optimisticComplete, false);
    assert.equal(empty.workerLogsIncludedByDefault, false);

    const send = resolveMasterSend(empty, { message: "What is blocking us?" });
    assert.equal(send.method, "master.send");
    const { method, ...payload } = send;
    const result = await connection.request(method, payload);
    assert.equal(result.proposal.intent, "explain_project_status");
    assert.ok(result.proposal.response.length > 0);
    assert.ok(result.proposal.citations.some((entry) => entry.id === projectId));

    const withTurn = buildMasterModel({
      snapshot: await connection.request("projects.get", { projectId }),
      sessionId: SESSION,
      turns: [
        {
          id: "live-turn-1",
          userMessage: send.message,
          proposal: result.proposal,
          ...(result.commandStatus === undefined ? {} : { commandStatus: result.commandStatus }),
          ...(result.commandDetails === undefined ? {} : { commandDetails: result.commandDetails }),
        },
      ],
    });
    const view = masterTurnById(withTurn, "live-turn-1");
    assert.equal(view.kind, "explanation");
    assert.equal(view.isExplanation, true);

    const drill = resolveMasterCitationDrilldown(withTurn, result.proposal.citations[0]);
    assert.ok(CORE_V1_METHODS.includes(drill.method));
    if (drill.method === "projects.get") {
      const reread = await connection.request(drill.method, { projectId: drill.projectId });
      assert.equal(reread.summary.project.id, projectId);
    }

    const decisions = resolveMasterDrilldown(withTurn, { kind: "decisions" });
    const listedDecisions = await connection.request(decisions.method, {
      projectId: decisions.projectId,
    });
    assert.ok(Array.isArray(listedDecisions.decisions));

    const revisions = resolveMasterDrilldown(withTurn, { kind: "revisions" });
    const listedRevisions = await connection.request(revisions.method, {
      projectId: revisions.projectId,
    });
    assert.ok(Array.isArray(listedRevisions.revisions));

    const events = resolveMasterDrilldown(withTurn, { kind: "events" });
    const replayed = await connection.request(events.method, {
      projectId: events.projectId,
      afterSequence: 0,
    });
    assert.ok(Array.isArray(replayed.events));

    const reopen = resolveMasterReopenRefresh(projectId);
    assert.equal(reopen.action, "refresh-before-render");
    assert.ok(reopen.refreshMethods.includes("projects.get"));
    assert.ok(reopen.refreshMethods.includes("events.replay"));
    assert.ok(reopen.refreshMethods.includes("decisions.list"));
    assert.ok(reopen.refreshMethods.includes("roadmaps.revisions.list"));

    const rebuilt = buildMasterModel({
      snapshot: await connection.request("projects.get", { projectId }),
      sessionId: SESSION,
      turns: [],
    });
    assert.equal(rebuilt.projectId, projectId);
    assert.equal(rebuilt.latestEventSequence, withTurn.latestEventSequence);
  });
});

test("live stale roadmap resolve reconciles by refreshing before retry", async () => {
  await withMasterDaemon(async ({ connection, workspace }) => {
    const { projectId } = await createLiveProject(connection, workspace, "Master stale live");
    const generated = await connection.request("roadmaps.get", { projectId });
    const taskId = generated.roadmap.phases[0].tasks[0].id;

    const pending = await connection.request("roadmaps.revisions.propose", {
      projectId,
      baseRevisionNumber: 0,
      operations: [
        { kind: "modify_acceptance_criteria", taskId, acceptanceCriteria: ["Revised criterion"] },
      ],
      rationale: "Tighten the acceptance wording",
      actor: "test",
      sessionId: SESSION,
    });
    assert.equal(pending.outcome, "AWAITING_USER_APPROVAL");

    const advanced = await connection.request("roadmaps.revisions.propose", {
      projectId,
      baseRevisionNumber: 0,
      operations: [
        {
          kind: "add_task",
          phaseId: generated.roadmap.phases[0].id,
          position: generated.roadmap.phases[0].tasks.length,
          task: {
            id: "master-stale-probe",
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
      sessionId: SESSION,
    });
    if (advanced.outcome === "AWAITING_USER_APPROVAL") {
      const applied = await connection.request("roadmaps.revisions.resolve", {
        projectId,
        proposalEventId: advanced.proposal.proposalEventId,
        resolution: "approve",
        rationale: "The addition is correct",
        actor: "test",
        sessionId: SESSION,
      });
      assert.equal(applied.outcome, "APPLIED");
    } else {
      assert.equal(advanced.outcome, "APPLIED");
    }

    const stale = await connection.request("roadmaps.revisions.resolve", {
      projectId,
      proposalEventId: pending.proposal.proposalEventId,
      resolution: "approve",
      rationale: "Approve from an outdated base",
      actor: "test",
      sessionId: SESSION,
    });
    assert.equal(stale.outcome, "STALE");
    assert.equal(isMasterStaleOutcome(stale.outcome), true);

    const snapshot = await connection.request("projects.get", { projectId });
    const model = buildMasterModel({ snapshot, sessionId: SESSION, turns: [] });
    const retryResolve = resolveMasterRoadmapResolve(model, {
      proposalEventId: pending.proposal.proposalEventId,
      resolution: "approve",
      rationale: "Retry is validated first",
      actor: "test",
    });
    assert.equal(retryResolve.method, "roadmaps.revisions.resolve");
    const reconciliation = reconcileMasterStaleOutcome({
      proposalEventId: pending.proposal.proposalEventId,
      baseRevisionNumber: 0,
      latestRevisionNumber: (await connection.request("roadmaps.get", { projectId }))
        .revisionNumber,
    });
    assert.equal(reconciliation.action, "refresh-before-retry");
    assert.ok(reconciliation.refreshMethods.includes("roadmaps.revisions.list"));
  });
});
