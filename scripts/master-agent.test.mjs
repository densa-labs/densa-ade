import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  AgentAdapterMasterAgent,
  DatabaseMasterProjectContextReader,
  MasterAgentError,
  MasterAgentService,
  ProjectDecisionService,
  ProjectRundownService,
  StateTransitionService,
  ValidatedMasterCoreCommandGateway,
  runTemporaryRepoTaskProof,
} from "@densa-ade/core";
import { DensaAdeDatabase } from "@densa-ade/core/persistence";
import { FakeAgentAdapter } from "@densa-ade/testing";

const workspacePath = "/tmp/densa-p8m0-workspace";
const createdAt = "2026-08-29T01:00:00.000Z";

function seed() {
  const database = DensaAdeDatabase.openInMemory();
  let tick = 0;
  const nextTime = () => new Date(Date.parse(createdAt) + ++tick * 1_000).toISOString();
  database.repositories.projects.create({
    id: "project-master",
    name: "Master boundary proof",
    state: "DRAFT",
    executionMode: "guided",
    createdAt,
    updatedAt: createdAt,
  });
  database.repositories.phases.create({
    id: "phase-current",
    projectId: "project-master",
    title: "Current phase",
    state: "PENDING",
    position: 0,
    createdAt,
    updatedAt: createdAt,
  });
  database.repositories.tasks.create({
    id: "task-blocked",
    projectId: "project-master",
    phaseId: "phase-current",
    title: "Blocked task",
    state: "PENDING",
    position: 0,
    acceptanceCriteria: ["The blocker is resolved."],
    dependencyIds: [],
    createdAt,
    updatedAt: createdAt,
  });
  const transitions = new StateTransitionService();
  const transition = (entityType, id, state) => {
    const repository =
      entityType === "project"
        ? database.repositories.projects
        : entityType === "phase"
          ? database.repositories.phases
          : database.repositories.tasks;
    const entity = repository.findById(id);
    const occurredAt = nextTime();
    const context = { actor: "fixture", occurredAt, reason: "P8M0 test fixture" };
    const result =
      entityType === "project"
        ? transitions.transitionProject(entity, state, context)
        : entityType === "phase"
          ? transitions.transitionPhase(entity, state, context)
          : transitions.transitionTask(entity, state, context);
    database.persistStateTransition(result, `event-fixture-${entityType}-${state.toLowerCase()}`);
  };
  transition("project", "project-master", "PLANNING");
  transition("project", "project-master", "READY");
  transition("project", "project-master", "RUNNING");
  transition("phase", "phase-current", "READY");
  transition("phase", "phase-current", "RUNNING");
  transition("task", "task-blocked", "READY");
  transition("task", "task-blocked", "RUNNING");
  transition("task", "task-blocked", "BLOCKED");
  database.repositories.decisions.create({
    id: "decision-architecture",
    projectId: "project-master",
    kind: "decision",
    statement: "Keep Core authoritative.",
    title: "Keep Core authoritative",
    rationale: "All mutations must pass through Core domain services.",
    category: "architecture.authority",
    source: "system",
    scope: "project",
    status: "active",
    affectedPhaseIds: [],
    affectedTaskIds: [],
    createdAt,
  });
  database.repositories.events.append({
    id: "event-task-blocked",
    projectId: "project-master",
    phaseId: "phase-current",
    taskId: "task-blocked",
    type: "TASK_BLOCKED",
    eventVersion: 1,
    occurredAt: nextTime(),
    actor: "fixture",
    payload: { reason: "Acceptance evidence is incomplete" },
  });
  return database;
}

function request(message = "Why is the task blocked?") {
  return {
    projectId: "project-master",
    workspacePath,
    sessionId: "session-steering",
    message,
  };
}

function proposal(intent, action, overrides = {}) {
  return {
    formatVersion: 1,
    intent,
    response: "The authoritative Core snapshot supports this response.",
    citations: [{ kind: "task", id: "task-blocked" }],
    action,
    ...overrides,
  };
}

