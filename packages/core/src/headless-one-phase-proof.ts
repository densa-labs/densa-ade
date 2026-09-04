import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { AgentAdapter } from "@densa-ade/agent-sdk";
import {
  masterRoadmapSchema,
  eventIdSchema,
  phaseIdSchema,
  projectIdSchema,
  projectSpecificationSchema,
  taskIdSchema,
  type JsonObject,
  type MasterRoadmap,
  type PhaseReport,
} from "@densa-ade/protocol";

import { FreshContextPhaseValidator, IndependentReviewService } from "./independent-review.js";
import { MasterRoadmapGenerator } from "./master-roadmap.js";
import { DensaAdeDatabase } from "./persistence/database.js";
import { PortableProjectSynchronizer } from "./persistence/portable-project.js";
import { ProjectExecutionOrchestrator } from "./execution-modes.js";
import { SingleTaskPhaseExecutor } from "./phase-orchestrator.js";
import { stateTransitionService } from "./state-transitions.js";
import { SingleTaskOrchestrator } from "./task-orchestrator.js";

const executeFile = promisify(execFile);
const ACTOR = "densa:p9m0-proof";
const PROJECT_ID = projectIdSchema.parse("p9m0-normalize-name");
const PHASE_ID = phaseIdSchema.parse("phase.implementation");
const TASK_ID = taskIdSchema.parse("task.normalize-name");
const SOURCE_PATH = "src/normalize-name.js";

const specification = projectSpecificationSchema.parse({
  formatVersion: 1,
  projectGoal:
    "Build a tiny dependency-free JavaScript normalizeName utility, delivered as exactly one phase with one executable task.",
  targetUsers: ["JavaScript developers who need stable URL-safe display-name normalization."],
  coreUserJourneys: [
    "Import normalizeName and convert a human name into a lowercase hyphenated value.",
  ],
  requiredFeatures: [
    "Trim surrounding whitespace, collapse internal whitespace, and lowercase words joined by one hyphen.",
    "Reject non-string input with TypeError.",
    "Pass the repository's node:test suite.",
  ],
  nonGoals: [
    "No CLI, package publication, transliteration, locale-specific rules, or dependencies.",
  ],
  architectureConstraints: [
    "Only src/normalize-name.js may be changed by the implementation task.",
    "Densa ADE Core validation and Git evidence, not worker prose, decide completion.",
  ],
  platformRuntimeConstraints: ["Run on the installed Node.js runtime as an ECMAScript module."],
  integrations: ["Node.js built-in test runner."],
  dataStorageNeeds: ["No runtime persistence."],
  securityPrivacyRequirements: [
    "Do not access network, credentials, or files outside the fixture.",
  ],
  uxConstraints: ["The exported function must have deterministic behavior."],
  deploymentIntent: ["Local library fixture only."],
  explicitUserDecisions: [
    { topic: "Execution mode", decision: "Use phase-by-phase mode and stop at approval." },
    { topic: "Roadmap shape", decision: "Use exactly one phase with one executable task." },
  ],
  unresolvedQuestions: [],
});

const roadmap = masterRoadmapSchema.parse({
  formatVersion: 1,
  projectGoal: specification.projectGoal,
  phases: [
    {
      id: PHASE_ID,
      title: "Implement and validate the utility",
      goal: "Deliver the complete one-function fixture with independent evidence.",
      required: true,
      completionCriteria: ["The complete node:test suite passes after the task commit."],
      tasks: [
        {
          id: TASK_ID,
          title: "Implement normalizeName",
          goal: "Replace the placeholder with the specified dependency-free implementation.",
          executable: true,
          dependencyIds: [],
          acceptanceCriteria: [
            "node --test exits successfully for all normalizeName cases.",
            "Only src/normalize-name.js is changed by the implementation task.",
          ],
          riskLevel: "low",
          expectedValidators: ["unit_test", "acceptance"],
        },
      ],
    },
  ],
});

export interface HeadlessOnePhaseProofOptions {
  readonly adapter: AgentAdapter;
  readonly temporaryBaseDirectory?: string;
  readonly retainArtifacts?: boolean;
}

