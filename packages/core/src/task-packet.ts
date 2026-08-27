import {
  type Attempt,
  type Decision,
  type JsonValue,
  type MasterRoadmapPhase,
  type MasterRoadmapTask,
  type Phase,
  type Project,
  type ProjectSpecification,
  type Task,
} from "@densa/protocol";

import type { DensaRepositories } from "./persistence/repositories.js";

export const TASK_PACKET_MAX_BYTES = 192 * 1024;

const MAX_GOAL_BYTES = 2 * 1024;
const MAX_LIST_ENTRY_BYTES = 1024;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_PATH_BYTES = 512;
const MAX_DIAGNOSTICS_BYTES = 8 * 1024;
const MAX_ACCEPTANCE_CRITERIA = 16;
const MAX_DEPENDENCIES = 16;
const MAX_GLOBAL_CONSTRAINTS = 12;
const MAX_ARCHITECTURAL_DECISIONS = 8;
const MAX_FILE_CONTEXTS = 8;
const MAX_PERMISSION_ENTRIES = 12;

const GLOBAL_CONSTRAINT_FIELDS = [
  "nonGoals",
  "architectureConstraints",
  "platformRuntimeConstraints",
  "integrations",
  "dataStorageNeeds",
  "securityPrivacyRequirements",
  "uxConstraints",
  "deploymentIntent",
] as const satisfies readonly (keyof ProjectSpecification)[];

export type GlobalConstraintField = (typeof GLOBAL_CONSTRAINT_FIELDS)[number];

export interface GlobalConstraintReference {
  readonly field: GlobalConstraintField;
  readonly index: number;
}

export interface TaskPacketContextSelection {
  readonly globalConstraints: readonly GlobalConstraintReference[];
  readonly architecturalDecisionIds: readonly Decision["id"][];
}

export interface RelevantFileContext {
  /** Workspace-relative path only. */
  readonly path: string;
  /** A focused summary, never raw file contents. */
  readonly summary: string;
  /** Sensitive inputs are omitted entirely rather than merely labelled. */
  readonly sensitive?: boolean;
}

export type PermissionDisposition = "allowed" | "approval_required" | "denied";

export interface TaskPermissionEnvelopeInput {
  readonly id: string;
  readonly preset: "cautious" | "standard" | "autonomous";
  readonly grantedActions: readonly string[];
  readonly deniedActions: readonly string[];
  readonly writablePaths: readonly string[];
  readonly networkAccess: PermissionDisposition;
  readonly expiresAt?: string;
}

export interface BuildTaskPacketRequest {
  readonly taskId: Task["id"];
  readonly currentAttemptId?: Attempt["id"];
  readonly selection: TaskPacketContextSelection;
  readonly relevantFiles: readonly RelevantFileContext[];
  readonly permissionEnvelope: TaskPermissionEnvelopeInput;
}

export interface TaskPacketDependency {
  readonly id: Task["id"];
  readonly title: string;
  readonly goal: string;
  readonly state: Task["state"];
}

export interface TaskPacketConstraint {
  readonly field: GlobalConstraintField;
  readonly index: number;
  readonly text: string;
}

export interface TaskPacketDecision {
  readonly id: Decision["id"];
  readonly title: string;
  readonly rationale: string;
}

export interface TaskPacketFileContext {
  readonly path: string;
  readonly summary: string;
}

export interface TaskPacketPreviousFailure {
  readonly attemptId: Attempt["id"];
  readonly attemptNumber: number;
  readonly recordedAt: string;
  readonly diagnostics: string;
}

export interface TaskPacketPermissionEnvelope {
  readonly id: string;
  readonly preset: TaskPermissionEnvelopeInput["preset"];
  readonly grantedActions: readonly string[];
  readonly deniedActions: readonly string[];
  readonly writablePaths: readonly string[];
  readonly networkAccess: PermissionDisposition;
  readonly expiresAt?: string;
}

export type TaskPacketSourceKind =
  | "architectural_decision"
  | "global_constraint"
  | "permission_envelope"
  | "phase_goal"
  | "previous_attempt_diagnostics"
  | "project_summary"
  | "relevant_file_summary"
  | "task_acceptance_criteria"
  | "task_dependency"
  | "task_goal";

export interface TaskPacketContextSource {
  readonly kind: TaskPacketSourceKind;
  readonly sourceId: string;
}

