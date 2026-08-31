import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  RoadmapMutationError,
  RoadmapMutationService,
  applyRoadmapMutation,
  assertRoadmapMutationPolicy,
  classifyRoadmapMutation,
  parseMasterRoadmapMarkdown,
} from "@densa-ade/core";
import { DensaAdeDatabase } from "@densa-ade/core/persistence";
import { masterRoadmapSchema } from "@densa-ade/protocol";

const createdAt = "2026-08-27T01:00:00.000Z";
const changedAt = "2026-08-27T01:30:00.000Z";
const projectId = "project-roadmap-mutations";

function task(id, overrides = {}) {
  return {
    id,
    title: `Deliver ${id}`,
    goal: `Complete ${id}.`,
    executable: true,
    dependencyIds: [],
    acceptanceCriteria: [`${id} passes deterministic acceptance checks.`],
    riskLevel: "medium",
    expectedValidators: ["unit_test", "acceptance"],
    ...overrides,
  };
}

function roadmap() {
  return masterRoadmapSchema.parse({
    formatVersion: 1,
    projectGoal: "Build an inspectable local inventory application.",
    phases: [
      {
        id: "phase.foundation",
        title: "Foundation",
        goal: "Establish persistence.",
        required: true,
        completionCriteria: ["Storage passes integration checks."],
        tasks: [task("storage.schema")],
      },
      {
        id: "phase.product",
        title: "Product",
        goal: "Deliver inventory workflows.",
        required: true,
        completionCriteria: ["Inventory works end-to-end."],
        tasks: [
          task("inventory.crud", { dependencyIds: ["storage.schema"] }),
          task("product.e2e", {
            dependencyIds: ["inventory.crud"],
            expectedValidators: ["end_to_end", "acceptance"],
          }),
        ],
      },
    ],
  });
}

function specification() {
  return {
    formatVersion: 1,
    projectGoal: "Build an inspectable local inventory application.",
    targetUsers: ["Workshop operators"],
    coreUserJourneys: ["Manage local inventory"],
    requiredFeatures: ["Inspectable roadmap evolution"],
    nonGoals: [],
    architectureConstraints: ["Densa ADE Core is authoritative"],
    platformRuntimeConstraints: ["Node.js 22.13 or newer"],
    integrations: [],
    dataStorageNeeds: ["SQLite persistence"],
    securityPrivacyRequirements: ["Keep project state local"],
    uxConstraints: ["Expose mutation history"],
    deploymentIntent: ["Local macOS application"],
    explicitUserDecisions: [],
    unresolvedQuestions: [],
  };
}

function seedSpecification(database) {
  database.repositories.specifications.set({
    projectId,
    specification: specification(),
    createdAt,
    updatedAt: createdAt,
  });
}

function automatic(operation, classification) {
  return {
    operation,
    ...(classification === undefined ? {} : { classification }),
    rationale: "Keep the roadmap aligned with verified implementation needs.",
    actor: "master:test",
    sessionId: "session-roadmap-test",
    applicationMode: "automatic",
  };
}

function assertValid(impact) {
  assert.deepEqual(masterRoadmapSchema.parse(impact.roadmap), impact.roadmap);
  return impact.roadmap;
}

