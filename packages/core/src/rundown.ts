import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import process from "node:process";

import {
  isoTimestampSchema,
  projectIdSchema,
  projectRundownSchema,
  rundownGitSnapshotSchema,
  rundownPresentationPlanSchema,
  usageStateSchema,
  type DensaAdeErrorCode,
  type Phase,
  type PhaseReport,
  type ProjectId,
  type ProjectRundown,
  type RundownGitSnapshot,
  type RundownKind,
  type RundownPresentationPlan,
  type RundownReference,
  type Task,
  validationRunIdSchema,
} from "@densa-ade/protocol";

import type { DensaAdeDatabase } from "./persistence/database.js";
import { redactPortableText } from "./persistence/portable-project.js";
import { WorkspacePreflight } from "./workspace-preflight.js";

const GIT_TIMEOUT_MS = 10_000;
const GIT_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_RECENT_LIMIT = 20;
const MAX_RECENT_LIMIT = 50;

export interface GenerateProjectRundownRequest {
  readonly kind: RundownKind;
  readonly projectId: ProjectId;
  readonly workspacePath: string;
  readonly phaseId?: string;
  readonly taskId?: string;
  readonly recentLimit?: number;
}

export interface GitRundownReader {
  inspect(workspacePath: string, commitShas: readonly string[]): Promise<RundownGitSnapshot>;
}

export interface RundownPresentationPlanner {
  plan(rundown: Readonly<ProjectRundown>): Promise<unknown>;
}

export interface ProjectRundownServiceOptions {
  readonly now?: () => string;
  readonly git?: GitRundownReader;
}

export class ProjectRundownError extends Error {
  readonly code: DensaAdeErrorCode;

  constructor(code: DensaAdeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProjectRundownError";
    this.code = code;
  }
}

interface GitCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly errorCode?: string;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
}

async function runGit(cwd: string, args: readonly string[]): Promise<GitCommandResult> {
  return await new Promise<GitCommandResult>((resolve) => {
    let timedOut = false;
    const child = execFile(
      "git",
      ["-c", "core.fsmonitor=false", ...args],
      {
        cwd,
        encoding: "utf8",
        env: gitEnvironment(),
        maxBuffer: GIT_OUTPUT_LIMIT_BYTES,
      },
      (error, stdout, stderr) => {
        clearTimeout(timeoutHandle);
        const commandError = error as NodeJS.ErrnoException | null;
        resolve({
          exitCode:
            commandError === null
              ? 0
              : typeof commandError.code === "number"
                ? commandError.code
                : child.exitCode,
          stdout,
          stderr,
          timedOut,
          ...(commandError?.code === undefined || typeof commandError.code === "number"
            ? {}
            : { errorCode: commandError.code }),
        });
      },
    );
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, GIT_TIMEOUT_MS);
    timeoutHandle.unref();
  });
}

function gitFailure(command: string, result: GitCommandResult): string {
  const outcome = result.timedOut
    ? "timed out"
    : result.errorCode === undefined
      ? `exited ${String(result.exitCode)}`
      : `failed with ${result.errorCode}`;
  const detail = result.stderr.trim().slice(0, 1_024);
  return `${command} ${outcome}${detail.length === 0 ? "" : `: ${detail}`}`;
}

/** Read-only local Git inspection used only as one input to Core-owned rundown facts. */
export class LocalGitRundownReader implements GitRundownReader {
  constructor(private readonly preflight = new WorkspacePreflight()) {}