export interface TaskPacket {
  readonly formatVersion: 1;
  readonly project: Readonly<{
    id: Project["id"];
    name: string;
    summary: string;
  }>;
  readonly phase: Readonly<{
    id: Phase["id"];
    title: string;
    goal: string;
  }>;
  readonly task: Readonly<{
    id: Task["id"];
    title: string;
    goal: string;
    acceptanceCriteria: readonly string[];
    dependencies: readonly TaskPacketDependency[];
  }>;
  readonly globalConstraints: readonly TaskPacketConstraint[];
  readonly architecturalDecisions: readonly TaskPacketDecision[];
  readonly relevantFiles: readonly TaskPacketFileContext[];
  readonly previousAttemptFailure?: TaskPacketPreviousFailure;
  readonly permissionEnvelope: TaskPacketPermissionEnvelope;
  readonly scopeInstruction: string;
  readonly contextSources: readonly TaskPacketContextSource[];
  readonly bounds: Readonly<{
    maxBytes: number;
    byteLength: number;
    truncated: boolean;
  }>;
}

export type TaskPacketBuildErrorCode =
  | "CONTEXT_MISMATCH"
  | "INVALID_CONTEXT_SELECTION"
  | "INVALID_PERMISSION_ENVELOPE"
  | "PACKET_TOO_LARGE"
  | "PROJECT_NOT_FOUND"
  | "ROADMAP_NOT_FOUND"
  | "SPECIFICATION_NOT_FOUND"
  | "TASK_NOT_FOUND";

export interface TaskPacketBuiltResult {
  readonly status: "built";
  readonly packet: TaskPacket;
}

export interface TaskPacketRejectedResult {
  readonly status: "rejected";
  readonly code: TaskPacketBuildErrorCode;
  readonly message: string;
}

export type TaskPacketBuildResult = TaskPacketBuiltResult | TaskPacketRejectedResult;

interface TruncationTracker {
  truncated: boolean;
}

function rejected(code: TaskPacketBuildErrorCode, message: string): TaskPacketRejectedResult {
  return Object.freeze({ status: "rejected", code, message });
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function truncateUtf8(value: string, maxBytes: number, tracker: TruncationTracker): string {
  if (byteLength(value) <= maxBytes) return value;
  tracker.truncated = true;
  const suffix = "…[truncated]";
  const contentBudget = Math.max(0, maxBytes - byteLength(suffix));
  let result = "";
  let used = 0;
  for (const character of value) {
    const characterBytes = byteLength(character);
    if (used + characterBytes > contentBudget) break;
    result += character;
    used += characterBytes;
  }
  return `${result}${suffix}`;
}

const SECRET_PATTERNS: readonly Readonly<{
  expression: RegExp;
  replacement: string;
}>[] = [
  {
    expression: /<secret>[\s\S]*?<\/secret>/giu,
    replacement: "[REDACTED]",
  },
  {
    expression: /\[secret:[^\]]*\]/giu,
    replacement: "[REDACTED]",
  },
  {
    expression:
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu,
    replacement: "[REDACTED PRIVATE KEY]",
  },
  {
    expression: /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|AKIA[A-Z0-9]{16})\b/gu,
    replacement: "[REDACTED TOKEN]",
  },
  {
    expression: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/giu,
    replacement: "$1[REDACTED]",
  },
  {
    expression:
      /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret|token)\s*[:=]\s*)[^\s,;]+/giu,
    replacement: "$1[REDACTED]",
  },
];

function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (redacted, { expression, replacement }) => redacted.replace(expression, replacement),
    value,
  );
}

function boundedText(value: string, maxBytes: number, tracker: TruncationTracker): string {
  return truncateUtf8(redactSecrets(value), maxBytes, tracker);
}

function boundedId(value: string, tracker: TruncationTracker): string {
  return boundedText(value, MAX_IDENTIFIER_BYTES, tracker);
}

function isSensitiveKey(key: string): boolean {
  return /(?:api.?key|authorization|cookie|credential|password|private.?key|secret|token)/iu.test(
    key,
  );
}

