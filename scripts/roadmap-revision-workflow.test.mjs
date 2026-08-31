import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  MasterRoadmapRevisionWorkflow,
  RoadmapMutationError,
  RoadmapMutationService,
  StateTransitionService,
  DependencyScheduler,
} from "@densa-ade/core";
import { DensaAdeDatabase } from "@densa-ade/core/persistence";

const projectId = "project-roadmap-workflow";
const createdAt = "2026-08-30T01:00:00.000Z";

function task(id, overrides = {}) {
  return {
    id,
    title: `Deliver ${id}`,
    goal: `Complete ${id}.`,
    executable: true,
    dependencyIds: [],
    acceptanceCriteria: [`${id} passes deterministic checks.`],
    riskLevel: "medium",
    expectedValidators: ["unit_test", "acceptance"],
    ...overrides,
  };
}

function roadmap() {
  return {
    formatVersion: 1,
    projectGoal: "Build a local product with inspectable roadmap steering.",
    phases: [
      {
        id: "foundation",
        title: "Foundation",
        goal: "Establish local foundations.",
        required: true,
        completionCriteria: ["Foundation checks pass."],
        tasks: [task("storage")],
      },
      {
        id: "product",
        title: "Product",
        goal: "Deliver product workflows.",
        required: true,
        completionCriteria: ["Product checks pass."],
        tasks: [
          task("search", { dependencyIds: ["storage"] }),
          task("qa", { dependencyIds: ["search"] }),
        ],
      },
      {
        id: "deployment",
        title: "Deployment",
        goal: "Package the product for deployment.",
        required: false,
        completionCriteria: [],
        tasks: [],
      },
    ],
  };
}

function specification() {
  return {
    formatVersion: 1,
    projectGoal: roadmap().projectGoal,
    targetUsers: ["Local teams"],
    coreUserJourneys: ["Steer delivery"],
    requiredFeatures: ["Inspectable roadmap revisions"],
    nonGoals: [],
    architectureConstraints: ["Core remains authoritative"],
    platformRuntimeConstraints: ["Node.js 22.13 or newer"],
    integrations: [],
    dataStorageNeeds: ["SQLite"],
    securityPrivacyRequirements: ["Local-first"],
    uxConstraints: ["Show before and after"],
    deploymentIntent: ["Local packaging"],
    explicitUserDecisions: [],
    unresolvedQuestions: [],
  };
}

function seed(database, { runningTaskId } = {}) {
  database.repositories.projects.create({
    id: projectId,
    name: "Roadmap workflow proof",
    state: "DRAFT",
    executionMode: "continuous",
    createdAt,
    updatedAt: createdAt,
  });
  database.repositories.specifications.set({
    projectId,
    specification: specification(),
    createdAt,
    updatedAt: createdAt,
  });
  for (const [phasePosition, phase] of roadmap().phases.entries()) {
    database.repositories.phases.create({
      id: phase.id,
      projectId,
      title: phase.title,
      state: "PENDING",
      position: phasePosition,
      createdAt,
      updatedAt: createdAt,
    });
    for (const [position, candidate] of phase.tasks.entries()) {
      database.repositories.tasks.create({
        id: candidate.id,
        projectId,
        phaseId: phase.id,
        title: candidate.title,
        state: "PENDING",
        position,
        acceptanceCriteria: candidate.acceptanceCriteria,
        dependencyIds: candidate.dependencyIds,
        createdAt,
        updatedAt: createdAt,
      });
    }
  }
  database.persistInitialMasterRoadmap({
    projectId,
    roadmap: roadmap(),
    revisionNumber: 0,
    createdAt,
    updatedAt: createdAt,
  });
  if (runningTaskId !== undefined) {
    const transitions = new StateTransitionService();
    let tick = 0;
    for (const state of ["READY", "RUNNING"]) {
      const current = database.repositories.tasks.findById(runningTaskId);
      const occurredAt = new Date(Date.parse(createdAt) + ++tick * 1_000).toISOString();
      database.persistStateTransition(
        transitions.transitionTask(current, state, {
          actor: "fixture",
          occurredAt,
          reason: "Establish active task fixture",
        }),
        `event-${runningTaskId}-${state.toLowerCase()}`,
      );
    }
  }
}

function workflow(database, workspace, overrides = {}) {
  let eventNumber = 0;
  let revisionNumber = 0;
  let proposalNumber = 0;
  let tick = 20;
  return new MasterRoadmapRevisionWorkflow(database, {
    workspacePath: workspace,
    now: () => new Date(Date.parse(createdAt) + ++tick * 1_000).toISOString(),
    proposalIdFactory: () => `proposal-${String(++proposalNumber)}`,
    eventIdFactory: () => `event-proposal-${String(++eventNumber)}`,
    revisionIdFactory: () => `revision-${String(++revisionNumber)}`,
    mutationEventIdFactory: () => `event-roadmap-${String(++eventNumber)}`,
    ...overrides,
  });
}

