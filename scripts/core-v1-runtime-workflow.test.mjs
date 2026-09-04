import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { CoreDaemon, CoreIpcClient } from "../packages/core/dist/index.js";
import { DensaAdeDatabase } from "../packages/core/dist/persistence/index.js";
import { CoreV1Client } from "../packages/protocol/dist/index.js";

const timestamp = "2026-09-03T00:00:00.000Z";
const execute = promisify(execFile);

class WorkflowAgentAdapter {
  adapterId = "workflow";
  requests = [];
  holdNextWorker = false;
  blockedRuns = new Map();

  async detect() {
    return { status: "available", adapterId: this.adapterId, command: "workflow", version: "1" };
  }

  async getStatus() {
    return { status: "available", version: "1" };
  }

  async getUsageState() {
    return { status: "available" };
  }

  async cancel(runId) {
    this.blockedRuns.get(runId)?.();
  }

  async *execute(request) {
    this.requests.push(request);
    yield { type: "run.started", runId: request.runId, occurredAt: timestamp };
    let finalMessage;
    if (request.prompt.includes("Master-role adaptive interview analyst")) {
      if (request.prompt.includes('"stage":"initial"')) {
        finalMessage = JSON.stringify({
          formatVersion: 1,
          additions: [],
          questions: [
            {
              id: "scope",
              question: "What exact outcome should the first task deliver?",
              category: "feature_scope",
              impact: "high",
              context: null,
              proposedDefault: null,
              defaultRationale: null,
              defaultCanBeUsedWithoutAnswer: null,
              batchKey: "scope",
            },
          ],
        });
      } else {
        const input = JSON.parse(request.prompt.slice(request.prompt.lastIndexOf("Input:\n") + 7));
        const answer = input.answers[0];
        finalMessage = JSON.stringify({
          formatVersion: 1,
          additions: [
            {
              field: "requiredFeatures",
              value: answer.answer,
              source: { kind: "answer", questionId: answer.questionId },
            },
          ],
          questions: [],
        });
      }
    } else if (request.prompt.includes("Master-role initial roadmap planner")) {
      const specification = JSON.parse(
        request.prompt.slice(request.prompt.lastIndexOf("ProjectSpecification:\n") + 22),
      );
      finalMessage = JSON.stringify({
        formatVersion: 1,
        projectGoal: specification.projectGoal,
        phases: [
          {
            id: "phase.delivery",
            title: "Deliver the requested workflow",
            goal: "Produce and validate the requested deterministic result",
            required: true,
            completionCriteria: ["The project test suite passes after the task commit"],
            tasks: [
              {
                id: "task.delivery",
                title: "Implement the deterministic result",
                goal: specification.requiredFeatures[0] ?? specification.projectGoal,
                executable: true,
                dependencyIds: [],
                supersededByTaskIds: [],
                acceptanceCriteria: [
                  "npm test exits successfully and src/result.js exports the expected value",
                ],
                riskLevel: "low",
                expectedValidators: ["unit_test", "independent_ai_review"],
              },
            ],
          },
        ],
      });
    } else if (request.prompt.includes("Plan the exact workspace-relative file scope")) {
      finalMessage = JSON.stringify({
        ownedPaths: ["src/result.js"],
        intendedPaths: ["src/result.js"],
      });
    } else if (request.accessMode === "workspace-write") {
      if (this.holdNextWorker) {
        this.holdNextWorker = false;
        await new Promise((resolve) => this.blockedRuns.set(request.runId, resolve));
        this.blockedRuns.delete(request.runId);
        yield {
          type: "run.terminal",
          runId: request.runId,
          occurredAt: timestamp,
          outcome: "cancelled",
        };
        return;
      }
      await mkdir(join(request.cwd, "src"), { recursive: true });
      await writeFile(join(request.cwd, "src/result.js"), 'export const result = "ready";\n');
      finalMessage = "Implemented; Core validation remains authoritative.";
    } else if (request.prompt.includes("Act only as an independent reviewer")) {
      const context = JSON.parse(request.prompt.slice(request.prompt.lastIndexOf("\n\n") + 2));
      finalMessage = JSON.stringify({
        verdict: "pass",
        summary: "Deterministic evidence and repository state satisfy the scoped criteria.",
        findings: [],
        criteria: context.acceptanceCriteria.map((criterion) => ({
          criterionPosition: criterion.criterionPosition,
          assessment: "satisfied",
          rationale: "The required deterministic command passed.",
        })),
        confidence: 1,
        unknowns: [],
      });
    } else if (request.prompt.includes("project-level Master Agent")) {
      const projectId = request.prompt.match(/"projectId":"([^"]+)"/)?.[1];
      finalMessage = JSON.stringify({
        formatVersion: 1,
        intent: "explain_project_status",
        response: "The project is at its current persisted lifecycle boundary.",
        citations: [{ kind: "project", id: projectId }],
        action: { kind: "respond" },
      });
    } else {
      throw new Error("Unexpected workflow adapter request");
    }
    yield {
      type: "run.terminal",
      runId: request.runId,
      occurredAt: timestamp,
      outcome: "succeeded",
      finalMessage,
    };
  }
}