function sanitizeJson(value: JsonValue, tracker: TruncationTracker): JsonValue {
  if (typeof value === "string") return boundedText(value, MAX_DIAGNOSTICS_BYTES, tracker);
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeJson(entry, tracker));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left.localeCompare(right))
        .map((key) => [
          key,
          isSensitiveKey(key) ? "[REDACTED]" : sanitizeJson(value[key] ?? null, tracker),
        ]),
    );
  }
  return value;
}

function stableJson(value: JsonValue): string {
  return JSON.stringify(value);
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort((left, right) => left.localeCompare(right)));
}

function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\")) return false;
  const segments = path.split("/");
  return !segments.some((segment) => segment.length === 0 || segment === ".." || segment === ".");
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function findRoadmapContext(
  phases: readonly MasterRoadmapPhase[],
  taskId: string,
): { readonly phase: MasterRoadmapPhase; readonly task: MasterRoadmapTask } | undefined {
  for (const phase of phases) {
    const task = phase.tasks.find((candidate) => candidate.id === taskId);
    if (task !== undefined) return { phase, task };
  }
  return undefined;
}

function addSource(
  sources: TaskPacketContextSource[],
  kind: TaskPacketSourceKind,
  sourceId: string,
  tracker: TruncationTracker,
): void {
  sources.push(Object.freeze({ kind, sourceId: boundedText(sourceId, MAX_PATH_BYTES, tracker) }));
}

function selectConstraints(
  specification: ProjectSpecification,
  references: readonly GlobalConstraintReference[],
  sources: TaskPacketContextSource[],
  tracker: TruncationTracker,
): readonly TaskPacketConstraint[] | TaskPacketRejectedResult {
  const normalized = [...references].sort((left, right) => {
    const fieldOrder =
      GLOBAL_CONSTRAINT_FIELDS.indexOf(left.field) - GLOBAL_CONSTRAINT_FIELDS.indexOf(right.field);
    return fieldOrder === 0 ? left.index - right.index : fieldOrder;
  });
  const unique = new Set<string>();
  const selected: TaskPacketConstraint[] = [];
  for (const reference of normalized) {
    if (!GLOBAL_CONSTRAINT_FIELDS.includes(reference.field) || !Number.isInteger(reference.index)) {
      return rejected(
        "INVALID_CONTEXT_SELECTION",
        "Global constraint references require a supported field and integer index",
      );
    }
    const key = `${reference.field}:${String(reference.index)}`;
    if (unique.has(key)) continue;
    unique.add(key);
    const values = specification[reference.field];
    const value = values[reference.index];
    if (reference.index < 0 || value === undefined) {
      return rejected("INVALID_CONTEXT_SELECTION", `Global constraint ${key} does not exist`);
    }
    if (selected.length >= MAX_GLOBAL_CONSTRAINTS) {
      return rejected(
        "PACKET_TOO_LARGE",
        `Task packet selects more than ${String(MAX_GLOBAL_CONSTRAINTS)} global constraints`,
      );
    }
    selected.push(
      Object.freeze({
        field: reference.field,
        index: reference.index,
        text: boundedText(value, MAX_LIST_ENTRY_BYTES, tracker),
      }),
    );
    addSource(sources, "global_constraint", `specification:${key}`, tracker);
  }
  return Object.freeze(selected);
}

function selectDecisions(
  decisions: readonly Decision[],
  decisionIds: readonly Decision["id"][],
  sources: TaskPacketContextSource[],
  tracker: TruncationTracker,
): readonly TaskPacketDecision[] | TaskPacketRejectedResult {
  const requested = new Set(decisionIds);
  if (requested.size > MAX_ARCHITECTURAL_DECISIONS) {
    return rejected(
      "PACKET_TOO_LARGE",
      `Task packet selects more than ${String(MAX_ARCHITECTURAL_DECISIONS)} architectural decisions`,
    );
  }
  const byId = new Map(decisions.map((decision) => [decision.id, decision]));
  for (const decisionId of requested) {
    if (!byId.has(decisionId)) {
      return rejected(
        "INVALID_CONTEXT_SELECTION",
        `Architectural decision ${decisionId} does not exist for the project`,
      );
    }
  }
  const selected: TaskPacketDecision[] = [];
  for (const decision of decisions) {
    if (!requested.has(decision.id)) continue;
    selected.push(
      Object.freeze({
        id: decision.id,
        title: boundedText(decision.title, MAX_LIST_ENTRY_BYTES, tracker),
        rationale: boundedText(decision.rationale, MAX_GOAL_BYTES, tracker),
      }),
    );
    addSource(sources, "architectural_decision", `decision:${decision.id}`, tracker);
  }
  return Object.freeze(selected);
}

