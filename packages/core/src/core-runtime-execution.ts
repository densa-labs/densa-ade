import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  isTerminalAgentEvent,
  type AgentAdapter,
  type AgentRunRequest,
} from "@densa-ade/agent-sdk";
import {
  eventIdSchema,
  type JsonObject,
  type PhaseId,
  type ProjectId,
  type TaskId,
} from "@densa-ade/protocol";

import {
  ProjectExecutionControlService,
  type ControlledProjectLifecycleResult,
} from "./execution-control.js";
import {
  FreshContextPhaseValidator,
  FreshContextTaskLifecycleValidator,
  IndependentReviewService,
} from "./independent-review.js";
import type { DensaAdeDatabase } from "./persistence/database.js";
import { PortableProjectSynchronizer } from "./persistence/portable-project.js";
import {
  type AuthorizedOperationContext,
  evaluatePermissionPolicy,
  PermissionPolicyService,
} from "./permission-policy.js";
import {
  type PhaseTaskExecutionDetails,
  SingleTaskPhaseExecutor,
  type PhaseValidationOutcome,
  type PhaseValidationRequest,
} from "./phase-orchestrator.js";
import { ProjectValidationDetector } from "./project-validation-detector.js";
import { redactSensitiveText } from "./secret-redaction.js";
import { stateTransitionService } from "./state-transitions.js";
import type { SchedulerGateSnapshot } from "./scheduler.js";
import { TaskPacketBuilder, renderTaskPacketPrompt } from "./task-packet.js";
import {
  SingleTaskOrchestrator,
  type TaskLifecycleValidationRequest,
} from "./task-orchestrator.js";
import { runProofCommand } from "./task-proof-harness.js";
import { normalizePaths } from "./workspace-path-evidence.js";

const VALIDATION_TIMEOUT_MS = 5 * 60 * 1_000;
const DIAGNOSTIC_LIMIT = 4_096;
const SCOPE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ownedPaths", "intendedPaths"],
  properties: {
    ownedPaths: {
      type: "array",
      minItems: 1,
      maxItems: 64,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 512 },
    },
    intendedPaths: {
      type: "array",
      minItems: 1,
      maxItems: 64,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 512 },
    },
  },
} as const satisfies JsonObject;

const GLOBAL_CONSTRAINT_FIELDS = [
  "nonGoals",
  "architectureConstraints",
  "platformRuntimeConstraints",
  "integrations",
  "dataStorageNeeds",
  "securityPrivacyRequirements",
  "uxConstraints",
  "deploymentIntent",
] as const;

export interface CoreRuntimeExecutionRequest {
  readonly projectId: ProjectId;
  readonly workspacePath: string;
  readonly actor: string;
  readonly gates: SchedulerGateSnapshot;
  readonly signal?: AbortSignal;
  readonly phaseApproval?: Readonly<{ phaseId: PhaseId }>;
  readonly guidedTaskApproval?: Readonly<{ taskId: TaskId }>;
  readonly gitAuthorization?: AuthorizedOperationContext;
}

function bounded(value: string): string {
  const safe = redactSensitiveText(value);
  return safe.length <= DIAGNOSTIC_LIMIT
    ? safe
    : `${safe.slice(0, DIAGNOSTIC_LIMIT - 16)}...[truncated]`;
}

function validScope(value: unknown): value is {
  readonly ownedPaths: readonly string[];
  readonly intendedPaths: readonly string[];
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => key !== "ownedPaths" && key !== "intendedPaths") ||
    !Array.isArray(record["ownedPaths"]) ||
    !Array.isArray(record["intendedPaths"]) ||
    record["ownedPaths"].some((path) => typeof path !== "string") ||
    record["intendedPaths"].some((path) => typeof path !== "string")
  ) {
    return false;
  }
  const owned = normalizePaths(record["ownedPaths"] as string[]);
  const intended = normalizePaths(record["intendedPaths"] as string[]);
  return (
    owned !== undefined &&
    intended !== undefined &&
    owned.length <= 64 &&
    intended.length <= 64 &&
    intended.every((path) => owned.includes(path))
  );
}

