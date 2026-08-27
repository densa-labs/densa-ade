import {
  type MasterRoadmap,
  type Phase,
  type Project,
  type ProjectId,
  type Task,
} from "@densa/protocol";

import type { DensaRepositories } from "./persistence/repositories.js";

export type SchedulerGateScope = "project" | "phase" | "task";

export interface SchedulerPermissionBlocker {
  readonly id: string;
  readonly scope: SchedulerGateScope;
  readonly phaseId?: Phase["id"];
  readonly taskId?: Task["id"];
  readonly reason: string;
}

/**
 * A complete policy-layer snapshot supplied for this scheduling decision.
 *
 * P5M0 deliberately does not invent the later permissions/decision persistence model. Requiring
 * this snapshot keeps the scheduler provider-neutral while preventing it from silently assuming
 * that missing policy evidence means permission was granted.
 */
export interface SchedulerGateSnapshot {
  readonly outstandingUserDecisionIds: readonly string[];
  readonly permissionBlockers: readonly SchedulerPermissionBlocker[];
}

export interface SchedulerRequest {
  readonly projectId: ProjectId;
  readonly gates: SchedulerGateSnapshot;
}

export type SchedulerNoWorkClassification = "blocked" | "complete" | "idle" | "invalid";

export type SchedulerNoWorkReasonCode =
  | "ACTIVE_TASK"
  | "ALL_TASKS_COMPLETED"
  | "DEPENDENCIES_INCOMPLETE"
  | "GATE_SNAPSHOT_INVALID"
  | "NO_READY_TASK"
  | "OUTSTANDING_USER_DECISION"
  | "PERMISSION_BLOCKED"
  | "PERSISTED_ROADMAP_INCONSISTENT"
  | "PROJECT_BLOCKED"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_PAUSED"
  | "PROJECT_STATE_NOT_RUNNABLE"
  | "PROJECT_TERMINAL"
  | "ROADMAP_NOT_FOUND"
  | "SERIAL_EXECUTION_VIOLATION"
  | "TASK_BLOCKED"
  | "TASK_NOT_READY"
  | "USAGE_UNAVAILABLE";

export interface SchedulerNoWorkReason {
  readonly code: SchedulerNoWorkReasonCode;
  readonly classification: SchedulerNoWorkClassification;
  readonly message: string;
  readonly phaseId?: Phase["id"];
  readonly taskId?: Task["id"];
  readonly relatedIds?: readonly string[];
}

export interface ScheduledTaskSelection {
  readonly status: "selected";
  readonly project: Project;
  readonly phase: Phase;
  readonly task: Task;
  readonly roadmapRevisionNumber: number;
  readonly tieBreak: Readonly<{
    phasePosition: number;
    taskPosition: number;
    taskId: Task["id"];
  }>;
}

export interface SchedulerNoWorkSelection {
  readonly status: "no_work";
  readonly reasons: readonly SchedulerNoWorkReason[];
}

export type SchedulerSelection = ScheduledTaskSelection | SchedulerNoWorkSelection;

interface RoadmapEntry {
  readonly phasePosition: number;
  readonly taskPosition: number;
  readonly phaseId: Phase["id"];
  readonly taskId: Task["id"];
  readonly executable: boolean;
  readonly dependencyIds: readonly Task["id"][];
}

const ACTIVE_TASK_STATES = new Set<Task["state"]>(["RUNNING", "VALIDATING", "RETRYING"]);

function noWork(...reasons: SchedulerNoWorkReason[]): SchedulerNoWorkSelection {
  return Object.freeze({ status: "no_work", reasons: Object.freeze(reasons) });
}

function reason(
  code: SchedulerNoWorkReasonCode,
  classification: SchedulerNoWorkClassification,
  message: string,
  context: {
    readonly phaseId?: Phase["id"];
    readonly taskId?: Task["id"];
    readonly relatedIds?: readonly string[];
  } = {},
): SchedulerNoWorkReason {
  return Object.freeze({
    code,
    classification,
    message,
    ...(context.phaseId === undefined ? {} : { phaseId: context.phaseId }),
    ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
    ...(context.relatedIds === undefined
      ? {}
      : { relatedIds: Object.freeze([...context.relatedIds]) }),
  });
}