function selectFiles(
  files: readonly RelevantFileContext[],
  sources: TaskPacketContextSource[],
  tracker: TruncationTracker,
): readonly TaskPacketFileContext[] | TaskPacketRejectedResult {
  const byPath = new Map<string, RelevantFileContext>();
  for (const file of files) {
    if (!isSafeRelativePath(file.path)) {
      return rejected(
        "INVALID_CONTEXT_SELECTION",
        `Relevant file path must be normalized and workspace-relative: ${file.path}`,
      );
    }
    if (byPath.has(file.path)) {
      return rejected("INVALID_CONTEXT_SELECTION", `Relevant file path is repeated: ${file.path}`);
    }
    if (file.summary.length === 0) {
      return rejected("INVALID_CONTEXT_SELECTION", `Relevant file summary is empty: ${file.path}`);
    }
    byPath.set(file.path, file);
  }
  const selected: TaskPacketFileContext[] = [];
  for (const [path, file] of [...byPath].sort(([left], [right]) => left.localeCompare(right))) {
    if (file.sensitive === true) continue;
    if (selected.length >= MAX_FILE_CONTEXTS) {
      return rejected(
        "PACKET_TOO_LARGE",
        `Task packet selects more than ${String(MAX_FILE_CONTEXTS)} file summaries`,
      );
    }
    selected.push(
      Object.freeze({
        path: boundedText(path, MAX_PATH_BYTES, tracker),
        summary: boundedText(file.summary, MAX_GOAL_BYTES, tracker),
      }),
    );
    addSource(sources, "relevant_file_summary", `workspace:${path}`, tracker);
  }
  return Object.freeze(selected);
}

function normalizePermissionEnvelope(
  input: TaskPermissionEnvelopeInput,
  tracker: TruncationTracker,
): TaskPacketPermissionEnvelope | TaskPacketRejectedResult {
  if (input.id.length === 0) {
    return rejected("INVALID_PERMISSION_ENVELOPE", "Permission envelope ID must not be empty");
  }
  if (!(["cautious", "standard", "autonomous"] as const).includes(input.preset)) {
    return rejected("INVALID_PERMISSION_ENVELOPE", "Permission envelope preset is invalid");
  }
  if (!(["allowed", "approval_required", "denied"] as const).includes(input.networkAccess)) {
    return rejected("INVALID_PERMISSION_ENVELOPE", "Network permission disposition is invalid");
  }
  if (input.writablePaths.some((path) => path !== "." && !isSafeRelativePath(path))) {
    return rejected(
      "INVALID_PERMISSION_ENVELOPE",
      "Writable permission paths must be normalized and workspace-relative",
    );
  }
  const granted = uniqueSorted(input.grantedActions);
  const denied = uniqueSorted(input.deniedActions);
  const writablePaths = uniqueSorted(input.writablePaths);
  if (
    granted.some((action) => action.length === 0) ||
    denied.some((action) => action.length === 0)
  ) {
    return rejected("INVALID_PERMISSION_ENVELOPE", "Permission actions must not be empty");
  }
  const overlap = granted.find((action) => denied.includes(action));
  if (overlap !== undefined) {
    return rejected(
      "INVALID_PERMISSION_ENVELOPE",
      `Permission action cannot be both granted and denied: ${overlap}`,
    );
  }
  if (
    granted.length > MAX_PERMISSION_ENTRIES ||
    denied.length > MAX_PERMISSION_ENTRIES ||
    writablePaths.length > MAX_PERMISSION_ENTRIES
  ) {
    return rejected(
      "PACKET_TOO_LARGE",
      `Permission envelope lists more than ${String(MAX_PERMISSION_ENTRIES)} entries in one category`,
    );
  }
  const cap = (values: readonly string[], maxBytes: number): readonly string[] => {
    return Object.freeze(values.map((value) => boundedText(value, maxBytes, tracker)));
  };
  return Object.freeze({
    id: boundedId(input.id, tracker),
    preset: input.preset,
    grantedActions: cap(granted, MAX_LIST_ENTRY_BYTES),
    deniedActions: cap(denied, MAX_LIST_ENTRY_BYTES),
    writablePaths: cap(writablePaths, MAX_PATH_BYTES),
    networkAccess: input.networkAccess,
    ...(input.expiresAt === undefined
      ? {}
      : { expiresAt: boundedText(input.expiresAt, MAX_IDENTIFIER_BYTES, tracker) }),
  });
}