function serviceWithGateway(database, structuredProposal, gateway, rundowns) {
  const adapter = new FakeAgentAdapter({ finalMessage: JSON.stringify(structuredProposal) });
  const agent = new AgentAdapterMasterAgent(adapter, {
    cwd: workspacePath,
    runIdFactory: (sessionId) => `master-session-${sessionId}-turn-1`,
  });
  return {
    adapter,
    service: new MasterAgentService(
      agent,
      new DatabaseMasterProjectContextReader(database),
      gateway,
      rundowns,
    ),
  };
}

test("Master explanation runs in a separate read-only session and cites authoritative IDs", async () => {
  const database = seed();
  const gateway = {
    async execute() {
      throw new Error("Explanation intents must not issue commands");
    },
  };
  const explanation = proposal(
    "explain_decision",
    { kind: "respond" },
    {
      citations: [
        { kind: "project", id: "project-master" },
        { kind: "phase", id: "phase-current" },
        { kind: "task", id: "task-blocked" },
        { kind: "decision", id: "decision-architecture" },
        { kind: "event", id: "event-task-blocked" },
      ],
    },
  );
  const { adapter, service } = serviceWithGateway(database, explanation, gateway);

  const response = await service.handle(request());

  assert.equal(response.intent, "explain_decision");
  assert.equal(response.commandResult, undefined);
  assert.deepEqual(response.citations, explanation.citations);
  assert.equal(adapter.requests.length, 1);
  assert.equal(adapter.requests[0].accessMode, "read-only");
  assert.equal(adapter.requests[0].runId, "master-session-session-steering-turn-1");
  assert.equal(adapter.requests[0].outputSchema.type, "object");
  assert.match(adapter.requests[0].prompt, /TASK_BLOCKED/u);
  assert.match(adapter.requests[0].prompt, /decision-architecture/u);
  database.close();
});

test("Master factual summaries use Core-owned rundown facts instead of agent-authored numbers", async () => {
  const database = seed();
  const structured = proposal(
    "explain_project_status",
    { kind: "respond" },
    { response: "The agent claims there are 999 tasks and 999 validation runs." },
  );
  const { service } = serviceWithGateway(
    database,
    structured,
    {
      async execute() {
        throw new Error("Status explanations must not issue commands");
      },
    },
    new ProjectRundownService(database, {
      now: () => "2026-08-29T01:10:00.000Z",
      git: {
        async inspect() {
          return { status: "unavailable", reason: "No Git fixture", commits: [] };
        },
      },
    }),
  );

  const response = await service.handle(request("Give me the current project status."));

  assert.match(response.response, /Tasks: 1 \(BLOCKED=1\)/u);
  assert.match(response.response, /Validation runs: 0/u);
  assert.doesNotMatch(response.response, /999/u);
  database.close();
});

test("Master context fails closed before provider execution when its authoritative snapshot is oversized", async () => {
  const database = seed();
  const adapter = new FakeAgentAdapter({
    finalMessage: JSON.stringify(proposal("explain_project_status", { kind: "respond" })),
  });
  const service = new MasterAgentService(
    new AgentAdapterMasterAgent(adapter, { cwd: workspacePath }),
    {
      read(projectId) {
        const context = new DatabaseMasterProjectContextReader(database).read(projectId);
        return {
          ...context,
          tasks: [{ ...context.tasks[0], title: "x".repeat(1_024 * 1_024) }],
        };
      },
    },
    {
      async execute() {
        throw new Error("Oversized context must stop before command execution");
      },
    },
  );

  await assert.rejects(
    service.handle(request("Summarize the project.")),
    (error) =>
      error instanceof MasterAgentError &&
      error.code === "USER_CONFIGURATION_ERROR" &&
      /context exceeds/u.test(error.message),
  );
  assert.equal(adapter.requests.length, 0);
  database.close();
});

