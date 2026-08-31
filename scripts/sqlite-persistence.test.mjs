import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { StateTransitionService } from "@densa-ade/core";
import { DensaAdeDatabase, DensaDatabase, PersistenceError } from "@densa-ade/core/persistence";

import { schemaMigrations } from "../packages/core/dist/persistence/migrations.js";

const createdAt = "2026-08-26T06:00:00.000Z";
const updatedAt = "2026-08-26T06:15:00.000Z";
const fixedMigrationTime = () => "2026-08-26T05:00:00.000Z";

function makeProject(id = "project-persistence") {
  return {
    id,
    name: "Persistence proof",
    state: "DRAFT",
    executionMode: "guided",
    createdAt,
    updatedAt: createdAt,
  };
}

function makePhase(projectId = "project-persistence", id = "phase-persistence") {
  return {
    id,
    projectId,
    title: "Persist state",
    state: "PENDING",
    position: 0,
    createdAt,
    updatedAt: createdAt,
  };
}

function makeTask({
  id = "task-persistence",
  projectId = "project-persistence",
  phaseId = "phase-persistence",
  position = 0,
  dependencyIds = [],
} = {}) {
  return {
    id,
    projectId,
    phaseId,
    title: `Persist ${id}`,
    state: "PENDING",
    position,
    acceptanceCriteria: ["The record round-trips", "Foreign keys remain valid"],
    dependencyIds,
    createdAt,
    updatedAt: createdAt,
  };
}

function makeSpecification() {
  return {
    formatVersion: 1,
    projectGoal: "Prove structured specifications persist exactly.",
    targetUsers: ["Local-first developers"],
    coreUserJourneys: ["Describe a project before roadmap generation"],
    requiredFeatures: ["Lossless SPEC.md export"],
    nonGoals: ["Cloud-only operation"],
    architectureConstraints: ["Keep Core editor-independent"],
    platformRuntimeConstraints: ["Node.js 22.13 or newer"],
    integrations: ["Git"],
    dataStorageNeeds: ["SQLite is authoritative"],
    securityPrivacyRequirements: ["Do not persist secrets"],
    uxConstraints: ["Surface unknown information honestly"],
    deploymentIntent: ["Local macOS application"],
    explicitUserDecisions: [{ topic: "Telemetry", decision: "Off by default" }],
    unresolvedQuestions: [
      {
        id: "deployment.signing",
        question: "How will release signing be managed?",
        category: "deployment",
        impact: "high",
      },
    ],
  };
}

function withDatabase(work) {
  const database = DensaAdeDatabase.openInMemory({ now: fixedMigrationTime });
  try {
    assert.equal(DensaDatabase, DensaAdeDatabase);
    assert.equal(database.repositories.densaRunBranches, database.repositories.densaAdeRunBranches);
    return work(database);
  } finally {
    database.close();
  }
}

function seedTaskGraph(repositories) {
  const project = makeProject();
  const phase = makePhase();
  const dependency = makeTask({ id: "task-dependency" });
  const task = makeTask({ id: "task-persistence", position: 1, dependencyIds: [dependency.id] });
  repositories.projects.create(project);
  repositories.phases.create(phase);
  repositories.tasks.create(dependency);
  repositories.tasks.create(task);
  return { project, phase, dependency, task };
}