  async inspect(workspacePath: string, commitShas: readonly string[]): Promise<RundownGitSnapshot> {
    const preflight = await this.preflight.inspect(workspacePath);
    const headSha = preflight.head.commit;
    if (!preflight.repository.isGitRepository || headSha === undefined) {
      return rundownGitSnapshotSchema.parse({
        status: "unavailable",
        reason: preflight.decision.reason,
        commits: [],
      });
    }

    const commits = [];
    for (const sha of [...new Set(commitShas)].sort()) {
      if (!/^[a-fA-F0-9]{7,64}$/u.test(sha)) {
        commits.push({ sha, status: "missing" as const });
        continue;
      }
      const exists = await runGit(workspacePath, ["cat-file", "-e", `${sha}^{commit}`]);
      if (exists.exitCode === 1 || exists.exitCode === 128) {
        commits.push({ sha, status: "missing" as const });
        continue;
      }
      if (exists.exitCode !== 0) {
        throw new ProjectRundownError("GIT_FAILURE", gitFailure("git cat-file", exists));
      }
      const reachable = await runGit(workspacePath, ["merge-base", "--is-ancestor", sha, headSha]);
      if (reachable.exitCode !== 0 && reachable.exitCode !== 1) {
        throw new ProjectRundownError("GIT_FAILURE", gitFailure("git merge-base", reachable));
      }
      commits.push({
        sha,
        status: reachable.exitCode === 0 ? ("reachable" as const) : ("unreachable" as const),
      });
    }

    return rundownGitSnapshotSchema.parse({
      status: "available",
      headSha,
      ...(preflight.head.branch === undefined ? {} : { branch: preflight.head.branch }),
      dirty: preflight.changes.dirty,
      commits,
    });
  }
}

function cleanText(value: string): string {
  const clean = redactPortableText(value).replace(/\s+/gu, " ").trim();
  return clean.slice(0, 512) || "No detail was recorded.";
}

function reference(kind: RundownReference["kind"], id: string): RundownReference {
  return Object.freeze({ kind, id });
}

function referenceKey(value: RundownReference): string {
  return `${value.kind}:${value.id}`;
}

function uniqueReferences(values: readonly RundownReference[]): readonly RundownReference[] {
  const unique = new Map<string, RundownReference>();
  for (const value of values) unique.set(referenceKey(value), value);
  return Object.freeze(
    [...unique.values()].sort((left, right) =>
      referenceKey(left).localeCompare(referenceKey(right)),
    ),
  );
}