test("Master service redacts user and persisted context before any model-neutral agent sees it", async () => {
  const database = seed();
  database.repositories.events.append({
    id: "event-secret-context",
    projectId: "project-master",
    type: "PROJECT_CONTEXT_RECORDED",
    eventVersion: 1,
    occurredAt: "2026-08-29T01:11:00.000Z",
    actor: "fixture",
    payload: { api_key: "sk-proj-secret-context-value" },
  });
  let seen;
  const service = new MasterAgentService(
    {
      async propose(conversation) {
        seen = conversation;
        return proposal(
          "explain_decision",
          { kind: "respond" },
          { citations: [{ kind: "decision", id: "decision-architecture" }] },
        );
      },
    },
    new DatabaseMasterProjectContextReader(database),
    {
      async execute() {
        throw new Error("Decision explanation must not issue a command");
      },
    },
  );

  await service.handle(request("My token=sk-proj-user-message-secret; explain the decision."));

  assert.ok(seen);
  assert.doesNotMatch(JSON.stringify(seen), /sk-proj|user-message-secret|secret-context-value/u);
  assert.match(JSON.stringify(seen), /\[REDACTED\]/u);
  database.close();
});

test("fake-agent structured proposals map exactly to Core commands", async () => {
  const cases = [
    {
      intent: "propose_roadmap_change",
      action: {
        kind: "propose_roadmap_change",
        operation: {
          kind: "modify_acceptance_criteria",
          taskId: "task-blocked",
          acceptanceCriteria: ["The blocker has deterministic evidence."],
        },
        additionalOperations: [
          {
            kind: "reorder_task",
            taskId: "task-blocked",
            phaseId: "phase-current",
            position: 0,
          },
        ],
        rationale: "Make completion independently verifiable.",
      },
    },
    {
      intent: "propose_project_constraint_change",
      action: {
        kind: "propose_project_constraint_change",
        change: {
          operation: "add",
          path: "architectureConstraints.localOnly",
          value: { required: true },
        },
        rationale: "Preserve local-first operation.",
      },
    },
    { intent: "request_project_control", action: { kind: "request_pause" } },
    {
      intent: "request_project_control",
      action: { kind: "request_resume", acknowledgeIntervention: true },
    },
    {
      intent: "request_project_control",
      action: { kind: "request_mode_change", mode: "phase" },
    },
    {
      intent: "resolve_roadmap_revision",
      action: {
        kind: "resolve_roadmap_revision",
        proposalEventId: "event-roadmap-proposal",
        resolution: "approve",
        rationale: "The user approved the inspected proposal.",
      },
    },
  ];

  for (const [index, fixture] of cases.entries()) {
    const database = seed();
    const commands = [];
    const gateway = {
      async execute(command) {
        commands.push(command);
        return {
          command: command.kind,
          status: command.kind.startsWith("propose_") ? "PROPOSED" : "REQUESTED",
          details: { acceptedBy: "fake-core-gateway" },
        };
      },
    };
    const { service } = serviceWithGateway(
      database,
      proposal(fixture.intent, fixture.action),
      gateway,
    );

    const response = await service.handle(request(`case ${index}`));

    assert.equal(commands.length, 1);
    assert.equal(commands[0].kind, fixture.action.kind);
    assert.equal(commands[0].projectId, "project-master");
    assert.equal(commands[0].workspacePath, workspacePath);
    assert.equal(commands[0].sessionId, "session-steering");
    assert.equal(commands[0].actor, "densa-master:session-steering");
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(commands[0]).filter(
          ([key]) => !["projectId", "workspacePath", "sessionId", "actor"].includes(key),
        ),
      ),
      fixture.action,
    );
    assert.equal(response.commandResult.command, fixture.action.kind);
    database.close();
  }
});

test("validated gateway routes mode requests through audited Core domain operations", async () => {
  const database = seed();
  let tick = 0;
  const now = () => new Date(Date.parse(createdAt) + ++tick * 1_000).toISOString();
  const structured = proposal("request_project_control", {
    kind: "request_mode_change",
    mode: "phase",
  });
  const { service } = serviceWithGateway(
    database,
    structured,
    new ValidatedMasterCoreCommandGateway(database, { now }),
  );

  const response = await service.handle(request("Switch to phase approval mode."));

  assert.equal(response.commandResult.status, "CHANGED");
  assert.equal(database.repositories.projects.findById("project-master").executionMode, "phase");
  const modeEvent = database.eventJournal
    .replay({ projectId: "project-master", limit: 50 })
    .find((event) => event.type === "EXECUTION_MODE_CHANGED");
  assert.ok(modeEvent);
  assert.equal(modeEvent.actor, "densa-master:session-steering");
  assert.deepEqual(modeEvent.payload, {
    previousMode: "guided",
    mode: "phase",
    effectiveAt: "safe_boundary",
  });
  database.close();
});