test("every supported roadmap operation produces a graph-valid accepted roadmap", () => {
  const addedTask = assertValid(
    applyRoadmapMutation(roadmap(), {
      kind: "add_task",
      phaseId: "phase.product",
      position: 1,
      task: task("inventory.search", { dependencyIds: ["inventory.crud"] }),
    }),
  );
  assert.equal(addedTask.phases[1].tasks[1].id, "inventory.search");

  const splitImpact = applyRoadmapMutation(roadmap(), {
    kind: "split_task",
    taskId: "storage.schema",
    replacementTasks: [task("storage.tables"), task("storage.migrations")],
  });
  const split = assertValid(splitImpact);
  assert.deepEqual(split.phases[1].tasks[0].dependencyIds, [
    "storage.tables",
    "storage.migrations",
  ]);
  assert.deepEqual(splitImpact.affectedPhaseIds, ["phase.foundation", "phase.product"]);

  const reordered = assertValid(
    applyRoadmapMutation(roadmap(), {
      kind: "reorder_task",
      taskId: "inventory.crud",
      phaseId: "phase.product",
      position: 1,
    }),
  );
  assert.equal(reordered.phases[1].tasks[1].id, "inventory.crud");

  const dependencyChanged = assertValid(
    applyRoadmapMutation(roadmap(), {
      kind: "change_dependency",
      taskId: "product.e2e",
      dependencyIds: ["storage.schema", "inventory.crud"],
    }),
  );
  assert.deepEqual(dependencyChanged.phases[1].tasks[1].dependencyIds, [
    "storage.schema",
    "inventory.crud",
  ]);

  const acceptanceChanged = assertValid(
    applyRoadmapMutation(roadmap(), {
      kind: "modify_acceptance_criteria",
      taskId: "inventory.crud",
      acceptanceCriteria: ["Create, update, and delete each pass integration checks."],
    }),
  );
  assert.match(acceptanceChanged.phases[1].tasks[0].acceptanceCriteria[0], /integration/u);

  const phaseAdded = assertValid(
    applyRoadmapMutation(roadmap(), {
      kind: "add_phase",
      position: 2,
      phase: {
        id: "phase.optional",
        title: "Optional polish",
        goal: "Document future polish.",
        required: false,
        completionCriteria: [],
        tasks: [],
      },
    }),
  );
  assert.equal(phaseAdded.phases.at(-1).id, "phase.optional");

  const phaseRemoved = assertValid(
    applyRoadmapMutation(phaseAdded, {
      kind: "remove_phase",
      phaseId: "phase.optional",
    }),
  );
  assert.equal(phaseRemoved.phases.length, 2);

  const architectureChanged = assertValid(
    applyRoadmapMutation(roadmap(), {
      kind: "change_architecture_task_details",
      taskId: "storage.schema",
      goal: "Use encrypted local persistence with explicit migrations.",
      riskLevel: "high",
      expectedValidators: ["integration_test", "security", "acceptance"],
    }),
  );
  assert.equal(architectureChanged.phases[0].tasks[0].riskLevel, "high");

  const superseded = assertValid(
    applyRoadmapMutation(roadmap(), {
      kind: "mark_task_superseded",
      taskId: "inventory.crud",
      supersededByTaskIds: ["storage.schema"],
    }),
  );
  assert.equal(superseded.phases[1].tasks[0].executable, false);
  assert.deepEqual(superseded.phases[1].tasks[0].supersededByTaskIds, ["storage.schema"]);
  assert.deepEqual(superseded.phases[1].tasks[1].dependencyIds, ["storage.schema"]);
});

test("invalid accepted mutations are rejected before state or history can change", () => {
  assert.throws(
    () =>
      applyRoadmapMutation(roadmap(), {
        kind: "change_dependency",
        taskId: "storage.schema",
        dependencyIds: ["product.e2e"],
      }),
    (error) =>
      error instanceof RoadmapMutationError &&
      error.code === "USER_CONFIGURATION_ERROR" &&
      /dependency cycle/u.test(error.message),
  );
  assert.throws(
    () =>
      applyRoadmapMutation(roadmap(), {
        kind: "remove_phase",
        phaseId: "phase.foundation",
      }),
    /missing task storage\.schema/u,
  );
});

test("classification floors and policy prevent unsafe automatic application", () => {
  const removePhase = { kind: "remove_phase", phaseId: "phase.optional" };
  assert.equal(classifyRoadmapMutation(removePhase), "scope");
  assert.throws(() => classifyRoadmapMutation(removePhase, "minor"), /at least SCOPE/u);
  assert.equal(
    classifyRoadmapMutation(
      { kind: "modify_acceptance_criteria", taskId: "inventory.crud", acceptanceCriteria: ["x"] },
      "scope",
    ),
    "scope",
  );

  const continuous = { executionMode: "continuous", allowSignificantAutoApply: true };
  assert.throws(
    () => assertRoadmapMutationPolicy("scope", automatic(removePhase, "scope"), continuous),
    /require explicit user approval in continuous mode/u,
  );
  assert.doesNotThrow(() =>
    assertRoadmapMutationPolicy(
      "significant",
      automatic({
        kind: "change_architecture_task_details",
        taskId: "storage.schema",
        goal: "Use a different architecture.",
      }),
      continuous,
    ),
  );
  assert.throws(
    () =>
      assertRoadmapMutationPolicy(
        "significant",
        automatic({
          kind: "change_architecture_task_details",
          taskId: "storage.schema",
          goal: "Use a different architecture.",
        }),
        { executionMode: "continuous", allowSignificantAutoApply: false },
      ),
    /user policy explicitly allows/u,
  );
});

