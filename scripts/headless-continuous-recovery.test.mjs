import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  GitWorkspaceProbe,
  IndependentReviewService,
  ProjectExecutionControlService,
  ProjectExecutionOrchestrator,
  RecoveryInspector,
  RoadmapMutationService,
  SingleTaskOrchestrator,
  SingleTaskPhaseExecutor,
  StateTransitionService,
  UsageAutoResumeService,
} from "@densa-ade/core";
import { DensaAdeDatabase } from "@densa-ade/core/persistence";
import { masterRoadmapSchema } from "@densa-ade/protocol";
import { FakeAgentAdapter, FakeClock } from "@densa-ade/testing";

const roots = new Set();
const baseTime = Date.parse("2026-08-30T00:00:00.000Z");

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

function clock(start = baseTime) {
  let tick = 0;
  return () => new Date(start + tick++ * 1_000).toISOString();
}

function createRepository(prefix, files = { "task.txt": "baseline\n" }) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.add(root);
  const workspace = join(root, "workspace");
  git(root, ["init", "--quiet", "--initial-branch=main", workspace]);
  writeFileSync(join(workspace, ".gitignore"), ".densa-ade/runtime/\n*.sqlite\n", "utf8");
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(workspace, path), content, "utf8");
  }
  git(workspace, ["add", "--all"]);
  git(workspace, [
    "-c",
    "user.name=Densa ADE P9M1 Fixture",
    "-c",
    "user.email=densa-p9m1@localhost",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "fixture: known checkpoint",
  ]);
  git(workspace, ["config", "user.name", "Densa ADE P9M1 Fixture"]);
  git(workspace, ["config", "user.email", "densa-p9m1@localhost"]);
  git(workspace, ["config", "commit.gpgsign", "false"]);
  return { root, workspace, databasePath: join(root, "runtime.sqlite") };
}

function transition(database, kind, id, state, now, reason = "P9M1 deterministic fixture") {
  const service = new StateTransitionService();
  const repository =
    kind === "project"
      ? database.repositories.projects
      : kind === "phase"
        ? database.repositories.phases
        : database.repositories.tasks;
  const current = repository.findById(id);
  assert.ok(current, `${kind} ${id} must exist before transition`);
  const occurredAt = now();
  const context = { actor: "densa:p9m1-proof", occurredAt, reason };
  const change =
    kind === "project"
      ? service.transitionProject(current, state, context)
      : kind === "phase"
        ? service.transitionPhase(current, state, context)
        : service.transitionTask(current, state, context);
  database.persistStateTransition(
    change,
    `p9m1-${kind}-${id}-${state.toLowerCase()}-${occurredAt.replaceAll(/[^0-9]/gu, "")}`,
  );
}

function task(id, dependencyIds = []) {
  return {
    id,
    title: `Deliver ${id}`,
    goal: `Complete ${id} with deterministic evidence.`,
    executable: true,
    dependencyIds,
    acceptanceCriteria: [`${id} writes the independently accepted output.`],
    riskLevel: "medium",
    expectedValidators: ["unit_test", "acceptance"],
  };
}

function continuousRoadmap() {
  return masterRoadmapSchema.parse({
    formatVersion: 1,
    projectGoal: "Prove deterministic continuous execution and retry recovery.",
    phases: [
      {
        id: "phase.retry",
        title: "Retry paths",
        goal: "Recover from worker and validation failures.",
        required: true,
        completionCriteria: ["Both retry paths complete with durable evidence."],
        tasks: [task("task.agent-retry"), task("task.validation-retry", ["task.agent-retry"])],
      },
      {
        id: "phase.finish",
        title: "Continuous finish",
        goal: "Cross the phase boundary without user approval.",
        required: true,
        completionCriteria: ["The second phase completes automatically."],
        tasks: [task("task.finish", ["task.validation-retry"])],
      },
    ],
  });
}