async function proposeScope(
  adapter: AgentAdapter,
  request: AgentRunRequest,
): Promise<{ readonly ownedPaths: readonly string[]; readonly intendedPaths: readonly string[] }> {
  let terminalCount = 0;
  let finalMessage: string | undefined;
  let failure: string | undefined;
  for await (const event of adapter.execute(request)) {
    if (!isTerminalAgentEvent(event)) continue;
    terminalCount += 1;
    if (event.outcome === "succeeded") finalMessage = event.finalMessage;
    else failure = event.error?.message ?? `Scope planner ended ${event.outcome}`;
  }
  if (terminalCount !== 1 || failure !== undefined || finalMessage === undefined) {
    throw new Error(
      bounded(
        failure ??
          `Task scope planner produced ${String(terminalCount)} terminal events without a result`,
      ),
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(finalMessage);
  } catch {
    throw new Error("Task scope planner did not return one exact JSON document");
  }
  if (!validScope(parsed)) {
    throw new Error("Task scope planner returned invalid or over-broad workspace-relative paths");
  }
  return {
    ownedPaths: normalizePaths(parsed.ownedPaths)!,
    intendedPaths: normalizePaths(parsed.intendedPaths)!,
  };
}

async function validationEvidence(workspacePath: string): Promise<{
  readonly passed: boolean;
  readonly summaries: readonly string[];
}> {
  const plan = await new ProjectValidationDetector().detect({ workspacePath });
  if (plan.status !== "detected" || plan.commands.length === 0) {
    return {
      passed: false,
      summaries: [
        `No safe deterministic validation command was available: ${
          plan.issues.map((issue) => issue.code).join(", ") || "unknown project ecosystem"
        }`,
      ],
    };
  }
  const summaries: string[] = [];
  let passed = true;
  for (const command of plan.commands) {
    const result = await runProofCommand(
      command.argv[0]!,
      command.argv.slice(1),
      resolve(workspacePath, command.cwd),
      VALIDATION_TIMEOUT_MS,
    );
    const commandPassed =
      result.timedOut !== true && result.error === undefined && result.exitCode === 0;
    passed &&= commandPassed;
    summaries.push(
      commandPassed
        ? `${command.id} passed`
        : bounded(
            `${command.id} failed: ${result.error?.message ?? result.stderr ?? `exit ${String(result.exitCode)}`}`,
          ),
    );
  }
  return { passed, summaries };
}

async function changedPaths(workspacePath: string): Promise<readonly string[]> {
  const [tracked, untracked] = await Promise.all([
    runProofCommand(
      "git",
      ["diff", "--name-only", "-z", "HEAD", "--"],
      workspacePath,
      VALIDATION_TIMEOUT_MS,
    ),
    runProofCommand(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z", "--"],
      workspacePath,
      VALIDATION_TIMEOUT_MS,
    ),
  ]);
  if (
    tracked.timedOut ||
    untracked.timedOut ||
    tracked.error !== undefined ||
    untracked.error !== undefined ||
    tracked.exitCode !== 0 ||
    untracked.exitCode !== 0
  ) {
    throw new Error("Could not inspect the complete worker change set");
  }
  return Object.freeze(
    [...new Set(`${tracked.stdout}\0${untracked.stdout}`.split("\0").filter(Boolean))].sort(),
  );
}

function taskValidator(
  database: DensaAdeDatabase,
  adapter: AgentAdapter,
  ownedPaths: readonly string[],
) {
  const independentReviews = new IndependentReviewService(database);
  return new FreshContextTaskLifecycleValidator({
    deterministic: {
      validatorId: "runtime-deterministic-validation",
      async validate(request: TaskLifecycleValidationRequest) {
        const paths = await changedPaths(request.workspacePath);
        const unexpected = paths.filter((path) => !ownedPaths.includes(path));
        const evidence = await validationEvidence(request.workspacePath);
        return {
          passed: evidence.passed && unexpected.length === 0,
          diagnostics: {
            commands: [...evidence.summaries],
            changedPaths: [...paths],
            unexpectedPaths: [...unexpected],
          },
        };
      },
    },
    service: independentReviews,
    adapter,
    buildReviewInput: (request) => {
      const implementingWorkerRunId = database.repositories.agentRuns.findByAttemptId(
        request.attempt.id,
      )?.adapterRunId;
      return {
        goal: request.task.title,
        relevantDiff:
          "Core-observed changed paths before task commit:\n" +
          ownedPaths.map((path) => `- ${path}`).join("\n"),
        architectureConstraints:
          database.repositories.specifications.findByProjectId(request.projectId)?.specification
            .architectureConstraints ?? [],
        ...(implementingWorkerRunId === undefined ? {} : { implementingWorkerRunId }),
      };
    },
  });
}

function phaseValidator(database: DensaAdeDatabase, adapter: AgentAdapter) {
  return new FreshContextPhaseValidator({
    deterministic: {
      validatorId: "runtime-phase-validation",
      async validate(request: PhaseValidationRequest): Promise<PhaseValidationOutcome> {
        const evidence = await validationEvidence(request.workspacePath);
        return {
          passed: evidence.passed,
          summary: evidence.summaries.join("; "),
          checks: evidence.summaries.map((summary, index) => ({
            validatorId: `runtime-phase-command-${String(index + 1)}`,
            passed: !summary.includes(" failed:"),
            summary,
          })),
        };
      },
    },
    service: new IndependentReviewService(database),
    adapter,
    buildReviewInput: (request) => ({
      goal: request.phase.title,
      acceptanceCriteria:
        database.repositories.masterRoadmaps
          .findByProjectId(request.projectId)
          ?.roadmap.phases.find((phase) => phase.id === request.phase.id)?.completionCriteria ?? [],
      relevantDiff: request.tasks.map((task) => `${task.id}: ${task.state}`).join("\n"),
      architectureConstraints:
        database.repositories.specifications.findByProjectId(request.projectId)?.specification
          .architectureConstraints ?? [],
    }),
  });
}

/**
 * Composes the already-audited scheduler, task lifecycle, Git checkpoint/commit, deterministic
 * validation, and fresh-context review services for the production Core v1 start boundary.
 */
export class CoreRuntimeExecutionService {
  constructor(
    private readonly database: DensaAdeDatabase,
    private readonly adapter: AgentAdapter,
    private readonly executionControl: ProjectExecutionControlService,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async execute(request: CoreRuntimeExecutionRequest): Promise<ControlledProjectLifecycleResult> {
    const details = {
      build: async ({ taskId, workspacePath }: { taskId: TaskId; workspacePath: string }) => {
        const task = this.database.repositories.tasks.findById(taskId);
        const spec = this.database.repositories.specifications.findByProjectId(request.projectId);
        if (task === undefined || spec === undefined) {
          throw new Error("Task execution context is incomplete");
        }
        const scope = await proposeScope(this.adapter, {
          runId: `task-scope-${randomUUID()}`,
          cwd: workspacePath,
          accessMode: "read-only",
          outputSchema: SCOPE_OUTPUT_SCHEMA,
          prompt: [
            "Plan the exact workspace-relative file scope for this Densa ADE task.",
            "Inspect the repository read-only. Return exact file paths, including files that will be created.",
            "Do not return directories, '.', .git paths, globs, absolute paths, or parent traversal.",
            "intendedPaths must be a subset of ownedPaths.",
            'Return one JSON object only: {"ownedPaths":["path"],"intendedPaths":["path"]}.',
            `Task: ${task.title}`,
            `Acceptance criteria: ${task.acceptanceCriteria.join(" | ")}`,
          ].join("\n"),
        });
        const selection = GLOBAL_CONSTRAINT_FIELDS.flatMap((field) =>
          spec.specification[field].map((_value, index) => ({ field, index })),
        );
        const permissionPolicy = new PermissionPolicyService(this.database).getConfiguration(
          request.projectId,
        );
        const networkDisposition = evaluatePermissionPolicy(
          permissionPolicy,
          "network_access",
        ).disposition;
        const packet = new TaskPacketBuilder(this.database.repositories).build({
          taskId,
          selection: { globalConstraints: selection, architecturalDecisionIds: [] },
          relevantFiles: [],
          permissionEnvelope: {
            id: `runtime-${taskId}`,
            preset: permissionPolicy.preset,
            grantedActions: ["workspace_write", "local_validation"],
            deniedActions: ["privilege_escalation", "remote_push", "unrelated_file_access"],
            writablePaths: scope.ownedPaths,
            networkAccess:
              networkDisposition === "allow"
                ? "allowed"
                : networkDisposition === "ask_user"
                  ? "approval_required"
                  : "denied",
          },
        });
        if (packet.status !== "built") {
          throw new Error(`Task Packet rejected: ${packet.code}: ${packet.message}`);
        }
        return {
          workerPrompt: renderTaskPacketPrompt(packet.packet),
          ownedPaths: scope.ownedPaths,
          intendedPaths: scope.intendedPaths,
          adapter: this.adapter,
          validator: taskValidator(this.database, this.adapter, scope.ownedPaths),
          ...(request.gitAuthorization === undefined
            ? {}
            : { gitAuthorization: request.gitAuthorization }),
        } satisfies PhaseTaskExecutionDetails;
      },
    };
    const result = await this.executionControl.execute({
      projectId: request.projectId,
      workspacePath: request.workspacePath,
      gates: request.gates,
      taskExecutor: new SingleTaskPhaseExecutor(new SingleTaskOrchestrator(this.database), details),
      validator: phaseValidator(this.database, this.adapter),
      actor: request.actor,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.phaseApproval === undefined ? {} : { phaseApproval: request.phaseApproval }),
      ...(request.guidedTaskApproval === undefined
        ? {}
        : { guidedTaskApproval: request.guidedTaskApproval }),
    });
    if (result.status === "STOPPED") {
      const project = this.database.repositories.projects.findById(request.projectId);
      const occurredAt = this.now();
      if (
        project !== undefined &&
        stateTransitionService.canTransitionProject(project.state, "BLOCKED")
      ) {
        this.database.persistStateTransition(
          stateTransitionService.transitionProject(project, "BLOCKED", {
            actor: request.actor,
            occurredAt,
            reason: result.reason,
          }),
          eventIdSchema.parse(`runtime-execution-${randomUUID()}`),
        );
      }
    }
    const portable = await new PortableProjectSynchronizer(this.database.repositories).synchronize(
      request.workspacePath,
      request.projectId,
    );
    if (portable.status !== "synchronized") {
      throw new Error(
        `Portable project synchronization conflicted: ${portable.conflicts
          .map((conflict) => conflict.path)
          .join(", ")}`,
      );
    }
    return result;
  }
}