test("validated gateway routes pause requests through the centralized state transition service", async () => {
  const database = seed();
  let tick = 0;
  const now = () => new Date(Date.parse(createdAt) + 20_000 + ++tick * 1_000).toISOString();
  const structured = proposal("request_project_control", { kind: "request_pause" });
  const { service } = serviceWithGateway(
    database,
    structured,
    new ValidatedMasterCoreCommandGateway(database, { now }),
  );

  const response = await service.handle(request("Pause at the safe boundary."));

  assert.equal(response.commandResult.status, "APPLIED");
  assert.equal(database.repositories.projects.findById("project-master").state, "PAUSED");
  const events = database.eventJournal.replay({ projectId: "project-master", limit: 50 });
  assert.ok(events.some((event) => event.type === "PROJECT_PAUSE_REQUESTED"));
  const transition = events.find(
    (event) =>
      event.type === "PROJECT_STATE_CHANGED" &&
      event.payload.previousState === "RUNNING" &&
      event.payload.state === "PAUSED",
  );
  assert.ok(transition);
  assert.equal(transition.actor, "densa-master:session-steering");
  database.close();
});

test("scope roadmap proposals stop for inspectable user approval without mutating the roadmap", async () => {
  const database = seed();
  database.persistInitialMasterRoadmap({
    projectId: "project-master",
    roadmap: {
      formatVersion: 1,
      projectGoal: "Prove the Master boundary.",
      phases: [
        {
          id: "phase-current",
          title: "Current phase",
          goal: "Keep the authoritative phase.",
          required: true,
          completionCriteria: ["The phase remains inspectable."],
          tasks: [
            {
              id: "task-blocked",
              title: "Blocked task",
              goal: "Resolve the blocker.",
              executable: true,
              dependencyIds: [],
              acceptanceCriteria: ["The blocker is resolved."],
              riskLevel: "medium",
              expectedValidators: ["acceptance"],
            },
          ],
        },
      ],
    },
    revisionNumber: 0,
    createdAt,
    updatedAt: createdAt,
  });
  const structured = proposal("propose_roadmap_change", {
    kind: "propose_roadmap_change",
    operation: {
      kind: "modify_acceptance_criteria",
      taskId: "task-blocked",
      acceptanceCriteria: ["A weaker replacement criterion."],
    },
    rationale: "Replace a promised acceptance criterion without user approval.",
  });
  const { service } = serviceWithGateway(
    database,
    structured,
    new ValidatedMasterCoreCommandGateway(database, { now: () => "2026-08-29T02:00:00.000Z" }),
  );

  const response = await service.handle(request("Weaken the acceptance criterion."));

  assert.equal(response.commandResult.status, "AWAITING_USER_APPROVAL");
  assert.equal(response.commandResult.details.classification, "scope");
  assert.equal(response.commandResult.details.approvalRequired, true);
  assert.equal(
    response.commandResult.details.before.phases[0].tasks[0].acceptanceCriteria[0],
    "The blocker is resolved.",
  );
  assert.equal(
    response.commandResult.details.after.phases[0].tasks[0].acceptanceCriteria[0],
    "A weaker replacement criterion.",
  );
  assert.equal(
    database.repositories.masterRoadmaps.findByProjectId("project-master").revisionNumber,
    0,
  );
  assert.equal(database.repositories.roadmapRevisions.listByProjectId("project-master").length, 0);
  assert.equal(
    database.repositories.roadmapRevisionProposals.listByProjectId("project-master").length,
    1,
  );
  const proposalEvent = database.eventJournal
    .replay({ projectId: "project-master", limit: 50 })
    .find((event) => event.type === "ROADMAP_REVISION_PROPOSED");
  assert.ok(proposalEvent);
  assert.equal(proposalEvent.payload.status, "awaiting_approval");
  database.close();
});