function roadmapEntries(roadmap: MasterRoadmap): readonly RoadmapEntry[] {
  return Object.freeze(
    roadmap.phases.flatMap((phase, phasePosition) =>
      phase.tasks.map((task, taskPosition) =>
        Object.freeze({
          phasePosition,
          taskPosition,
          phaseId: phase.id as Phase["id"],
          taskId: task.id as Task["id"],
          executable: task.executable,
          dependencyIds: Object.freeze(
            task.dependencyIds.map((dependencyId) => dependencyId as Task["id"]),
          ),
        }),
      ),
    ),
  );
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort((first, second) => first.localeCompare(second));
  const sortedRight = [...right].sort((first, second) => first.localeCompare(second));
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function validateGateSnapshot(
  gates: SchedulerGateSnapshot | undefined,
  phases: ReadonlyMap<string, Phase>,
  tasks: ReadonlyMap<string, Task>,
): SchedulerNoWorkReason | undefined {
  if (
    gates === undefined ||
    !Array.isArray(gates.outstandingUserDecisionIds) ||
    !Array.isArray(gates.permissionBlockers)
  ) {
    return reason(
      "GATE_SNAPSHOT_INVALID",
      "invalid",
      "Scheduling requires a complete decision and permission gate snapshot",
    );
  }
  if (
    gates.outstandingUserDecisionIds.some(
      (decisionId) => typeof decisionId !== "string" || decisionId.length === 0,
    )
  ) {
    return reason(
      "GATE_SNAPSHOT_INVALID",
      "invalid",
      "Outstanding user decision IDs must be non-empty strings",
    );
  }
  for (const blocker of gates.permissionBlockers) {
    if (
      blocker === null ||
      typeof blocker !== "object" ||
      typeof blocker.id !== "string" ||
      blocker.id.length === 0 ||
      typeof blocker.reason !== "string" ||
      blocker.reason.length === 0
    ) {
      return reason(
        "GATE_SNAPSHOT_INVALID",
        "invalid",
        "Permission blockers require non-empty IDs and reasons",
      );
    }
    if (
      (blocker.scope === "project" &&
        (blocker.phaseId !== undefined || blocker.taskId !== undefined)) ||
      (blocker.scope === "phase" &&
        (blocker.phaseId === undefined || blocker.taskId !== undefined)) ||
      (blocker.scope === "task" &&
        (blocker.taskId === undefined || blocker.phaseId !== undefined)) ||
      !["project", "phase", "task"].includes(blocker.scope)
    ) {
      return reason(
        "GATE_SNAPSHOT_INVALID",
        "invalid",
        `Permission blocker ${blocker.id} has an invalid scope target`,
      );
    }
    if (
      (blocker.phaseId !== undefined && !phases.has(blocker.phaseId)) ||
      (blocker.taskId !== undefined && !tasks.has(blocker.taskId))
    ) {
      return reason(
        "GATE_SNAPSHOT_INVALID",
        "invalid",
        `Permission blocker ${blocker.id} targets missing persisted work`,
      );
    }
  }
  return undefined;
}

function validatePersistedRoadmap(
  roadmap: MasterRoadmap,
  phases: readonly Phase[],
  tasks: readonly Task[],
): SchedulerNoWorkReason | undefined {
  const entries = roadmapEntries(roadmap);
  const phaseById = new Map(phases.map((phase) => [phase.id, phase]));
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const roadmapPhaseIds = new Set(roadmap.phases.map((phase) => phase.id));
  const roadmapTaskIds = new Set(entries.map((entry) => entry.taskId));

  if (phases.some((phase) => !roadmapPhaseIds.has(phase.id))) {
    return reason(
      "PERSISTED_ROADMAP_INCONSISTENT",
      "invalid",
      "Persisted phase state contains a phase absent from the authoritative roadmap",
    );
  }
  if (tasks.some((task) => !roadmapTaskIds.has(task.id))) {
    return reason(
      "PERSISTED_ROADMAP_INCONSISTENT",
      "invalid",
      "Persisted task state contains a task absent from the authoritative roadmap",
    );
  }

  for (const [phasePosition, roadmapPhase] of roadmap.phases.entries()) {
    const phase = phaseById.get(roadmapPhase.id as Phase["id"]);
    if (phase === undefined || phase.position !== phasePosition) {
      return reason(
        "PERSISTED_ROADMAP_INCONSISTENT",
        "invalid",
        `Roadmap phase ${roadmapPhase.id} is missing or has stale ordering metadata`,
        { phaseId: roadmapPhase.id as Phase["id"] },
      );
    }
  }

  for (const entry of entries) {
    const task = taskById.get(entry.taskId);
    if (!entry.executable && task === undefined) continue;
    if (
      task === undefined ||
      task.phaseId !== entry.phaseId ||
      task.position !== entry.taskPosition ||
      !sameIds(task.dependencyIds, entry.dependencyIds)
    ) {
      return reason(
        "PERSISTED_ROADMAP_INCONSISTENT",
        "invalid",
        `Roadmap task ${entry.taskId} is missing or disagrees with persisted scheduling metadata`,
        { phaseId: entry.phaseId, taskId: entry.taskId },
      );
    }
  }
  return undefined;
}

function projectStateReason(project: Project): SchedulerNoWorkReason | undefined {
  switch (project.state) {
    case "READY":
    case "RUNNING":
      return undefined;
    case "PAUSED":
      return reason("PROJECT_PAUSED", "idle", `Project ${project.id} is paused`);
    case "WAITING_FOR_USER":
      return reason(
        "OUTSTANDING_USER_DECISION",
        "blocked",
        `Project ${project.id} is waiting for a user decision`,
      );
    case "WAITING_FOR_USAGE":
      return reason(
        "USAGE_UNAVAILABLE",
        "blocked",
        `Project ${project.id} is waiting for agent usage availability`,
      );
    case "BLOCKED":
      return reason("PROJECT_BLOCKED", "blocked", `Project ${project.id} is blocked`);
    case "COMPLETED":
    case "FAILED":
      return reason(
        "PROJECT_TERMINAL",
        project.state === "COMPLETED" ? "complete" : "blocked",
        `Project ${project.id} is terminal in ${project.state}`,
      );
    case "DRAFT":
    case "PLANNING":
      return reason(
        "PROJECT_STATE_NOT_RUNNABLE",
        "idle",
        `Project ${project.id} is ${project.state}, not READY or RUNNING`,
      );
  }
}

function permissionApplies(blocker: SchedulerPermissionBlocker, entry: RoadmapEntry): boolean {
  return (
    blocker.scope === "project" ||
    (blocker.scope === "phase" && blocker.phaseId === entry.phaseId) ||
    (blocker.scope === "task" && blocker.taskId === entry.taskId)
  );
}

/**
 * Read-only, deterministic serial scheduler over authoritative persisted state.
 *
 * It selects at most one already-READY task. State promotion, agent execution, and task leasing
 * belong to later orchestration milestones.
 */
export class DependencyScheduler {
  constructor(private readonly repositories: DensaRepositories) {}

  selectNext(request: SchedulerRequest): SchedulerSelection {
    const project = this.repositories.projects.findById(request.projectId);
    if (project === undefined) {
      return noWork(
        reason(
          "PROJECT_NOT_FOUND",
          "invalid",
          `Project ${request.projectId} does not exist in authoritative state`,
        ),
      );
    }
    const roadmapRecord = this.repositories.masterRoadmaps.findByProjectId(project.id);
    if (roadmapRecord === undefined) {
      return noWork(
        reason(
          "ROADMAP_NOT_FOUND",
          "invalid",
          `Project ${project.id} has no persisted authoritative roadmap`,
        ),
      );
    }

    const phases = this.repositories.phases.listByProjectId(project.id);
    const tasks = this.repositories.tasks.listByProjectId(project.id);
    const phaseById = new Map(phases.map((phase) => [phase.id, phase]));
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const consistencyReason = validatePersistedRoadmap(roadmapRecord.roadmap, phases, tasks);
    if (consistencyReason !== undefined) return noWork(consistencyReason);

    const gateReason = validateGateSnapshot(request.gates, phaseById, taskById);
    if (gateReason !== undefined) return noWork(gateReason);

    const stateReason = projectStateReason(project);
    if (stateReason !== undefined) return noWork(stateReason);

    if (request.gates.outstandingUserDecisionIds.length > 0) {
      return noWork(
        reason("OUTSTANDING_USER_DECISION", "blocked", "A blocking user decision is outstanding", {
          relatedIds: request.gates.outstandingUserDecisionIds,
        }),
      );
    }
    const projectPermissionBlockers = request.gates.permissionBlockers.filter(
      (blocker) => blocker.scope === "project",
    );
    if (projectPermissionBlockers.length > 0) {
      return noWork(
        reason("PERMISSION_BLOCKED", "blocked", "Project permissions prohibit scheduling", {
          relatedIds: projectPermissionBlockers.map((blocker) => blocker.id),
        }),
      );
    }

    const waitingForUser = tasks.filter((task) => task.state === "WAITING_FOR_USER");
    if (waitingForUser.length > 0) {
      return noWork(
        reason(
          "OUTSTANDING_USER_DECISION",
          "blocked",
          "Persisted task state is waiting for a user decision",
          { relatedIds: waitingForUser.map((task) => task.id) },
        ),
      );
    }
    const waitingForUsage = tasks.filter((task) => task.state === "WAITING_FOR_USAGE");
    if (waitingForUsage.length > 0) {
      return noWork(
        reason(
          "USAGE_UNAVAILABLE",
          "blocked",
          "Persisted task state is waiting for agent usage availability",
          { relatedIds: waitingForUsage.map((task) => task.id) },
        ),
      );
    }

    const activeTasks = tasks.filter((task) => ACTIVE_TASK_STATES.has(task.state));
    if (activeTasks.length > 0) {
      return noWork(
        reason(
          activeTasks.length === 1 ? "ACTIVE_TASK" : "SERIAL_EXECUTION_VIOLATION",
          activeTasks.length === 1 ? "idle" : "invalid",
          activeTasks.length === 1
            ? `Task ${activeTasks[0]?.id ?? "unknown"} already owns the serial execution slot`
            : "Multiple persisted tasks claim the serial execution slot",
          { relatedIds: activeTasks.map((task) => task.id) },
        ),
      );
    }

    const entries = roadmapEntries(roadmapRecord.roadmap).filter((entry) => entry.executable);
    const reasons: SchedulerNoWorkReason[] = [];
    for (const entry of entries) {
      const phase = phaseById.get(entry.phaseId);
      const task = taskById.get(entry.taskId);
      if (phase === undefined || task === undefined) continue;
      if (task.state !== "READY") {
        if (task.state === "BLOCKED") {
          reasons.push(
            reason("TASK_BLOCKED", "blocked", `Task ${task.id} is blocked`, {
              phaseId: phase.id,
              taskId: task.id,
            }),
          );
        }
        continue;
      }
      if (phase.state !== "READY" && phase.state !== "RUNNING") {
        reasons.push(
          reason(
            "TASK_NOT_READY",
            phase.state === "BLOCKED" ? "blocked" : "idle",
            `Ready task ${task.id} cannot run while phase ${phase.id} is ${phase.state}`,
            { phaseId: phase.id, taskId: task.id },
          ),
        );
        continue;
      }
      const permissionBlockers = request.gates.permissionBlockers.filter((blocker) =>
        permissionApplies(blocker, entry),
      );
      if (permissionBlockers.length > 0) {
        reasons.push(
          reason(
            "PERMISSION_BLOCKED",
            "blocked",
            `Permissions prohibit scheduling task ${task.id}`,
            {
              phaseId: phase.id,
              taskId: task.id,
              relatedIds: permissionBlockers.map((blocker) => blocker.id),
            },
          ),
        );
        continue;
      }
      const incompleteDependencies = entry.dependencyIds.filter(
        (dependencyId) => taskById.get(dependencyId)?.state !== "COMPLETED",
      );
      if (incompleteDependencies.length > 0) {
        reasons.push(
          reason(
            "DEPENDENCIES_INCOMPLETE",
            "blocked",
            `Task ${task.id} has incomplete hard dependencies`,
            {
              phaseId: phase.id,
              taskId: task.id,
              relatedIds: incompleteDependencies,
            },
          ),
        );
        continue;
      }

      return Object.freeze({
        status: "selected",
        project,
        phase,
        task,
        roadmapRevisionNumber: roadmapRecord.revisionNumber,
        tieBreak: Object.freeze({
          phasePosition: entry.phasePosition,
          taskPosition: entry.taskPosition,
          taskId: task.id,
        }),
      });
    }

    if (entries.every((entry) => taskById.get(entry.taskId)?.state === "COMPLETED")) {
      return noWork(
        reason("ALL_TASKS_COMPLETED", "complete", "Every executable roadmap task is completed"),
      );
    }
    if (reasons.length > 0) return noWork(...reasons);
    return noWork(
      reason("NO_READY_TASK", "idle", "No executable task is currently in READY state"),
    );
  }
}