function findPreviousFailure(
  repositories: DensaRepositories,
  task: Task,
  currentAttemptId: Attempt["id"] | undefined,
  sources: TaskPacketContextSource[],
  tracker: TruncationTracker,
): TaskPacketPreviousFailure | TaskPacketRejectedResult | undefined {
  const attempts = repositories.attempts.listByTaskId(task.id);
  let candidates = attempts;
  if (currentAttemptId !== undefined) {
    const currentIndex = attempts.findIndex((attempt) => attempt.id === currentAttemptId);
    if (currentIndex < 0) {
      return rejected(
        "CONTEXT_MISMATCH",
        "Current attempt does not exist or does not belong to the requested task",
      );
    }
    if (currentIndex !== attempts.length - 1) {
      return rejected(
        "CONTEXT_MISMATCH",
        "Current attempt is stale because a newer task attempt exists",
      );
    }
    candidates = attempts.slice(0, currentIndex);
  }
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const attempt = candidates[index];
    if (attempt === undefined) continue;
    const plan = repositories.attemptRollbackPlans.findByAttemptId(attempt.id);
    if (plan?.failureRecordedAt === undefined) continue;
    const sanitized = stableJson(sanitizeJson(plan.diagnostics, tracker));
    const failure = Object.freeze({
      attemptId: attempt.id,
      attemptNumber: attempt.number,
      recordedAt: plan.failureRecordedAt,
      diagnostics: truncateUtf8(sanitized, MAX_DIAGNOSTICS_BYTES, tracker),
    });
    addSource(sources, "previous_attempt_diagnostics", `attempt:${attempt.id}`, tracker);
    return failure;
  }
  return undefined;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function finalizeBounds(
  packet: Omit<TaskPacket, "bounds">,
  tracker: TruncationTracker,
): TaskPacket {
  let measured = 0;
  let candidate: TaskPacket = {
    ...packet,
    bounds: {
      maxBytes: TASK_PACKET_MAX_BYTES,
      byteLength: measured,
      truncated: tracker.truncated,
    },
  };
  let next = byteLength(JSON.stringify(candidate));
  while (next !== measured) {
    measured = next;
    candidate = {
      ...packet,
      bounds: {
        maxBytes: TASK_PACKET_MAX_BYTES,
        byteLength: measured,
        truncated: tracker.truncated,
      },
    };
    next = byteLength(JSON.stringify(candidate));
  }
  return deepFreeze(candidate);
}

/**
 * Builds deterministic, bounded worker context from authoritative structured state.
 *
 * Relevance is explicit: callers select constraint/decision IDs and supply summaries instead of
 * conversations or raw file contents. The builder never reads the event journal.
 */
export class TaskPacketBuilder {
  constructor(private readonly repositories: DensaRepositories) {}

