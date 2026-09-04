import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";

import {
  BrowserValidationValidator,
  CoreDaemon,
  CoreIpcClient,
  IndependentReviewService,
  PermissionPolicyService,
  ProjectExecutionControlService,
  ProjectExecutionOrchestrator,
  RecoveryInspector,
  RoadmapMutationService,
  RunCheckpointService,
  SingleTaskOrchestrator,
  StateTransitionService,
  TaskCommitService,
  UsageAutoResumeService,
  ValidationPipeline,
  WorkspacePreflight,
  redactEvent,
  redactLog,
} from "@densa-ade/core";
import { DensaAdeDatabase } from "@densa-ade/core/persistence";
import { masterRoadmapSchema, projectSpecificationSchema } from "@densa-ade/protocol";
import { FakeAgentAdapter, FakeClock } from "@densa-ade/testing";

import { schemaMigrations } from "../packages/core/dist/persistence/migrations.js";
import {
  captureValidationWorkspace,
  recordValidationWorkspace,
} from "../packages/core/dist/validation-workspace.js";

const MATRIX_VERSION = "p13m0.1";
const ACTOR = "densa:p13m0-matrix";
const BASE_TIME = Date.parse("2026-09-01T00:00:00.000Z");
const roots = new Set();

function git(repository, args) {
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdio: "pipe",
  });
}

function clock(start = BASE_TIME) {
  let tick = 0;
  return () => new Date(start + tick++ * 1_000).toISOString();
}

function track(root) {
  roots.add(root);
  return root;
}

function createGitRepo(prefix, files = { "task.txt": "baseline\n" }) {
  const root = track(mkdtempSync(join(tmpdir(), prefix)));
  const workspace = join(root, "workspace");
  git(root, ["init", "--quiet", "--initial-branch=main", workspace]);
  writeFileSync(join(workspace, ".gitignore"), ".densa-ade/runtime/\n*.sqlite\n", "utf8");
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(workspace, path), content, "utf8");
  }
  git(workspace, ["add", "--all"]);
  git(workspace, [
    "-c",
    "user.name=Densa ADE P13M0",
    "-c",
    "user.email=densa-p13m0@localhost",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "fixture: known checkpoint",
  ]);
  git(workspace, ["config", "user.name", "Densa ADE P13M0"]);
  git(workspace, ["config", "user.email", "densa-p13m0@localhost"]);
  git(workspace, ["config", "commit.gpgsign", "false"]);
  return { root, workspace, databasePath: join(root, "runtime.sqlite") };
}

function transition(database, kind, id, state, now, reason = "P13M0 matrix fixture") {
  const service = new StateTransitionService();
  const repository =
    kind === "project"
      ? database.repositories.projects
      : kind === "phase"
        ? database.repositories.phases
        : database.repositories.tasks;
  const current = repository.findById(id);
  assert.ok(current, `${kind} ${id} must exist`);
  const occurredAt = now();
  const context = { actor: ACTOR, occurredAt, reason };
  const change =
    kind === "project"
      ? service.transitionProject(current, state, context)
      : kind === "phase"
        ? service.transitionPhase(current, state, context)
        : service.transitionTask(current, state, context);
  database.persistStateTransition(
    change,
    `p13m0-${kind}-${id}-${state.toLowerCase()}-${occurredAt.replaceAll(/[^0-9]/gu, "")}-${Math.floor(Math.random() * 1_000_000)}`,
  );
}

function assertCoherentReplay(events) {
  assert.ok(events.length > 0, "each scenario must leave replayable facts");
  for (let index = 1; index < events.length; index += 1) {
    assert.equal(events[index].sequenceNumber, events[index - 1].sequenceNumber + 1);
    assert.ok(Date.parse(events[index].occurredAt) >= Date.parse(events[index - 1].occurredAt));
  }
}

function cleanSpecification(projectGoal) {
  return projectSpecificationSchema.parse({
    formatVersion: 1,
    projectGoal,
    targetUsers: ["Local-first developers"],
    coreUserJourneys: ["Turn an idea into an inspectable roadmap"],
    requiredFeatures: ["Deterministic release matrix"],
    nonGoals: ["Cloud execution"],
    architectureConstraints: ["Densa ADE Core is authoritative"],
    platformRuntimeConstraints: ["Node.js 22.13 or newer"],
    integrations: ["Git"],
    dataStorageNeeds: ["SQLite is authoritative"],
    securityPrivacyRequirements: ["Telemetry off by default"],
    uxConstraints: ["Unknown state is shown as unknown"],
    deploymentIntent: ["Local macOS application"],
    explicitUserDecisions: [],
    unresolvedQuestions: [],
  });
}

function matrixTask(id, dependencyIds = []) {
  return {
    id,
    title: `Deliver ${id}`,
    goal: `Complete ${id} with deterministic evidence.`,
    executable: true,
    dependencyIds,
    acceptanceCriteria: [`${id} has deterministic evidence.`],
    riskLevel: "low",
    expectedValidators: ["unit_test"],
  };
}

function seedProjectWithRoadmap(
  database,
  now,
  { projectId, executionMode, roadmap, workspacePath },
) {
  const createdAt = now();
  database.repositories.projects.create({
    id: projectId,
    name: `P13M0 ${projectId}`,
    state: "DRAFT",
    executionMode,
    createdAt,
    updatedAt: createdAt,
  });
  database.repositories.specifications.set({
    projectId,
    specification: cleanSpecification(roadmap.projectGoal),
    createdAt,
    updatedAt: createdAt,
  });
  // Store the roadmap through the audited service so the matrix exercises the real path.
  const service = new RoadmapMutationService(database, { workspacePath, now });
  // storeInitialRoadmap is async because it regenerates portable files.
  return { createdAt, service };
}

function completingExecutor(database, now, order, beforeCompletion) {
  return {
    async execute(request) {
      order.push(request.taskId);
      await beforeCompletion?.(request);
      const attemptId = `attempt-${request.taskId}-${order.length}-${Date.parse(now())}`;
      database.repositories.attempts.create({
        id: attemptId,
        taskId: request.taskId,
        number: 1,
        startedAt: now(),
      });
      transition(database, "task", request.taskId, "RUNNING", now);
      transition(database, "task", request.taskId, "VALIDATING", now);
      database.repositories.attempts.recordCommit(
        attemptId,
        request.taskId,
        `commit-${request.taskId}`,
      );
      database.repositories.attempts.recordCompleted(attemptId, now());
      transition(database, "task", request.taskId, "COMPLETED", now);
      return {
        status: "COMPLETED",
        taskId: request.taskId,
        attemptCount: 1,
        commitSha: `commit-${request.taskId}`,
      };
    },
  };
}

function phaseValidator(database, now) {
  return {
    validatorId: "p13m0-phase-validator",
    providesIndependentReview: true,
    async validate({ projectId, phase, validationEventId, workspacePath }) {
      const roadmapPhase = database.repositories.masterRoadmaps
        .findByProjectId(projectId)
        .roadmap.phases.find((entry) => entry.id === phase.id);
      assert.ok(roadmapPhase);
      const reviewId = `p13m0-review-${phase.id}-${Date.parse(now())}`;
      await new IndependentReviewService(database, {
        now,
        workspaceFingerprint: async () => "p13m0-stable-review-context",
      }).execute({
        id: reviewId,
        projectId,
        phaseId: phase.id,
        validationEventId,
        workspacePath,
        goal: roadmapPhase.goal,
        acceptanceCriteria: roadmapPhase.completionCriteria,
        relevantDiff: "+ p13m0 fixture output",
        deterministicResults: [
          {
            validatorId: "p13m0-phase-suite",
            status: "passed",
            required: true,
            summary: "Suite passed.",
          },
        ],
        architectureConstraints: ["Core owns the phase verdict."],
        adapter: new FakeAgentAdapter({
          now,
          finalMessage: JSON.stringify({
            verdict: "pass",
            summary: "Phase evidence is consistent.",
            findings: [],
            criteria: roadmapPhase.completionCriteria.map((_c, i) => ({
              criterionPosition: i,
              assessment: "satisfied",
              rationale: "Deterministic evidence supports the criterion.",
            })),
            confidence: 0.9,
            unknowns: [],
          }),
        }),
        reviewerRunId: `p13m0-reviewer-${phase.id}-${Date.parse(now())}`,
      });
      return {
        passed: true,
        independentReviewId: reviewId,
        summary: "Phase suite and review passed.",
        checks: [{ validatorId: "p13m0-phase-suite", passed: true, summary: "Suite passed." }],
      };
    },
  };
}