function seedContinuous(database, now) {
  const roadmap = continuousRoadmap();
  const createdAt = now();
  database.repositories.projects.create({
    id: "project-p9m1-continuous",
    name: "P9M1 continuous proof",
    state: "DRAFT",
    executionMode: "continuous",
    createdAt,
    updatedAt: createdAt,
  });
  for (const [phasePosition, phase] of roadmap.phases.entries()) {
    database.repositories.phases.create({
      id: phase.id,
      projectId: "project-p9m1-continuous",
      title: phase.title,
      state: "PENDING",
      position: phasePosition,
      createdAt,
      updatedAt: createdAt,
    });
    for (const [taskPosition, entry] of phase.tasks.entries()) {
      database.repositories.tasks.create({
        id: entry.id,
        projectId: "project-p9m1-continuous",
        phaseId: phase.id,
        title: entry.title,
        state: "PENDING",
        position: taskPosition,
        acceptanceCriteria: entry.acceptanceCriteria,
        dependencyIds: entry.dependencyIds,
        createdAt,
        updatedAt: createdAt,
      });
    }
  }
  database.persistInitialMasterRoadmap({
    projectId: "project-p9m1-continuous",
    roadmap,
    revisionNumber: 0,
    createdAt,
    updatedAt: createdAt,
  });
  transition(database, "project", "project-p9m1-continuous", "PLANNING", now);
  transition(database, "project", "project-p9m1-continuous", "READY", now);
  transition(database, "project", "project-p9m1-continuous", "RUNNING", now);
  transition(database, "phase", "phase.retry", "READY", now);
}

function phaseValidator(database, now) {
  return {
    validatorId: "p9m1-phase-validator",
    providesIndependentReview: true,
    async validate({ projectId, phase, validationEventId, workspacePath }) {
      const roadmapPhase = database.repositories.masterRoadmaps
        .findByProjectId(projectId)
        .roadmap.phases.find((entry) => entry.id === phase.id);
      assert.ok(roadmapPhase);
      const reviewId = `p9m1-review-${phase.id}`;
      await new IndependentReviewService(database, {
        now,
        workspaceFingerprint: async () => "p9m1-stable-review-context",
      }).execute({
        id: reviewId,
        projectId,
        phaseId: phase.id,
        validationEventId,
        workspacePath,
        goal: roadmapPhase.goal,
        acceptanceCriteria: roadmapPhase.completionCriteria,
        relevantDiff: "+ independently validated P9M1 fixture output",
        deterministicResults: [
          {
            validatorId: "p9m1-phase-suite",
            status: "passed",
            required: true,
            summary: "All task evidence passed.",
          },
        ],
        architectureConstraints: ["Core validation, not fake worker prose, owns completion."],
        adapter: new FakeAgentAdapter({
          now,
          finalMessage: JSON.stringify({
            verdict: "pass",
            summary: "The phase evidence is internally consistent.",
            findings: [],
            criteria: roadmapPhase.completionCriteria.map((_criterion, criterionPosition) => ({
              criterionPosition,
              assessment: "satisfied",
              rationale: "Deterministic task evidence supports the criterion.",
            })),
            confidence: 0.95,
            unknowns: [],
          }),
        }),
        reviewerRunId: `p9m1-reviewer-${phase.id}`,
      });
      return {
        passed: true,
        independentReviewId: reviewId,
        summary: "Phase suite and fresh-context review passed.",
        checks: [
          { validatorId: "p9m1-phase-suite", passed: true, summary: "All evidence passed." },
        ],
      };
    },
  };
}

function assertCoherentReplay(events) {
  assert.ok(events.length > 0, "each scenario must leave replayable facts");
  for (let index = 1; index < events.length; index += 1) {
    assert.equal(events[index].sequenceNumber, events[index - 1].sequenceNumber + 1);
    assert.ok(Date.parse(events[index].occurredAt) >= Date.parse(events[index - 1].occurredAt));
  }
}

