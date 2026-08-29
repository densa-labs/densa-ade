import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  AgentAdapterMasterAgent,
  DatabaseMasterProjectContextReader,
  MasterAgentError,
  MasterAgentService,
  StateTransitionService,
  ValidatedMasterCoreCommandGateway,
  runTemporaryRepoTaskProof,
} from "@densa/core";
import { DensaDatabase } from "@densa/core/persistence";
import { FakeAgentAdapter } from "@densa/testing";

const workspacePath = "/tmp/densa-p8m0-workspace";
const createdAt = "2026-08-29T01:00:00.000Z";

function seed() {
  const database = DensaDatabase.openInMemory();
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
    title: "Keep Core authoritative",
    rationale: "All mutations must pass through Core domain services.",
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

function serviceWithGateway(database, structuredProposal, gateway) {
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

test("scope roadmap proposals cannot bypass Core permission policy", async () => {
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
    operation: { kind: "remove_phase", phaseId: "phase-current" },
    rationale: "Remove promised scope without user approval.",
  });
  const { service } = serviceWithGateway(
    database,
    structured,
    new ValidatedMasterCoreCommandGateway(database, { now: () => "2026-08-29T02:00:00.000Z" }),
  );

  await assert.rejects(
    service.handle(request("Remove the current phase.")),
    /SCOPE roadmap mutations require explicit user approval/u,
  );
  assert.equal(
    database.repositories.masterRoadmaps.findByProjectId("project-master").revisionNumber,
    0,
  );
  assert.equal(database.repositories.roadmapRevisions.listByProjectId("project-master").length, 0);
  const permissionEvent = database.eventJournal
    .replay({ projectId: "project-master", limit: 50 })
    .find(
      (event) =>
        event.type === "PERMISSION_DECISION_RECORDED" &&
        event.payload.operation === "roadmap_scope_change",
    );
  assert.ok(permissionEvent);
  assert.equal(permissionEvent.payload.disposition, "ask_user");
  database.close();
});

test("constraint actions remain non-authoritative proposals until the P8M1 persistence workflow", async () => {
  const database = seed();
  const structured = proposal("propose_project_constraint_change", {
    kind: "propose_project_constraint_change",
    change: {
      operation: "replace",
      path: "platformRuntimeConstraints.target",
      value: { target: "macOS" },
    },
    rationale: "Keep the v0.1 target explicit.",
  });
  const before = database.repositories.projectSettings.findByProjectId("project-master");
  const { service } = serviceWithGateway(
    database,
    structured,
    new ValidatedMasterCoreCommandGateway(database),
  );

  const response = await service.handle(request("Propose a macOS-only constraint."));

  assert.equal(response.commandResult.status, "PROPOSED");
  assert.equal(response.commandResult.details.persistenceRequired, true);
  assert.deepEqual(database.repositories.projectSettings.findByProjectId("project-master"), before);
  database.close();
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