test("removing an existing acceptance promise is a scope change requiring approval", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "densa-p4m3-criteria-"));
  const database = DensaAdeDatabase.openInMemory({ now: () => createdAt });
  try {
    database.repositories.projects.create({
      id: projectId,
      name: "Acceptance policy proof",
      state: "DRAFT",
      executionMode: "continuous",
      createdAt,
      updatedAt: createdAt,
    });
    seedSpecification(database);
    const service = new RoadmapMutationService(database, { workspacePath: workspace });
    await assert.rejects(
      service.storeInitialRoadmap(projectId, {
        ...roadmap(),
        projectGoal: "A weaker replacement goal.",
      }),
      /changed the exact project specification goal/u,
    );
    assert.equal(database.repositories.masterRoadmaps.findByProjectId(projectId), undefined);
    await service.storeInitialRoadmap(projectId, roadmap());
    await assert.rejects(
      service.apply(
        projectId,
        automatic({
          kind: "reorder_task",
          taskId: "inventory.crud",
          phaseId: "phase.product",
          position: 0,
        }),
      ),
      /did not change the authoritative roadmap/u,
    );
    await assert.rejects(
      service.apply(
        projectId,
        automatic({
          kind: "modify_acceptance_criteria",
          taskId: "inventory.crud",
          acceptanceCriteria: ["A weaker replacement criterion passes."],
        }),
      ),
      /SCOPE roadmap mutations require explicit user approval/u,
    );
    assert.equal(database.repositories.roadmapRevisions.listByProjectId(projectId).length, 0);
  } finally {
    database.close();
    await rm(workspace, { force: true, recursive: true });
  }
});

test("portable regeneration failure is explicit after the authoritative mutation commits", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "densa-p4m3-sync-failure-"));
  const database = DensaAdeDatabase.openInMemory({ now: () => createdAt });
  try {
    database.repositories.projects.create({
      id: projectId,
      name: "Portable failure proof",
      state: "DRAFT",
      executionMode: "phase",
      createdAt,
      updatedAt: createdAt,
    });
    seedSpecification(database);
    const service = new RoadmapMutationService(database, {
      workspacePath: workspace,
      now: () => changedAt,
    });
    await service.storeInitialRoadmap(projectId, roadmap());
    const portableRoadmap = join(workspace, ".densa-ade", "ROADMAP.md");
    const symlinkTarget = join(workspace, "human-roadmap.md");
    await writeFile(symlinkTarget, "# Human roadmap\n", "utf8");
    await unlink(portableRoadmap);
    await symlink(symlinkTarget, portableRoadmap);

    const result = await service.apply(
      projectId,
      automatic({
        kind: "add_task",
        phaseId: "phase.product",
        position: 2,
        task: task("inventory.audit", { dependencyIds: ["inventory.crud"] }),
      }),
    );

    assert.deepEqual(result.portableSync, {
      status: "failed",
      code: "WORKSPACE_CONFLICT",
      message: `Portable project file is not a safe regular file: ${portableRoadmap}`,
    });
    assert.equal(database.repositories.masterRoadmaps.findByProjectId(projectId).revisionNumber, 1);
    assert.equal(database.repositories.roadmapRevisions.listByProjectId(projectId).length, 1);
    assert.equal(await readFile(symlinkTarget, "utf8"), "# Human roadmap\n");
  } finally {
    database.close();
    await rm(workspace, { force: true, recursive: true });
  }
});