  build(request: BuildTaskPacketRequest): TaskPacketBuildResult {
    const tracker: TruncationTracker = { truncated: false };
    const task = this.repositories.tasks.findById(request.taskId);
    if (task === undefined)
      return rejected("TASK_NOT_FOUND", `Task ${request.taskId} was not found`);
    const project = this.repositories.projects.findById(task.projectId);
    if (project === undefined) {
      return rejected("PROJECT_NOT_FOUND", `Project ${task.projectId} was not found`);
    }
    const specification = this.repositories.specifications.findByProjectId(project.id);
    if (specification === undefined) {
      return rejected("SPECIFICATION_NOT_FOUND", `Project ${project.id} has no specification`);
    }
    const roadmapRecord = this.repositories.masterRoadmaps.findByProjectId(project.id);
    if (roadmapRecord === undefined) {
      return rejected("ROADMAP_NOT_FOUND", `Project ${project.id} has no authoritative roadmap`);
    }
    const roadmapContext = findRoadmapContext(roadmapRecord.roadmap.phases, task.id);
    const phase = this.repositories.phases.findById(task.phaseId);
    if (
      roadmapContext === undefined ||
      phase === undefined ||
      phase.projectId !== project.id ||
      roadmapContext.phase.id !== phase.id
    ) {
      return rejected(
        "CONTEXT_MISMATCH",
        "Persisted task/phase state does not match the authoritative roadmap",
      );
    }
    if (
      !sameStrings(task.acceptanceCriteria, roadmapContext.task.acceptanceCriteria) ||
      !sameStrings(task.dependencyIds, roadmapContext.task.dependencyIds)
    ) {
      return rejected(
        "CONTEXT_MISMATCH",
        "Persisted task acceptance criteria or dependencies are stale",
      );
    }

    const sources: TaskPacketContextSource[] = [];
    const constraints = selectConstraints(
      specification.specification,
      request.selection.globalConstraints,
      sources,
      tracker,
    );
    if ("status" in constraints) return constraints;
    const decisions = selectDecisions(
      this.repositories.decisions.listByProjectId(project.id),
      request.selection.architecturalDecisionIds,
      sources,
      tracker,
    );
    if ("status" in decisions) return decisions;
    const files = selectFiles(request.relevantFiles, sources, tracker);
    if ("status" in files) return files;
    const permissions = normalizePermissionEnvelope(request.permissionEnvelope, tracker);
    if ("status" in permissions) return permissions;
    const previousFailure = findPreviousFailure(
      this.repositories,
      task,
      request.currentAttemptId,
      sources,
      tracker,
    );
    if (previousFailure !== undefined && "status" in previousFailure) return previousFailure;

    if (task.dependencyIds.length > MAX_DEPENDENCIES) {
      return rejected(
        "PACKET_TOO_LARGE",
        `Task has more than ${String(MAX_DEPENDENCIES)} direct dependencies`,
      );
    }
    if (roadmapContext.task.acceptanceCriteria.length > MAX_ACCEPTANCE_CRITERIA) {
      return rejected(
        "PACKET_TOO_LARGE",
        `Task has more than ${String(MAX_ACCEPTANCE_CRITERIA)} acceptance criteria`,
      );
    }

    const dependencies: TaskPacketDependency[] = [];
    const taskById = new Map(
      this.repositories.tasks
        .listByProjectId(project.id)
        .map((candidate) => [candidate.id, candidate]),
    );
    const roadmapTaskById = new Map(
      roadmapRecord.roadmap.phases.flatMap((roadmapPhase) =>
        roadmapPhase.tasks.map((roadmapTask) => [roadmapTask.id, roadmapTask] as const),
      ),
    );
    for (const dependencyId of task.dependencyIds) {
      const persistedDependency = taskById.get(dependencyId);
      const roadmapDependency = roadmapTaskById.get(dependencyId);
      if (persistedDependency === undefined || roadmapDependency === undefined) {
        return rejected(
          "CONTEXT_MISMATCH",
          `Task dependency ${dependencyId} is missing from persisted or roadmap state`,
        );
      }
      dependencies.push(
        Object.freeze({
          id: persistedDependency.id,
          title: boundedText(persistedDependency.title, MAX_LIST_ENTRY_BYTES, tracker),
          goal: boundedText(roadmapDependency.goal, MAX_GOAL_BYTES, tracker),
          state: persistedDependency.state,
        }),
      );
      addSource(sources, "task_dependency", `task:${dependencyId}`, tracker);
    }

    const acceptanceCriteria = Object.freeze(
      roadmapContext.task.acceptanceCriteria.map((criterion, index) => {
        addSource(
          sources,
          "task_acceptance_criteria",
          `task:${task.id}:acceptance:${String(index)}`,
          tracker,
        );
        return redactSecrets(criterion);
      }),
    );

    addSource(
      sources,
      "project_summary",
      `roadmap:${roadmapRecord.revisionNumber}:project`,
      tracker,
    );
    addSource(
      sources,
      "phase_goal",
      `roadmap:${roadmapRecord.revisionNumber}:phase:${phase.id}`,
      tracker,
    );
    addSource(
      sources,
      "task_goal",
      `roadmap:${roadmapRecord.revisionNumber}:task:${task.id}`,
      tracker,
    );
    addSource(sources, "permission_envelope", `permission:${permissions.id}`, tracker);

    const packetWithoutBounds: Omit<TaskPacket, "bounds"> = {
      formatVersion: 1,
      project: Object.freeze({
        id: project.id,
        name: boundedText(project.name, MAX_LIST_ENTRY_BYTES, tracker),
        summary: boundedText(roadmapRecord.roadmap.projectGoal, MAX_GOAL_BYTES, tracker),
      }),
      phase: Object.freeze({
        id: phase.id,
        title: boundedText(phase.title, MAX_LIST_ENTRY_BYTES, tracker),
        goal: boundedText(roadmapContext.phase.goal, MAX_GOAL_BYTES, tracker),
      }),
      task: Object.freeze({
        id: task.id,
        title: boundedText(task.title, MAX_LIST_ENTRY_BYTES, tracker),
        goal: redactSecrets(roadmapContext.task.goal),
        acceptanceCriteria,
        dependencies: Object.freeze(dependencies),
      }),
      globalConstraints: constraints,
      architecturalDecisions: decisions,
      relevantFiles: files,
      ...(previousFailure === undefined ? {} : { previousAttemptFailure: previousFailure }),
      permissionEnvelope: permissions,
      scopeInstruction:
        "Implement only the exact task goal and acceptance criteria. Do not alter unrelated scope, files, architecture, or user work.",
      contextSources: Object.freeze(sources),
    };
    const packet = finalizeBounds(packetWithoutBounds, tracker);
    if (packet.bounds.byteLength > TASK_PACKET_MAX_BYTES) {
      return rejected(
        "PACKET_TOO_LARGE",
        `Task packet exceeds the ${String(TASK_PACKET_MAX_BYTES)} byte limit after bounded construction`,
      );
    }
    return Object.freeze({ status: "built", packet });
  }
}