function stateCounts(
  values: readonly string[],
): readonly { readonly state: string; readonly count: number }[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.freeze(
    [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([state, count]) => Object.freeze({ state, count })),
  );
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const a = sorted(left);
  const b = sorted(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function digestFacts(facts: object): string {
  return createHash("sha256").update(JSON.stringify(facts)).digest("hex");
}

function latestFailureSummary(
  database: DensaAdeDatabase,
  failedRunIds: readonly string[],
): string | undefined {
  const latestId = failedRunIds.at(-1);
  if (latestId === undefined) return undefined;
  const result = database.repositories.validationResults
    .listByRunId(validationRunIdSchema.parse(latestId))
    .findLast((entry) => entry.status === "failed" || entry.status === "error");
  const diagnostic = result?.diagnostics.findLast((entry) => entry.severity === "error");
  return diagnostic === undefined
    ? "The latest persisted validation run failed."
    : cleanText(diagnostic.message);
}

function assertPhaseReportMatchesDatabase(
  report: PhaseReport,
  phase: Phase,
  tasks: readonly Task[],
  database: DensaAdeDatabase,
): string[] {
  if (report.projectId !== phase.projectId || report.phaseId !== phase.id) {
    throw new ProjectRundownError(
      "INTERNAL_INVARIANT_VIOLATION",
      "Phase report project/phase identity disagrees with authoritative state",
    );
  }
  const expectedState =
    report.outcome === "blocked"
      ? ["BLOCKED"]
      : report.outcome === "awaiting_approval"
        ? ["AWAITING_APPROVAL", "COMPLETED"]
        : ["COMPLETED"];
  if (!expectedState.includes(phase.state)) {
    throw new ProjectRundownError(
      "INTERNAL_INVARIANT_VIOLATION",
      `Phase report outcome ${report.outcome} disagrees with phase state ${phase.state}`,
    );
  }

  const completedTaskIds = tasks
    .filter((task) => task.state === "COMPLETED")
    .map((task) => task.id);
  if (
    !sameStrings(
      report.tasksCompleted.map((task) => task.taskId),
      completedTaskIds,
    )
  ) {
    throw new ProjectRundownError(
      "INTERNAL_INVARIANT_VIOLATION",
      "Phase report completed tasks disagree with authoritative task state",
    );
  }
  for (const entry of report.tasksCompleted) {
    if (database.repositories.attempts.listByTaskId(entry.taskId).length !== entry.attemptCount) {
      throw new ProjectRundownError(
        "INTERNAL_INVARIANT_VIOLATION",
        `Phase report attempt count disagrees for task ${entry.taskId}`,
      );
    }
  }

  const expectedCommits = tasks.flatMap((task) =>
    database.repositories.attempts
      .listByTaskId(task.id)
      .flatMap((attempt) => (attempt.commitSha === undefined ? [] : [attempt.commitSha])),
  );
  if (
    !sameStrings(
      report.commits.map((commit) => commit.sha),
      expectedCommits,
    )
  ) {
    throw new ProjectRundownError(
      "INTERNAL_INVARIANT_VIOLATION",
      "Phase report commits disagree with authoritative attempt metadata",
    );
  }

  const validationRunIds: string[] = [];
  const reportChecks = report.validations.filter((check) => check.scope === "task");
  const expectedChecks = tasks.flatMap((task) =>
    database.repositories.validationRuns
      .listByTaskId(task.id)
      .filter((run) => run.passed !== undefined),
  );
  if (reportChecks.length !== expectedChecks.length) {
    throw new ProjectRundownError(
      "INTERNAL_INVARIANT_VIOLATION",
      "Phase report validation count disagrees with authoritative validation runs",
    );
  }
  for (const run of expectedChecks) {
    const check = reportChecks.find((candidate) =>
      candidate.validationRunId === undefined
        ? candidate.taskId === run.taskId &&
          candidate.validatorId === run.validatorId &&
          candidate.passed === run.passed &&
          candidate.startedAt === run.startedAt &&
          candidate.completedAt === run.completedAt
        : candidate.validationRunId === run.id,
    );
    if (check === undefined || check.passed !== run.passed) {
      throw new ProjectRundownError(
        "INTERNAL_INVARIANT_VIOLATION",
        `Phase report validation facts disagree for run ${run.id}`,
      );
    }
    const resultIds = database.repositories.validationResults
      .listByRunId(run.id)
      .map((result) => result.id);
    if (
      check.validationResultIds.length > 0 &&
      !sameStrings(check.validationResultIds, resultIds)
    ) {
      throw new ProjectRundownError(
        "INTERNAL_INVARIANT_VIOLATION",
        `Phase report validator-result references disagree for run ${run.id}`,
      );
    }
    validationRunIds.push(run.id);
  }

  const expectedValidationEventType =
    report.phaseValidation.status === "passed"
      ? "PHASE_VALIDATION_PASSED"
      : report.phaseValidation.status === "failed"
        ? "PHASE_VALIDATION_FAILED"
        : "PHASE_VALIDATION_SKIPPED";
  const startedEvent = database.eventJournal
    .replay({
      projectId: report.projectId,
      phaseId: report.phaseId,
      types: ["PHASE_STATE_CHANGED"],
      limit: 1_000,
    })
    .find(
      (event) => event.occurredAt === report.phaseStartedAt && event.payload["state"] === "RUNNING",
    );
  const validationEvent = database.eventJournal
    .replay({
      projectId: report.projectId,
      phaseId: report.phaseId,
      types: [expectedValidationEventType],
      limit: 1_000,
    })
    .findLast((event) => event.occurredAt === report.generatedAt);
  const reportEvent = database.eventJournal
    .replay({
      projectId: report.projectId,
      phaseId: report.phaseId,
      types: ["PHASE_REPORT_GENERATED"],
      limit: 1_000,
    })
    .findLast((event) => event.occurredAt === report.generatedAt);
  if (
    startedEvent === undefined ||
    validationEvent === undefined ||
    reportEvent === undefined ||
    validationEvent.payload["status"] !== report.phaseValidation.status ||
    validationEvent.payload["validatorId"] !== report.phaseValidation.validatorId ||
    reportEvent.payload["outcome"] !== report.outcome ||
    reportEvent.payload["reportPath"] !== report.reportPath
  ) {
    throw new ProjectRundownError(
      "INTERNAL_INVARIANT_VIOLATION",
      "Phase report has no matching durable validation/report events",
    );
  }
  return sorted(validationRunIds);
}

function assertGitVerifiesReport(report: PhaseReport, git: RundownGitSnapshot): void {
  if (git.status !== "available") {
    throw new ProjectRundownError(
      "GIT_FAILURE",
      `Cannot verify phase report Git facts: ${git.reason}`,
    );
  }
  const bySha = new Map(git.commits.map((commit) => [commit.sha, commit.status]));
  for (const commit of report.commits) {
    if (bySha.get(commit.sha) !== "reachable") {
      throw new ProjectRundownError(
        "INTERNAL_INVARIANT_VIOLATION",
        `Phase report commit ${commit.sha} is not reachable from the inspected Git HEAD`,
      );
    }
  }
}

/** Generates immutable, human-renderable P8M3 facts without consulting conversational memory. */
export class ProjectRundownService {
  readonly #now: () => string;
  readonly #git: GitRundownReader;

  constructor(
    private readonly database: DensaAdeDatabase,
    options: ProjectRundownServiceOptions = {},
  ) {
    const clock = options.now ?? (() => new Date().toISOString());
    this.#now = () => isoTimestampSchema.parse(clock());
    this.#git = options.git ?? new LocalGitRundownReader();
  }

  async generate(request: GenerateProjectRundownRequest): Promise<ProjectRundown> {
    const projectId = projectIdSchema.parse(request.projectId);
    if (!isAbsolute(request.workspacePath)) {
      throw new ProjectRundownError(
        "USER_CONFIGURATION_ERROR",
        "Project rundown workspace path must be absolute",
      );
    }
    const recentLimit = request.recentLimit ?? DEFAULT_RECENT_LIMIT;
    if (!Number.isInteger(recentLimit) || recentLimit < 1 || recentLimit > MAX_RECENT_LIMIT) {
      throw new ProjectRundownError(
        "USER_CONFIGURATION_ERROR",
        `Project rundown recent limit must be between 1 and ${String(MAX_RECENT_LIMIT)}`,
      );
    }
    const project = this.database.repositories.projects.findById(projectId);
    if (project === undefined) {
      throw new ProjectRundownError(
        "USER_CONFIGURATION_ERROR",
        `Project ${projectId} does not exist`,
      );
    }
    if (request.kind === "blocked_project" && project.state !== "BLOCKED") {
      throw new ProjectRundownError(
        "USER_CONFIGURATION_ERROR",
        `Blocked-project rundown requires BLOCKED state, not ${project.state}`,
      );
    }
    if (request.kind === "usage_waiting" && project.state !== "WAITING_FOR_USAGE") {
      throw new ProjectRundownError(
        "USER_CONFIGURATION_ERROR",
        `Usage-waiting rundown requires WAITING_FOR_USAGE state, not ${project.state}`,
      );
    }
    const allPhases = this.database.repositories.phases.listByProjectId(projectId);
    const requestedPhase =
      request.phaseId === undefined
        ? undefined
        : allPhases.find((phase) => phase.id === request.phaseId);
    if (request.phaseId !== undefined && requestedPhase === undefined) {
      throw new ProjectRundownError(
        "USER_CONFIGURATION_ERROR",
        `Phase ${request.phaseId} does not belong to project ${projectId}`,
      );
    }
    const allTasks = this.database.repositories.tasks.listByProjectId(projectId);
    const requestedTask =
      request.taskId === undefined
        ? undefined
        : allTasks.find((task) => task.id === request.taskId);
    if (
      request.taskId !== undefined &&
      (requestedTask === undefined ||
        (requestedPhase !== undefined && requestedTask.phaseId !== requestedPhase.id))
    ) {
      throw new ProjectRundownError(
        "USER_CONFIGURATION_ERROR",
        `Task ${request.taskId} does not belong to the requested project scope`,
      );
    }
    if (request.kind === "phase_completion" && requestedPhase === undefined) {
      throw new ProjectRundownError(
        "USER_CONFIGURATION_ERROR",
        "Phase-completion rundowns require a phaseId",
      );
    }

    const phases = requestedPhase === undefined ? allPhases : [requestedPhase];
    const tasks =
      requestedTask === undefined
        ? requestedPhase === undefined
          ? allTasks
          : allTasks.filter((task) => task.phaseId === requestedPhase.id)
        : [requestedTask];
    const taskIds = new Set(tasks.map((task) => task.id));
    const validationRuns = tasks.flatMap((task) =>
      this.database.repositories.validationRuns.listByTaskId(task.id),
    );
    const validationResults = new Map(
      validationRuns.map((run) => [
        run.id,
        this.database.repositories.validationResults.listByRunId(run.id),
      ]),
    );
    const attempts = new Map(
      tasks.map((task) => [task.id, this.database.repositories.attempts.listByTaskId(task.id)]),
    );
    const commitShas = sorted(
      tasks.flatMap((task) =>
        (attempts.get(task.id) ?? []).flatMap((attempt) =>
          attempt.commitSha === undefined ? [] : [attempt.commitSha],
        ),
      ),
    );
    const git = await this.#git.inspect(request.workspacePath, commitShas);

    let phaseReport: ProjectRundown["phaseReport"];
    if (requestedPhase !== undefined) {
      const report = this.database.repositories.phaseReports.findByPhaseId(requestedPhase.id);
      if (request.kind === "phase_completion" && report === undefined) {
        throw new ProjectRundownError(
          "INTERNAL_INVARIANT_VIOLATION",
          `Phase ${requestedPhase.id} has no durable completion report`,
        );
      }
      if (request.kind === "phase_completion" && report?.outcome === "blocked") {
        throw new ProjectRundownError(
          "USER_CONFIGURATION_ERROR",
          `Phase ${requestedPhase.id} has a blocked report, not a completion report`,
        );
      }
      if (report !== undefined) {
        const reportTasks = allTasks.filter((task) => task.phaseId === requestedPhase.id);
        const validationRunIds = assertPhaseReportMatchesDatabase(
          report,
          requestedPhase,
          reportTasks,
          this.database,
        );
        assertGitVerifiesReport(report, git);
        phaseReport = Object.freeze({
          phaseId: report.phaseId,
          reportPath: report.reportPath,
          outcome: report.outcome,
          generatedAt: report.generatedAt,
          verification: "verified" as const,
          taskIds: sorted(report.tasksCompleted.map((task) => task.taskId)),
          validationRunIds,
          commitShas: sorted(report.commits.map((commit) => commit.sha)),
        });
      }
    }

    const latestEvent = this.database.repositories.events.latest(projectId);
    const afterSequence = Math.max(
      0,
      (latestEvent?.sequenceNumber ?? 0) - Math.max(recentLimit * 4, recentLimit),
    );
    const recentEvents = this.database.eventJournal
      .replay({ projectId, afterSequence, limit: recentLimit * 4 })
      .filter(
        (event) =>
          requestedPhase === undefined ||
          event.phaseId === undefined ||
          event.phaseId === requestedPhase.id,
      )
      .filter(
        (event) =>
          requestedTask === undefined ||
          event.taskId === undefined ||
          event.taskId === requestedTask.id,
      )
      .slice(-recentLimit);
    const decisions = this.database.repositories.decisions.listByProjectId(projectId);
    const revisions = this.database.repositories.roadmapRevisions.listByProjectId(projectId);
    const recentChanges = [
      ...recentEvents.map((event) => ({
        kind: "event" as const,
        id: event.id,
        occurredAt: event.occurredAt,
        summary: cleanText(
          typeof event.payload["reason"] === "string" ? event.payload["reason"] : event.type,
        ),
        references: uniqueReferences([
          reference("event", event.id),
          ...(event.phaseId === undefined ? [] : [reference("phase", event.phaseId)]),
          ...(event.taskId === undefined ? [] : [reference("task", event.taskId)]),
        ]),
      })),
      ...decisions.map((decision) => ({
        kind: "decision" as const,
        id: decision.id,
        occurredAt: decision.createdAt,
        summary: cleanText(`${decision.title}: ${decision.rationale}`),
        references: [reference("decision", decision.id)],
      })),
      ...revisions.map((revision) => ({
        kind: "roadmap_revision" as const,
        id: revision.id,
        occurredAt: revision.createdAt,
        summary: cleanText(revision.reason),
        references: [reference("roadmap_revision", revision.id)],
      })),
    ]
      .sort((left, right) =>
        left.occurredAt === right.occurredAt
          ? left.id.localeCompare(right.id)
          : left.occurredAt.localeCompare(right.occurredAt),
      )
      .slice(-recentLimit);

    const retryHistory = tasks.flatMap((task) => {
      const taskAttempts = attempts.get(task.id) ?? [];
      const failedRuns = validationRuns.filter(
        (run) => run.taskId === task.id && run.passed === false,
      );
      if (taskAttempts.length <= 1 && failedRuns.length === 0) return [];
      const failureSummary = latestFailureSummary(
        this.database,
        failedRuns.map((run) => run.id),
      );
      return [
        Object.freeze({
          taskId: task.id,
          attemptCount: taskAttempts.length,
          attemptIds: taskAttempts.map((attempt) => attempt.id),
          failedValidationCount: failedRuns.length,
          failedValidationRunIds: failedRuns.map((run) => run.id),
          ...(failureSummary === undefined ? {} : { latestFailureSummary: failureSummary }),
        }),
      ];
    });

    const usageEvent = this.database.eventJournal
      .replay({ projectId, types: ["USAGE_LIMIT_REACHED"], limit: 1_000 })
      .findLast((event) => event.taskId === undefined || taskIds.has(event.taskId));
    const parsedUsage = usageStateSchema.safeParse(usageEvent?.payload["usageState"]);
    const usage: ProjectRundown["usage"] =
      project.state !== "WAITING_FOR_USAGE"
        ? { status: "not_waiting" }
        : usageEvent === undefined || !parsedUsage.success || parsedUsage.data.status !== "limited"
          ? {
              status: "unknown",
              reason: "Persisted usage-wait state has no reliable matching usage-limit evidence.",
              ...(usageEvent === undefined ? {} : { sourceEventId: usageEvent.id }),
            }
          : {
              status: "limited",
              sourceEventId: usageEvent.id,
              ...(usageEvent.taskId === undefined ? {} : { taskId: usageEvent.taskId }),
              resetAt:
                parsedUsage.data.resetAt === undefined
                  ? {
                      status: "unknown",
                      reason: "The provider did not report a reset time.",
                    }
                  : { status: "known", value: parsedUsage.data.resetAt },
            };

    const validation = {
      runCount: validationRuns.length,
      passedCount: validationRuns.filter((run) => run.passed === true).length,
      failedCount: validationRuns.filter((run) => run.passed === false).length,
      incompleteCount: validationRuns.filter((run) => run.passed === undefined).length,
      resultCount: [...validationResults.values()].reduce(
        (count, results) => count + results.length,
        0,
      ),
      runs: validationRuns.map((run) => ({
        id: run.id,
        taskId: run.taskId,
        validatorId: cleanText(run.validatorId),
        status:
          run.passed === undefined
            ? ("incomplete" as const)
            : run.passed
              ? ("passed" as const)
              : ("failed" as const),
        resultIds: (validationResults.get(run.id) ?? []).map((result) => result.id),
      })),
    };
    const references = uniqueReferences([
      reference("project", project.id),
      ...phases.map((phase) => reference("phase", phase.id)),
      ...tasks.map((task) => reference("task", task.id)),
      ...validationRuns.map((run) => reference("validation_run", run.id)),
      ...[...validationResults.values()].flatMap((results) =>
        results.map((result) => reference("validation_result", result.id)),
      ),
      ...tasks.flatMap((task) =>
        (attempts.get(task.id) ?? []).map((attempt) => reference("attempt", attempt.id)),
      ),
      ...decisions.map((decision) => reference("decision", decision.id)),
      ...recentEvents.map((event) => reference("event", event.id)),
      ...revisions.map((revision) => reference("roadmap_revision", revision.id)),
      ...commitShas.map((sha) => reference("git_commit", sha)),
      ...(phaseReport === undefined ? [] : [reference("phase_report", phaseReport.phaseId)]),
    ]);
    const facts = {
      formatVersion: 1 as const,
      kind: request.kind,
      generatedAt: this.#now(),
      project: {
        id: project.id,
        name: cleanText(project.name),
        state: project.state,
        executionMode: project.executionMode,
        updatedAt: project.updatedAt,
      },
      scope: {
        ...(requestedPhase === undefined ? {} : { phaseId: requestedPhase.id }),
        ...(requestedTask === undefined ? {} : { taskId: requestedTask.id }),
      },
      phaseStateCounts: stateCounts(phases.map((phase) => phase.state)),
      taskStateCounts: stateCounts(tasks.map((task) => task.state)),
      validation,
      git,
      usage,
      activeDecisionIds: sorted(
        decisions.filter((decision) => decision.status === "active").map((decision) => decision.id),
      ),
      ...(phaseReport === undefined ? {} : { phaseReport }),
      recentChanges,
      retryHistory,
      drillDownReferences: references,
    };
    return projectRundownSchema.parse({ ...facts, factsDigest: digestFacts(facts) });
  }
}

function countLine(label: string, counts: ProjectRundown["taskStateCounts"]): string {
  const total = counts.reduce((sum, entry) => sum + entry.count, 0);
  const detail = counts.map((entry) => `${entry.state}=${String(entry.count)}`).join(", ");
  return `- ${label}: ${String(total)}${detail.length === 0 ? "" : ` (${detail})`}`;
}

/** Deterministic prose: every number is interpolated by Core from validated facts. */
export function renderProjectRundown(
  rundown: ProjectRundown,
  plan?: RundownPresentationPlan,
): string {
  const parsed = projectRundownSchema.parse(rundown);
  if (plan !== undefined && plan.factsDigest !== parsed.factsDigest) {
    throw new ProjectRundownError(
      "INTERNAL_INVARIANT_VIOLATION",
      "Rundown presentation plan targets a different fact snapshot",
    );
  }
  const availableReferences = new Set(parsed.drillDownReferences.map(referenceKey));
  if (
    plan?.highlightedReferences.some((entry) => !availableReferences.has(referenceKey(entry))) ===
    true
  ) {
    throw new ProjectRundownError(
      "INTERNAL_INVARIANT_VIOLATION",
      "Rundown presentation plan cites a fact outside the authoritative snapshot",
    );
  }
  const lines = [
    `# ${parsed.kind.replaceAll("_", " ")}: ${parsed.project.name}`,
    "",
    `- Project: \`${parsed.project.id}\``,
    `- State: \`${parsed.project.state}\``,
    `- Execution mode: \`${parsed.project.executionMode}\``,
    countLine("Phases", parsed.phaseStateCounts),
    countLine("Tasks", parsed.taskStateCounts),
    `- Validation runs: ${String(parsed.validation.runCount)} (passed=${String(parsed.validation.passedCount)}, failed=${String(parsed.validation.failedCount)}, incomplete=${String(parsed.validation.incompleteCount)}; results=${String(parsed.validation.resultCount)})`,
  ];
  if (parsed.git.status === "available") {
    lines.push(
      `- Git: \`${parsed.git.headSha}\`${parsed.git.branch === undefined ? "" : ` on \`${parsed.git.branch}\``}; workspace ${parsed.git.dirty ? "dirty" : "clean"}.`,
    );
  } else lines.push(`- Git: unavailable — ${parsed.git.reason}`);
  if (parsed.usage.status === "limited") {
    lines.push(
      `- Usage: waiting; reset ${parsed.usage.resetAt.status === "known" ? parsed.usage.resetAt.value : `unknown (${parsed.usage.resetAt.reason})`}.`,
    );
  } else if (parsed.usage.status === "unknown") {
    lines.push(`- Usage: unknown — ${parsed.usage.reason}`);
  }
  if (parsed.phaseReport !== undefined) {
    lines.push(
      `- Phase report: \`${parsed.phaseReport.phaseId}\` ${parsed.phaseReport.outcome}; ${String(parsed.phaseReport.taskIds.length)} completed tasks, ${String(parsed.phaseReport.validationRunIds.length)} validation runs, ${String(parsed.phaseReport.commitShas.length)} Git commits; DB/Git/validation facts verified.`,
    );
  }
  lines.push("", "## Retry and failure history", "");
  lines.push(
    ...(parsed.retryHistory.length === 0
      ? ["- No retries or persisted validation failures in scope."]
      : parsed.retryHistory.map(
          (entry) =>
            `- \`${entry.taskId}\`: ${String(entry.attemptCount)} attempts; ${String(entry.failedValidationCount)} failed validation runs${entry.latestFailureSummary === undefined ? "." : ` — ${entry.latestFailureSummary}`}`,
        )),
  );
  lines.push("", "## Recent changes", "");
  lines.push(
    ...(parsed.recentChanges.length === 0
      ? ["- No recent persisted changes in scope."]
      : parsed.recentChanges.map(
          (change) => `- \`${change.kind}:${change.id}\` — ${change.summary}`,
        )),
  );
  const highlighted = plan?.highlightedReferences ?? [];
  if (highlighted.length > 0) {
    lines.push("", "## Master-selected drill-downs", "");
    lines.push(...highlighted.map((entry) => `- \`${referenceKey(entry)}\``));
  }
  lines.push("", "## Drill-down references", "");
  lines.push(...parsed.drillDownReferences.map((entry) => `- \`${referenceKey(entry)}\``), "");
  return lines.join("\n");
}

/** Validates a Master-selected emphasis plan without accepting prose or replacement facts. */
export async function presentProjectRundown(
  rundown: ProjectRundown,
  planner: RundownPresentationPlanner,
): Promise<string> {
  const parsed = projectRundownSchema.parse(rundown);
  const plan = rundownPresentationPlanSchema.parse(await planner.plan(parsed));
  if (plan.factsDigest !== parsed.factsDigest) {
    throw new ProjectRundownError(
      "INTERNAL_INVARIANT_VIOLATION",
      "Master rundown plan does not match the authoritative fact digest",
    );
  }
  const available = new Set(parsed.drillDownReferences.map(referenceKey));
  if (plan.highlightedReferences.some((entry) => !available.has(referenceKey(entry)))) {
    throw new ProjectRundownError(
      "INTERNAL_INVARIANT_VIOLATION",
      "Master rundown plan cites a fact outside the authoritative snapshot",
    );
  }
  return renderProjectRundown(parsed, plan);
}