test("an explicit follow-up approval resolves and applies the persisted roadmap proposal", async () => {
  await rm(workspacePath, { force: true, recursive: true });
  const database = seed();
  database.persistInitialMasterRoadmap({
    projectId: "project-master",
    roadmap: {
      formatVersion: 1,
      projectGoal: "Prove the Master boundary.",
      phases: [
        {
          id: "phase-current",
          title: "Current phase",
          goal: "Keep the authoritative phase.",
          required: true,
          completionCriteria: ["The phase remains inspectable."],
          tasks: [
            {
              id: "task-blocked",
              title: "Blocked task",
              goal: "Resolve the blocker.",
              executable: true,
              dependencyIds: [],
              acceptanceCriteria: ["The blocker is resolved."],
              riskLevel: "medium",
              expectedValidators: ["acceptance"],
            },
          ],
        },
      ],
    },
    revisionNumber: 0,
    createdAt,
    updatedAt: createdAt,
  });
  let tick = 0;
  const now = () => new Date(Date.parse(createdAt) + 30_000 + ++tick * 1_000).toISOString();
  const gateway = new ValidatedMasterCoreCommandGateway(database, { now });
  const proposedAction = proposal("propose_roadmap_change", {
    kind: "propose_roadmap_change",
    operation: {
      kind: "modify_acceptance_criteria",
      taskId: "task-blocked",
      acceptanceCriteria: ["A replacement criterion is explicitly approved."],
    },
    rationale: "Replace an existing acceptance promise.",
  });
  const first = serviceWithGateway(database, proposedAction, gateway);
  const proposed = await first.service.handle(request("Propose the replacement."));
  assert.match(first.adapter.requests[0].prompt, /Prove the Master boundary/u);
  const proposalEventId = proposed.commandResult.details.proposalEventId;

  const approvalAction = proposal(
    "resolve_roadmap_revision",
    {
      kind: "resolve_roadmap_revision",
      proposalEventId,
      resolution: "approve",
      rationale: "I approve the inspected before and after.",
    },
    { citations: [{ kind: "event", id: proposalEventId }] },
  );
  const second = serviceWithGateway(database, approvalAction, gateway);
  const applied = await second.service.handle(request("Approve that roadmap revision."));

  assert.equal(applied.commandResult.status, "APPLIED");
  assert.equal(applied.commandResult.details.revisionNumber, 1);
  assert.equal(
    database.repositories.roadmapRevisionProposals.findByEventId(proposalEventId).status,
    "applied",
  );
  const approval = database.repositories.decisions
    .listByProjectId("project-master")
    .find((decision) => decision.category.startsWith("roadmap.revision.approval."));
  assert.ok(approval);
  assert.equal(approval.source, "user");
  assert.equal(
    database.repositories.masterRoadmaps.findByProjectId("project-master").roadmap.phases[0]
      .tasks[0].acceptanceCriteria[0],
    "A replacement criterion is explicitly approved.",
  );
  const repeated = serviceWithGateway(database, approvalAction, gateway);
  const repeatedResult = await repeated.service.handle(request("Approve that roadmap revision."));
  assert.equal(repeatedResult.commandResult.status, "APPLIED");
  assert.equal(
    database.repositories.decisions
      .listByProjectId("project-master")
      .filter((decision) => decision.category.startsWith("roadmap.revision.approval.")).length,
    1,
  );
  database.close();
  await rm(workspacePath, { force: true, recursive: true });
});