function markdownList(values: readonly string[], empty: string): readonly string[] {
  return values.length === 0 ? [`- ${empty}`] : values.map((value) => `- ${value}`);
}

/** Renders a stable worker prompt without exposing packet audit metadata as instructions. */
export function renderTaskPacketPrompt(packet: TaskPacket): string {
  const lines = [
    "# Densa Worker Task Packet",
    "",
    "## Project",
    `Name: ${packet.project.name}`,
    `Summary: ${packet.project.summary}`,
    "",
    "## Global constraints",
    ...markdownList(
      packet.globalConstraints.map((constraint) => constraint.text),
      "No additional selected constraints.",
    ),
    "",
    "## Relevant architectural decisions",
    ...markdownList(
      packet.architecturalDecisions.map((decision) => `${decision.title} — ${decision.rationale}`),
      "No architectural decisions were selected for this task.",
    ),
    "",
    "## Current phase",
    `${packet.phase.title}: ${packet.phase.goal}`,
    "",
    "## Exact task",
    `${packet.task.title}: ${packet.task.goal}`,
    "",
    "### Acceptance criteria",
    ...packet.task.acceptanceCriteria.map(
      (criterion, index) => `${String(index + 1)}. ${criterion}`,
    ),
    "",
    "### Dependencies",
    ...markdownList(
      packet.task.dependencies.map(
        (dependency) =>
          `${dependency.id} [${dependency.state}] — ${dependency.title}: ${dependency.goal}`,
      ),
      "No direct dependencies.",
    ),
    "",
    "### Relevant files",
    ...markdownList(
      packet.relevantFiles.map((file) => `${file.path} — ${file.summary}`),
      "No file summaries were selected.",
    ),
  ];
  if (packet.previousAttemptFailure !== undefined) {
    lines.push(
      "",
      "### Previous attempt failure",
      `Attempt ${String(packet.previousAttemptFailure.attemptNumber)} (${packet.previousAttemptFailure.attemptId}) failed:`,
      ...packet.previousAttemptFailure.diagnostics.split("\n").map((line) => `    ${line}`),
    );
  }
  lines.push(
    "",
    "## Permission envelope",
    `Preset: ${packet.permissionEnvelope.preset}`,
    `Network: ${packet.permissionEnvelope.networkAccess}`,
    ...markdownList(
      packet.permissionEnvelope.grantedActions.map((action) => `Granted: ${action}`),
      "No actions explicitly granted.",
    ),
    ...packet.permissionEnvelope.deniedActions.map((action) => `- Denied: ${action}`),
    ...packet.permissionEnvelope.writablePaths.map((path) => `- Writable path: ${path}`),
    "",
    "## Scope boundary",
    packet.scopeInstruction,
    "",
  );
  return lines.join("\n");
}