async function runContinuousRetryScenario(cycle) {
  const fixture = createRepository(`densa-p9m1-continuous-${String(cycle)}-`, {
    "agent.txt": "baseline\n",
    "validation.txt": "baseline\n",
    "finish.txt": "baseline\n",
  });
  const now = clock(baseTime + cycle * 100_000);
  let database = DensaAdeDatabase.open(fixture.databasePath);
  seedContinuous(database, now);

  let agentAdapter;
  agentAdapter = new FakeAgentAdapter({
    now,
    scripts: [
      {
        outcome: "failed",
        error: { code: "PROCESS_FAILURE", message: "Injected retryable worker failure" },
        onExecute() {
          writeFileSync(join(fixture.workspace, "agent.txt"), "partial worker output\n", "utf8");
        },
      },
      {
        finalMessage: "Recovered worker run completed.",
        onExecute() {
          writeFileSync(join(fixture.workspace, "agent.txt"), "accepted\n", "utf8");
        },
      },
    ],
  });
  let validationAdapter;
  validationAdapter = new FakeAgentAdapter({
    now,
    scripts: [
      {
        finalMessage: "First output still needs correction.",
        onExecute() {
          writeFileSync(join(fixture.workspace, "validation.txt"), "rejected\n", "utf8");
        },
      },
      {
        finalMessage: "Corrected output completed.",
        onExecute() {
          writeFileSync(join(fixture.workspace, "validation.txt"), "accepted\n", "utf8");
        },
      },
    ],
  });
  const finishAdapter = new FakeAgentAdapter({
    now,
    finalMessage: "Continuous second phase completed.",
    onExecute() {
      writeFileSync(join(fixture.workspace, "finish.txt"), "accepted\n", "utf8");
    },
  });
  const taskInputs = new Map([
    ["task.agent-retry", { path: "agent.txt", adapter: agentAdapter }],
    ["task.validation-retry", { path: "validation.txt", adapter: validationAdapter }],
    ["task.finish", { path: "finish.txt", adapter: finishAdapter }],
  ]);
  const taskExecutor = new SingleTaskPhaseExecutor(new SingleTaskOrchestrator(database, { now }), {
    async build({ taskId }) {
      const input = taskInputs.get(taskId);
      assert.ok(input);
      return {
        workerPrompt: `Write accepted output to ${input.path}.`,
        ownedPaths: [input.path],
        intendedPaths: [input.path],
        adapter: input.adapter,
        validator: {
          validatorId: `p9m1-validator-${taskId}`,
          async validate({ workspacePath, attempt }) {
            const actual = readFileSync(join(workspacePath, input.path), "utf8");
            return {
              passed: actual === "accepted\n",
              diagnostics: {
                attemptNumber: attempt.number,
                expected: "accepted\\n",
                actual,
                failingCriterion:
                  actual === "accepted\n" ? "none" : `${input.path} was not accepted`,
              },
            };
          },
        },
      };
    },
  });

  const completed = await new ProjectExecutionOrchestrator(database, { now }).execute({
    projectId: "project-p9m1-continuous",
    workspacePath: fixture.workspace,
    gates: { outstandingUserDecisionIds: [], permissionBlockers: [] },
    taskExecutor,
    validator: phaseValidator(database, now),
    actor: "densa:p9m1-proof",
  });
  assert.equal(completed.status, "COMPLETED", JSON.stringify(completed));
  assert.equal(agentAdapter.requests.length, 2);
  assert.equal(validationAdapter.requests.length, 2);
  assert.equal(finishAdapter.requests.length, 1);
  assert.deepEqual(
    ["task.agent-retry", "task.validation-retry", "task.finish"].map(
      (taskId) => database.repositories.attempts.listByTaskId(taskId).length,
    ),
    [2, 2, 1],
  );
  const events = database.eventJournal.replay({
    projectId: "project-p9m1-continuous",
    limit: 1_000,
  });
  assertCoherentReplay(events);
  assert.equal(events.filter((event) => event.type === "PHASE_REPORT_GENERATED").length, 2);
  assert.equal(events.filter((event) => event.type === "PHASE_REPORTS_SYNCHRONIZED").length, 1);
  assert.equal(
    events.find(
      (event) => event.type === "PHASE_REPORT_GENERATED" && event.phaseId === "phase.retry",
    ).payload.portableSync,
    "deferred_until_project_boundary",
  );
  assert.equal(events.filter((event) => event.type === "VALIDATION_FAILED").length, 1);
  database.close();

  database = DensaAdeDatabase.open(fixture.databasePath);
  assert.equal(
    database.repositories.projects.findById("project-p9m1-continuous").state,
    "COMPLETED",
  );
  assert.deepEqual(
    database.repositories.phases
      .listByProjectId("project-p9m1-continuous")
      .map((phase) => phase.state),
    ["COMPLETED", "COMPLETED"],
  );
  assert.deepEqual(
    database.repositories.tasks
      .listByProjectId("project-p9m1-continuous")
      .map((entry) => entry.state),
    ["COMPLETED", "COMPLETED", "COMPLETED"],
  );
  database.close();
}