async function initializeWorkspace(workspace) {
  await mkdir(join(workspace, "test"), { recursive: true });
  await writeFile(
    join(workspace, "package.json"),
    JSON.stringify({
      name: "runtime-workflow-fixture",
      private: true,
      type: "module",
      scripts: { test: "node --test" },
    }),
  );
  await writeFile(
    join(workspace, "test/result.test.js"),
    [
      'import assert from "node:assert/strict";',
      'import { test } from "node:test";',
      'import { result } from "../src/result.js";',
      'test("runtime worker result", () => assert.equal(result, "ready"));',
      "",
    ].join("\n"),
  );
  await execute("git", ["init", "--quiet", "--initial-branch=main"], { cwd: workspace });
  await execute("git", ["config", "user.name", "Workflow Test"], { cwd: workspace });
  await execute("git", ["config", "user.email", "workflow@localhost"], { cwd: workspace });
  await execute("git", ["add", "package.json", "test/result.test.js"], { cwd: workspace });
  await execute("git", ["commit", "--quiet", "-m", "fixture baseline"], { cwd: workspace });
}

async function commitPlanningProjection(workspace) {
  await execute("git", ["add", ".densa-ade"], { cwd: workspace });
  await execute("git", ["commit", "--quiet", "-m", "accept Densa ADE project plan"], {
    cwd: workspace,
  });
}

async function waitForSnapshot(client, projectId, predicate) {
  let latest;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const snapshot = await client.request("projects.get", { projectId });
    latest = snapshot;
    if (predicate(snapshot)) return snapshot;
    await delay(25);
  }
  const replay = await client.request("events.replay", { projectId, afterSequence: 0 });
  throw new Error(
    `Timed out waiting for the production lifecycle boundary: ${JSON.stringify({
      latest,
      events: replay.events.slice(-8),
    })}`,
  );
}

async function waitForWorker(adapter) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (adapter.blockedRuns.size > 0) return;
    await delay(25);
  }
  throw new Error("Timed out waiting for the held production worker");
}

