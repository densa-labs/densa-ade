import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CORE_V1_MAX_PAGE_SIZE,
  CORE_V1_METHODS,
  PROTOCOL_VERSION,
  CoreV1Client,
  coreV1NotificationEventSchema,
  coreV1OperationContracts,
  parseCoreV1Notification,
  parseCoreV1Request,
  parseCoreV1Result,
} from "../packages/protocol/dist/index.js";

const timestamp = "2026-08-30T00:00:00.000Z";
const later = "2026-08-30T00:01:00.000Z";
const workspacePath = "/tmp/densa-ade-v1-fixture";
const project = {
  id: "project-v1",
  name: "Protocol fixture",
  state: "READY",
  executionMode: "phase",
  createdAt: timestamp,
  updatedAt: timestamp,
};
const phase = {
  id: "phase-v1",
  projectId: project.id,
  title: "Foundation",
  state: "READY",
  position: 0,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const task = {
  id: "task-v1",
  projectId: project.id,
  phaseId: phase.id,
  title: "Prove the contract",
  state: "READY",
  position: 0,
  acceptanceCriteria: ["The fake client completes every v1 UI interaction"],
  dependencyIds: [],
  createdAt: timestamp,
  updatedAt: timestamp,
};
const specification = {
  formatVersion: 1,
  projectGoal: "Prove an editor-neutral protocol",
  targetUsers: ["IDE users"],
  coreUserJourneys: ["Start and monitor a project"],
  requiredFeatures: ["Strict protocol contracts"],
  nonGoals: ["Implement IDE rendering"],
  architectureConstraints: ["Core remains authoritative"],
  platformRuntimeConstraints: ["macOS v0.1"],
  integrations: ["Codex CLI"],
  dataStorageNeeds: ["SQLite"],
  securityPrivacyRequirements: ["No secrets in logs"],
  uxConstraints: ["Familiar editor behavior"],
  deploymentIntent: ["Local first"],
  explicitUserDecisions: [],
  unresolvedQuestions: [],
};
const roadmap = {
  projectId: project.id,
  roadmap: {
    formatVersion: 1,
    projectGoal: specification.projectGoal,
    phases: [
      {
        id: "roadmap-phase-1",
        title: "Foundation",
        goal: "Freeze the boundary",
        required: true,
        completionCriteria: ["Protocol contracts pass"],
        tasks: [
          {
            id: "roadmap-task-1",
            title: "Define protocol",
            goal: "Cover every v1 UI interaction",
            executable: true,
            dependencyIds: [],
            acceptanceCriteria: ["Every operation is schema validated"],
            riskLevel: "high",
            expectedValidators: ["unit_test"],
          },
        ],
      },
    ],
  },
  revisionNumber: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const summary = {
  project,
  workspacePath,
  currentPhaseId: phase.id,
  completedTaskCount: 0,
  totalTaskCount: 1,
  attentionRequired: false,
};
const permissionPolicy = {
  formatVersion: 1,
  preset: "standard",
  overrides: [],
};
const settings = {
  projectId: project.id,
  executionMode: "phase",
  permissionPolicy,
  keepAwakeBatteryPolicy: { minimumLevelPercent: 20 },
  telemetryEnabled: false,
  updatedAt: timestamp,
};
const persistedEvent = {
  id: "event-v1",
  projectId: project.id,
  phaseId: phase.id,
  taskId: task.id,
  type: "TASK_STARTED",
  eventVersion: 1,
  sequenceNumber: 1,
  occurredAt: timestamp,
  actor: "core",
  payload: { state: "RUNNING" },
};
const runLog = {
  cursor: "log-1",
  projectId: project.id,
  phaseId: phase.id,
  taskId: task.id,
  attemptId: "attempt-v1",
  occurredAt: timestamp,
  source: "worker",
  level: "info",
  message: "Worker started",
  redacted: true,
};
const validationRun = {
  id: "validation-v1",
  taskId: task.id,
  attemptId: "attempt-v1",
  validatorId: "unit-test",
  planId: "plan-v1",
  planVersion: "1",
  manualReviewCriteria: [],
  startedAt: timestamp,
  completedAt: later,
  passed: true,
};
const validationResult = {
  id: "validation-result-v1",
  validationRunId: validationRun.id,
  position: 0,
  validatorId: "unit-test",
  validatorVersion: "1",
  evidenceSource: "deterministic_validator",
  policy: "required",
  status: "passed",
  startedAt: timestamp,
  completedAt: later,
  command: ["npm", "test"],
  exitCode: 0,
  diagnostics: [],
  relatedAcceptanceCriteria: task.acceptanceCriteria,
  retryRelevant: false,
};
const proposal = {
  id: "roadmap-proposal-v1",
  proposalEventId: "proposal-event-v1",
  projectId: project.id,
  baseRevisionNumber: 1,
  classification: "minor",
  rationale: "Add a missing test",
  actor: "user",
  sessionId: "session-v1",
  operations: [
    {
      kind: "modify_acceptance_criteria",
      taskId: "roadmap-task-1",
      acceptanceCriteria: ["Every operation is schema validated"],
    },
  ],
  beforeValue: { revisionNumber: 1 },
  afterValue: { revisionNumber: 2 },
  affectedPhaseIds: [phase.id],
  affectedTaskIds: [task.id],
  activeTaskIds: [],
  approvalRequired: true,
  status: "awaiting_approval",
  createdAt: timestamp,
  updatedAt: timestamp,
};
const decision = {
  id: "decision-v1",
  projectId: project.id,
  kind: "decision",
  statement: "Use the v1 protocol boundary",
  title: "Freeze protocol v1",
  rationale: "The IDE needs a stable contract",
  category: "architecture",
  source: "user",
  scope: "project",
  status: "active",
  affectedPhaseIds: [phase.id],
  affectedTaskIds: [task.id],
  createdAt: timestamp,
};
const roadmapRevision = {
  id: "roadmap-revision-v1",
  projectId: project.id,
  classification: "minor",
  reason: proposal.rationale,
  actor: "user",
  sessionId: "session-v1",
  createdAt: timestamp,
  affectedPhaseIds: [phase.id],
  affectedTaskIds: [task.id],
  oldValue: proposal.beforeValue,
  newValue: proposal.afterValue,
  operation: proposal.operations[0],
};
const attempt = {
  id: "attempt-v1",
  taskId: task.id,
  number: 1,
  startedAt: timestamp,
  completedAt: later,
  agentRunId: "agent-run-v1",
  commitSha: "a".repeat(40),
};
const phaseReport = {
  formatVersion: 1,
  projectId: project.id,
  phaseId: phase.id,
  phaseTitle: phase.title,
  outcome: "blocked",
  executionMode: "phase",
  roadmapRevisionNumber: 1,
  phaseStartedAt: timestamp,
  generatedAt: later,
  reportPath: ".densa-ade/reports/phase-v1.md",
  tasksCompleted: [],
  validations: [],
  independentReviews: [],
  commits: [],
  filesChanged: [],
  importantDecisions: [],
  roadmapChanges: [],
  retriesAndFailures: [],
  unresolvedIssues: ["Fixture remains intentionally blocked"],
  phaseValidation: { status: "not_run", summary: "Not run for the blocked fixture" },
};

const noPage = { hasMore: false };
const snapshot = {
  summary,
  specification,
  roadmap,
  phases: [phase],
  tasks: [task],
  pendingApprovals: [],
  usage: { status: "available" },
  latestEventSequence: 1,
};

const payloads = {
  "system.bootstrap": {},
  "projects.list": {},
  "projects.create": {
    name: project.name,
    workspacePath,
    idea: specification.projectGoal,
    executionMode: "phase",
    actor: "user",
  },
  "projects.get": { projectId: project.id },
  "projects.specification.get": { projectId: project.id },
  "projects.interview.answer": {
    projectId: project.id,
    sessionId: "session-v1",
    answers: [{ questionId: "target-users", answer: "IDE users" }],
  },
  "roadmaps.generate": { projectId: project.id, sessionId: "session-v1", actor: "user" },
  "projects.start": { projectId: project.id, workspacePath, actor: "user" },
  "dashboard.get": { projectId: project.id },
  "decisions.list": { projectId: project.id },
  "roadmaps.get": { projectId: project.id },
  "roadmaps.revisions.list": { projectId: project.id },
  "roadmaps.revisions.propose": {
    projectId: project.id,
    baseRevisionNumber: 1,
    operations: proposal.operations,
    rationale: proposal.rationale,
    actor: "user",
    sessionId: "session-v1",
  },
  "roadmaps.revisions.resolve": {
    projectId: project.id,
    proposalEventId: proposal.proposalEventId,
    resolution: "approve",
    rationale: "The change is correct",
    actor: "user",
    sessionId: "session-v1",
  },
  "master.send": {
    projectId: project.id,
    workspacePath,
    sessionId: "session-v1",
    message: "What is happening?",
  },
  "tasks.approve": {
    projectId: project.id,
    phaseId: phase.id,
    taskId: task.id,
    decision: "approve",
    actor: "user",
    reason: "The completed guided task is accepted",
  },
  "phases.approve": {
    projectId: project.id,
    phaseId: phase.id,
    decision: "approve",
    actor: "user",
    reason: "Validation passed",
  },
  "phases.report.get": { projectId: project.id, phaseId: phase.id },
  "projects.pause": { projectId: project.id, workspacePath, actor: "user" },
  "projects.resume": { projectId: project.id, workspacePath, actor: "user" },
  "projects.stop": { projectId: project.id, workspacePath, actor: "user" },
  "settings.get": { projectId: project.id },
  "settings.update": {
    projectId: project.id,
    actor: "user",
    reason: "Choose phase mode",
    executionMode: "phase",
  },
  "permissions.resolve": {
    projectId: project.id,
    decisionId: "permission-decision-v1",
    resolution: "approve",
    actor: "user",
    reason: "Allow this exact operation",
  },
  "usage.get": { projectId: project.id },
  "events.replay": { projectId: project.id, afterSequence: 0 },
  "events.subscribe": { projectId: project.id, afterSequence: 0 },
  "logs.list": { projectId: project.id },
  "git.status": { projectId: project.id, workspacePath },
  "git.commit.get": { projectId: project.id, sha: "a".repeat(40) },
  "attempts.list": { projectId: project.id, taskId: task.id },
  "validation.list": { projectId: project.id, taskId: task.id },
  "validation.get": { projectId: project.id, validationRunId: validationRun.id },
};

const results = {
  "system.bootstrap": {
    protocolVersion: PROTOCOL_VERSION,
    serverInstanceId: "core-v1",
    capabilities: [...CORE_V1_METHODS],
    projects: [summary],
    projectsPage: noPage,
  },
  "projects.list": { projects: [summary], page: noPage },
  "projects.create": { project, workspacePath, interviewQuestions: [] },
  "projects.get": snapshot,
  "projects.specification.get": { projectId: project.id, specification },
  "projects.interview.answer": {
    projectId: project.id,
    specification,
    nextQuestions: [],
    readyForRoadmap: true,
  },
  "roadmaps.generate": roadmap,
  "projects.start": { projectId: project.id, state: "READY", firstPhaseId: phase.id },
  "dashboard.get": {
    project: summary,
    phaseCounts: [{ state: "READY", count: 1 }],
    taskCounts: [{ state: "READY", count: 1 }],
    currentPhase: phase,
    currentTask: task,
    pendingApprovals: [],
    recentFailureCount: 0,
    retryCount: 0,
    validation: { passed: 1, failed: 0, incomplete: 0 },
    usage: { status: "available" },
    latestEventSequence: 1,
  },
  "decisions.list": { decisions: [decision], page: noPage },
  "roadmaps.get": roadmap,
  "roadmaps.revisions.list": { revisions: [roadmapRevision], page: noPage },
  "roadmaps.revisions.propose": { proposal, outcome: "AWAITING_USER_APPROVAL" },
  "roadmaps.revisions.resolve": { proposal, outcome: "AWAITING_USER_APPROVAL" },
  "master.send": {
    proposal: {
      formatVersion: 1,
      intent: "explain_project_status",
      response: "The project is ready.",
      citations: [{ kind: "project", id: project.id }],
      action: { kind: "respond" },
    },
  },
  "tasks.approve": { projectId: project.id, phaseId: phase.id, task, outcome: "APPROVED" },
  "phases.approve": { projectId: project.id, phase, outcome: "APPROVED" },
  "phases.report.get": phaseReport,
  "projects.pause": { projectId: project.id, status: "PAUSED", reason: "Paused" },
  "projects.resume": { projectId: project.id, status: "RESUMED" },
  "projects.stop": { projectId: project.id, status: "STOPPED", reason: "Stopped safely" },
  "settings.get": settings,
  "settings.update": settings,
  "permissions.resolve": {
    projectId: project.id,
    decisionId: "permission-decision-v1",
    outcome: "APPROVED",
  },
  "usage.get": { projectId: project.id, usage: { status: "available" }, observedAt: timestamp },
  "events.replay": { events: [persistedEvent], latestSequence: 1, hasMore: false },
  "events.subscribe": {
    events: [persistedEvent],
    latestSequence: 1,
    hasMore: false,
    subscribed: true,
  },
  "logs.list": { entries: [runLog], page: noPage },
  "git.status": {
    projectId: project.id,
    workspacePath,
    available: true,
    headSha: "a".repeat(40),
    branch: "main",
    dirty: false,
    changedPaths: [],
    observedAt: timestamp,
  },
  "git.commit.get": {
    sha: "a".repeat(40),
    subject: "densa-ade: fixture",
    authoredAt: timestamp,
    reachable: true,
    taskId: task.id,
    attemptId: "attempt-v1",
    changedPaths: ["packages/protocol/src/core-v1.ts"],
  },
  "attempts.list": { attempts: [attempt], page: noPage },
  "validation.list": { runs: [validationRun], page: noPage },
  "validation.get": { run: validationRun, results: [validationResult] },
};

test("the fake IDE client round-trips every v1 schema without Core or DB imports", async () => {
  assert.equal(PROTOCOL_VERSION, "1.0.0");
  assert.deepEqual(Object.keys(coreV1OperationContracts), [...CORE_V1_METHODS]);

  const seen = new Set();
  const transport = {
    async request(envelope) {
      const request = parseCoreV1Request(envelope);
      seen.add(request.method);
      return parseCoreV1Result(request.method, results[request.method]);
    },
  };
  let requestNumber = 0;
  const client = new CoreV1Client(transport, () => `fake-request-${String(++requestNumber)}`);

  for (const method of CORE_V1_METHODS) {
    assert.deepEqual(await client.request(method, payloads[method]), results[method]);
  }
  assert.deepEqual([...seen], [...CORE_V1_METHODS]);
});

test("the v1 client rejects schema-valid responses from another project", async () => {
  const transport = {
    async request() {
      return {
        events: [{ ...persistedEvent, projectId: "project-other" }],
        latestSequence: 1,
        hasMore: false,
      };
    },
  };
  const client = new CoreV1Client(transport, () => "request-cross-project");
  await assert.rejects(
    client.request("events.replay", { projectId: project.id, afterSequence: 0 }),
    /projectId boundary/u,
  );
});

test("request binding permits opaque historical IDs, canonical workspace paths, and abbreviated SHAs", async () => {
  const client = new CoreV1Client(
    {
      async request(envelope) {
        if (envelope.method === "events.replay") {
          return {
            ...results["events.replay"],
            events: [{ ...persistedEvent, payload: { projectId: "historical-reference" } }],
          };
        }
        if (envelope.method === "projects.create") {
          return { ...results["projects.create"], workspacePath: "/private/tmp/canonical-project" };
        }
        return results[envelope.method];
      },
    },
    () => "request-valid-identities",
  );
  assert.equal((await client.request("events.replay", payloads["events.replay"])).events.length, 1);
  assert.equal(
    (await client.request("git.commit.get", { projectId: project.id, sha: "a".repeat(7) })).sha,
    "a".repeat(40),
  );
  assert.equal(
    (await client.request("projects.create", payloads["projects.create"])).workspacePath,
    "/private/tmp/canonical-project",
  );
});

test("request binding rejects substituted task, validation, and commit identities", async () => {
  const substitutions = [
    ["tasks.approve", { ...results["tasks.approve"], task: { ...task, id: "task-other" } }],
    [
      "validation.get",
      { ...results["validation.get"], run: { ...validationRun, id: "run-other" } },
    ],
    ["git.commit.get", { ...results["git.commit.get"], sha: "b".repeat(40) }],
  ];
  for (const [method, substituted] of substitutions) {
    const client = new CoreV1Client(
      {
        async request() {
          return substituted;
        },
      },
      () => "request-substitution",
    );
    await assert.rejects(client.request(method, payloads[method]), /different requested/u);
  }
});

test("large histories are bounded and strict payloads reject UI-only fields", () => {
  assert.equal(
    coreV1OperationContracts["events.replay"].payload.safeParse({
      projectId: project.id,
      limit: CORE_V1_MAX_PAGE_SIZE + 1,
    }).success,
    false,
  );
  assert.equal(
    coreV1OperationContracts["logs.list"].result.safeParse({
      entries: Array.from({ length: CORE_V1_MAX_PAGE_SIZE + 1 }, () => runLog),
      page: noPage,
    }).success,
    false,
  );
  assert.equal(
    coreV1OperationContracts["projects.pause"].payload.safeParse({
      ...payloads["projects.pause"],
      optimisticState: "PAUSED",
    }).success,
    false,
  );
  assert.equal(
    coreV1OperationContracts["tasks.approve"].payload.safeParse({
      ...payloads["tasks.approve"],
      taskId: "task-from-another-project",
      optimisticState: "COMPLETED",
    }).success,
    false,
  );
});

test("v1 notifications validate durable event sequences and redacted bounded logs", () => {
  assert.equal(coreV1NotificationEventSchema.safeParse("core.event").success, true);
  assert.equal(
    parseCoreV1Notification({
      protocolVersion: PROTOCOL_VERSION,
      kind: "notification",
      event: "core.event",
      payload: persistedEvent,
    }).payload.sequenceNumber,
    1,
  );
  assert.throws(() =>
    parseCoreV1Notification({
      protocolVersion: PROTOCOL_VERSION,
      kind: "notification",
      event: "run.log.appended",
      payload: { ...runLog, message: "x".repeat(16 * 1_024 + 1) },
    }),
  );
});