test("accepted mutations atomically persist history and event, then regenerate ROADMAP.md", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "densa-p4m3-"));
  const database = DensaAdeDatabase.openInMemory({ now: () => createdAt });
  let revisionNumber = 0;
  let eventNumber = 0;
  try {
    database.repositories.projects.create({
      id: projectId,
      name: "Roadmap mutation proof",
      state: "DRAFT",
      executionMode: "continuous",
      createdAt,
      updatedAt: createdAt,
    });
    seedSpecification(database);
    database.repositories.projectSettings.set({
      projectId,
      values: { allowSignificantRoadmapMutationAutoApply: true },
      updatedAt: createdAt,
    });
    const service = new RoadmapMutationService(database, {
      workspacePath: workspace,
      now: () => changedAt,
      revisionIdFactory: () => `revision-${++revisionNumber}`,
      eventIdFactory: () => `event-roadmap-${++eventNumber}`,
    });
    await service.storeInitialRoadmap(projectId, roadmap());

    const result = await service.apply(
      projectId,
      automatic({
        kind: "add_phase",
        position: 2,
        phase: {
          id: "phase.optional",
          title: "Optional polish",
          goal: "Keep optional work inspectable.",
          required: false,
          completionCriteria: [],
          tasks: [],
        },
      }),
    );

    assert.equal(result.classification, "significant");
    assert.equal(result.revisionNumber, 1);
    assert.equal(result.event.type, "ROADMAP_CHANGED");
    assert.equal(result.event.payload.sessionId, "session-roadmap-test");
    assert.equal(result.portableSync.status, "synchronized");
    const stored = database.repositories.masterRoadmaps.findByProjectId(projectId);
    assert.equal(stored.revisionNumber, 1);
    assert.equal(stored.roadmap.phases.at(-1).id, "phase.optional");
    const history = database.repositories.roadmapRevisions.listByProjectId(projectId);
    assert.equal(history.length, 1);
    assert.equal(history[0].sessionId, "session-roadmap-test");
    assert.equal(history[0].operation.kind, "add_phase");
    assert.deepEqual(history[0].oldValue, roadmap());
    assert.deepEqual(history[0].newValue, stored.roadmap);

    const roadmapMarkdown = await readFile(join(workspace, ".densa-ade", "ROADMAP.md"), "utf8");
    assert.match(roadmapMarkdown, /## Phase 3: Optional polish/u);
    assert.match(roadmapMarkdown, /## Roadmap revision history/u);
    assert.match(roadmapMarkdown, /Session: session-roadmap-test/u);
    assert.match(roadmapMarkdown, /Operation: `add_phase`/u);
    assert.deepEqual(parseMasterRoadmapMarkdown(roadmapMarkdown), stored.roadmap);

    const failingPersistenceService = new RoadmapMutationService(database, {
      workspacePath: workspace,
      now: () => changedAt,
      revisionIdFactory: () => "revision-rollback-proof",
      eventIdFactory: () => "event-roadmap-1",
    });
    await assert.rejects(
      failingPersistenceService.apply(
        projectId,
        automatic({
          kind: "add_task",
          phaseId: "phase.product",
          position: 2,
          task: task("inventory.rollback-proof", { dependencyIds: ["inventory.crud"] }),
        }),
      ),
      (error) =>
        error.code === "PERSISTENCE_FAILURE" &&
        /UNIQUE constraint failed: events\.id/u.test(error.cause?.message),
    );
    assert.equal(database.repositories.masterRoadmaps.findByProjectId(projectId).revisionNumber, 1);
    assert.equal(database.repositories.roadmapRevisions.listByProjectId(projectId).length, 1);
    assert.equal(
      database.repositories.masterRoadmaps
        .findByProjectId(projectId)
        .roadmap.phases[1].tasks.some((candidate) => candidate.id === "inventory.rollback-proof"),
      false,
    );

    await assert.rejects(
      service.apply(
        projectId,
        automatic({ kind: "remove_phase", phaseId: "phase.optional" }, "scope"),
      ),
      /require explicit user approval in continuous mode/u,
    );
    assert.equal(database.repositories.roadmapRevisions.listByProjectId(projectId).length, 1);
    assert.equal(database.eventJournal.replay({ projectId, types: ["ROADMAP_CHANGED"] }).length, 1);

    await assert.rejects(
      service.apply(projectId, {
        operation: { kind: "remove_phase", phaseId: "phase.optional" },
        classification: "scope",
        rationale: "Attempt removal without a durable approval decision.",
        actor: "master:test",
        sessionId: "session-roadmap-test",
        applicationMode: "approved",
        approval: {
          decisionId: "decision-missing",
          approvedBy: "user:test",
          approvedAt: changedAt,
          sessionId: "session-user-approval",
        },
      }),
      /approval decision decision-missing is not recorded/u,
    );
    assert.equal(database.repositories.roadmapRevisions.listByProjectId(projectId).length, 1);

    database.repositories.decisions.create({
      id: "decision-remove-optional-phase",
      projectId,
      kind: "decision",
      statement: "Remove the optional phase.",
      title: "Remove optional phase",
      rationale: "The user explicitly approved removal after reviewing the scope impact.",
      category: "approval.roadmap-scope-change",
      source: "user",
      scope: "phase",
      status: "active",
      affectedPhaseIds: ["phase.optional"],
      affectedTaskIds: [],
      createdAt: changedAt,
    });
    const approved = await service.apply(projectId, {
      operation: { kind: "remove_phase", phaseId: "phase.optional" },
      classification: "scope",
      rationale: "Remove the explicitly rejected optional phase.",
      actor: "master:test",
      sessionId: "session-roadmap-test",
      applicationMode: "approved",
      approval: {
        decisionId: "decision-remove-optional-phase",
        approvedBy: "user:test",
        approvedAt: changedAt,
        sessionId: "session-user-approval",
      },
    });
    assert.equal(approved.classification, "scope");
    assert.equal(approved.revisionNumber, 2);
    assert.equal(approved.roadmap.phases.length, 2);
    assert.equal(database.repositories.roadmapRevisions.listByProjectId(projectId).length, 2);
  } finally {
    database.close();
    await rm(workspace, { force: true, recursive: true });
  }
});