function createTaskFixture(prefix) {
  const fixture = createRepository(prefix);
  const now = clock();
  const database = DensaAdeDatabase.open(fixture.databasePath);
  const createdAt = now();
  const project = {
    id: `project-${prefix.replaceAll(/[^a-z0-9]/gu, "")}`,
    name: "P9M1 task proof",
    state: "DRAFT",
    executionMode: "continuous",
    createdAt,
    updatedAt: createdAt,
  };
  const phase = {
    id: `phase-${prefix.replaceAll(/[^a-z0-9]/gu, "")}`,
    projectId: project.id,
    title: "Failure scenario",
    state: "PENDING",
    position: 0,
    createdAt,
    updatedAt: createdAt,
  };
  const taskEntry = {
    id: `task-${prefix.replaceAll(/[^a-z0-9]/gu, "")}`,
    projectId: project.id,
    phaseId: phase.id,
    title: "Exercise durable failure handling",
    state: "PENDING",
    position: 0,
    acceptanceCriteria: ["task.txt contains accepted output"],
    dependencyIds: [],
    createdAt,
    updatedAt: createdAt,
  };
  database.repositories.projects.create(project);
  database.repositories.phases.create(phase);
  database.repositories.tasks.create(taskEntry);
  transition(database, "task", taskEntry.id, "READY", now);
  return { ...fixture, database, now, project, phase, task: taskEntry };
}

function taskRequest(fixture, adapter, validator) {
  return {
    projectId: fixture.project.id,
    taskId: fixture.task.id,
    workspacePath: fixture.workspace,
    workerPrompt: "Write accepted output to task.txt.",
    ownedPaths: ["task.txt"],
    intendedPaths: ["task.txt"],
    adapter,
    validator,
    actor: "densa:p9m1-proof",
  };
}

function startProject(fixture) {
  transition(fixture.database, "project", fixture.project.id, "PLANNING", fixture.now);
  transition(fixture.database, "project", fixture.project.id, "READY", fixture.now);
  transition(fixture.database, "project", fixture.project.id, "RUNNING", fixture.now);
}

function safePreflight(workspace, branch) {
  return {
    schemaVersion: 1,
    workspacePath: workspace,
    repository: { isGitRepository: true, isWorkTree: true, isBare: false, root: workspace },
    head: {
      commit: git(workspace, ["rev-parse", "HEAD"]).trim(),
      branch,
      detached: false,
      unborn: false,
    },
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
      reason: "Known Densa ADE run branch is safe",
    },
    automaticActionsPerformed: false,
  };
}