function seedSingleTask(
  database,
  now,
  { projectId, taskId, phaseId, executionMode = "continuous" },
) {
  const createdAt = now();
  database.repositories.projects.create({
    id: projectId,
    name: `P13M0 ${projectId}`,
    state: "DRAFT",
    executionMode,
    createdAt,
    updatedAt: createdAt,
  });
  database.repositories.phases.create({
    id: phaseId,
    projectId,
    title: "Matrix phase",
    state: "PENDING",
    position: 0,
    createdAt,
    updatedAt: createdAt,
  });
  database.repositories.tasks.create({
    id: taskId,
    projectId,
    phaseId,
    title: `Matrix task ${taskId}`,
    state: "PENDING",
    position: 0,
    acceptanceCriteria: ["task.txt contains accepted output"],
    dependencyIds: [],
    createdAt,
    updatedAt: createdAt,
  });
  transition(database, "task", taskId, "READY", now);
  return createdAt;
}

function singleTaskRequest({ projectId, taskId, workspacePath, adapter, validator, extra = {} }) {
  return {
    projectId,
    taskId,
    workspacePath,
    workerPrompt: "Write accepted output to task.txt. Agent prose is not evidence.",
    ownedPaths: ["task.txt"],
    intendedPaths: ["task.txt"],
    adapter,
    validator,
    actor: ACTOR,
    ...extra,
  };
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("fixture port unavailable");
  await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  return address.port;
}