export interface HeadlessOnePhaseProofResult {
  readonly verdict: "PASS" | "FAIL";
  readonly projectId: typeof PROJECT_ID;
  readonly workspacePath: string;
  readonly databasePath: string;
  readonly diagnosticsPath: string;
  readonly restartCount: number;
  readonly finalProjectState: string;
  readonly finalPhaseState: string;
  readonly finalTaskState: string;
  readonly phaseReport: PhaseReport;
  readonly taskCommitSha?: string;
  readonly gitSubjects: readonly string[];
  readonly eventCount: number;
  readonly failureReasons: readonly string[];
}

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function command(
  cwd: string,
  executable: string,
  args: readonly string[],
): Promise<CommandResult> {
  try {
    const result = await executeFile(executable, [...args], {
      cwd,
      encoding: "utf8",
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        LC_ALL: "C",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
      maxBuffer: 1024 * 1024,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message,
    };
  }
}

function clock(): () => string {
  let previous = 0;
  return () => {
    const now = Math.max(Date.now(), previous + 1);
    previous = now;
    return new Date(now).toISOString();
  };
}

async function initializeFixture(workspacePath: string): Promise<void> {
  await mkdir(join(workspacePath, "src"), { recursive: true });
  await mkdir(join(workspacePath, "test"), { recursive: true });
  await writeFile(
    join(workspacePath, "package.json"),
    `${JSON.stringify({ name: "densa-p9m0-proof", private: true, type: "module", scripts: { test: "node --test" } }, undefined, 2)}\n`,
  );
  await writeFile(
    join(workspacePath, SOURCE_PATH),
    [
      "export function normalizeName(_value) {",
      '  throw new Error("P9M0 fixture is not implemented");',
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(workspacePath, "test/normalize-name.test.js"),
    [
      'import assert from "node:assert/strict";',
      'import { test } from "node:test";',
      'import { normalizeName } from "../src/normalize-name.js";',
      "",
      'test("normalizes whitespace and case", () => {',
      '  assert.equal(normalizeName("  Ada   Lovelace  "), "ada-lovelace");',
      "});",
      "",
      'test("preserves an already normalized name", () => {',
      '  assert.equal(normalizeName("grace-hopper"), "grace-hopper");',
      "});",
      "",
      'test("rejects non-string input", () => {',
      "  assert.throws(() => normalizeName(42), TypeError);",
      "});",
      "",
    ].join("\n"),
  );
  const initialized = await command(workspacePath, "git", [
    "init",
    "--quiet",
    "--initial-branch=main",
  ]);
  if (initialized.exitCode !== 0) throw new Error(`git init failed: ${initialized.stderr}`);
  for (const [key, value] of [
    ["user.name", "Densa ADE P9M0 Proof"],
    ["user.email", "densa-p9m0@localhost"],
    ["commit.gpgsign", "false"],
  ] as const) {
    const configured = await command(workspacePath, "git", ["config", "--local", key, value]);
    if (configured.exitCode !== 0)
      throw new Error(`git config ${key} failed: ${configured.stderr}`);
  }
}

function transitionProject(
  database: DensaAdeDatabase,
  state: "PLANNING" | "READY" | "RUNNING",
  now: () => string,
): void {
  const project = database.repositories.projects.findById(PROJECT_ID);
  if (project === undefined) throw new Error("Proof project disappeared");
  const occurredAt = now();
  database.persistStateTransition(
    stateTransitionService.transitionProject(project, state, {
      actor: ACTOR,
      occurredAt,
      reason: `P9M0 proof entered ${state}`,
    }),
    eventIdSchema.parse(`p9m0-project-${state.toLowerCase()}`),
  );
}

function seedProject(
  database: DensaAdeDatabase,
  generatedRoadmap: MasterRoadmap,
  now: () => string,
): void {
  const createdAt = now();
  database.repositories.projects.create({
    id: PROJECT_ID,
    name: "Normalize name proof",
    state: "DRAFT",
    executionMode: "phase",
    createdAt,
    updatedAt: createdAt,
  });
  database.repositories.events.append({
    id: eventIdSchema.parse("p9m0-project-created"),
    projectId: PROJECT_ID,
    type: "PROJECT_CREATED",
    eventVersion: 1,
    occurredAt: createdAt,
    actor: ACTOR,
    payload: { source: "cli-proof", ideaAccepted: true },
  });
  transitionProject(database, "PLANNING", now);
  const plannedAt = now();
  database.transaction((repositories) => {
    repositories.specifications.set({
      projectId: PROJECT_ID,
      specification,
      createdAt: plannedAt,
      updatedAt: plannedAt,
    });
    for (const [phasePosition, phase] of generatedRoadmap.phases.entries()) {
      const persistedPhaseId = phaseIdSchema.parse(phase.id);
      repositories.phases.create({
        id: persistedPhaseId,
        projectId: PROJECT_ID,
        title: phase.title,
        state: "PENDING",
        position: phasePosition,
        createdAt: plannedAt,
        updatedAt: plannedAt,
      });
      for (const [taskPosition, task] of phase.tasks.entries()) {
        repositories.tasks.create({
          id: taskIdSchema.parse(task.id),
          projectId: PROJECT_ID,
          phaseId: persistedPhaseId,
          title: task.title,
          state: "PENDING",
          position: taskPosition,
          acceptanceCriteria: task.acceptanceCriteria,
          dependencyIds: task.dependencyIds.map((dependencyId) => taskIdSchema.parse(dependencyId)),
          createdAt: plannedAt,
          updatedAt: plannedAt,
        });
      }
    }
    repositories.masterRoadmaps.create({
      projectId: PROJECT_ID,
      roadmap: generatedRoadmap,
      revisionNumber: 0,
      createdAt: plannedAt,
      updatedAt: plannedAt,
    });
    repositories.events.append({
      id: eventIdSchema.parse("p9m0-roadmap-generated"),
      projectId: PROJECT_ID,
      type: "ROADMAP_GENERATED",
      eventVersion: 1,
      occurredAt: plannedAt,
      actor: ACTOR,
      payload: { phaseCount: generatedRoadmap.phases.length, executionMode: "phase" },
    });
  });
  transitionProject(database, "READY", now);
}

async function commitBaseline(workspacePath: string): Promise<string> {
  const added = await command(workspacePath, "git", [
    "add",
    ".densa-ade",
    "package.json",
    "src",
    "test",
  ]);
  if (added.exitCode !== 0) throw new Error(`git add failed: ${added.stderr}`);
  const committed = await command(workspacePath, "git", [
    "-c",
    "user.name=Densa ADE P9M0 Proof",
    "-c",
    "user.email=densa-p9m0@localhost",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "fixture: initialize one-phase project",
  ]);
  if (committed.exitCode !== 0) throw new Error(`baseline commit failed: ${committed.stderr}`);
  const head = await command(workspacePath, "git", ["rev-parse", "HEAD"]);
  if (head.exitCode !== 0) throw new Error(`git rev-parse failed: ${head.stderr}`);
  return head.stdout.trim();
}

function deterministicTaskValidator() {
  return {
    validatorId: "p9m0-node-test",
    async validate(request: { workspacePath: string }) {
      const result = await command(request.workspacePath, process.execPath, ["--test"]);
      return {
        passed: result.exitCode === 0,
        diagnostics: {
          command: [process.execPath, "--test"],
          exitCode: result.exitCode,
          stdout: result.stdout.slice(0, 16_384),
          stderr: result.stderr.slice(0, 16_384),
        } satisfies JsonObject,
      };
    },
  };
}

function deterministicPhaseValidator() {
  return {
    validatorId: "p9m0-phase-node-test",
    async validate(request: { workspacePath: string }) {
      const result = await command(request.workspacePath, process.execPath, ["--test"]);
      const passed = result.exitCode === 0;
      return {
        passed,
        summary: passed
          ? "The complete node:test suite passed."
          : "The complete node:test suite failed.",
        checks: [
          {
            validatorId: "node-test",
            passed,
            summary: passed
              ? "node --test exited 0."
              : `node --test exited ${String(result.exitCode)}: ${result.stderr.slice(0, 2_048)}`,
          },
        ],
      };
    },
  };
}

async function writeDiagnostics(
  path: string,
  result: Omit<HeadlessOnePhaseProofResult, "diagnosticsPath">,
): Promise<void> {
  await writeFile(path, `${JSON.stringify(result, undefined, 2)}\n`, { mode: 0o600 });
}

/** P9M0 executable proof of the real serial headless lifecycle on a disposable Git project. */
export async function runHeadlessOnePhaseProof(
  options: HeadlessOnePhaseProofOptions,
): Promise<HeadlessOnePhaseProofResult> {
  const temporaryRoot = await mkdtemp(
    join(options.temporaryBaseDirectory ?? tmpdir(), "densa-p9m0-"),
  );
  const workspacePath = join(temporaryRoot, "workspace");
  const databasePath = join(temporaryRoot, "state.sqlite");
  const diagnosticsPath = join(temporaryRoot, "proof-result.json");
  const failureReasons: string[] = [];
  let database: DensaAdeDatabase | undefined;
  try {
    await mkdir(workspacePath);
    await initializeFixture(workspacePath);
    const generated = await new MasterRoadmapGenerator({
      async propose() {
        return roadmap;
      },
    }).generate(specification);
    if (generated.roadmap.phases.length !== 1 || generated.schedule.length !== 1) {
      throw new Error("Proof roadmap must contain exactly one phase and one task");
    }

    const now = clock();
    database = DensaAdeDatabase.open(databasePath);
    seedProject(database, generated.roadmap, now);
    const initialSync = await new PortableProjectSynchronizer(database.repositories).synchronize(
      workspacePath,
      PROJECT_ID,
    );
    if (initialSync.status !== "synchronized")
      throw new Error("Initial portable projection conflicted");
    const startingCommit = await commitBaseline(workspacePath);

    database.close();
    database = DensaAdeDatabase.open(databasePath);
    if (
      database.repositories.specifications.findByProjectId(PROJECT_ID)?.specification
        .projectGoal !== specification.projectGoal ||
      database.repositories.masterRoadmaps.findByProjectId(PROJECT_ID)?.roadmap.phases.length !== 1
    ) {
      throw new Error("Specification or roadmap did not survive the pre-execution Core restart");
    }
    transitionProject(database, "RUNNING", now);
    const persistedPhase = database.repositories.phases.findById(PHASE_ID);
    if (persistedPhase === undefined) throw new Error("Proof phase disappeared after restart");
    database.persistStateTransition(
      stateTransitionService.transitionPhase(persistedPhase, "READY", {
        actor: ACTOR,
        occurredAt: now(),
        reason: "Phase-by-phase proof is ready to execute",
      }),
      eventIdSchema.parse("p9m0-phase-ready"),
    );

    const taskOrchestrator = new SingleTaskOrchestrator(database, { now });
    const taskExecutor = new SingleTaskPhaseExecutor(taskOrchestrator, {
      async build() {
        return {
          workerPrompt: [
            "Implement the complete normalizeName fixture task.",
            "Edit only src/normalize-name.js. Do not edit tests, package metadata, .densa-ade files, or Git metadata, and do not commit.",
            "Requirements: accept only strings; trim surrounding whitespace; split on one or more whitespace characters; lowercase each word; join words with a single hyphen; preserve already-hyphenated text; throw TypeError for non-string input.",
            "Run node --test before finishing. Your prose is not completion evidence; Densa ADE Core will validate and commit independently.",
          ].join("\n"),
          ownedPaths: [SOURCE_PATH],
          intendedPaths: [SOURCE_PATH],
          adapter: options.adapter,
          validator: deterministicTaskValidator(),
        };
      },
    });
    const reviewService = new IndependentReviewService(database, { now });
    const phaseValidator = new FreshContextPhaseValidator({
      deterministic: deterministicPhaseValidator(),
      service: reviewService,
      adapter: options.adapter,
      buildReviewInput: () => ({
        goal: roadmap.phases[0]?.goal ?? "Validate the one-phase fixture.",
        acceptanceCriteria: roadmap.phases[0]?.completionCriteria ?? [],
        relevantDiff: [
          `Validated change from ${startingCommit} to the current task commit:`,
          readFileSync(join(workspacePath, SOURCE_PATH), "utf8"),
        ].join("\n"),
        architectureConstraints: specification.architectureConstraints,
      }),
    });
    const execution = await new ProjectExecutionOrchestrator(database, { now }).execute({
      projectId: PROJECT_ID,
      workspacePath,
      gates: { outstandingUserDecisionIds: [], permissionBlockers: [] },
      taskExecutor,
      validator: phaseValidator,
      actor: ACTOR,
    });
    if (execution.status !== "AWAITING_PHASE_APPROVAL") {
      failureReasons.push(`Expected AWAITING_PHASE_APPROVAL, received ${execution.status}.`);
    }
    const phaseReport =
      execution.status === "AWAITING_PHASE_APPROVAL"
        ? execution.report
        : database.repositories.phaseReports.findByPhaseId(PHASE_ID);
    if (phaseReport === undefined)
      throw new Error("Execution stopped without a durable phase report");
    await new PortableProjectSynchronizer(database.repositories).synchronize(
      workspacePath,
      PROJECT_ID,
    );
    const completedAttempt = database.repositories.attempts
      .listByTaskId(TASK_ID)
      .findLast((attempt) => attempt.commitSha !== undefined);
    const taskCommitSha = completedAttempt?.commitSha;

    database.close();
    database = DensaAdeDatabase.open(databasePath);
    const finalProject = database.repositories.projects.findById(PROJECT_ID);
    const finalPhase = database.repositories.phases.findById(PHASE_ID);
    const finalTask = database.repositories.tasks.findById(TASK_ID);
    const persistedReport = database.repositories.phaseReports.findByPhaseId(PHASE_ID);
    const events = database.eventJournal.replay({ projectId: PROJECT_ID, limit: 1_000 });
    const gitLog = await command(workspacePath, "git", ["log", "--format=%H%x09%s"]);
    const gitSubjects = gitLog.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t").slice(1).join("\t"));
    if (finalProject?.state !== "RUNNING")
      failureReasons.push("Project did not remain RUNNING at the approval boundary.");
    if (finalPhase?.state !== "AWAITING_APPROVAL")
      failureReasons.push("Phase did not persist AWAITING_APPROVAL.");
    if (finalTask?.state !== "COMPLETED") failureReasons.push("Task did not persist COMPLETED.");
    if (persistedReport?.outcome !== "awaiting_approval")
      failureReasons.push("Phase report did not survive restart accurately.");
    if (!gitSubjects.some((subject) => subject.startsWith(`densa-ade: ${TASK_ID} `)))
      failureReasons.push("Git history does not map the task ID to its commit.");
    if (!events.some((event) => event.type === "VALIDATION_PASSED" && event.taskId === TASK_ID))
      failureReasons.push("No authoritative passing task-validation fact was persisted.");
    if (taskCommitSha === undefined) failureReasons.push("Task has no verified commit.");
    else if (
      !phaseReport.commits.some(
        (commit) => commit.taskId === TASK_ID && commit.sha === taskCommitSha,
      )
    )
      failureReasons.push("Phase report commit does not match the verified task commit.");

    const resultWithoutPath: Omit<HeadlessOnePhaseProofResult, "diagnosticsPath"> = {
      verdict: failureReasons.length === 0 ? "PASS" : "FAIL",
      projectId: PROJECT_ID,
      workspacePath,
      databasePath,
      restartCount: 2,
      finalProjectState: finalProject?.state ?? "missing",
      finalPhaseState: finalPhase?.state ?? "missing",
      finalTaskState: finalTask?.state ?? "missing",
      phaseReport: persistedReport ?? phaseReport,
      ...(taskCommitSha === undefined ? {} : { taskCommitSha }),
      gitSubjects,
      eventCount: events.length,
      failureReasons,
    };
    await writeDiagnostics(diagnosticsPath, resultWithoutPath);
    return Object.freeze({ ...resultWithoutPath, diagnosticsPath });
  } catch (error) {
    failureReasons.push(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    database?.close();
    if (options.retainArtifacts === false)
      await rm(temporaryRoot, { recursive: true, force: true });
  }
}
