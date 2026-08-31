import { randomUUID } from "node:crypto";

import { isTerminalAgentEvent, type AgentAdapter } from "@densa-ade/agent-sdk";
import {
  masterRoadmapOutputSchema,
  masterRoadmapSchema,
  projectSpecificationSchema,
  type DensaAdeErrorCode,
  type MasterRoadmap,
  type MasterRoadmapTask,
  type ProjectSpecification,
} from "@densa-ade/protocol";

import { detectSpecificationContradictions } from "./project-specification.js";

const CANONICAL_BLOCK_START = "<!-- densa:master-roadmap:canonical -->\n```json\n";
const CANONICAL_BLOCK_END = "\n```\n<!-- /densa:master-roadmap:canonical -->";

export interface MasterRoadmapRequest {
  readonly specification: ProjectSpecification;
}

/** Model-neutral Master-role boundary. The agent proposes; Core validates and schedules. */
export interface MasterRoadmapAgent {
  propose(request: MasterRoadmapRequest): Promise<MasterRoadmap>;
}

export class MasterRoadmapError extends Error {
  readonly code: DensaAdeErrorCode;

  constructor(code: DensaAdeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MasterRoadmapError";
    this.code = code;
  }
}

export class MasterRoadmapMarkdownError extends Error {
  readonly code = "USER_CONFIGURATION_ERROR";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MasterRoadmapMarkdownError";
  }
}

export interface AgentAdapterMasterRoadmapOptions {
  readonly cwd: string;
  readonly runIdFactory?: () => string;
}

function formatValidationIssues(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): string {
  return issues
    .slice(0, 8)
    .map(
      (issue) => `${issue.path.length === 0 ? "roadmap" : issue.path.join(".")}: ${issue.message}`,
    )
    .join("; ");
}

function parseAgentRoadmap(value: unknown): MasterRoadmap {
  const result = masterRoadmapSchema.safeParse(value);
  if (!result.success) {
    throw new MasterRoadmapError(
      "PROCESS_FAILURE",
      `Master roadmap proposal failed structural validation: ${formatValidationIssues(result.error.issues)}`,
      { cause: result.error },
    );
  }
  return result.data;
}

/** Converts one exact structured AgentAdapter response into a Core-validated roadmap proposal. */
export class AgentAdapterMasterRoadmapAgent implements MasterRoadmapAgent {
  private readonly cwd: string;
  private readonly runIdFactory: () => string;

  constructor(
    private readonly adapter: AgentAdapter,
    options: AgentAdapterMasterRoadmapOptions,
  ) {
    if (options.cwd.trim().length === 0) {
      throw new MasterRoadmapError(
        "USER_CONFIGURATION_ERROR",
        "Master roadmap working directory must not be empty",
      );
    }
    this.cwd = options.cwd;
    this.runIdFactory = options.runIdFactory ?? (() => `master-roadmap-${randomUUID()}`);
  }