test("a file database migrates from zero and reopening does not reapply migrations", () => {
  const directory = mkdtempSync(join(tmpdir(), "densa-p2m1-migration-"));
  const path = join(directory, "runtime.sqlite");
  try {
    const first = DensaAdeDatabase.open(path, { now: fixedMigrationTime });
    assert.equal(first.schemaVersion, 16);
    assert.equal(first.expectedSchemaVersion, 16);
    assert.deepEqual(first.listUserTables(), [
      "acceptance_criteria",
      "agent_runs",
      "attempt_rollback_plans",
      "attempts",
      "checkpoints",
      "decisions",
      "densa_run_branches",
      "events",
      "independent_reviews",
      "manual_acceptance_reviews",
      "master_roadmaps",
      "phase_reports",
      "phases",
      "project_settings",
      "projects",
      "roadmap_revision_proposals",
      "roadmap_revisions",
      "specifications",
      "task_commit_intents",
      "task_dependencies",
      "task_publication_intents",
      "tasks",
      "validation_results",
      "validation_runs",
    ]);
    first.close();

    const reopened = DensaAdeDatabase.open(path, { now: fixedMigrationTime });
    assert.equal(reopened.schemaVersion, 16);
    reopened.close();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("an applied migration checksum mismatch fails closed", () => {
  const directory = mkdtempSync(join(tmpdir(), "densa-p2m1-checksum-"));
  const path = join(directory, "runtime.sqlite");
  try {
    const first = DensaAdeDatabase.open(path, { now: fixedMigrationTime });
    first.close();
    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE _densa_migrations SET checksum = ? WHERE version = 1").run("0".repeat(64));
    raw.close();

    assert.throws(
      () => DensaAdeDatabase.open(path, { now: fixedMigrationTime }),
      (error) => error instanceof PersistenceError && error.code === "PERSISTENCE_FAILURE",
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("migration 15 preserves legacy run branches and phase-report paths", () => {
  const directory = mkdtempSync(join(tmpdir(), "densa-ade-namespace-migration-"));
  const path = join(directory, "runtime.sqlite");
  try {
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TABLE _densa_migrations (
        version INTEGER PRIMARY KEY CHECK (version > 0),
        name TEXT NOT NULL UNIQUE,
        checksum TEXT NOT NULL CHECK (length(checksum) = 64),
        applied_at TEXT NOT NULL CHECK (length(applied_at) >= 20)
      ) STRICT;
    `);
    for (const migration of schemaMigrations.slice(0, 14)) {
      raw.exec(migration.sql);
      raw
        .prepare(
          "INSERT INTO _densa_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
        )
        .run(
          migration.version,
          migration.name,
          createHash("sha256").update(migration.sql).digest("hex"),
          fixedMigrationTime(),
        );
    }
    raw.exec(`
      INSERT INTO projects (id, name, state, execution_mode, created_at, updated_at)
      VALUES ('project-legacy-namespace', 'Legacy namespace', 'RUNNING', 'phase',
              '${createdAt}', '${createdAt}');
      INSERT INTO phases (id, project_id, title, state, position, created_at, updated_at)
      VALUES ('phase-legacy-namespace', 'project-legacy-namespace', 'Legacy namespace',
              'RUNNING', 0, '${createdAt}', '${createdAt}');
      INSERT INTO densa_run_branches
        (project_id, workspace_path, branch_name, source_branch, starting_commit,
         status, created_at, activated_at)
      VALUES ('project-legacy-namespace', '/tmp/legacy-workspace',
              'densa/run/legacy-namespace', 'main', '0123456789abcdef',
              'ACTIVE', '${createdAt}', '${createdAt}');
      INSERT INTO phase_reports
        (phase_id, project_id, outcome, report_path, report_json, generated_at)
      VALUES ('phase-legacy-namespace', 'project-legacy-namespace', 'completed',
              '.densa/reports/phase-legacy.md', '{"formatVersion":1}', '${createdAt}');
    `);
    raw.close();

    const database = DensaAdeDatabase.open(path, { now: fixedMigrationTime });
    assert.equal(database.schemaVersion, 16);
    assert.equal(
      database.repositories.densaAdeRunBranches.findByProjectId("project-legacy-namespace")
        ?.branchName,
      "densa/run/legacy-namespace",
    );
    database.close();

    const migrated = new DatabaseSync(path);
    assert.equal(
      migrated.prepare("SELECT report_path FROM phase_reports").get().report_path,
      ".densa/reports/phase-legacy.md",
    );
    assert.deepEqual(migrated.prepare("PRAGMA foreign_key_check").all(), []);
    migrated.close();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("project, phase, and aggregate task repositories preserve protocol records", () => {
  withDatabase(({ repositories }) => {
    const { project, phase, dependency, task } = seedTaskGraph(repositories);

    assert.deepEqual(repositories.projects.findById(project.id), project);
    assert.deepEqual(repositories.phases.findById(phase.id), phase);
    assert.deepEqual(repositories.phases.listByProjectId(project.id), [phase]);
    assert.deepEqual(repositories.tasks.findById(dependency.id), dependency);
    assert.deepEqual(repositories.tasks.findById(task.id), task);
    assert.deepEqual(repositories.tasks.listByProjectId(project.id), [dependency, task]);
    assert.deepEqual(repositories.acceptanceCriteria.listForTask(task.id), [
      { taskId: task.id, position: 0, description: "The record round-trips" },
      { taskId: task.id, position: 1, description: "Foreign keys remain valid" },
    ]);
    assert.deepEqual(repositories.taskDependencies.listForTask(task.id), [
      { taskId: task.id, dependencyTaskId: dependency.id },
    ]);
  });
});

test("repository creation cannot bypass canonical initial states", () => {
  withDatabase(({ repositories }) => {
    assert.throws(
      () => repositories.projects.create({ ...makeProject(), state: "COMPLETED" }),
      (error) => error instanceof PersistenceError && error.code === "PERSISTENCE_FAILURE",
    );
    repositories.projects.create(makeProject());
    assert.throws(
      () => repositories.phases.create({ ...makePhase(), state: "COMPLETED" }),
      (error) => error instanceof PersistenceError && error.code === "PERSISTENCE_FAILURE",
    );
    repositories.phases.create(makePhase());
    assert.throws(
      () => repositories.tasks.create({ ...makeTask(), state: "COMPLETED" }),
      (error) => error instanceof PersistenceError && error.code === "PERSISTENCE_FAILURE",
    );
  });
});

test("all remaining P2M1 repositories round-trip their runtime records", () => {
  withDatabase(({ repositories }) => {
    const { project, phase, task } = seedTaskGraph(repositories);
    const specification = {
      projectId: project.id,
      specification: makeSpecification(),
      createdAt,
      updatedAt,
    };
    const attempt = {
      id: "attempt-1",
      taskId: task.id,
      number: 1,
      startedAt: createdAt,
    };
    const agentRun = {
      id: "agent-run-1",
      attemptId: attempt.id,
      adapterId: "fake",
      startedAt: createdAt,
      completedAt: updatedAt,
      adapterRunId: "fake-run-1",
      processId: 4242,
      processIdentity: "worker-identity-4242",
    };
    const validationRun = {
      id: "validation-run-1",
      taskId: task.id,
      attemptId: attempt.id,
      validatorId: "node-test",
      startedAt: createdAt,
      completedAt: updatedAt,
      passed: false,
    };
    const decision = {
      id: "decision-1",
      projectId: project.id,
      kind: "decision",
      statement: "Use SQLite for authoritative runtime state.",
      title: "Use SQLite",
      rationale: "Runtime state needs transactions and foreign keys.",
      category: "architecture.persistence",
      source: "system",
      scope: "project",
      status: "active",
      affectedPhaseIds: [phase.id],
      affectedTaskIds: [task.id],
      createdAt,
    };
    const revision = {
      id: "revision-1",
      projectId: project.id,
      classification: "minor",
      reason: "Split a task for validation",
      actor: "densa-core:test",
      createdAt,
      affectedPhaseIds: ["phase-persistence"],
      affectedTaskIds: [task.id],
      oldValue: { title: "Old" },
      newValue: { title: "New", positions: [0, 1] },
    };
    const checkpoint = {
      id: "checkpoint-1",
      projectId: project.id,
      createdAt,
      description: "Clean Git worktree",
      gitHead: "0123456789abcdef",
      gitStatus: "",
      workspaceFingerprint: "workspace-fingerprint-1",
    };
    const event = {
      id: "event-manual-1",
      projectId: project.id,
      type: "PROJECT_CREATED",
      eventVersion: 1,
      occurredAt: createdAt,
      actor: "densa-core:test",
      payload: { executionMode: "guided" },
    };
    const settings = {
      projectId: project.id,
      values: { executionMode: "guided", keepAwake: false },
      updatedAt,
    };

    repositories.specifications.set(specification);
    repositories.attempts.create(attempt);
    repositories.agentRuns.create(agentRun);
    repositories.validationRuns.create(validationRun);
    repositories.decisions.create(decision);
    repositories.roadmapRevisions.create(revision);
    repositories.checkpoints.create(checkpoint);
    repositories.events.append(event);
    repositories.projectSettings.set(settings);

    assert.deepEqual(repositories.specifications.findByProjectId(project.id), specification);
    assert.deepEqual(repositories.attempts.findById(attempt.id), {
      ...attempt,
      agentRunId: agentRun.id,
    });
    assert.deepEqual(repositories.attempts.listByTaskId(task.id), [
      { ...attempt, agentRunId: agentRun.id },
    ]);
    assert.deepEqual(repositories.agentRuns.findById(agentRun.id), agentRun);
    assert.deepEqual(repositories.agentRuns.findByAttemptId(attempt.id), agentRun);
    assert.deepEqual(repositories.validationRuns.findById(validationRun.id), {
      ...validationRun,
      manualReviewCriteria: [],
    });
    assert.deepEqual(repositories.validationRuns.listByTaskId(task.id), [
      { ...validationRun, manualReviewCriteria: [] },
    ]);
    assert.deepEqual(repositories.decisions.findById(decision.id), decision);
    assert.deepEqual(repositories.decisions.listByProjectId(project.id), [decision]);
    assert.deepEqual(repositories.roadmapRevisions.findById(revision.id), revision);
    assert.deepEqual(repositories.roadmapRevisions.listByProjectId(project.id), [revision]);
    assert.deepEqual(repositories.checkpoints.findById(checkpoint.id), checkpoint);
    assert.deepEqual(repositories.checkpoints.listByProjectId(project.id), [checkpoint]);
    assert.deepEqual(repositories.events.findById(event.id), { ...event, sequenceNumber: 1 });
    assert.deepEqual(repositories.projectSettings.findByProjectId(project.id), settings);
  });
});

test("migrations 3 through 16 preserve version-2 runtime rows and convert legacy specifications", () => {
  const directory = mkdtempSync(join(tmpdir(), "densa-p2m4-migration-"));
  const path = join(directory, "runtime.sqlite");
  try {
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TABLE _densa_migrations (
        version INTEGER PRIMARY KEY CHECK (version > 0),
        name TEXT NOT NULL UNIQUE,
        checksum TEXT NOT NULL CHECK (length(checksum) = 64),
        applied_at TEXT NOT NULL CHECK (length(applied_at) >= 20)
      ) STRICT;
    `);
    for (const migration of schemaMigrations.slice(0, 2)) {
      raw.exec(migration.sql);
      raw
        .prepare(
          "INSERT INTO _densa_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
        )
        .run(
          migration.version,
          migration.name,
          createHash("sha256").update(migration.sql).digest("hex"),
          fixedMigrationTime(),
        );
    }
    raw
      .prepare(
        `INSERT INTO projects (id, name, state, execution_mode, created_at, updated_at)
         VALUES ('project-v2', 'Version 2', 'DRAFT', 'guided', ?, ?)`,
      )
      .run(createdAt, createdAt);
    raw
      .prepare(
        `INSERT INTO projects (id, name, state, execution_mode, created_at, updated_at)
         VALUES ('project-empty-spec', 'Empty legacy spec', 'DRAFT', 'guided', ?, ?)`,
      )
      .run(createdAt, createdAt);
    raw
      .prepare(
        `INSERT INTO phases (id, project_id, title, state, position, created_at, updated_at)
         VALUES ('phase-v2', 'project-v2', 'Version 2', 'PENDING', 0, ?, ?)`,
      )
      .run(createdAt, createdAt);
    raw
      .prepare(
        `INSERT INTO tasks
         (id, project_id, phase_id, title, state, position, created_at, updated_at)
         VALUES ('task-v2', 'project-v2', 'phase-v2', 'Version 2', 'PENDING', 0, ?, ?)`,
      )
      .run(createdAt, createdAt);
    raw
      .prepare(
        `INSERT INTO attempts (id, task_id, number, started_at)
         VALUES ('attempt-v2', 'task-v2', 1, ?)`,
      )
      .run(createdAt);
    raw
      .prepare(
        `INSERT INTO agent_runs (id, attempt_id, adapter_id, started_at)
         VALUES ('agent-run-v2', 'attempt-v2', 'fake', ?)`,
      )
      .run(createdAt);
    raw
      .prepare(
        `INSERT INTO checkpoints (id, project_id, created_at, description)
         VALUES ('checkpoint-v2', 'project-v2', ?, 'pre-recovery metadata')`,
      )
      .run(createdAt);
    raw
      .prepare(
        `INSERT INTO decisions (id, project_id, title, rationale, created_at)
         VALUES ('decision-v2', 'project-v2', 'Keep legacy choice', 'Preserve audit history', ?)`,
      )
      .run(createdAt);
    raw
      .prepare(
        `INSERT INTO specifications (project_id, content, created_at, updated_at)
         VALUES ('project-v2', ?, ?, ?)`,
      )
      .run("# Legacy specification\n\nPreserve this exact text.", createdAt, updatedAt);
    raw
      .prepare(
        `INSERT INTO specifications (project_id, content, created_at, updated_at)
         VALUES ('project-empty-spec', '   ', ?, ?)`,
      )
      .run(createdAt, updatedAt);
    raw.close();

    const database = DensaAdeDatabase.open(path, { now: fixedMigrationTime });
    assert.equal(database.schemaVersion, 16);
    assert.deepEqual(database.repositories.agentRuns.findById("agent-run-v2"), {
      id: "agent-run-v2",
      attemptId: "attempt-v2",
      adapterId: "fake",
      startedAt: createdAt,
    });
    assert.deepEqual(database.repositories.checkpoints.findById("checkpoint-v2"), {
      id: "checkpoint-v2",
      projectId: "project-v2",
      createdAt,
      description: "pre-recovery metadata",
    });
    assert.equal(database.repositories.attempts.findById("attempt-v2").commitSha, undefined);
    assert.deepEqual(database.repositories.decisions.findById("decision-v2"), {
      id: "decision-v2",
      projectId: "project-v2",
      kind: "decision",
      statement: "Keep legacy choice",
      title: "Keep legacy choice",
      rationale: "Preserve audit history",
      category: "legacy",
      source: "system",
      scope: "project",
      status: "active",
      affectedPhaseIds: [],
      affectedTaskIds: [],
      createdAt,
    });
    assert.deepEqual(database.repositories.specifications.findByProjectId("project-v2"), {
      projectId: "project-v2",
      specification: {
        ...makeSpecification(),
        projectGoal: "# Legacy specification\n\nPreserve this exact text.",
        targetUsers: [],
        coreUserJourneys: [],
        requiredFeatures: [],
        nonGoals: [],
        architectureConstraints: [],
        platformRuntimeConstraints: [],
        integrations: [],
        dataStorageNeeds: [],
        securityPrivacyRequirements: [],
        uxConstraints: [],
        deploymentIntent: [],
        explicitUserDecisions: [],
        unresolvedQuestions: [],
      },
      createdAt,
      updatedAt,
    });
    assert.equal(
      database.repositories.specifications.findByProjectId("project-empty-spec").specification
        .projectGoal,
      "No project goal was recorded in the legacy specification.",
    );
    database.close();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("failed multi-record work rolls back every repository write", () => {
  withDatabase((database) => {
    const project = makeProject("project-rollback");
    assert.throws(
      () =>
        database.transaction((repositories) => {
          repositories.projects.create(project);
          repositories.phases.create(makePhase(project.id, "phase-rollback"));
          repositories.tasks.create(
            makeTask({
              id: "task-rollback",
              projectId: project.id,
              phaseId: "phase-rollback",
            }),
          );
          throw new Error("injected transaction failure");
        }),
      /injected transaction failure/u,
    );

    assert.equal(database.repositories.projects.findById(project.id), undefined);
    assert.equal(database.repositories.phases.findById("phase-rollback"), undefined);
    assert.equal(database.repositories.tasks.findById("task-rollback"), undefined);
  });
});

test("foreign keys reject cross-project and cross-task relationships", () => {
  withDatabase(({ repositories }) => {
    const first = seedTaskGraph(repositories);
    const secondProject = makeProject("project-foreign-key");
    const secondPhase = makePhase(secondProject.id, "phase-foreign-key");
    const secondTask = makeTask({
      id: "task-foreign-key",
      projectId: secondProject.id,
      phaseId: secondPhase.id,
    });
    repositories.projects.create(secondProject);
    repositories.phases.create(secondPhase);
    repositories.tasks.create(secondTask);
    repositories.attempts.create({
      id: "attempt-foreign-key",
      taskId: first.task.id,
      number: 1,
      startedAt: createdAt,
    });

    assert.throws(() =>
      repositories.validationRuns.create({
        id: "validation-cross-task",
        taskId: secondTask.id,
        attemptId: "attempt-foreign-key",
        validatorId: "node-test",
        startedAt: createdAt,
      }),
    );
    assert.throws(() =>
      repositories.tasks.create(
        makeTask({
          id: "task-cross-project-dependency",
          projectId: secondProject.id,
          phaseId: secondPhase.id,
          position: 1,
          dependencyIds: [first.task.id],
        }),
      ),
    );
    assert.equal(repositories.tasks.findById("task-cross-project-dependency"), undefined);
  });
});

test("state changes and audit events commit atomically for every entity type", () => {
  withDatabase((database) => {
    const { project, phase, task } = seedTaskGraph(database.repositories);
    const service = new StateTransitionService();
    const context = { actor: "densa-core:test", occurredAt: updatedAt, reason: "ready for work" };

    const projectTransition = service.transitionProject(project, "PLANNING", context);
    const phaseTransition = service.transitionPhase(phase, "READY", context);
    const taskTransition = service.transitionTask(task, "READY", context);

    database.persistStateTransition(projectTransition, "event-project-transition");
    database.persistStateTransition(phaseTransition, "event-phase-transition");
    database.persistStateTransition(taskTransition, "event-task-transition");

    assert.equal(database.repositories.projects.findById(project.id).state, "PLANNING");
    assert.equal(database.repositories.phases.findById(phase.id).state, "READY");
    assert.equal(database.repositories.tasks.findById(task.id).state, "READY");
    assert.deepEqual(
      database.repositories.events.findById("event-task-transition").payload,
      taskTransition.event.payload,
    );
  });
});

test("an event insert failure rolls back its preceding state update", () => {
  withDatabase((database) => {
    const project = makeProject("project-atomic-rollback");
    database.repositories.projects.create(project);
    database.repositories.events.append({
      id: "event-duplicate",
      projectId: project.id,
      type: "PROJECT_CREATED",
      eventVersion: 1,
      occurredAt: createdAt,
      actor: "densa-core:test",
      payload: {},
    });

    const transition = new StateTransitionService().transitionProject(project, "PLANNING", {
      actor: "densa-core:test",
      occurredAt: updatedAt,
    });
    assert.throws(() => database.persistStateTransition(transition, "event-duplicate"));
    assert.deepEqual(database.repositories.projects.findById(project.id), project);
  });
});

test("attempt completion and its task transition roll back together on an audit failure", () => {
  withDatabase((database) => {
    const { project, task } = seedTaskGraph(database.repositories);
    const transitions = new StateTransitionService();
    database.persistStateTransition(
      transitions.transitionTask(task, "READY", {
        actor: "densa-core:test",
        occurredAt: "2026-08-26T06:10:00.000Z",
      }),
      "event-attempt-task-ready",
    );
    const readyTask = database.repositories.tasks.findById(task.id);
    const attempt = database.repositories.attempts.create({
      id: "attempt-atomic-completion",
      taskId: task.id,
      number: 1,
      startedAt: "2026-08-26T06:11:00.000Z",
    });
    database.repositories.events.append({
      id: "event-attempt-completion-duplicate",
      projectId: project.id,
      phaseId: task.phaseId,
      taskId: task.id,
      type: "FIXTURE_EVENT",
      eventVersion: 1,
      occurredAt: "2026-08-26T06:12:00.000Z",
      actor: "densa-core:test",
      payload: {},
    });
    const completedAt = "2026-08-26T06:13:00.000Z";

    assert.throws(() =>
      database.persistAttemptCompletion({
        attemptId: attempt.id,
        completedAt,
        outcome: "blocked",
        eventId: "event-attempt-completion-duplicate",
        actor: "densa-core:test",
        transition: transitions.transitionTask(readyTask, "BLOCKED", {
          actor: "densa-core:test",
          occurredAt: completedAt,
        }),
      }),
    );
    assert.equal(database.repositories.attempts.findById(attempt.id).completedAt, undefined);
    assert.equal(database.repositories.tasks.findById(task.id).state, "READY");
  });
});

test("stale transition snapshots fail closed without appending an event", () => {
  withDatabase((database) => {
    const project = makeProject("project-stale-transition");
    database.repositories.projects.create(project);
    const service = new StateTransitionService();
    database.persistStateTransition(
      service.transitionProject(project, "PLANNING", {
        actor: "densa-core:test",
        occurredAt: updatedAt,
      }),
      "event-first-transition",
    );

    assert.throws(
      () =>
        database.persistStateTransition(
          service.transitionProject(project, "PLANNING", {
            actor: "densa-core:test",
            occurredAt: "2026-08-26T06:30:00.000Z",
          }),
          "event-stale-transition",
        ),
      (error) => error instanceof PersistenceError && error.code === "PERSISTENCE_FAILURE",
    );
    assert.equal(database.repositories.events.findById("event-stale-transition"), undefined);
  });
});

for (const kind of ["project", "phase", "task"]) {
  test(`persistence revalidates ${kind} transitions and binds the event to the entity`, () => {
    withDatabase((database) => {
      const graph = seedTaskGraph(database.repositories);
      const service = new StateTransitionService();
      const entity = graph[kind];
      const method = `transition${kind[0].toUpperCase()}${kind.slice(1)}`;
      const valid = service[method](entity, kind === "project" ? "PLANNING" : "READY", {
        actor: "test",
        occurredAt: updatedAt,
      });
      const forged = {
        ...valid,
        state: "COMPLETED",
        entity: { ...valid.entity, state: "COMPLETED" },
        event: { ...valid.event, payload: { ...valid.event.payload, state: "COMPLETED" } },
      };
      assert.throws(() => database.persistStateTransition(forged, `forged-${kind}`));
      const other = makeProject("other-project");
      database.repositories.projects.create(other);
      assert.throws(() =>
        database.persistStateTransition(
          {
            ...valid,
            event: {
              projectId: other.id,
              type: valid.event.type,
              eventVersion: 1,
              occurredAt: valid.event.occurredAt,
              actor: valid.event.actor,
              payload: valid.event.payload,
            },
          },
          `misattributed-${kind}`,
        ),
      );
      assert.equal(database.eventJournal.findById(`forged-${kind}`), undefined);
      assert.equal(database.repositories[`${kind}s`].findById(entity.id).state, entity.state);
    });
  });
}

test("a lifecycle cycle cannot make an old transition snapshot current again", () => {
  withDatabase((database) => {
    const { task } = seedTaskGraph(database.repositories);
    const service = new StateTransitionService();
    const stale = service.transitionTask(task, "READY", { actor: "test", occurredAt: updatedAt });
    for (const [index, state] of ["BLOCKED", "PENDING"].entries()) {
      database.persistStateTransition(
        service.transitionTask(database.repositories.tasks.findById(task.id), state, {
          actor: "test",
          occurredAt: `2026-08-26T06:${20 + index}:00.000Z`,
        }),
        `cycle-${index}`,
      );
    }
    assert.throws(() => database.persistStateTransition(stale, "stale-cycle"), PersistenceError);
    assert.equal(database.eventJournal.findById("stale-cycle"), undefined);
  });
});

test("database open and repository constraint failures use the stable persistence error code", () => {
  const directory = mkdtempSync(join(tmpdir(), "densa-persistence-errors-"));
  try {
    assert.throws(
      () => DensaAdeDatabase.open(join(directory, "missing", "runtime.sqlite")),
      (error) => error.code === "PERSISTENCE_FAILURE",
    );
    withDatabase((database) => {
      database.repositories.projects.create(makeProject());
      assert.throws(
        () => database.repositories.projects.create(makeProject()),
        (error) => error.code === "PERSISTENCE_FAILURE",
      );
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("migration 16 preserves legacy ownership without granting isolated rollback authority", () => {
  const directory = mkdtempSync(join(tmpdir(), "densa-isolation-migration-"));
  const databasePath = join(directory, "runtime.sqlite");
  try {
    const raw = new DatabaseSync(databasePath);
    raw.exec(
      "CREATE TABLE _densa_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT",
    );
    for (const migration of schemaMigrations.slice(0, 15)) {
      raw.exec(migration.sql);
      raw
        .prepare("INSERT INTO _densa_migrations VALUES (?, ?, ?, ?)")
        .run(
          migration.version,
          migration.name,
          createHash("sha256").update(migration.sql).digest("hex"),
          createdAt,
        );
    }
    raw
      .prepare(
        "INSERT INTO projects (id,name,state,execution_mode,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      )
      .run("legacy-project", "Legacy", "DRAFT", "guided", createdAt, createdAt);
    raw
      .prepare(
        "INSERT INTO densa_run_branches (project_id,workspace_path,branch_name,source_branch,starting_commit,status,created_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        "legacy-project",
        "/legacy/source",
        "densa-ade/run/legacy",
        "main",
        "a".repeat(40),
        "CREATING",
        createdAt,
      );
    raw.close();
    const database = DensaAdeDatabase.open(databasePath);
    assert.equal(database.schemaVersion, 16);
    const legacy = database.repositories.densaAdeRunBranches.findByProjectId("legacy-project");
    assert.equal(legacy.workspacePath, "/legacy/source");
    assert.equal(legacy.sourceWorkspacePath, undefined);
    assert.equal(legacy.status, "CREATING");
    database.close();
    const migrated = new DatabaseSync(databasePath);
    migrated.exec("PRAGMA foreign_keys=ON");
    assert.throws(
      () =>
        migrated
          .prepare("UPDATE densa_run_branches SET source_workspace_path = workspace_path")
          .run(),
      /CHECK constraint/,
    );
    assert.throws(
      () =>
        migrated
          .prepare("INSERT INTO task_publication_intents VALUES (?,?,?,?,?,?,?)")
          .run("missing", "/source", "main", "a".repeat(40), "b".repeat(40), createdAt, null),
      /FOREIGN KEY/,
    );
    assert.deepEqual(migrated.prepare("PRAGMA foreign_key_check").all(), []);
    migrated.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