describe("P9M1 deterministic Continuous-mode and recovery stress harness", () => {
  test("two Continuous phases recover from agent and validation failures repeatedly", async () => {
    for (let cycle = 1; cycle <= 3; cycle += 1) await runContinuousRetryScenario(cycle);
  });

  test("four failed attempts persist diagnostics, restore Git, and end BLOCKED", async () => {
    const fixture = createTaskFixture("p9m1-four-failures-");
    const startingHead = git(fixture.workspace, ["rev-parse", "HEAD"]).trim();
    const adapter = new FakeAgentAdapter({
      now: fixture.now,
      finalMessage: "Worker completion is not acceptance evidence.",
      onExecute() {
        writeFileSync(
          join(fixture.workspace, "task.txt"),
          `invalid attempt ${String(adapter.requests.length)}\n`,
          "utf8",
        );
      },
    });
    const result = await new SingleTaskOrchestrator(fixture.database, {
      now: fixture.now,
    }).execute(
      taskRequest(fixture, adapter, {
        validatorId: "p9m1-always-fail",
        async validate({ attempt }) {
          return {
            passed: false,
            diagnostics: {
              attemptNumber: attempt.number,
              failingCriterion: "fixture output must be independently accepted",
            },
          };
        },
      }),
    );
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.attemptCount, 4);
    assert.equal(readFileSync(join(fixture.workspace, "task.txt"), "utf8"), "baseline\n");
    assert.equal(git(fixture.workspace, ["rev-parse", "HEAD"]).trim(), startingHead);
    assert.equal(git(fixture.workspace, ["status", "--porcelain"]), "");
    const events = fixture.database.eventJournal.replay({
      projectId: fixture.project.id,
      limit: 1_000,
    });
    assertCoherentReplay(events);
    assert.equal(events.filter((event) => event.type === "VALIDATION_FAILED").length, 4);
    fixture.database.close();
    const reopened = DensaAdeDatabase.open(fixture.databasePath);
    assert.equal(reopened.repositories.tasks.findById(fixture.task.id).state, "BLOCKED");
    assert.equal(reopened.repositories.attempts.listByTaskId(fixture.task.id).length, 4);
    reopened.close();
  });

  test("usage waiting survives a Core restart and auto-resumes without busy polling", async () => {
    const fixture = createTaskFixture("p9m1-usage-restart-");
    startProject(fixture);
    const limited = new FakeAgentAdapter({
      now: fixture.now,
      outcome: "failed",
      error: { code: "USAGE_LIMITED", message: "Injected structured usage limit" },
      usageState: { status: "limited" },
      onExecute() {
        writeFileSync(join(fixture.workspace, "task.txt"), "partial limited output\n", "utf8");
      },
    });
    const waiting = await new SingleTaskOrchestrator(fixture.database, {
      now: fixture.now,
    }).execute(
      taskRequest(fixture, limited, {
        validatorId: "p9m1-unused-validator",
        async validate() {
          throw new Error("usage-limited output must never reach validation");
        },
      }),
    );
    assert.equal(waiting.status, "WAITING_FOR_USAGE");
    assert.equal(readFileSync(join(fixture.workspace, "task.txt"), "utf8"), "baseline\n");

    const fakeClock = new FakeClock("2026-08-30T03:00:00.000Z");
    const branch = git(fixture.workspace, ["branch", "--show-current"]).trim();
    const serviceOptions = {
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
          return safePreflight(fixture.workspace, branch);
        },
      },
      recoveryInspector: {
        async inspect() {
          return {
            classification: "CLEANLY_IDLE",
            reason: "Rolled-back usage boundary matches the checkpoint",
            actions: ["NONE"],
            automaticActionsPerformed: false,
          };
        },
      },
    };
    const firstService = new UsageAutoResumeService(fixture.database, serviceOptions);
    const scheduled = firstService.enable({
      projectId: fixture.project.id,
      workspacePath: fixture.workspace,
      actor: "densa:p9m1-proof",
    });
    assert.equal(scheduled.status, "SCHEDULED");
    assert.equal(fakeClock.pendingCount, 1);
    firstService.dispose();
    fixture.database.close();
    assert.equal(fakeClock.pendingCount, 0);

    const reopened = DensaAdeDatabase.open(fixture.databasePath);
    const secondService = new UsageAutoResumeService(reopened, serviceOptions);
    const restored = secondService.restore(fixture.project.id);
    assert.equal(restored.status, "SCHEDULED");
    assert.equal(restored.nextProbeAt, scheduled.nextProbeAt);
    assert.equal(fakeClock.pendingCount, 1);
    fakeClock.set(Date.parse(restored.nextProbeAt));
    const resumed = await secondService.probe(fixture.project.id);
    assert.equal(resumed.status, "RESUMED");
    assert.equal(fakeClock.pendingCount, 0);
    assert.equal(reopened.repositories.projects.findById(fixture.project.id).state, "RUNNING");
    assert.equal(reopened.repositories.tasks.findById(fixture.task.id).state, "RETRYING");
    const events = reopened.eventJournal.replay({ projectId: fixture.project.id, limit: 1_000 });
    assertCoherentReplay(events);
    const types = events.map((event) => event.type);
    assert.ok(types.indexOf("USAGE_LIMIT_REACHED") < types.indexOf("USAGE_AVAILABILITY_CONFIRMED"));
    assert.ok(types.indexOf("USAGE_AVAILABILITY_CONFIRMED") < types.lastIndexOf("PROJECT_RESUMED"));
    secondService.dispose();
    reopened.close();
  });

  test("a Core restart mid-task classifies the missing worker without mutating user files", async () => {
    const fixture = createTaskFixture("p9m1-mid-task-restart-");
    startProject(fixture);
    transition(fixture.database, "phase", fixture.phase.id, "READY", fixture.now);
    transition(fixture.database, "phase", fixture.phase.id, "RUNNING", fixture.now);
    transition(fixture.database, "task", fixture.task.id, "RUNNING", fixture.now);
    const observed = await new GitWorkspaceProbe().inspect(fixture.workspace);
    assert.equal(observed.status, "available");
    fixture.database.repositories.checkpoints.create({
      id: "checkpoint-p9m1-mid-task",
      projectId: fixture.project.id,
      createdAt: fixture.now(),
      description: "Checkpoint before the simulated Core restart",
      gitHead: observed.snapshot.gitHead,
      gitStatus: observed.snapshot.gitStatus,
      workspaceFingerprint: observed.snapshot.fingerprint,
    });
    const attempt = fixture.database.repositories.attempts.create({
      id: "attempt-p9m1-mid-task",
      taskId: fixture.task.id,
      number: 1,
      startedAt: fixture.now(),
    });
    fixture.database.repositories.agentRuns.create({
      id: "run-p9m1-mid-task",
      attemptId: attempt.id,
      adapterId: "fake",
      adapterRunId: "fake-mid-task",
      processId: 9911,
      processIdentity: "p9m1-missing-worker",
      startedAt: fixture.now(),
    });
    writeFileSync(join(fixture.workspace, "user-note.txt"), "preserve through recovery\n", "utf8");
    const userContent = readFileSync(join(fixture.workspace, "user-note.txt"), "utf8");
    fixture.database.close();

    const reopened = DensaAdeDatabase.open(fixture.databasePath);
    const recovery = await new RecoveryInspector(reopened.repositories, {
      workspaceProbe: {
        async inspect() {
          return {
            status: "available",
            snapshot: {
              gitHead: observed.snapshot.gitHead,
              gitStatus: observed.snapshot.gitStatus,
              fingerprint: observed.snapshot.fingerprint,
            },
          };
        },
      },
      processProbe: {
        async inspect(processId) {
          return { processId, status: "gone" };
        },
      },
    }).inspect({ projectId: fixture.project.id, workspacePath: fixture.workspace });
    assert.equal(recovery.classification, "TASK_PROCESS_GONE");
    assert.deepEqual(recovery.taskStateRecommendation, {
      taskId: fixture.task.id,
      state: "INTERRUPTED",
    });
    assert.equal(reopened.repositories.tasks.findById(fixture.task.id).state, "RUNNING");
    assert.equal(readFileSync(join(fixture.workspace, "user-note.txt"), "utf8"), userContent);
    assertCoherentReplay(
      reopened.eventJournal.replay({ projectId: fixture.project.id, limit: 1_000 }),
    );
    reopened.close();
  });

  test("pause detects manual workspace changes and preserves them through acknowledged resume", async () => {
    const fixture = createTaskFixture("p9m1-pause-user-change-");
    startProject(fixture);
    const service = new ProjectExecutionControlService(fixture.database, {
      now: fixture.now,
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
    const request = {
      projectId: fixture.project.id,
      workspacePath: fixture.workspace,
      actor: "densa:p9m1-proof",
    };
    assert.equal((await service.pause(request)).status, "PAUSED");
    writeFileSync(join(fixture.workspace, "user-note.txt"), "manual work must survive\n", "utf8");
    const intervention = await service.resume(request);
    assert.equal(intervention.status, "INTERVENTION_REQUIRED");
    assert.deepEqual(intervention.recontextualization.changedPaths, ["user-note.txt"]);
    const resumed = await service.resume({ ...request, acknowledgeIntervention: true });
    assert.equal(resumed.status, "RESUMED");
    assert.equal(
      readFileSync(join(fixture.workspace, "user-note.txt"), "utf8"),
      "manual work must survive\n",
    );
    const events = fixture.database.eventJournal.replay({
      projectId: fixture.project.id,
      limit: 1_000,
    });
    assertCoherentReplay(events);
    assert.equal(events.filter((event) => event.type === "HUMAN_INTERVENTION_DETECTED").length, 1);
    fixture.database.close();
    const reopened = DensaAdeDatabase.open(fixture.databasePath);
    assert.equal(reopened.repositories.projects.findById(fixture.project.id).state, "RUNNING");
    assert.equal(
      readFileSync(join(fixture.workspace, "user-note.txt"), "utf8"),
      "manual work must survive\n",
    );
    reopened.close();
  });

  test("scope mutation remains unapplied until explicit approval and blocks Continuous execution", async () => {
    const fixture = createRepository("densa-p9m1-scope-approval-");
    const now = clock();
    const database = DensaAdeDatabase.open(fixture.databasePath);
    const createdAt = now();
    database.repositories.projects.create({
      id: "project-p9m1-scope",
      name: "Scope approval proof",
      state: "DRAFT",
      executionMode: "continuous",
      createdAt,
      updatedAt: createdAt,
    });
    const roadmap = masterRoadmapSchema.parse({
      formatVersion: 1,
      projectGoal: "Preserve required scope until the user approves change.",
      phases: [
        {
          id: "phase.required",
          title: "Required scope",
          goal: "Deliver the promised feature.",
          required: true,
          completionCriteria: ["The promised feature remains represented."],
          tasks: [task("task.required")],
        },
        {
          id: "phase.retained",
          title: "Retained scope",
          goal: "Keep the roadmap graph valid while approval is tested.",
          required: true,
          completionCriteria: ["A retained required phase remains."],
          tasks: [task("task.retained")],
        },
      ],
    });
    database.persistInitialMasterRoadmap({
      projectId: "project-p9m1-scope",
      roadmap,
      revisionNumber: 0,
      createdAt,
      updatedAt: createdAt,
    });
    const service = new RoadmapMutationService(database, {
      workspacePath: fixture.workspace,
      now,
      revisionIdFactory: () => "p9m1-scope-revision",
      eventIdFactory: () => "p9m1-scope-event",
    });
    await assert.rejects(
      service.apply("project-p9m1-scope", {
        operation: { kind: "remove_phase", phaseId: "phase.required" },
        classification: "scope",
        rationale: "Injected scope-removal proposal",
        actor: "densa:p9m1-proof",
        sessionId: "p9m1-scope-session",
        applicationMode: "automatic",
      }),
      /require explicit user approval/u,
    );
    assert.equal(
      database.repositories.masterRoadmaps.findByProjectId("project-p9m1-scope").revisionNumber,
      0,
    );
    assert.equal(
      database.repositories.roadmapRevisions.listByProjectId("project-p9m1-scope").length,
      0,
    );
    const blocked = await new ProjectExecutionOrchestrator(database, { now }).execute({
      projectId: "project-p9m1-scope",
      workspacePath: fixture.workspace,
      gates: { outstandingUserDecisionIds: ["decision.scope-removal"], permissionBlockers: [] },
      taskExecutor: {
        async execute() {
          throw new Error("approval gate must stop execution");
        },
      },
      validator: {
        validatorId: "unused",
        async validate() {
          throw new Error("unused");
        },
      },
      actor: "densa:p9m1-proof",
    });
    assert.equal(blocked.status, "BLOCKED");
    assert.match(blocked.reason, /decision\.scope-removal/u);
    database.close();
    const reopened = DensaAdeDatabase.open(fixture.databasePath);
    assert.equal(
      reopened.repositories.masterRoadmaps.findByProjectId("project-p9m1-scope").revisionNumber,
      0,
    );
    assert.equal(
      reopened.repositories.roadmapRevisions.listByProjectId("project-p9m1-scope").length,
      0,
    );
    reopened.close();
  });
});

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