  async propose(request: MasterRoadmapRequest): Promise<MasterRoadmap> {
    let terminalCount = 0;
    let finalMessage: string | undefined;
    let failureMessage: string | undefined;
    let failureCode: DensaAdeErrorCode = "PROCESS_FAILURE";

    for await (const event of this.adapter.execute({
      runId: this.runIdFactory(),
      cwd: this.cwd,
      prompt: buildMasterRoadmapPrompt(request.specification),
      outputSchema: masterRoadmapOutputSchema,
      accessMode: "read-only",
    })) {
      if (!isTerminalAgentEvent(event)) continue;
      terminalCount += 1;
      if (event.outcome === "succeeded") finalMessage = event.finalMessage;
      else {
        failureCode = event.error?.code ?? "PROCESS_FAILURE";
        failureMessage = event.error?.message ?? `Master roadmap run ended ${event.outcome}`;
      }
    }

    if (terminalCount !== 1) {
      throw new MasterRoadmapError(
        "PROCESS_FAILURE",
        `Master roadmap run produced ${terminalCount} terminal events; expected exactly one`,
      );
    }
    if (failureMessage !== undefined) {
      throw new MasterRoadmapError(failureCode, failureMessage);
    }
    if (finalMessage === undefined) {
      throw new MasterRoadmapError(
        "PROCESS_FAILURE",
        "Master roadmap run succeeded without a structured final response",
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(finalMessage);
    } catch (error) {
      throw new MasterRoadmapError(
        "PROCESS_FAILURE",
        "Master roadmap final response is not one exact JSON document",
        { cause: error },
      );
    }
    return parseAgentRoadmap(parsed);
  }
}

function buildMasterRoadmapPrompt(specification: ProjectSpecification): string {
  return [
    "You are the Master-role initial roadmap planner for Densa ADE.",
    "Turn the complete supplied ProjectSpecification into the complete intended project arc before execution begins.",
    "Preserve projectGoal exactly. Do not weaken, delete, or invent user requirements.",
    "Create ordered phases with stable unique IDs, clear goals, explicit completion criteria, and tasks.",
    "Every task needs a stable unique ID, dependencies by task ID, risk level, and expected validator categories.",
    "Every executable task needs concrete, testable acceptance criteria. Dependencies must exist and be acyclic.",
    "Mark a phase required when it is necessary to deliver the specified project; every required phase must contain tasks.",
    "Use dependencies, not array order alone, to express scheduling constraints across the full project.",
    "Return exactly one JSON object and no Markdown or commentary.",
    "Allowed riskLevel values: low, medium, high, critical.",
    "Allowed expectedValidators values: build, typecheck, lint, unit_test, integration_test, end_to_end, acceptance, security, accessibility, performance, manual_review, independent_ai_review.",
    "The object shape is:",
    '{"formatVersion":1,"projectGoal":"exact specification goal","phases":[{"id":"stable.phase.id","title":"text","goal":"text","required":true,"completionCriteria":["criterion"],"tasks":[{"id":"stable.task.id","title":"text","goal":"text","executable":true,"dependencyIds":["task.id"],"acceptanceCriteria":["criterion"],"riskLevel":"low|medium|high|critical","expectedValidators":["category"]}]}]}',
    "ProjectSpecification:",
    JSON.stringify(specification),
  ].join("\n");
}

function assertSpecificationReady(input: ProjectSpecification): ProjectSpecification {
  const specification = projectSpecificationSchema.parse(input);
  const blockingQuestionIds = specification.unresolvedQuestions
    .filter(
      (question) =>
        question.impact === "high" ||
        (question.impact === "medium" && question.defaultCanBeUsedWithoutAnswer !== true),
    )
    .map(({ id }) => id);
  const contradictions = detectSpecificationContradictions(specification);
  if (blockingQuestionIds.length > 0 || contradictions.length > 0) {
    const reasons = [
      ...(blockingQuestionIds.length === 0
        ? []
        : [`blocking questions: ${blockingQuestionIds.join(", ")}`]),
      ...(contradictions.length === 0
        ? []
        : [`contradictions: ${contradictions.map(({ code }) => code).join(", ")}`]),
    ];
    throw new MasterRoadmapError(
      "USER_CONFIGURATION_ERROR",
      `Project specification is not ready for roadmap generation (${reasons.join("; ")})`,
    );
  }
  return specification;
}

export interface RoadmapScheduleEntry {
  readonly phaseId: string;
  readonly taskId: string;
  readonly executable: boolean;
}

/** Return one deterministic topological order, using roadmap order to break ready-task ties. */
export function topologicallyScheduleRoadmap(
  input: MasterRoadmap,
): readonly RoadmapScheduleEntry[] {
  const roadmap = masterRoadmapSchema.parse(input);
  const taskEntries = roadmap.phases.flatMap((phase) =>
    phase.tasks.map((task) => ({ phaseId: phase.id, task })),
  );
  const indegree = new Map(taskEntries.map(({ task }) => [task.id, task.dependencyIds.length]));
  const dependents = new Map(taskEntries.map(({ task }) => [task.id, [] as string[]]));
  const byTaskId = new Map(taskEntries.map((entry) => [entry.task.id, entry]));
  for (const { task } of taskEntries) {
    for (const dependencyId of task.dependencyIds) {
      dependents.get(dependencyId)?.push(task.id);
    }
  }

  const ready = taskEntries
    .filter(({ task }) => indegree.get(task.id) === 0)
    .map(({ task }) => task.id);
  const scheduled: RoadmapScheduleEntry[] = [];
  for (let index = 0; index < ready.length; index += 1) {
    const taskId = ready[index];
    if (taskId === undefined) continue;
    const entry = byTaskId.get(taskId);
    if (entry === undefined) {
      throw new MasterRoadmapError(
        "INTERNAL_INVARIANT_VIOLATION",
        `Validated roadmap task ${taskId} disappeared during scheduling`,
      );
    }
    scheduled.push(
      Object.freeze({
        phaseId: entry.phaseId,
        taskId,
        executable: entry.task.executable,
      }),
    );
    for (const dependentId of dependents.get(taskId) ?? []) {
      const nextIndegree = (indegree.get(dependentId) ?? 0) - 1;
      indegree.set(dependentId, nextIndegree);
      if (nextIndegree === 0) ready.push(dependentId);
    }
  }
  if (scheduled.length !== taskEntries.length) {
    throw new MasterRoadmapError(
      "INTERNAL_INVARIANT_VIOLATION",
      "Validated roadmap could not be topologically scheduled",
    );
  }
  return Object.freeze(scheduled);
}

function appendCriteria(lines: string[], title: string, criteria: readonly string[]): void {
  lines.push(`#### ${title}`, "");
  if (criteria.length === 0) {
    lines.push("_None required._", "");
    return;
  }
  for (const criterion of criteria) {
    lines.push(`- ${criterion.replace(/\r\n?/gu, "\n").replace(/\n/gu, "\n  ")}`);
  }
  lines.push("");
}

function renderTask(lines: string[], task: MasterRoadmapTask): void {
  lines.push(
    `### ${task.id} — ${task.title.replace(/\s+/gu, " ").trim()}`,
    "",
    task.goal.replace(/\r\n?/gu, "\n"),
    "",
    `- Executable: ${task.executable ? "yes" : "no"}`,
    `- Risk: **${task.riskLevel.toUpperCase()}**`,
    `- Dependencies: ${task.dependencyIds.length === 0 ? "none" : task.dependencyIds.map((id) => `\`${id}\``).join(", ")}`,
    `- Superseded by: ${(task.supersededByTaskIds?.length ?? 0) === 0 ? "none" : task.supersededByTaskIds?.map((id) => `\`${id}\``).join(", ")}`,
    `- Expected validators: ${task.expectedValidators.length === 0 ? "none" : task.expectedValidators.map((validator) => `\`${validator}\``).join(", ")}`,
    "",
  );
  appendCriteria(lines, "Acceptance criteria", task.acceptanceCriteria);
}

/** Render the complete structured plan into deterministic, inspectable ROADMAP.md content. */
export function renderMasterRoadmapMarkdown(input: MasterRoadmap): string {
  const roadmap = masterRoadmapSchema.parse(input);
  const lines = [
    "# Master Roadmap",
    "",
    "> Generated from Densa ADE Core's versioned initial roadmap. Task dependencies, not document order alone, govern execution.",
    "",
    "## Project goal",
    "",
    roadmap.projectGoal.replace(/\r\n?/gu, "\n"),
    "",
  ];

  for (const [phaseIndex, phase] of roadmap.phases.entries()) {
    lines.push(
      `## Phase ${phaseIndex + 1}: ${phase.title.replace(/\s+/gu, " ").trim()}`,
      "",
      `- ID: \`${phase.id}\``,
      `- Required: ${phase.required ? "yes" : "no"}`,
      "",
      phase.goal.replace(/\r\n?/gu, "\n"),
      "",
    );
    appendCriteria(lines, "Phase completion criteria", phase.completionCriteria);
    if (phase.tasks.length === 0) lines.push("_No tasks._", "");
    else for (const task of phase.tasks) renderTask(lines, task);
  }

  lines.push(
    "## Canonical structured roadmap",
    "",
    "This machine-readable block is part of the portable document and must remain synchronized with the human-readable sections above.",
    "",
    `${CANONICAL_BLOCK_START}${JSON.stringify(roadmap, undefined, 2)}${CANONICAL_BLOCK_END}`,
    "",
  );
  return lines.join("\n");
}