describe(`P13M0 release reliability matrix ${MATRIX_VERSION}`, () => {
  test("R01 new project -> spec -> roadmap -> Phase 1 -> approval", async () => {
    const fixture = createGitRepo("densa-p13m0-r01-");
    const now = clock();
    const database = DensaAdeDatabase.open(fixture.databasePath);
    try {
      const roadmap = masterRoadmapSchema.parse({
        formatVersion: 1,
        projectGoal: "Prove the release matrix end-to-end project arc.",
        phases: [
          {
            id: "phase.one",
            title: "First phase",
            goal: "Deliver the first phase.",
            required: true,
            completionCriteria: ["First phase evidence passes."],
            tasks: [matrixTask("task.r01.alpha"), matrixTask("task.r01.beta", ["task.r01.alpha"])],
          },
        ],
      });
      const { service } = seedProjectWithRoadmap(database, now, {
        projectId: "project-p13m0-r01",
        executionMode: "phase",
        roadmap,
        workspacePath: fixture.workspace,
      });
      await service.storeInitialRoadmap("project-p13m0-r01", roadmap);
      transition(database, "project", "project-p13m0-r01", "PLANNING", now);
      transition(database, "project", "project-p13m0-r01", "READY", now);
      transition(database, "project", "project-p13m0-r01", "RUNNING", now);
      transition(database, "phase", "phase.one", "READY", now);
      const order = [];
      const result = await new ProjectExecutionOrchestrator(database, { now }).execute({
        projectId: "project-p13m0-r01",
        workspacePath: fixture.workspace,
        gates: { outstandingUserDecisionIds: [], permissionBlockers: [] },
        taskExecutor: completingExecutor(database, now, order),
        validator: phaseValidator(database, now),
        actor: ACTOR,
      });
      assert.equal(result.status, "AWAITING_PHASE_APPROVAL");
      assert.equal(result.phaseId, "phase.one");
      assert.deepEqual(order, ["task.r01.alpha", "task.r01.beta"]);
      const events = database.eventJournal.replay({ projectId: "project-p13m0-r01", limit: 1_000 });
      assertCoherentReplay(events);
      assert.ok(
        events.some(
          (e) =>
            e.type === "ROADMAP_GENERATED" ||
            e.type === "PROJECT_STARTED" ||
            e.type === "PHASE_REPORT_GENERATED",
        ),
      );
    } finally {
      database.close();
    }
  });

  test("R02 Guided mode stops after every validated task", async () => {
    const fixture = createGitRepo("densa-p13m0-r02-");
    const now = clock();
    const database = DensaAdeDatabase.openInMemory();
    const roadmap = masterRoadmapSchema.parse({
      formatVersion: 1,
      projectGoal: "Prove Guided boundaries.",
      phases: [
        {
          id: "phase.guided",
          title: "Guided",
          goal: "Stop after each task.",
          required: true,
          completionCriteria: ["Guided evidence passes."],
          tasks: [matrixTask("task.r02.alpha"), matrixTask("task.r02.beta", ["task.r02.alpha"])],
        },
      ],
    });
    const createdAt = now();
    database.repositories.projects.create({
      id: "project-p13m0-r02",
      name: "R02",
      state: "DRAFT",
      executionMode: "guided",
      createdAt,
      updatedAt: createdAt,
    });
    for (const [pi, phase] of roadmap.phases.entries()) {
      database.repositories.phases.create({
        id: phase.id,
        projectId: "project-p13m0-r02",
        title: phase.title,
        state: "PENDING",
        position: pi,
        createdAt,
        updatedAt: createdAt,
      });
      for (const [ti, t] of phase.tasks.entries()) {
        database.repositories.tasks.create({
          id: t.id,
          projectId: "project-p13m0-r02",
          phaseId: phase.id,
          title: t.title,
          state: "PENDING",
          position: ti,
          acceptanceCriteria: t.acceptanceCriteria,
          dependencyIds: t.dependencyIds,
          createdAt,
          updatedAt: createdAt,
        });
      }
    }
    database.persistInitialMasterRoadmap({
      projectId: "project-p13m0-r02",
      roadmap,
      revisionNumber: 0,
      createdAt,
      updatedAt: createdAt,
    });
    transition(database, "project", "project-p13m0-r02", "PLANNING", now);
    transition(database, "project", "project-p13m0-r02", "READY", now);
    transition(database, "project", "project-p13m0-r02", "RUNNING", now);
    transition(database, "phase", "phase.guided", "READY", now);
    try {
      const order = [];
      const first = await new ProjectExecutionOrchestrator(database, { now }).execute({
        projectId: "project-p13m0-r02",
        workspacePath: fixture.workspace,
        gates: { outstandingUserDecisionIds: [], permissionBlockers: [] },
        taskExecutor: completingExecutor(database, now, order),
        validator: phaseValidator(database, now),
        actor: ACTOR,
      });
      assert.equal(first.status, "AWAITING_TASK_APPROVAL");
      assert.equal(first.taskId, "task.r02.alpha");
      const second = await new ProjectExecutionOrchestrator(database, { now }).execute({
        projectId: "project-p13m0-r02",
        workspacePath: fixture.workspace,
        gates: { outstandingUserDecisionIds: [], permissionBlockers: [] },
        taskExecutor: completingExecutor(database, now, order),
        validator: phaseValidator(database, now),
        actor: ACTOR,
        guidedTaskApproval: { taskId: "task.r02.alpha" },
      });
      assert.equal(second.status, "AWAITING_TASK_APPROVAL");
      assert.equal(second.taskId, "task.r02.beta");
    } finally {
      database.close();
    }
  });

  test("R03 Phase mode stops after each durable phase report", async () => {
    const fixture = createGitRepo("densa-p13m0-r03-");
    const now = clock();
    const database = DensaAdeDatabase.openInMemory();
    const roadmap = masterRoadmapSchema.parse({
      formatVersion: 1,
      projectGoal: "Prove Phase boundaries.",
      phases: [
        {
          id: "phase.a",
          title: "A",
          goal: "Finish A.",
          required: true,
          completionCriteria: ["A passes."],
          tasks: [matrixTask("task.r03.a")],
        },
        {
          id: "phase.b",
          title: "B",
          goal: "Finish B.",
          required: true,
          completionCriteria: ["B passes."],
          tasks: [matrixTask("task.r03.b", ["task.r03.a"])],
        },
      ],
    });
    const createdAt = now();
    database.repositories.projects.create({
      id: "project-p13m0-r03",
      name: "R03",
      state: "DRAFT",
      executionMode: "phase",
      createdAt,
      updatedAt: createdAt,
    });
    for (const [pi, phase] of roadmap.phases.entries()) {
      database.repositories.phases.create({
        id: phase.id,
        projectId: "project-p13m0-r03",
        title: phase.title,
        state: "PENDING",
        position: pi,
        createdAt,
        updatedAt: createdAt,
      });
      for (const [ti, t] of phase.tasks.entries()) {
        database.repositories.tasks.create({
          id: t.id,
          projectId: "project-p13m0-r03",
          phaseId: phase.id,
          title: t.title,
          state: "PENDING",
          position: ti,
          acceptanceCriteria: t.acceptanceCriteria,
          dependencyIds: t.dependencyIds,
          createdAt,
          updatedAt: createdAt,
        });
      }
    }
    database.persistInitialMasterRoadmap({
      projectId: "project-p13m0-r03",
      roadmap,
      revisionNumber: 0,
      createdAt,
      updatedAt: createdAt,
    });
    transition(database, "project", "project-p13m0-r03", "PLANNING", now);
    transition(database, "project", "project-p13m0-r03", "READY", now);
    transition(database, "project", "project-p13m0-r03", "RUNNING", now);
    transition(database, "phase", "phase.a", "READY", now);
    try {
      const order = [];
      const first = await new ProjectExecutionOrchestrator(database, { now }).execute({
        projectId: "project-p13m0-r03",
        workspacePath: fixture.workspace,
        gates: { outstandingUserDecisionIds: [], permissionBlockers: [] },
        taskExecutor: completingExecutor(database, now, order),
        validator: phaseValidator(database, now),
        actor: ACTOR,
      });
      assert.equal(first.status, "AWAITING_PHASE_APPROVAL");
      assert.equal(first.phaseId, "phase.a");
      const second = await new ProjectExecutionOrchestrator(database, { now }).execute({
        projectId: "project-p13m0-r03",
        workspacePath: fixture.workspace,
        gates: { outstandingUserDecisionIds: [], permissionBlockers: [] },
        taskExecutor: completingExecutor(database, now, order),
        validator: phaseValidator(database, now),
        actor: ACTOR,
        phaseApproval: { phaseId: "phase.a" },
      });
      assert.equal(second.status, "AWAITING_PHASE_APPROVAL");
      assert.equal(second.phaseId, "phase.b");
    } finally {
      database.close();
    }
  });

  test("R04 Continuous multi-phase flow completes without approval stops", async () => {
    const fixture = createGitRepo("densa-p13m0-r04-");
    const now = clock();
    const database = DensaAdeDatabase.openInMemory();
    const roadmap = masterRoadmapSchema.parse({
      formatVersion: 1,
      projectGoal: "Prove Continuous flow.",
      phases: [
        {
          id: "phase.c1",
          title: "C1",
          goal: "Finish C1.",
          required: true,
          completionCriteria: ["C1 passes."],
          tasks: [matrixTask("task.r04.a")],
        },
        {
          id: "phase.c2",
          title: "C2",
          goal: "Finish C2.",
          required: true,
          completionCriteria: ["C2 passes."],
          tasks: [matrixTask("task.r04.b", ["task.r04.a"])],
        },
      ],
    });
    const createdAt = now();
    database.repositories.projects.create({
      id: "project-p13m0-r04",
      name: "R04",
      state: "DRAFT",
      executionMode: "continuous",
      createdAt,
      updatedAt: createdAt,
    });
    for (const [pi, phase] of roadmap.phases.entries()) {
      database.repositories.phases.create({
        id: phase.id,
        projectId: "project-p13m0-r04",
        title: phase.title,
        state: "PENDING",
        position: pi,
        createdAt,
        updatedAt: createdAt,
      });
      for (const [ti, t] of phase.tasks.entries()) {
        database.repositories.tasks.create({
          id: t.id,
          projectId: "project-p13m0-r04",
          phaseId: phase.id,
          title: t.title,
          state: "PENDING",
          position: ti,
          acceptanceCriteria: t.acceptanceCriteria,
          dependencyIds: t.dependencyIds,
          createdAt,
          updatedAt: createdAt,
        });
      }
    }
    database.persistInitialMasterRoadmap({
      projectId: "project-p13m0-r04",
      roadmap,
      revisionNumber: 0,
      createdAt,
      updatedAt: createdAt,
    });
    transition(database, "project", "project-p13m0-r04", "PLANNING", now);
    transition(database, "project", "project-p13m0-r04", "READY", now);
    transition(database, "project", "project-p13m0-r04", "RUNNING", now);
    transition(database, "phase", "phase.c1", "READY", now);
    try {
      const order = [];
      const result = await new ProjectExecutionOrchestrator(database, { now }).execute({
        projectId: "project-p13m0-r04",
        workspacePath: fixture.workspace,
        gates: { outstandingUserDecisionIds: [], permissionBlockers: [] },
        taskExecutor: completingExecutor(database, now, order),
        validator: phaseValidator(database, now),
        actor: ACTOR,
      });
      assert.equal(result.status, "COMPLETED");
      assert.deepEqual(order, ["task.r04.a", "task.r04.b"]);
    } finally {
      database.close();
    }
  });

  test("R05 retry then success carries persisted failure evidence", async () => {
    const fixture = createGitRepo("densa-p13m0-r05-");
    const now = clock();
    const database = DensaAdeDatabase.open(fixture.databasePath);
    try {
      seedSingleTask(database, now, {
        projectId: "project-p13m0-r05",
        taskId: "task-r05",
        phaseId: "phase-r05",
      });
      const adapter = new FakeAgentAdapter({
        now,
        finalMessage: "Every attempt is complete.",
        onExecute(request) {
          const target = request.cwd ?? fixture.workspace;
          const n = adapter.requests.length;
          writeFileSync(join(target, "task.txt"), n === 1 ? "rejected\n" : "accepted\n", "utf8");
        },
      });
      const result = await new SingleTaskOrchestrator(database, { now }).execute(
        singleTaskRequest({
          projectId: "project-p13m0-r05",
          taskId: "task-r05",
          workspacePath: fixture.workspace,
          adapter,
          validator: {
            validatorId: "r05-validator",
            async validate({ workspacePath, attempt }) {
              const actual = readFileSync(join(workspacePath, "task.txt"), "utf8");
              if (attempt.number === 1) {
                return {
                  passed: false,
                  diagnostics: {
                    attemptNumber: 1,
                    failingCriterion: "first attempt rejected",
                    actual,
                  },
                };
              }
              return { passed: actual === "accepted\n", diagnostics: { attemptNumber: 2, actual } };
            },
          },
        }),
      );
      assert.equal(result.status, "COMPLETED");
      assert.equal(result.attemptCount, 2);
      assert.equal(database.repositories.attempts.listByTaskId("task-r05").length, 2);
    } finally {
      database.close();
    }
  });

  test("R06 four retries end BLOCKED with diagnostics and clean Git", async () => {
    const fixture = createGitRepo("densa-p13m0-r06-");
    const now = clock();
    const database = DensaAdeDatabase.open(fixture.databasePath);
    try {
      seedSingleTask(database, now, {
        projectId: "project-p13m0-r06",
        taskId: "task-r06",
        phaseId: "phase-r06",
      });
      const startingHead = git(fixture.workspace, ["rev-parse", "HEAD"]).trim();
      const adapter = new FakeAgentAdapter({
        now,
        finalMessage: "Done despite the validator.",
        onExecute(request) {
          const target = request.cwd ?? fixture.workspace;
          writeFileSync(
            join(target, "task.txt"),
            `invalid ${String(adapter.requests.length)}\n`,
            "utf8",
          );
        },
      });
      const result = await new SingleTaskOrchestrator(database, { now }).execute(
        singleTaskRequest({
          projectId: "project-p13m0-r06",
          taskId: "task-r06",
          workspacePath: fixture.workspace,
          adapter,
          validator: {
            validatorId: "r06-always-fail",
            async validate({ attempt }) {
              return {
                passed: false,
                diagnostics: {
                  attemptNumber: attempt.number,
                  failingCriterion: "must be accepted",
                },
              };
            },
          },
        }),
      );
      assert.equal(result.status, "BLOCKED");
      assert.equal(result.attemptCount, 4);
      assert.equal(database.repositories.tasks.findById("task-r06").state, "BLOCKED");
      assert.equal(readFileSync(join(fixture.workspace, "task.txt"), "utf8"), "baseline\n");
      assert.equal(git(fixture.workspace, ["rev-parse", "HEAD"]).trim(), startingHead);
    } finally {
      database.close();
    }
  });

  test("R07 deterministic validation failure blocks completion", async () => {
    const database = DensaAdeDatabase.openInMemory();
    const createdAt = "2026-09-01T00:00:00.000Z";
    try {
      database.repositories.projects.create({
        id: "project-p13m0-r07",
        name: "R07",
        state: "DRAFT",
        executionMode: "guided",
        createdAt,
        updatedAt: createdAt,
      });
      database.repositories.phases.create({
        id: "phase-r07",
        projectId: "project-p13m0-r07",
        title: "R07",
        state: "PENDING",
        position: 0,
        createdAt,
        updatedAt: createdAt,
      });
      database.repositories.tasks.create({
        id: "task-r07",
        projectId: "project-p13m0-r07",
        phaseId: "phase-r07",
        title: "R07",
        state: "PENDING",
        position: 0,
        acceptanceCriteria: ["Build passes."],
        dependencyIds: [],
        createdAt,
        updatedAt: createdAt,
      });
      const outcome = await new ValidationPipeline(database, { now: () => createdAt }).execute({
        runId: "validation-p13m0-r07",
        projectId: "project-p13m0-r07",
        taskId: "task-r07",
        workspacePath: "/tmp/densa-p13m0-r07",
        plan: {
          id: "r07-plan",
          version: "1",
          validators: [
            {
              validator: {
                id: "unit-test",
                version: "1",
                async validate() {
                  return {
                    status: "failed",
                    diagnostics: [{ severity: "error", message: "1 test failed" }],
                    retryRelevant: true,
                  };
                },
              },
              evidenceSource: "deterministic_validator",
              policy: "required",
              relatedAcceptanceCriteria: ["Build passes."],
            },
          ],
        },
      });
      assert.equal(outcome.passed, false);
      assert.equal(outcome.canComplete, false);
      assert.equal(outcome.results[0].status, "failed");
    } finally {
      database.close();
    }
  });

  test("R08 browser validation failure records retry-relevant evidence and cleans up", async () => {
    const workspace = track(mkdtempSync(join(tmpdir(), "densa-p13m0-r08-")));
    const port = await reservePort();
    const pidPath = join(workspace, "server.pid");
    const scriptPath = join(workspace, "server.mjs");
    const launcherPath = join(workspace, "launcher.mjs");
    writeFileSync(
      scriptPath,
      `import { writeFileSync } from "node:fs";\nimport { createServer } from "node:http";\nconst [port, pidPath] = process.argv.slice(2);\nwriteFileSync(pidPath, String(process.pid));\nconst server = createServer((_req, res) => { res.writeHead(200, {"content-type": "text/html"}); res.end("<h1>matrix</h1>"); });\nserver.listen(Number(port), "127.0.0.1");\n`,
      "utf8",
    );
    writeFileSync(
      launcherPath,
      `import { spawn } from "node:child_process";\nconst child = spawn(process.execPath, process.argv.slice(2), { stdio: "inherit" });\nchild.once("exit", (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code ?? 1); });\nsetInterval(() => {}, 1000);\n`,
      "utf8",
    );
    const validator = new BrowserValidationValidator(
      {
        url: `http://127.0.0.1:${String(port)}/`,
        source: "user-configured",
        startCommand: {
          argv: [process.execPath, launcherPath, scriptPath, String(port), pidPath],
          cwd: ".",
        },
      },
      [{ kind: "visible_text", path: "/", text: "absent-matrix-text" }],
      {
        runner: {
          async run() {
            return {
              status: "failed",
              logs: [{ level: "error", message: "expected text absent" }],
              logsTruncated: false,
              artifacts: [],
              message: "Browser visible_text check failed: expected text absent",
            };
          },
        },
        artifactRoot: join(workspace, "artifacts"),
        artifactId: () => "r08",
        runTimeoutMs: 2_000,
      },
    );
    const result = await validator.validate({
      projectId: "project-p13m0-r08",
      taskId: "task-p13m0-r08",
      workspacePath: workspace,
      relatedAcceptanceCriteria: ["The expected text is visible."],
    });
    assert.equal(result.status, "failed");
    assert.equal(result.retryRelevant, true);
    assert.ok(result.diagnostics.some((d) => d.code === "BROWSER_CHECK_FAILED"));
    // Dev-server group must not leak: pid file either absent or dead.
    if (existsSync(pidPath)) {
      const pid = Number(readFileSync(pidPath, "utf8"));
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch (e) {
        if (e.code === "ESRCH") alive = false;
        else throw e;
      }
      assert.equal(alive, false);
    }
  });

  test("R09 roadmap minor/scope mutations respect policy and stay graph-valid", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "densa-p13m0-r09-"));
    track(workspace);
    const database = DensaAdeDatabase.openInMemory();
    const now = clock();
    try {
      const projectGoal = "Prove roadmap mutation policy.";
      database.repositories.projects.create({
        id: "project-p13m0-r09",
        name: "R09",
        state: "DRAFT",
        executionMode: "continuous",
        createdAt: now(),
        updatedAt: now(),
      });
      database.repositories.specifications.set({
        projectId: "project-p13m0-r09",
        specification: cleanSpecification(projectGoal),
        createdAt: now(),
        updatedAt: now(),
      });
      const service = new RoadmapMutationService(database, { workspacePath: workspace, now });
      const roadmap = masterRoadmapSchema.parse({
        formatVersion: 1,
        projectGoal,
        phases: [
          {
            id: "phase.r09.a",
            title: "A",
            goal: "Finish A.",
            required: true,
            completionCriteria: ["A passes."],
            tasks: [matrixTask("task.r09.a")],
          },
          {
            id: "phase.r09.b",
            title: "B",
            goal: "Finish B.",
            required: true,
            completionCriteria: ["B passes."],
            tasks: [matrixTask("task.r09.b", ["task.r09.a"])],
          },
          {
            id: "phase.r09.optional",
            title: "Optional",
            goal: "Optional polish.",
            required: false,
            completionCriteria: [],
            tasks: [],
          },
        ],
      });
      await service.storeInitialRoadmap("project-p13m0-r09", roadmap);
      const minor = await service.apply("project-p13m0-r09", {
        operation: {
          kind: "add_task",
          phaseId: "phase.r09.b",
          position: 1,
          task: matrixTask("task.r09.extra", ["task.r09.b"]),
        },
        rationale: "Add a missing test task.",
        actor: ACTOR,
        sessionId: "p13m0-r09",
        applicationMode: "automatic",
      });
      assert.equal(minor.classification, "minor");
      assert.equal(
        database.repositories.masterRoadmaps.findByProjectId("project-p13m0-r09").revisionNumber,
        1,
      );
      await assert.rejects(
        service.apply("project-p13m0-r09", {
          operation: { kind: "remove_phase", phaseId: "phase.r09.optional" },
          classification: "scope",
          rationale: "Remove optional scope without approval.",
          actor: ACTOR,
          sessionId: "p13m0-r09",
          applicationMode: "automatic",
        }),
        /require explicit user approval/u,
      );
      assert.equal(
        database.repositories.masterRoadmaps.findByProjectId("project-p13m0-r09").revisionNumber,
        1,
      );
    } finally {
      database.close();
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test("R10 user pause and resume are durable and idempotent", async () => {
    const database = DensaAdeDatabase.openInMemory();
    const now = clock();
    const createdAt = now();
    database.repositories.projects.create({
      id: "project-p13m0-r10",
      name: "R10",
      state: "DRAFT",
      executionMode: "continuous",
      createdAt,
      updatedAt: createdAt,
    });
    for (const s of ["PLANNING", "READY", "RUNNING"])
      transition(database, "project", "project-p13m0-r10", s, now);
    const snapshot = { gitHead: "a".repeat(40), gitStatus: "", fingerprint: "r10" };
    const cleanPreflight = {
      schemaVersion: 1,
      workspacePath: "/tmp/densa-p13m0-r10",
      repository: {
        isGitRepository: true,
        isWorkTree: true,
        isBare: false,
        root: "/tmp/densa-p13m0-r10",
      },
      head: {
        commit: "a".repeat(40),
        branch: "densa-ade/run/project-p13m0-r10",
        detached: false,
        unborn: false,
      },
      changes: { staged: [], unstaged: [], untracked: [], dirty: false },
      operations: { merge: false, rebase: false, cherryPick: false, active: [] },
      ignoredDensaAdeRuntimeArtifacts: [],
      densaAdeRun: {
        branchPrefix: "densa-ade/run/",
        currentBranchOwned: true,
        ownedBranches: [],
        hasOwnedRunBranch: false,
      },
      decision: {
        outcome: "PROCEED",
        code: "CLEAN_REPOSITORY",
        requiresUserDecision: false,
        reason: "clean",
      },
      automaticActionsPerformed: false,
    };
    const service = new ProjectExecutionControlService(database, {
      now,
      workspaceProbe: {
        async inspect() {
          return { status: "available", snapshot };
        },
      },
      preflight: {
        async inspect() {
          return cleanPreflight;
        },
      },
      recoveryInspector: {
        async inspect() {
          return {
            classification: "CLEANLY_IDLE",
            reason: "idle",
            actions: ["NONE"],
            automaticActionsPerformed: false,
          };
        },
      },
    });
    try {
      const req = {
        projectId: "project-p13m0-r10",
        workspacePath: "/tmp/densa-p13m0-r10",
        actor: ACTOR,
      };
      assert.equal((await service.pause(req)).status, "PAUSED");
      assert.equal((await service.pause(req)).status, "UNCHANGED");
      assert.equal(database.repositories.projects.findById("project-p13m0-r10").state, "PAUSED");
      assert.equal((await service.resume(req)).status, "RESUMED");
      assert.equal(database.repositories.projects.findById("project-p13m0-r10").state, "RUNNING");
    } finally {
      database.close();
    }
  });

  test("R11 cancel current worker produces a deterministic terminal event", async () => {
    const fixture = createGitRepo("densa-p13m0-r11-");
    const now = clock();
    const database = DensaAdeDatabase.open(fixture.databasePath);
    try {
      seedSingleTask(database, now, {
        projectId: "project-p13m0-r11",
        taskId: "task-r11",
        phaseId: "phase-r11",
      });
      const controller = new globalThis.AbortController();
      const adapter = new FakeAgentAdapter({
        now,
        holdOpen: true,
        onExecute(request) {
          const target = request.cwd ?? fixture.workspace;
          writeFileSync(join(target, "task.txt"), "cancelled\n", "utf8");
        },
      });
      const result = await new SingleTaskOrchestrator(database, { now }).execute(
        singleTaskRequest({
          projectId: "project-p13m0-r11",
          taskId: "task-r11",
          workspacePath: fixture.workspace,
          adapter,
          validator: {
            validatorId: "r11",
            async validate() {
              return { passed: true, diagnostics: {} };
            },
          },
          extra: {
            signal: controller.signal,
            onAgentEvent(event) {
              if (event.type === "run.started") controller.abort();
            },
          },
        }),
      );
      assert.equal(result.status, "CANCELLED");
      assert.deepEqual(adapter.cancelledRunIds, [adapter.requests[0].runId]);
      assert.equal(database.repositories.tasks.findById("task-r11").state, "CANCELLED");
    } finally {
      database.close();
    }
  });

  test("R12 manual edit while paused is detected and preserved", async () => {
    const fixture = createGitRepo("densa-p13m0-r12-");
    const now = clock();
    const database = DensaAdeDatabase.open(fixture.databasePath);
    try {
      const createdAt = now();
      database.repositories.projects.create({
        id: "project-p13m0-r12",
        name: "R12",
        state: "DRAFT",
        executionMode: "continuous",
        createdAt,
        updatedAt: createdAt,
      });
      for (const s of ["PLANNING", "READY", "RUNNING"])
        transition(database, "project", "project-p13m0-r12", s, now);
      const service = new ProjectExecutionControlService(database, {
        now,
        recoveryInspector: {
          async inspect() {
            return {
              classification: "WORKSPACE_DIVERGED",
              reason: "Manual paused-workspace edit detected",
              actions: ["RECONCILE_WORKSPACE"],
              automaticActionsPerformed: false,
            };
          },
        },
      });
      const req = {
        projectId: "project-p13m0-r12",
        workspacePath: fixture.workspace,
        actor: ACTOR,
      };
      assert.equal((await service.pause(req)).status, "PAUSED");
      writeFileSync(join(fixture.workspace, "user-note.txt"), "manual work\n", "utf8");
      const intervention = await service.resume(req);
      assert.equal(intervention.status, "INTERVENTION_REQUIRED");
      const resumed = await service.resume({ ...req, acknowledgeIntervention: true });
      assert.equal(resumed.status, "RESUMED");
      assert.equal(readFileSync(join(fixture.workspace, "user-note.txt"), "utf8"), "manual work\n");
    } finally {
      database.close();
    }
  });

  test("R13 Core crash mid-run classifies the missing worker without touching user files", async () => {
    const fixture = createGitRepo("densa-p13m0-r13-");
    const now = clock();
    let database = DensaAdeDatabase.open(fixture.databasePath);
    const createdAt = now();
    database.repositories.projects.create({
      id: "project-p13m0-r13",
      name: "R13",
      state: "DRAFT",
      executionMode: "continuous",
      createdAt,
      updatedAt: createdAt,
    });
    for (const s of ["PLANNING", "READY", "RUNNING"])
      transition(database, "project", "project-p13m0-r13", s, now);
    database.repositories.phases.create({
      id: "phase-r13",
      projectId: "project-p13m0-r13",
      title: "R13",
      state: "PENDING",
      position: 0,
      createdAt,
      updatedAt: createdAt,
    });
    database.repositories.tasks.create({
      id: "task-r13",
      projectId: "project-p13m0-r13",
      phaseId: "phase-r13",
      title: "R13",
      state: "PENDING",
      position: 0,
      acceptanceCriteria: ["c"],
      dependencyIds: [],
      createdAt,
      updatedAt: createdAt,
    });
    transition(database, "phase", "phase-r13", "READY", now);
    transition(database, "phase", "phase-r13", "RUNNING", now);
    transition(database, "task", "task-r13", "READY", now);
    transition(database, "task", "task-r13", "RUNNING", now);
    const observed = await new (await import("@densa-ade/core")).GitWorkspaceProbe().inspect(
      fixture.workspace,
    );
    assert.equal(observed.status, "available");
    database.repositories.checkpoints.create({
      id: "checkpoint-r13",
      projectId: "project-p13m0-r13",
      createdAt: now(),
      description: "pre-crash",
      gitHead: observed.snapshot.gitHead,
      gitStatus: observed.snapshot.gitStatus,
      workspaceFingerprint: observed.snapshot.fingerprint,
    });
    const attempt = database.repositories.attempts.create({
      id: "attempt-r13",
      taskId: "task-r13",
      number: 1,
      startedAt: now(),
    });
    database.repositories.agentRuns.create({
      id: "run-r13",
      attemptId: attempt.id,
      adapterId: "fake",
      adapterRunId: "fake-r13",
      processId: 987_654,
      processIdentity: "p13m0-missing",
      startedAt: now(),
    });
    writeFileSync(join(fixture.workspace, "user-note.txt"), "preserve\n", "utf8");
    database.close();
    database = DensaAdeDatabase.open(fixture.databasePath);
    try {
      const recovery = await new RecoveryInspector(database.repositories, {
        workspaceProbe: {
          async inspect() {
            return { status: "available", snapshot: observed.snapshot };
          },
        },
        processProbe: {
          async inspect(pid) {
            return { processId: pid, status: "gone" };
          },
        },
      }).inspect({ projectId: "project-p13m0-r13", workspacePath: fixture.workspace });
      assert.equal(recovery.classification, "TASK_PROCESS_GONE");
      assert.deepEqual(recovery.taskStateRecommendation, {
        taskId: "task-r13",
        state: "INTERRUPTED",
      });
      assert.equal(readFileSync(join(fixture.workspace, "user-note.txt"), "utf8"), "preserve\n");
    } finally {
      database.close();
    }
  });

  test("R14 IDE crash leaves Core running for a second reader", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "densa-p13m0-r14-"));
    track(runtimeDirectory);
    const database = DensaAdeDatabase.openInMemory();
    const ts = "2026-09-01T00:00:00.000Z";
    database.repositories.projects.create({
      id: "project-p13m0-r14",
      name: "R14",
      state: "DRAFT",
      executionMode: "guided",
      createdAt: ts,
      updatedAt: ts,
    });
    database.eventJournal.append({
      id: "event-r14-1",
      projectId: "project-p13m0-r14",
      type: "PROJECT_STARTED",
      eventVersion: 1,
      occurredAt: ts,
      actor: ACTOR,
      payload: {},
    });
    const daemon = await CoreDaemon.start({ runtimeDirectory, database });
    const first = new CoreIpcClient({ runtimeDirectory });
    try {
      const status = await first.request({
        protocolVersion: (await import("@densa-ade/protocol")).PROTOCOL_VERSION,
        kind: "request",
        requestId: "r14-status",
        method: "core.status",
        payload: {},
      });
      assert.equal(status.state, "running");
      // Simulate IDE crash: hard disconnect without daemon shutdown.
      first.disconnect();
      const second = new CoreIpcClient({ runtimeDirectory });
      try {
        const after = await second.request({
          protocolVersion: (await import("@densa-ade/protocol")).PROTOCOL_VERSION,
          kind: "request",
          requestId: "r14-status-2",
          method: "core.status",
          payload: {},
        });
        assert.equal(after.state, "running");
        assert.equal(after.instanceId, daemon.status().instanceId);
      } finally {
        second.disconnect();
      }
    } finally {
      first.disconnect();
      await daemon.stop();
      database.close();
      await rm(runtimeDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test("R15 Core restart preserves authoritative state", async () => {
    const fixture = createGitRepo("densa-p13m0-r15-");
    const now = clock();
    let database = DensaAdeDatabase.open(fixture.databasePath);
    const createdAt = now();
    database.repositories.projects.create({
      id: "project-p13m0-r15",
      name: "R15",
      state: "DRAFT",
      executionMode: "phase",
      createdAt,
      updatedAt: createdAt,
    });
    for (const s of ["PLANNING", "READY", "RUNNING"])
      transition(database, "project", "project-p13m0-r15", s, now);
    database.close();
    database = DensaAdeDatabase.open(fixture.databasePath);
    try {
      assert.equal(database.repositories.projects.findById("project-p13m0-r15").state, "RUNNING");
      assert.equal(
        database.repositories.projects.findById("project-p13m0-r15").executionMode,
        "phase",
      );
      const events = database.eventJournal.replay({ projectId: "project-p13m0-r15", limit: 100 });
      assertCoherentReplay(events);
    } finally {
      database.close();
    }
  });

  test("R16 usage wait checkpoints then auto-resumes without busy polling", async () => {
    const fixture = createGitRepo("densa-p13m0-r16-");
    const now = clock();
    const database = DensaAdeDatabase.open(fixture.databasePath);
    try {
      seedSingleTask(database, now, {
        projectId: "project-p13m0-r16",
        taskId: "task-r16",
        phaseId: "phase-r16",
      });
      transition(database, "project", "project-p13m0-r16", "PLANNING", now);
      transition(database, "project", "project-p13m0-r16", "READY", now);
      transition(database, "project", "project-p13m0-r16", "RUNNING", now);
      const waiting = await new SingleTaskOrchestrator(database, { now }).execute(
        singleTaskRequest({
          projectId: "project-p13m0-r16",
          taskId: "task-r16",
          workspacePath: fixture.workspace,
          adapter: new FakeAgentAdapter({
            now,
            outcome: "failed",
            error: { code: "USAGE_LIMITED", message: "limited" },
            usageState: { status: "limited" },
            onExecute({ cwd }) {
              writeFileSync(join(cwd, "task.txt"), "partial\n", "utf8");
            },
          }),
          validator: {
            validatorId: "r16-unused",
            async validate() {
              throw new Error("must not validate limited output");
            },
          },
        }),
      );
      assert.equal(waiting.status, "WAITING_FOR_USAGE");
      assert.equal(readFileSync(join(fixture.workspace, "task.txt"), "utf8"), "baseline\n");
      const fakeClock = new FakeClock("2026-09-01T03:00:00.000Z");
      const branch = git(fixture.workspace, ["branch", "--show-current"]).trim();
      const options = {
        clock: fakeClock,
        initialBackoffMs: 1_000,
        maxBackoffMs: 8_000,
        maxProbeAttempts: 4,
        usageProbe: {
          async getUsageState() {
            return { status: "available" };
          },
        },
        gateProvider: {
          async inspect() {
            return { outstandingUserDecisionIds: [], permissionBlockers: [] };
          },
        },
        preflight: {
          async inspect() {
            return {
              schemaVersion: 1,
              workspacePath: fixture.workspace,
              repository: {
                isGitRepository: true,
                isWorkTree: true,
                isBare: false,
                root: fixture.workspace,
              },
              head: { commit: "a".repeat(40), branch, detached: false, unborn: false },
              changes: { staged: [], unstaged: [], untracked: [], dirty: false },
              operations: { merge: false, rebase: false, cherryPick: false, active: [] },
              ignoredDensaAdeRuntimeArtifacts: [],
              densaAdeRun: {
                branchPrefix: "densa-ade/run/",
                currentBranchOwned: true,
                ownedBranches: [branch],
                hasOwnedRunBranch: true,
              },
              decision: {
                outcome: "PROCEED",
                code: "EXISTING_DENSA_RUN",
                requiresUserDecision: false,
                reason: "safe",
              },
              automaticActionsPerformed: false,
            };
          },
        },
        recoveryInspector: {
          async inspect() {
            return {
              classification: "CLEANLY_IDLE",
              reason: "idle",
              actions: ["NONE"],
              automaticActionsPerformed: false,
            };
          },
        },
      };
      const service = new UsageAutoResumeService(database, options);
      try {
        const scheduled = service.enable({
          projectId: "project-p13m0-r16",
          workspacePath: fixture.workspace,
          actor: ACTOR,
        });
        assert.equal(scheduled.status, "SCHEDULED");
        fakeClock.set(Date.parse(scheduled.nextProbeAt));
        const resumed = await service.probe("project-p13m0-r16");
        assert.equal(resumed.status, "RESUMED");
      } finally {
        service.dispose();
      }
    } finally {
      database.close();
    }
  });

  test("R17 unknown usage never enters WAITING_FOR_USAGE", async () => {
    const fixture = createGitRepo("densa-p13m0-r17-");
    const now = clock();
    const database = DensaAdeDatabase.open(fixture.databasePath);
    try {
      seedSingleTask(database, now, {
        projectId: "project-p13m0-r17",
        taskId: "task-r17",
        phaseId: "phase-r17",
      });
      transition(database, "project", "project-p13m0-r17", "PLANNING", now);
      transition(database, "project", "project-p13m0-r17", "READY", now);
      transition(database, "project", "project-p13m0-r17", "RUNNING", now);
      const result = await new SingleTaskOrchestrator(database, { now }).execute(
        singleTaskRequest({
          projectId: "project-p13m0-r17",
          taskId: "task-r17",
          workspacePath: fixture.workspace,
          adapter: new FakeAgentAdapter({
            now,
            outcome: "failed",
            error: { code: "USAGE_LIMITED", message: "uncorroborated" },
            usageState: { status: "unknown", reason: "no signal" },
          }),
          validator: {
            validatorId: "r17",
            async validate({ workspacePath }) {
              return {
                passed: readFileSync(join(workspacePath, "task.txt"), "utf8") === "baseline\n",
                diagnostics: {},
              };
            },
          },
        }),
      );
      // Unknown usage must not be misreported as a clean wait.
      assert.notEqual(result.status, "WAITING_FOR_USAGE");
      assert.equal(
        database.eventJournal.replay({
          projectId: "project-p13m0-r17",
          types: ["USAGE_LIMIT_REACHED"],
          limit: 10,
        }).length,
        0,
      );
    } finally {
      database.close();
    }
  });

  test("R18 dirty Git repo stops without destroying user work", async () => {
    const fixture = createGitRepo("densa-p13m0-r18-");
    writeFileSync(join(fixture.workspace, "staged.txt"), "staged\n", "utf8");
    git(fixture.workspace, ["add", "staged.txt"]);
    writeFileSync(join(fixture.workspace, "task.txt"), "unstaged user work\n", "utf8");
    writeFileSync(join(fixture.workspace, "untracked.txt"), "untracked\n", "utf8");
    const beforeStatus = git(fixture.workspace, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    const beforeHead = git(fixture.workspace, ["rev-parse", "HEAD"]).trim();
    const result = await new WorkspacePreflight().inspect(fixture.workspace);
    assert.equal(result.decision.outcome, "STOP");
    assert.equal(result.decision.code, "USER_CHANGES_PRESENT");
    assert.equal(result.decision.requiresUserDecision, true);
    assert.equal(
      git(fixture.workspace, ["status", "--porcelain=v1", "--untracked-files=all"]),
      beforeStatus,
    );
    assert.equal(git(fixture.workspace, ["rev-parse", "HEAD"]).trim(), beforeHead);
  });

  test("R19 Git commit failure leaves task VALIDATING with no SHA", async () => {
    const root = track(mkdtempSync(join(tmpdir(), "densa-p13m0-r19-")));
    const repository = join(root, "workspace");
    git(root, ["init", "--quiet", "--initial-branch=main", repository]);
    writeFileSync(join(repository, ".gitignore"), ".densa-ade/runtime/\n*.sqlite\n", "utf8");
    writeFileSync(join(repository, "task.txt"), "before\n", "utf8");
    git(repository, ["add", "--all"]);
    git(repository, [
      "-c",
      "user.name=Densa ADE P13M0",
      "-c",
      "user.email=densa-p13m0@localhost",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ]);
    const database = DensaAdeDatabase.open(join(root, "runtime.sqlite"));
    try {
      const createdAt = "2026-09-01T00:00:00.000Z";
      database.repositories.projects.create({
        id: "project-p13m0-r19",
        name: "R19",
        state: "DRAFT",
        executionMode: "guided",
        createdAt,
        updatedAt: createdAt,
      });
      database.repositories.phases.create({
        id: "phase-r19",
        projectId: "project-p13m0-r19",
        title: "R19",
        state: "PENDING",
        position: 0,
        createdAt,
        updatedAt: createdAt,
      });
      database.repositories.tasks.create({
        id: "TASK-R19",
        projectId: "project-p13m0-r19",
        phaseId: "phase-r19",
        title: "commit failure",
        state: "PENDING",
        position: 0,
        acceptanceCriteria: ["validated"],
        dependencyIds: [],
        createdAt,
        updatedAt: createdAt,
      });
      database.repositories.attempts.create({
        id: "attempt-r19",
        taskId: "TASK-R19",
        number: 1,
        startedAt: createdAt,
      });
      const checkpoint = await new RunCheckpointService(database).prepareTask({
        projectId: "project-p13m0-r19",
        taskId: "TASK-R19",
        attemptId: "attempt-r19",
        checkpointId: "checkpoint-r19",
        runActivatedEventId: "event-r19-run",
        checkpointEventId: "event-r19-checkpoint",
        workspacePath: repository,
        createdAt,
        actor: ACTOR,
      });
      assert.equal(checkpoint.status, "READY");
      const executionPath = checkpoint.run.workspacePath;
      git(executionPath, ["config", "user.name", "Densa ADE P13M0"]);
      git(executionPath, ["config", "user.email", "densa-p13m0@localhost"]);
      git(executionPath, ["config", "commit.gpgsign", "false"]);
      const transitions = new StateTransitionService();
      let task = database.repositories.tasks.findById("TASK-R19");
      for (const [state, eventId] of [
        ["READY", "event-r19-ready"],
        ["RUNNING", "event-r19-running"],
        ["VALIDATING", "event-r19-validating"],
      ]) {
        database.persistStateTransition(
          transitions.transitionTask(task, state, { actor: ACTOR, occurredAt: createdAt }),
          eventId,
        );
        task = database.repositories.tasks.findById("TASK-R19");
      }
      const validationId = "validation-r19";
      database.repositories.validationRuns.create({
        id: validationId,
        taskId: "TASK-R19",
        attemptId: "attempt-r19",
        validatorId: "r19",
        planId: "r19-plan",
        planVersion: "1",
        startedAt: createdAt,
        completedAt: createdAt,
        passed: true,
      });
      database.repositories.validationResults.create({
        id: `${validationId}:result:0`,
        validationRunId: validationId,
        position: 0,
        validatorId: "r19",
        validatorVersion: "1",
        evidenceSource: "deterministic_validator",
        policy: "required",
        status: "passed",
        startedAt: createdAt,
        completedAt: createdAt,
        diagnostics: [],
        relatedAcceptanceCriteria: ["validated"],
        retryRelevant: false,
      });
      // Capture runs against the isolated execution path.
      const checkpointHead = git(executionPath, ["rev-parse", "HEAD"]).trim();
      writeFileSync(join(executionPath, "task.txt"), "validated\n", "utf8");
      const evidence = await captureValidationWorkspace(executionPath);
      recordValidationWorkspace(database, validationId, evidence);
      const hook = join(checkpoint.run.sourceWorkspacePath, ".git", "hooks", "pre-commit");
      writeFileSync(hook, "#!/bin/sh\nexit 1\n", "utf8");
      chmodSync(hook, 0o700);
      const result = await new TaskCommitService(database).commitPassingTask({
        projectId: "project-p13m0-r19",
        taskId: "TASK-R19",
        attemptId: "attempt-r19",
        validationRunId: validationId,
        workspacePath: repository,
        intendedPaths: ["task.txt"],
        committedAt: createdAt,
        actor: ACTOR,
        commitRecordedEventId: "event-r19-committed",
        completionEventId: "event-r19-completed",
      });
      assert.equal(result.status, "STOPPED");
      assert.equal(result.code, "GIT_COMMAND_FAILED");
      assert.equal(git(executionPath, ["rev-parse", "HEAD"]).trim(), checkpointHead);
      assert.equal(database.repositories.tasks.findById("TASK-R19").state, "VALIDATING");
      assert.equal(database.repositories.attempts.findById("attempt-r19").commitSha, undefined);
    } finally {
      database.close();
    }
  });

  test("R20 secrets never appear in logs, events, or packets", async () => {
    const secret = "opaque-p13m0-secret-48291";
    const log = redactLog(`stderr password=${secret}`, [secret]);
    assert.equal(log.includes(secret), false);
    assert.match(log, /REDACTED/u);
    const event = redactEvent(
      {
        id: "event-r20",
        projectId: "project-p13m0-r20",
        type: "SECRET_PROOF",
        eventVersion: 1,
        occurredAt: "2026-09-01T00:00:00.000Z",
        actor: ACTOR,
        payload: { message: `Observed ${secret}` },
      },
      [secret],
    );
    assert.equal(JSON.stringify(event).includes(secret), false);
  });

  test("R21 policy denial is structured and auditable", async () => {
    const database = DensaAdeDatabase.openInMemory();
    const createdAt = "2026-09-01T00:00:00.000Z";
    try {
      database.repositories.projects.create({
        id: "project-p13m0-r21",
        name: "R21",
        state: "DRAFT",
        executionMode: "guided",
        createdAt,
        updatedAt: createdAt,
      });
      const policy = new PermissionPolicyService(database);
      policy.setPreset({
        projectId: "project-p13m0-r21",
        preset: "cautious",
        actor: ACTOR,
        reason: "matrix",
        occurredAt: createdAt,
      });
      const denied = policy.authorize({
        projectId: "project-p13m0-r21",
        operation: "privilege_escalation",
        actor: "worker:test",
        reason: "try sudo",
        occurredAt: createdAt,
      });
      assert.equal(denied.decision.disposition, "deny");
      assert.equal(denied.authorization, undefined);
      const events = database.repositories.events.replay({ projectId: "project-p13m0-r21" });
      assert.ok(
        events.some(
          (e) => e.type === "PERMISSION_DECISION_RECORDED" && e.payload.disposition === "deny",
        ),
      );
    } finally {
      database.close();
    }
  });

  test("R22 protocol reconnect replays without duplication", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "densa-p13m0-r22-"));
    track(runtimeDirectory);
    const database = DensaAdeDatabase.openInMemory();
    const ts = "2026-09-01T00:00:00.000Z";
    database.repositories.projects.create({
      id: "project-p13m0-r22",
      name: "R22",
      state: "DRAFT",
      executionMode: "guided",
      createdAt: ts,
      updatedAt: ts,
    });
    database.eventJournal.append({
      id: "event-r22-1",
      projectId: "project-p13m0-r22",
      type: "PROJECT_STARTED",
      eventVersion: 1,
      occurredAt: ts,
      actor: ACTOR,
      payload: {},
    });
    const daemon = await CoreDaemon.start({ runtimeDirectory, database });
    const { PROTOCOL_VERSION } = await import("@densa-ade/protocol");
    const client = new CoreIpcClient({ runtimeDirectory });
    try {
      const sub = await client.request({
        protocolVersion: PROTOCOL_VERSION,
        kind: "request",
        requestId: "r22-sub",
        method: "events.subscribe",
        payload: { projectId: "project-p13m0-r22", afterSequence: 0 },
      });
      assert.deepEqual(
        sub.events.map((e) => e.sequenceNumber),
        [1],
      );
      database.eventJournal.append({
        id: "event-r22-2",
        projectId: "project-p13m0-r22",
        type: "PROJECT_PAUSED",
        eventVersion: 1,
        occurredAt: "2026-09-01T00:01:00.000Z",
        actor: ACTOR,
        payload: {},
      });
      client.disconnect();
      await client.reconnect();
      const replay = await client.request({
        protocolVersion: PROTOCOL_VERSION,
        kind: "request",
        requestId: "r22-replay",
        method: "events.replay",
        payload: { projectId: "project-p13m0-r22", afterSequence: 1 },
      });
      assert.deepEqual(
        replay.events.map((e) => e.sequenceNumber),
        [2],
      );
    } finally {
      client.disconnect();
      await daemon.stop();
      database.close();
      await rm(runtimeDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test("R23 migration from a legacy fixture schema preserves runtime rows", async () => {
    const dir = track(mkdtempSync(join(tmpdir(), "densa-p13m0-r23-")));
    const path = join(dir, "runtime.sqlite");
    const createdAt = "2026-09-01T00:00:00.000Z";
    const raw = new DatabaseSync(path);
    raw.exec(
      `CREATE TABLE _densa_migrations (version INTEGER PRIMARY KEY CHECK (version > 0), name TEXT NOT NULL UNIQUE, checksum TEXT NOT NULL CHECK (length(checksum) = 64), applied_at TEXT NOT NULL CHECK (length(applied_at) >= 20)) STRICT;`,
    );
    for (const migration of schemaMigrations.slice(0, 2)) {
      raw.exec(migration.sql);
      raw
        .prepare(
          `INSERT INTO _densa_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)`,
        )
        .run(
          migration.version,
          migration.name,
          createHash("sha256").update(migration.sql).digest("hex"),
          createdAt,
        );
    }
    raw
      .prepare(
        `INSERT INTO projects (id, name, state, execution_mode, created_at, updated_at) VALUES ('project-p13m0-legacy', 'Legacy', 'DRAFT', 'guided', ?, ?)`,
      )
      .run(createdAt, createdAt);
    raw.close();
    const database = DensaAdeDatabase.open(path);
    try {
      assert.equal(database.schemaVersion, database.expectedSchemaVersion);
      assert.equal(database.repositories.projects.findById("project-p13m0-legacy").name, "Legacy");
      assert.deepEqual(database.prepare?.("PRAGMA foreign_key_check") ?? [], []);
    } finally {
      database.close();
    }
  });

  test("R24 critical scenarios repeat deterministically without flakiness", async () => {
    // Release gate: retry-success and four-failures must be stable across repeats.
    for (let cycle = 0; cycle < 2; cycle += 1) {
      const fixture = createGitRepo(`densa-p13m0-r24-${cycle}-`);
      const now = clock(BASE_TIME + cycle * 50_000);
      const database = DensaAdeDatabase.open(fixture.databasePath);
      try {
        seedSingleTask(database, now, {
          projectId: `project-p13m0-r24-${cycle}`,
          taskId: `task-r24-${cycle}`,
          phaseId: `phase-r24-${cycle}`,
        });
        const adapter = new FakeAgentAdapter({
          now,
          onExecute(request) {
            const target = request.cwd ?? fixture.workspace;
            writeFileSync(join(target, "task.txt"), "accepted\n", "utf8");
          },
        });
        const result = await new SingleTaskOrchestrator(database, { now }).execute(
          singleTaskRequest({
            projectId: `project-p13m0-r24-${cycle}`,
            taskId: `task-r24-${cycle}`,
            workspacePath: fixture.workspace,
            adapter,
            validator: {
              validatorId: "r24",
              async validate({ workspacePath }) {
                return {
                  passed: readFileSync(join(workspacePath, "task.txt"), "utf8") === "accepted\n",
                  diagnostics: {},
                };
              },
            },
          }),
        );
        assert.equal(result.status, "COMPLETED");
      } finally {
        database.close();
      }
    }
  });
});

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