test("approving an approval-free safe-boundary proposal does not fabricate user approval", async () => {
  const database = seed();
  database.persistInitialMasterRoadmap({
    projectId: "project-master",
    roadmap: {
      formatVersion: 1,
      projectGoal: "Prove safe-boundary steering.",
      phases: [
        {
          id: "phase-current",
          title: "Current phase",
          goal: "Keep active work stable.",
          required: true,
          completionCriteria: ["The active task remains stable."],
          tasks: [
            {
              id: "task-blocked",
              title: "Blocked task",
              goal: "Resolve the blocker.",
              executable: true,
              dependencyIds: [],
              acceptanceCriteria: ["The blocker is resolved."],
              riskLevel: "medium",
              expectedValidators: ["acceptance"],
            },
          ],
        },
      ],
    },
    revisionNumber: 0,
    createdAt,
    updatedAt: createdAt,
  });
  database.repositories.attempts.create({
    id: "attempt-unfinished-boundary",
    taskId: "task-blocked",
    number: 1,
    startedAt: "2026-08-29T01:20:00.000Z",
  });
  const gateway = new ValidatedMasterCoreCommandGateway(database, {
    now: () => "2026-08-29T01:21:00.000Z",
  });
  const proposed = await gateway.execute({
    kind: "propose_roadmap_change",
    projectId: "project-master",
    workspacePath,
    sessionId: "session-boundary",
    actor: "densa-master:session-boundary",
    operation: {
      kind: "modify_acceptance_criteria",
      taskId: "task-blocked",
      acceptanceCriteria: [
        "The blocker is resolved.",
        "The active task context changes only after a safe boundary.",
      ],
    },
    rationale: "Keep the task in place while proving the boundary.",
  });
  assert.equal(proposed.status, "WAITING_FOR_SAFE_BOUNDARY");

  const resolved = await gateway.execute({
    kind: "resolve_roadmap_revision",
    projectId: "project-master",
    workspacePath,
    sessionId: "session-boundary",
    actor: "densa-master:session-boundary",
    proposalEventId: proposed.details.proposalEventId,
    resolution: "approve",
    rationale: "Continue when the task reaches a safe boundary.",
  });

  assert.equal(resolved.status, "WAITING_FOR_SAFE_BOUNDARY");
  assert.equal(
    database.repositories.decisions
      .listByProjectId("project-master")
      .some((decision) => decision.category.startsWith("roadmap.revision.approval.")),
    false,
  );
  database.close();
});

test("an idempotent decision retry repairs a previously failed portable projection", async () => {
  await rm(workspacePath, { force: true, recursive: true });
  await writeFile(workspacePath, "block portable directory creation", "utf8");
  const database = seed();
  let decisionNumber = 0;
  let eventNumber = 0;
  const decisions = new ProjectDecisionService(database, {
    workspacePath,
    now: () => "2026-08-29T01:30:00.000Z",
    decisionIdFactory: () => `decision-portable-${String(++decisionNumber)}`,
    eventIdFactory: () => `event-portable-${String(++eventNumber)}`,
  });
  const input = {
    projectId: "project-master",
    kind: "constraint",
    statement: "Remain local only.",
    title: "Local only",
    rationale: "Preserve local-first behavior.",
    category: "architecture.local-only",
    source: "user",
    scope: "project",
    affectedPhaseIds: [],
    affectedTaskIds: [],
    actor: "user",
  };
  const first = await decisions.record(input);
  assert.equal(first.status, "RECORDED");
  assert.equal(first.portableSync.status, "failed");
  assert.equal(database.repositories.decisions.listByProjectId("project-master").length, 2);

  await rm(workspacePath, { force: true });
  await mkdir(workspacePath);
  const retried = await decisions.record(input);
  assert.equal(retried.status, "UNCHANGED");
  assert.equal(retried.portableSync.status, "synchronized");
  assert.equal(database.repositories.decisions.listByProjectId("project-master").length, 2);
  assert.match(
    await readFile(path.join(workspacePath, ".densa-ade", "DECISIONS.md"), "utf8"),
    /Remain local only/u,
  );
  database.close();
  await rm(workspacePath, { force: true, recursive: true });
});