/** Parse only renderer-produced ROADMAP.md files and re-run all graph validation. */
export function parseMasterRoadmapMarkdown(markdown: string): MasterRoadmap {
  const startIndex = markdown.indexOf(CANONICAL_BLOCK_START);
  if (startIndex === -1) {
    throw new MasterRoadmapMarkdownError("ROADMAP.md does not contain a canonical roadmap block");
  }
  if (markdown.indexOf(CANONICAL_BLOCK_START, startIndex + CANONICAL_BLOCK_START.length) !== -1) {
    throw new MasterRoadmapMarkdownError(
      "ROADMAP.md contains more than one canonical roadmap block",
    );
  }
  const jsonStart = startIndex + CANONICAL_BLOCK_START.length;
  const endIndex = markdown.indexOf(CANONICAL_BLOCK_END, jsonStart);
  if (endIndex === -1) {
    throw new MasterRoadmapMarkdownError("ROADMAP.md canonical roadmap block is incomplete");
  }
  try {
    return masterRoadmapSchema.parse(JSON.parse(markdown.slice(jsonStart, endIndex)));
  } catch (error) {
    throw new MasterRoadmapMarkdownError(
      "ROADMAP.md canonical roadmap is not valid version 1 data",
      { cause: error },
    );
  }
}

export interface GeneratedMasterRoadmap {
  readonly roadmap: MasterRoadmap;
  readonly roadmapMarkdown: string;
  readonly schedule: readonly RoadmapScheduleEntry[];
}

export class MasterRoadmapGenerator {
  constructor(private readonly masterAgent: MasterRoadmapAgent) {}

  async generate(input: ProjectSpecification): Promise<GeneratedMasterRoadmap> {
    const specification = assertSpecificationReady(input);
    const roadmap = parseAgentRoadmap(await this.masterAgent.propose({ specification }));
    if (roadmap.projectGoal !== specification.projectGoal) {
      throw new MasterRoadmapError(
        "INTERNAL_INVARIANT_VIOLATION",
        "Master roadmap proposal changed the exact project goal",
      );
    }
    return Object.freeze({
      roadmap,
      roadmapMarkdown: renderMasterRoadmapMarkdown(roadmap),
      schedule: topologicallyScheduleRoadmap(roadmap),
    });
  }
}