test("minor multi-operation steering applies as one revision with inspectable before and after", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "densa-p8m2-minor-"));
  const database = DensaAdeDatabase.openInMemory();
  try {
    seed(database);
    const result = await workflow(database, workspace).propose(projectId, {
      operations: [
        {
          kind: "add_task",
          phaseId: "product",
          position: 1,
          task: task("mobile", { dependencyIds: ["search"] }),
        },
        {
          kind: "change_dependency",
          taskId: "qa",
          dependencyIds: ["mobile"],
        },
      ],
      rationale: "Add mobile support before QA.",
      actor: "densa-master:session-1",
      sessionId: "session-1",
    });

    assert.equal(result.status, "APPLIED");
    assert.equal(result.proposal.status, "applied");
    assert.equal(result.proposal.classification, "minor");
    assert.equal(result.proposal.rationale, "Add mobile support before QA.");
    assert.equal(result.proposal.beforeValue.phases[1].tasks.length, 2);
    assert.equal(result.proposal.afterValue.phases[1].tasks[1].id, "mobile");
    assert.equal(result.mutation.revisionNumber, 1);
    const revisions = database.repositories.roadmapRevisions.listByProjectId(projectId);
    assert.equal(revisions.length, 1);
    assert.deepEqual(
      revisions[0].operations.map(({ kind }) => kind),
      ["add_task", "change_dependency"],
    );
    const portable = await readFile(join(workspace, ".densa-ade", "ROADMAP.md"), "utf8");
    assert.match(portable, /mobile/u);
    const runtime = database.repositories.tasks.findById("mobile");
    assert.ok(runtime, "accepted roadmap additions must be materialized");
    assert.equal(runtime.state, "PENDING");
    assert.deepEqual(database.repositories.tasks.findById("qa").dependencyIds, ["mobile"]);
    const selection = new DependencyScheduler(database.repositories).selectNext({
      projectId,
      gates: { outstandingUserDecisionIds: [], permissionBlockers: [] },
    });
    assert.equal(
      selection.reasons.some(({ code }) => code === "PERSISTED_ROADMAP_INCONSISTENT"),
      false,
    );
  } finally {
    database.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("scope replacement waits for explicit approval and applies the exact inspected snapshot", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "densa-p8m2-scope-"));
  const database = DensaAdeDatabase.openInMemory();
  try {
    seed(database);
    const service = workflow(database, workspace);
    const proposed = await service.propose(projectId, {
      operations: [
        {
          kind: "add_phase",
          position: 2,
          phase: {
            id: "local-packaging",
            title: "Local-only packaging",
            goal: "Package without remote deployment.",
            required: true,
            completionCriteria: ["Local package launches successfully."],
            tasks: [task("package-local", { dependencyIds: ["qa"] })],
          },
        },
        { kind: "remove_phase", phaseId: "deployment" },
      ],
      rationale: "Replace deployment with local-only packaging.",
      actor: "densa-master:session-2",
      sessionId: "session-2",
    });

    assert.equal(proposed.status, "AWAITING_USER_APPROVAL");
    assert.equal(proposed.proposal.classification, "scope");
    assert.equal(proposed.proposal.approvalRequired, true);
    assert.equal(database.repositories.masterRoadmaps.findByProjectId(projectId).revisionNumber, 0);
    database.repositories.decisions.create({
      id: "decision-user-approval",
      projectId,
      kind: "decision",
      statement: "Approve local-only packaging revision.",
      title: "Approve roadmap revision",
      rationale: "The user explicitly approved the inspected before and after.",
      category: `roadmap.revision.approval.${proposed.proposal.id}`,
      source: "user",
      scope: "project",
      status: "active",
      affectedPhaseIds: [],
      affectedTaskIds: [],
      createdAt: "2026-08-30T01:01:00.000Z",
    });

    const approval = {
      decisionId: "decision-user-approval",
      approvedBy: "user",
      approvedAt: "2026-08-30T01:01:00.000Z",
      sessionId: "session-2",
    };
    const mutations = new RoadmapMutationService(database, { workspacePath: workspace });
    const substitutedOperations = [
      {
        kind: "modify_acceptance_criteria",
        taskId: "search",
        acceptanceCriteria: ["A different, unapproved replacement"],
      },
    ];
    const substituted = mutations.preview(projectId, substitutedOperations);
    await assert.rejects(
      mutations.applyBatch(
        projectId,
        {
          operations: substitutedOperations,
          classification: "scope",
          rationale: proposed.proposal.rationale,
          actor: proposed.proposal.actor,
          sessionId: proposed.proposal.sessionId,
          applicationMode: "approved",
          approval,
          proposalEventId: proposed.proposal.proposalEventId,
        },
        {
          proposal: {
            ...proposed.proposal,
            operations: substitutedOperations,
            afterValue: substituted.roadmap,
          },
          expectedStatus: proposed.proposal.status,
        },
      ),
      /does not match the inspected base/u,
    );
    assert.equal(database.repositories.masterRoadmaps.findByProjectId(projectId).revisionNumber, 0);

    const applied = await service.applyProposal({
      proposalEventId: proposed.proposal.proposalEventId,
      approval: {
        decisionId: "decision-user-approval",
        approvedBy: "user",
        approvedAt: "2026-08-30T01:01:00.000Z",
        sessionId: "session-2",
      },
    });

    assert.equal(applied.status, "APPLIED");
    assert.equal(applied.proposal.approvalDecisionId, "decision-user-approval");
    assert.equal(applied.proposal.afterValue.phases[2].id, "local-packaging");
    assert.equal(
      database.repositories.masterRoadmaps.findByProjectId(projectId).roadmap.phases[2].id,
      "local-packaging",
    );
    const change = database.eventJournal
      .replay({ projectId, limit: 50 })
      .find((event) => event.type === "ROADMAP_CHANGED");
    assert.equal(change.payload.proposalEventId, proposed.proposal.proposalEventId);
  } finally {
    database.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("cyclic proposals fail before proposal or authoritative state is persisted", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "densa-p8m2-cycle-"));
  const database = DensaAdeDatabase.openInMemory();
  try {
    seed(database);
    await assert.rejects(
      workflow(database, workspace).propose(projectId, {
        operations: [{ kind: "change_dependency", taskId: "storage", dependencyIds: ["qa"] }],
        rationale: "Introduce an invalid cycle.",
        actor: "densa-master:session-3",
        sessionId: "session-3",
      }),
      (error) => error instanceof RoadmapMutationError && /dependency cycle/u.test(error.message),
    );
    assert.equal(
      database.repositories.roadmapRevisionProposals.listByProjectId(projectId).length,
      0,
    );
    assert.equal(database.repositories.masterRoadmaps.findByProjectId(projectId).revisionNumber, 0);
  } finally {
    database.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("an affected running task defers a minor change until its safe boundary", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "densa-p8m2-boundary-"));
  const database = DensaAdeDatabase.openInMemory();
  try {
    seed(database, { runningTaskId: "search" });
    const service = workflow(database, workspace);
    const proposed = await service.propose(projectId, {
      operations: [{ kind: "reorder_task", taskId: "search", phaseId: "product", position: 1 }],
      rationale: "Move search later without changing its live worker context.",
      actor: "densa-master:session-4",
      sessionId: "session-4",
    });

    assert.equal(proposed.status, "WAITING_FOR_SAFE_BOUNDARY");
    assert.deepEqual(proposed.proposal.activeTaskIds, ["search"]);
    assert.equal(database.repositories.masterRoadmaps.findByProjectId(projectId).revisionNumber, 0);

    const current = database.repositories.tasks.findById("search");
    const transition = new StateTransitionService().transitionTask(current, "INTERRUPTED", {
      actor: "fixture",
      occurredAt: "2026-08-30T01:02:00.000Z",
      reason: "Worker reached the controlled safe boundary",
    });
    database.persistStateTransition(transition, "event-search-interrupted");

    const applied = await service.applyProposal({
      proposalEventId: proposed.proposal.proposalEventId,
    });
    assert.equal(applied.status, "APPLIED");
    assert.deepEqual(applied.proposal.activeTaskIds, []);
    assert.equal(
      database.repositories.masterRoadmaps.findByProjectId(projectId).roadmap.phases[1].tasks[1].id,
      "search",
    );
    assert.equal(database.repositories.tasks.findById("search").position, 1);
  } finally {
    database.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("an intervening authoritative revision makes an inspected proposal stale instead of rebasing it", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "densa-p8m2-stale-"));
  const database = DensaAdeDatabase.openInMemory();
  try {
    seed(database);
    const service = workflow(database, workspace);
    const proposed = await service.propose(projectId, {
      operations: [{ kind: "remove_phase", phaseId: "deployment" }],
      rationale: "Remove remote deployment.",
      actor: "densa-master:session-5",
      sessionId: "session-5",
    });
    assert.equal(proposed.status, "AWAITING_USER_APPROVAL");

    await new RoadmapMutationService(database, {
      workspacePath: workspace,
      now: () => "2026-08-30T01:03:00.000Z",
      revisionIdFactory: () => "revision-intervening",
      eventIdFactory: () => "event-roadmap-intervening",
    }).apply(projectId, {
      operation: { kind: "reorder_task", taskId: "search", phaseId: "product", position: 1 },
      rationale: "Move search after QA planning.",
      actor: "densa-core:test",
      sessionId: "session-intervening",
      applicationMode: "automatic",
    });

    const stale = await service.applyProposal({
      proposalEventId: proposed.proposal.proposalEventId,
    });
    assert.equal(stale.status, "STALE");
    assert.equal(stale.proposal.status, "stale");
    assert.equal(stale.proposal.resolvedAt !== undefined, true);
    assert.equal(
      database.repositories.masterRoadmaps
        .findByProjectId(projectId)
        .roadmap.phases.some(({ id }) => id === "deployment"),
      true,
    );
  } finally {
    database.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
