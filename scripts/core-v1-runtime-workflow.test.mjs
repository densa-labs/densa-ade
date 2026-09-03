import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CoreDaemon, CoreIpcClient } from "../packages/core/dist/index.js";
import { DensaAdeDatabase } from "../packages/core/dist/persistence/index.js";
import { CoreV1Client } from "../packages/protocol/dist/index.js";

const timestamp = "2026-09-03T00:00:00.000Z";

async function withWorkflowDaemon(run) {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "densa-v1-workflow-"));
  const workspace = await mkdtemp(join(tmpdir(), "densa-v1-ws-"));
  const database = DensaAdeDatabase.openInMemory();
  const daemon = await CoreDaemon.start({ runtimeDirectory, database });
  const transport = new CoreIpcClient({ runtimeDirectory });
  let n = 0;
  const client = new CoreV1Client(transport, () => `workflow-${String(++n)}`);
  try {
    await run({ client, transport, database, daemon, runtimeDirectory, workspace });
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

    const restarted = await client.request("projects.start", {
      projectId: created.project.id,
      workspacePath: workspace,
      actor: "test",
    });
    assert.equal(restarted.state, "RUNNING");

    const snapshot = await client.request("projects.get", { projectId: created.project.id });
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
      answers: [{ questionId: "q", answer: "explicit" }],
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
  await withWorkflowDaemon(async ({ client, database, workspace }) => {
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
      answers: [{ questionId: "q", answer: "guided" }],
    });
    await client.request("roadmaps.generate", {
      projectId: created.project.id,
      sessionId: "s1",
      actor: "test",
    });
    await client.request("projects.start", {
      projectId: created.project.id,
      workspacePath: workspace,
      actor: "test",
    });
    const snapshot = await client.request("projects.get", { projectId: created.project.id });
    const phaseId = snapshot.phases[0].id;
    const taskId = snapshot.tasks[0].id;

    // Guided task approval without a prior REQUIRED event is recorded explicitly.
    database.repositories.events.append({
      id: "guided-required-1",
      projectId: created.project.id,
      phaseId,
      taskId,
      type: "GUIDED_TASK_APPROVAL_REQUIRED",
      eventVersion: 1,
      occurredAt: timestamp,
      actor: "test",
      payload: { taskId },
    });
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

    // Move the phase to AWAITING_APPROVAL through the centralized transition service.
    const { stateTransitionService } = await import("../packages/core/dist/index.js");
    const phase = database.repositories.phases.findById(phaseId);
    assert.ok(phase !== undefined);
    for (const next of ["READY", "RUNNING", "VALIDATING", "AWAITING_APPROVAL"]) {
      const current = database.repositories.phases.findById(phaseId);
      if (current.state === next) continue;
      database.persistStateTransition(
        stateTransitionService.transitionPhase(current, next, {
          actor: "test",
          occurredAt: timestamp,
          reason: "workflow test advances phase",
        }),
        `phase-advance-${next}`,
      );
    }
    const phaseApproved = await client.request("phases.approve", {
      projectId: created.project.id,
      phaseId,
      decision: "approve",
      actor: "test",
      reason: "Validation passed",
    });
    assert.equal(phaseApproved.outcome, "APPROVED");
    assert.equal(phaseApproved.phase.state, "COMPLETED");
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

test("file-backed daemon restart preserves the production workflow snapshot", async () => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "densa-v1-restart-"));
  const workspace = await mkdtemp(join(tmpdir(), "densa-v1-restart-ws-"));
  const databasePath = join(runtimeDirectory, "restart.sqlite");
  let projectId;
  try {
    {
      const database = DensaAdeDatabase.open(databasePath);
      const daemon = await CoreDaemon.start({ runtimeDirectory, database });
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
          answers: [{ questionId: "q", answer: "durable" }],
        });
        await client.request("roadmaps.generate", {
          projectId,
          sessionId: "s1",
          actor: "test",
        });
        await client.request("projects.start", {
          projectId,
          workspacePath: workspace,
          actor: "test",
        });
      } finally {
        transport.disconnect();
        await daemon.stop();
        database.close();
      }
    }
    {
      const database = DensaAdeDatabase.open(databasePath);
      const daemon = await CoreDaemon.start({ runtimeDirectory, database });
      const transport = new CoreIpcClient({ runtimeDirectory });
      let n = 0;
      const client = new CoreV1Client(transport, () => `restart-after-${String(++n)}`);
      try {
        const snapshot = await client.request("projects.get", { projectId });
        assert.equal(snapshot.summary.project.id, projectId);
        assert.ok(snapshot.phases.length >= 1);
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