async function withWorkflowDaemon(run) {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "densa-v1-workflow-"));
  const workspace = await mkdtemp(join(tmpdir(), "densa-v1-ws-"));
  await initializeWorkspace(workspace);
  const database = DensaAdeDatabase.openInMemory();
  const adapter = new WorkflowAgentAdapter();
  const daemon = await CoreDaemon.start({ runtimeDirectory, database, agentAdapter: adapter });
  const transport = new CoreIpcClient({ runtimeDirectory });
  let n = 0;
  const client = new CoreV1Client(transport, () => `workflow-${String(++n)}`);
  try {
    await run({ client, transport, database, daemon, runtimeDirectory, workspace, adapter });
  } finally {
    transport.disconnect();
    await daemon.stop();
    database.close();
    await rm(runtimeDirectory, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
}

test("production daemon runs the complete idea-to-start workflow without stubs", async () => {
  await withWorkflowDaemon(async ({ client, workspace }) => {
    const created = await client.request("projects.create", {
      name: "Workflow project",
      workspacePath: workspace,
      idea: "Build a tiny deterministic workflow tool with tests",
      executionMode: "phase",
      actor: "test",
    });
    assert.match(created.project.id, /^project-/u);
    assert.equal(created.project.state, "PLANNING");
    const retriedCreate = await client.request("projects.create", {
      name: "Workflow project",
      workspacePath: workspace,
      idea: "Build a tiny deterministic workflow tool with tests",
      executionMode: "phase",
      actor: "test",
    });
    assert.equal(retriedCreate.project.id, created.project.id);
    await assert.rejects(
      client.request("projects.create", {
        name: "Substituted project",
        workspacePath: workspace,
        idea: "Different project",
        executionMode: "phase",
        actor: "test",
      }),
      /workspace/i,
    );

    const answered = await client.request("projects.interview.answer", {
      projectId: created.project.id,
      sessionId: "session-1",
      answers: [{ questionId: "scope", answer: "Deterministic local workflow" }],
    });
    assert.equal(answered.readyForRoadmap, true);

    const roadmap = await client.request("roadmaps.generate", {
      projectId: created.project.id,
      sessionId: "session-1",
      actor: "test",
    });
    assert.equal(
      roadmap.roadmap.projectGoal,
      "Build a tiny deterministic workflow tool with tests",
    );
    assert.ok(roadmap.roadmap.phases.length >= 1);
    await commitPlanningProjection(workspace);

    const again = await client.request("roadmaps.generate", {
      projectId: created.project.id,
      sessionId: "session-1",
      actor: "test",
    });
    assert.equal(again.revisionNumber, roadmap.revisionNumber);

    const started = await client.request("projects.start", {
      projectId: created.project.id,
      workspacePath: workspace,
      actor: "test",
    });
    assert.equal(started.state, "RUNNING");
    assert.ok(typeof started.firstPhaseId === "string");

    const snapshot = await waitForSnapshot(
      client,
      created.project.id,
      (value) =>
        value.phases[0]?.state === "AWAITING_APPROVAL" && value.tasks[0]?.state === "COMPLETED",
    );
    assert.equal(snapshot.summary.project.id, created.project.id);
    assert.ok(snapshot.phases.length >= 1);
    assert.ok(snapshot.tasks.length >= 1);

    const dashboard = await client.request("dashboard.get", { projectId: created.project.id });
    assert.equal(dashboard.project.project.id, created.project.id);

    const master = await client.request("master.send", {
      projectId: created.project.id,
      workspacePath: workspace,
      sessionId: "session-1",
      message: "What is happening?",
    });
    assert.equal(master.proposal.intent, "explain_project_status");
    assert.ok(master.proposal.citations.some((c) => c.id === created.project.id));

    const approved = await client.request("phases.approve", {
      projectId: created.project.id,
      phaseId: snapshot.phases[0].id,
      decision: "approve",
      actor: "test",
      reason: "Production validation and review passed",
    });
    assert.equal(approved.outcome, "APPROVED");
    const completed = await waitForSnapshot(
      client,
      created.project.id,
      (value) => value.summary.project.state === "COMPLETED",
    );
    assert.equal(completed.summary.project.state, "COMPLETED");

    await assert.rejects(
      client.request("projects.start", {
        projectId: created.project.id,
        workspacePath: join(workspace, "elsewhere"),
        actor: "test",
      }),
      /workspace/i,
    );
  });
});

test("roadmap revisions require explicit approval and resolve truthfully", async () => {
  await withWorkflowDaemon(async ({ client, workspace }) => {
    const created = await client.request("projects.create", {
      name: "Revision project",
      workspacePath: workspace,
      idea: "Revision workflow must stay explicit",
      executionMode: "phase",
      actor: "test",
    });
    await client.request("projects.interview.answer", {
      projectId: created.project.id,
      sessionId: "s1",
      answers: [{ questionId: "scope", answer: "explicit" }],
    });
    const roadmap = await client.request("roadmaps.generate", {
      projectId: created.project.id,
      sessionId: "s1",
      actor: "test",
    });
    const taskId = roadmap.roadmap.phases[0].tasks[0].id;
    const proposed = await client.request("roadmaps.revisions.propose", {
      projectId: created.project.id,
      baseRevisionNumber: 0,
      operations: [
        { kind: "modify_acceptance_criteria", taskId, acceptanceCriteria: ["Revised criterion"] },
      ],
      rationale: "Tighten the acceptance wording",
      actor: "test",
      sessionId: "s1",
    });
    assert.equal(proposed.outcome, "AWAITING_USER_APPROVAL");
    const resolved = await client.request("roadmaps.revisions.resolve", {
      projectId: created.project.id,
      proposalEventId: proposed.proposal.proposalEventId,
      resolution: "approve",
      rationale: "The revision is correct",
      actor: "test",
      sessionId: "s1",
    });
    assert.equal(resolved.outcome, "APPLIED");

    const second = await client.request("roadmaps.revisions.propose", {
      projectId: created.project.id,
      baseRevisionNumber: 1,
      operations: [
        { kind: "modify_acceptance_criteria", taskId, acceptanceCriteria: ["Another criterion"] },
      ],
      rationale: "Second change",
      actor: "test",
      sessionId: "s1",
    });
    const rejected = await client.request("roadmaps.revisions.resolve", {
      projectId: created.project.id,
      proposalEventId: second.proposal.proposalEventId,
      resolution: "reject",
      rationale: "Not needed",
      actor: "test",
      sessionId: "s1",
    });
    assert.equal(rejected.outcome, "REJECTED");
  });
});

test("phase and guided task approvals move durable lifecycle state", async () => {
  await withWorkflowDaemon(async ({ client, workspace }) => {
    const created = await client.request("projects.create", {
      name: "Approval project",
      workspacePath: workspace,
      idea: "Approvals must move durable state",
      executionMode: "guided",
      actor: "test",
    });
    await client.request("projects.interview.answer", {
      projectId: created.project.id,
      sessionId: "s1",
      answers: [{ questionId: "scope", answer: "guided" }],
    });
    await client.request("roadmaps.generate", {
      projectId: created.project.id,
      sessionId: "s1",
      actor: "test",
    });
    await commitPlanningProjection(workspace);
    await client.request("projects.start", {
      projectId: created.project.id,
      workspacePath: workspace,
      actor: "test",
    });
    const snapshot = await waitForSnapshot(client, created.project.id, (value) =>
      value.pendingApprovals.some((approval) => approval.kind === "task"),
    );
    const phaseId = snapshot.phases[0].id;
    const taskId = snapshot.tasks[0].id;

    const approved = await client.request("tasks.approve", {
      projectId: created.project.id,
      phaseId,
      taskId,
      decision: "approve",
      actor: "test",
      reason: "The guided step looks correct",
    });
    assert.equal(approved.outcome, "APPROVED");
    const again = await client.request("tasks.approve", {
      projectId: created.project.id,
      phaseId,
      taskId,
      decision: "approve",
      actor: "test",
      reason: "repeat",
    });
    assert.equal(again.outcome, "UNCHANGED");

    const completed = await waitForSnapshot(
      client,
      created.project.id,
      (value) => value.summary.project.state === "COMPLETED",
    );
    assert.equal(completed.tasks[0].state, "COMPLETED");
  });
});

test("settings and permission resolutions persist through authoritative services", async () => {
  await withWorkflowDaemon(async ({ client, database, workspace }) => {
    const created = await client.request("projects.create", {
      name: "Settings project",
      workspacePath: workspace,
      idea: "Settings must persist",
      executionMode: "phase",
      actor: "test",
    });
    const updated = await client.request("settings.update", {
      projectId: created.project.id,
      actor: "test",
      reason: "Prefer continuous",
      executionMode: "continuous",
    });
    assert.equal(updated.executionMode, "continuous");

    const policy = await client.request("settings.update", {
      projectId: created.project.id,
      actor: "test",
      reason: "Tighten policy",
      permissionPolicy: {
        formatVersion: 1,
        preset: "cautious",
        overrides: [],
      },
    });
    assert.equal(policy.permissionPolicy.preset, "cautious");

    database.repositories.events.append({
      id: "permission-request-1",
      projectId: created.project.id,
      type: "RUNTIME_PERMISSION_REQUESTED",
      eventVersion: 1,
      occurredAt: timestamp,
      actor: "test",
      payload: { reason: "Allow this exact test operation", operation: "write_workspace" },
    });
    const resolved = await client.request("permissions.resolve", {
      projectId: created.project.id,
      decisionId: "permission-request-1",
      resolution: "approve",
      actor: "test",
      reason: "Allow this exact operation",
    });
    assert.equal(resolved.outcome, "APPROVED");
    const repeated = await client.request("permissions.resolve", {
      projectId: created.project.id,
      decisionId: "permission-request-1",
      resolution: "approve",
      actor: "test",
      reason: "repeat",
    });
    assert.equal(repeated.outcome, "UNCHANGED");
    const stale = await client.request("permissions.resolve", {
      projectId: created.project.id,
      decisionId: "permission-missing",
      resolution: "approve",
      actor: "test",
      reason: "missing",
    });
    assert.equal(stale.outcome, "STALE");
  });
});

test("cautious policy blocks production execution until exact write and Git approvals", async () => {
  await withWorkflowDaemon(async ({ client, workspace, adapter }) => {
    const created = await client.request("projects.create", {
      name: "Cautious workflow",
      workspacePath: workspace,
      idea: "Build a permission-gated deterministic workflow",
      executionMode: "phase",
      actor: "test",
    });
    await client.request("projects.interview.answer", {
      projectId: created.project.id,
      sessionId: "session-cautious",
      answers: [{ questionId: "scope", answer: "Deterministic local workflow" }],
    });
    await client.request("roadmaps.generate", {
      projectId: created.project.id,
      sessionId: "session-cautious",
      actor: "test",
    });
    await commitPlanningProjection(workspace);
    await client.request("settings.update", {
      projectId: created.project.id,
      actor: "test",
      reason: "Require explicit production mutation approval",
      permissionPolicy: {
        formatVersion: 1,
        preset: "cautious",
        overrides: [],
      },
    });

    const started = await client.request("projects.start", {
      projectId: created.project.id,
      workspacePath: workspace,
      actor: "test",
    });
    assert.equal(started.state, "WAITING_FOR_USER");
    assert.equal(
      adapter.requests.some((request) =>
        request.prompt.includes("Plan the exact workspace-relative file scope"),
      ),
      false,
    );

    let snapshot = await client.request("projects.get", { projectId: created.project.id });
    let permissions = snapshot.pendingApprovals.filter(
      (approval) => approval.kind === "permission",
    );
    assert.equal(permissions.length, 2);
    for (const permission of permissions) {
      const result = await client.request("permissions.resolve", {
        projectId: created.project.id,
        decisionId: permission.decisionId,
        resolution: "approve",
        actor: "test",
        reason: "Approve this exact production operation",
      });
      assert.equal(result.outcome, "APPROVED");
    }

    snapshot = await waitForSnapshot(
      client,
      created.project.id,
      (value) =>
        value.phases[0]?.state === "AWAITING_APPROVAL" && value.tasks[0]?.state === "COMPLETED",
    );
    permissions = snapshot.pendingApprovals.filter((approval) => approval.kind === "permission");
    assert.equal(permissions.length, 0);
    const taskPacketRequest = adapter.requests.find(
      (request) =>
        request.accessMode === "workspace-write" &&
        request.prompt.includes("## Permission envelope"),
    );
    assert.match(taskPacketRequest?.prompt ?? "", /Preset: cautious/u);
    assert.match(taskPacketRequest?.prompt ?? "", /Network: approval_required/u);
  });
});

test("file-backed daemon restart preserves the production workflow snapshot", async () => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "densa-v1-restart-"));
  const workspace = await mkdtemp(join(tmpdir(), "densa-v1-restart-ws-"));
  const databasePath = join(runtimeDirectory, "restart.sqlite");
  let projectId;
  try {
    await initializeWorkspace(workspace);
    {
      const database = DensaAdeDatabase.open(databasePath);
      const daemon = await CoreDaemon.start({
        runtimeDirectory,
        database,
        agentAdapter: new WorkflowAgentAdapter(),
      });
      const transport = new CoreIpcClient({ runtimeDirectory });
      let n = 0;
      const client = new CoreV1Client(transport, () => `restart-${String(++n)}`);
      try {
        const created = await client.request("projects.create", {
          name: "Restart project",
          workspacePath: workspace,
          idea: "Restart must preserve workflow",
          executionMode: "phase",
          actor: "test",
        });
        projectId = created.project.id;
        await client.request("projects.interview.answer", {
          projectId,
          sessionId: "s1",
          answers: [{ questionId: "scope", answer: "durable" }],
        });
        await client.request("roadmaps.generate", {
          projectId,
          sessionId: "s1",
          actor: "test",
        });
        await commitPlanningProjection(workspace);
        await client.request("projects.start", {
          projectId,
          workspacePath: workspace,
          actor: "test",
        });
        await waitForSnapshot(
          client,
          projectId,
          (value) => value.phases[0]?.state === "AWAITING_APPROVAL",
        );
      } finally {
        transport.disconnect();
        await daemon.stop();
        database.close();
      }
    }
    {
      const database = DensaAdeDatabase.open(databasePath);
      const daemon = await CoreDaemon.start({
        runtimeDirectory,
        database,
        agentAdapter: new WorkflowAgentAdapter(),
      });
      const transport = new CoreIpcClient({ runtimeDirectory });
      let n = 0;
      const client = new CoreV1Client(transport, () => `restart-after-${String(++n)}`);
      try {
        const snapshot = await client.request("projects.get", { projectId });
        assert.equal(snapshot.summary.project.id, projectId);
        assert.ok(snapshot.phases.length >= 1);
        assert.equal(snapshot.phases[0].state, "AWAITING_APPROVAL");
        assert.equal(snapshot.tasks[0].state, "COMPLETED");
        const replay = await client.request("events.replay", { projectId, afterSequence: 0 });
        assert.ok(replay.latestSequence >= 1);
        assert.ok(
          replay.events.some((e) => e.type === "PROJECT_CREATED" || e.type === "ROADMAP_GENERATED"),
        );
      } finally {
        transport.disconnect();
        await daemon.stop();
        database.close();
      }
    }
  } finally {
    await rm(runtimeDirectory, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("explicit restart resumes only a durably rolled-back interrupted worker", async () => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "densa-v1-interrupted-restart-"));
  const workspace = await mkdtemp(join(tmpdir(), "densa-v1-interrupted-restart-ws-"));
  const databasePath = join(runtimeDirectory, "restart.sqlite");
  let firstDaemon;
  let secondDaemon;
  let firstTransport;
  let secondTransport;
  try {
    await initializeWorkspace(workspace);
    const firstAdapter = new WorkflowAgentAdapter();
    firstAdapter.holdNextWorker = true;
    firstDaemon = await CoreDaemon.start({
      runtimeDirectory,
      databasePath,
      agentAdapter: firstAdapter,
    });
    firstTransport = new CoreIpcClient({ runtimeDirectory });
    let requestNumber = 0;
    const firstClient = new CoreV1Client(
      firstTransport,
      () => `interrupted-first-${String(++requestNumber)}`,
    );
    const created = await firstClient.request("projects.create", {
      name: "Interrupted restart",
      workspacePath: workspace,
      idea: "Restart an interrupted deterministic workflow safely",
      executionMode: "phase",
      actor: "test",
    });
    await firstClient.request("projects.interview.answer", {
      projectId: created.project.id,
      sessionId: "session-interrupted",
      answers: [{ questionId: "scope", answer: "durable retry" }],
    });
    await firstClient.request("roadmaps.generate", {
      projectId: created.project.id,
      sessionId: "session-interrupted",
      actor: "test",
    });
    await commitPlanningProjection(workspace);
    await firstClient.request("projects.start", {
      projectId: created.project.id,
      workspacePath: workspace,
      actor: "test",
    });
    await waitForWorker(firstAdapter);
    firstTransport.disconnect();
    firstTransport = undefined;
    await firstDaemon.stop();
    firstDaemon = undefined;

    const recoveryAdapter = new WorkflowAgentAdapter();
    secondDaemon = await CoreDaemon.start({
      runtimeDirectory,
      databasePath,
      agentAdapter: recoveryAdapter,
    });
    secondTransport = new CoreIpcClient({ runtimeDirectory });
    const secondClient = new CoreV1Client(
      secondTransport,
      () => `interrupted-second-${String(++requestNumber)}`,
    );
    const interrupted = await secondClient.request("projects.get", {
      projectId: created.project.id,
    });
    assert.equal(interrupted.summary.project.state, "BLOCKED");
    assert.equal(interrupted.tasks[0].state, "INTERRUPTED");
    const attempts = await secondClient.request("attempts.list", {
      projectId: created.project.id,
      taskId: interrupted.tasks[0].id,
      limit: 10,
    });
    assert.ok(attempts.attempts[0].completedAt);

    await commitPlanningProjection(workspace);
    const restarted = await secondClient.request("projects.start", {
      projectId: created.project.id,
      workspacePath: workspace,
      actor: "test",
    });
    assert.equal(restarted.state, "RUNNING");
    const recovered = await waitForSnapshot(
      secondClient,
      created.project.id,
      (value) =>
        value.phases[0]?.state === "AWAITING_APPROVAL" && value.tasks[0]?.state === "COMPLETED",
    );
    assert.equal(recovered.tasks[0].state, "COMPLETED");
    const recoveredAttempts = await secondClient.request("attempts.list", {
      projectId: created.project.id,
      taskId: recovered.tasks[0].id,
      limit: 10,
    });
    assert.equal(recoveredAttempts.attempts.length, 2);
  } finally {
    firstTransport?.disconnect();
    secondTransport?.disconnect();
    await firstDaemon?.stop();
    await secondDaemon?.stop();
    await rm(runtimeDirectory, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