test("Phase 8 portable mutations reject a workspace substituted after run ownership is persisted", async () => {
  const database = seed();
  database.repositories.densaAdeRunBranches.createCreating({
    projectId: "project-master",
    sourceWorkspacePath: workspacePath,
    workspacePath: "/tmp/densa-p8m0-isolated-run",
    branchName: "densa-ade/run/project-master",
    sourceBranch: "main",
    startingCommit: "abc1234",
    createdAt: "2026-08-29T01:40:00.000Z",
  });
  database.repositories.densaAdeRunBranches.activate("project-master", "2026-08-29T01:41:00.000Z");
  const decisions = new ProjectDecisionService(database, {
    workspacePath: "/tmp/densa-p8m0-substituted-workspace",
  });

  await assert.rejects(
    decisions.record({
      projectId: "project-master",
      kind: "constraint",
      statement: "Do not cross workspace boundaries.",
      title: "Workspace boundary",
      rationale: "Project identity must bind portable writes.",
      category: "workspace.boundary",
      source: "user",
      scope: "project",
      affectedPhaseIds: [],
      affectedTaskIds: [],
      actor: "user",
    }),
    (error) => error?.code === "WORKSPACE_CONFLICT" && /bound to workspace/u.test(error.message),
  );
  assert.equal(database.repositories.decisions.listByProjectId("project-master").length, 1);
  database.close();
});

test("constraint actions persist through Core and update the portable decision record", async () => {
  await rm(workspacePath, { force: true, recursive: true });
  const database = seed();
  const structured = proposal("propose_project_constraint_change", {
    kind: "propose_project_constraint_change",
    change: {
      operation: "add",
      path: "platformRuntimeConstraints.target",
      value: { target: "macOS" },
    },
    rationale: "Keep the v0.1 target explicit.",
  });
  const { service } = serviceWithGateway(
    database,
    structured,
    new ValidatedMasterCoreCommandGateway(database),
  );

  const response = await service.handle(request("Propose a macOS-only constraint."));

  assert.equal(response.commandResult.status, "APPLIED");
  const constraint = database.repositories.decisions
    .listByProjectId("project-master")
    .find((decision) => decision.kind === "constraint");
  assert.ok(constraint);
  assert.equal(constraint.category, "platformRuntimeConstraints.target");
  assert.equal(constraint.source, "master");
  assert.equal(constraint.status, "active");
  const portable = await readFile(path.join(workspacePath, ".densa-ade", "DECISIONS.md"), "utf8");
  assert.match(portable, /platformRuntimeConstraints\.target/u);
  assert.match(portable, /Status: active/u);
  database.close();
  await rm(workspacePath, { force: true, recursive: true });
});

test("unknown citations fail closed before any Core command is invoked", async () => {
  const database = seed();
  let commandCount = 0;
  const gateway = {
    async execute(command) {
      commandCount += 1;
      return { command: command.kind, status: "REQUESTED", details: {} };
    },
  };
  const structured = proposal(
    "request_project_control",
    { kind: "request_pause" },
    { citations: [{ kind: "event", id: "event-invented" }] },
  );
  const { service } = serviceWithGateway(database, structured, gateway);

  await assert.rejects(
    service.handle(request("Pause and cite why.")),
    (error) =>
      error instanceof MasterAgentError &&
      error.code === "INTERNAL_INVARIANT_VIOLATION" &&
      /event-invented/u.test(error.message),
  );
  assert.equal(commandCount, 0);
  database.close();
});

test("worker proof execution does not require a Master conversation or session", async (t) => {
  const worker = new FakeAgentAdapter({
    finalMessage: "Worker finished its scoped implementation.",
    onExecute: async ({ cwd }) => {
      await writeFile(
        path.join(cwd, "src", "sum.js"),
        "export function sum(a, b) {\n  return a + b;\n}\n",
        "utf8",
      );
    },
  });

  const result = await runTemporaryRepoTaskProof({
    adapter: worker,
    runId: "worker-without-master-session",
  });
  t.after(async () => {
    await Promise.all([
      rm(result.temporaryRoot, { recursive: true, force: true }),
      rm(result.diagnosticsRoot, { recursive: true, force: true }),
    ]);
  });

  assert.equal(result.verdict, "PASS");
  assert.equal(worker.requests.length, 1);
  assert.equal(worker.requests[0].runId, "worker-without-master-session");
  assert.doesNotMatch(worker.requests[0].prompt, /Master conversation|Master session/u);
});
