import {
  phaseSchema,
  projectSchema,
  taskSchema,
  type Phase,
  type PhaseState,
  type Project,
  type ProjectState,
  type Task,
  type TaskState,
} from "@densa/protocol";

type TransitionTable<State extends string> = Readonly<Record<State, readonly State[]>>;

function targets<State extends string>(...states: State[]): readonly State[] {
  return Object.freeze(states);
}

/** The complete set of project lifecycle edges accepted by Core. */
export const projectStateTransitions: TransitionTable<ProjectState> = Object.freeze({
  DRAFT: targets("PLANNING"),
  PLANNING: targets("READY", "WAITING_FOR_USER", "BLOCKED", "FAILED"),
  READY: targets("RUNNING", "PAUSED", "WAITING_FOR_USER", "WAITING_FOR_USAGE", "BLOCKED", "FAILED"),
  RUNNING: targets(
    "PAUSED",
    "WAITING_FOR_USER",
    "WAITING_FOR_USAGE",
    "BLOCKED",
    "COMPLETED",
    "FAILED",
  ),
  PAUSED: targets("READY", "RUNNING", "BLOCKED", "FAILED"),
  WAITING_FOR_USER: targets("PLANNING", "READY", "RUNNING", "PAUSED", "BLOCKED", "FAILED"),
  WAITING_FOR_USAGE: targets("READY", "RUNNING", "PAUSED", "BLOCKED", "FAILED"),
  BLOCKED: targets("PLANNING", "READY", "RUNNING", "PAUSED", "FAILED"),
  COMPLETED: targets<ProjectState>(),
  FAILED: targets<ProjectState>(),
});

/** The complete set of phase lifecycle edges accepted by Core. */
export const phaseStateTransitions: TransitionTable<PhaseState> = Object.freeze({
  PENDING: targets("READY", "BLOCKED"),
  READY: targets("RUNNING", "BLOCKED"),
  RUNNING: targets("VALIDATING", "BLOCKED"),
  VALIDATING: targets("RUNNING", "AWAITING_APPROVAL", "COMPLETED", "BLOCKED"),
  AWAITING_APPROVAL: targets("RUNNING", "COMPLETED", "BLOCKED"),
  COMPLETED: targets<PhaseState>(),
  BLOCKED: targets("PENDING", "READY", "RUNNING", "VALIDATING", "AWAITING_APPROVAL"),
});

/** The complete set of task lifecycle edges accepted by Core. */
export const taskStateTransitions: TransitionTable<TaskState> = Object.freeze({
  PENDING: targets("READY", "BLOCKED", "CANCELLED"),
  READY: targets("RUNNING", "WAITING_FOR_USER", "WAITING_FOR_USAGE", "BLOCKED", "CANCELLED"),
  RUNNING: targets(
    "VALIDATING",
    "RETRYING",
    "WAITING_FOR_USER",
    "WAITING_FOR_USAGE",
    "BLOCKED",
    "INTERRUPTED",
    "CANCELLED",
  ),
  VALIDATING: targets(
    "COMPLETED",
    "RETRYING",
    "WAITING_FOR_USER",
    "WAITING_FOR_USAGE",
    "BLOCKED",
    "INTERRUPTED",
    "CANCELLED",
  ),
  RETRYING: targets(
    "RUNNING",
    "WAITING_FOR_USER",
    "WAITING_FOR_USAGE",
    "BLOCKED",
    "INTERRUPTED",
    "CANCELLED",
  ),
  WAITING_FOR_USER: targets("READY", "RUNNING", "VALIDATING", "RETRYING", "BLOCKED", "CANCELLED"),
  WAITING_FOR_USAGE: targets(
    "READY",
    "RUNNING",
    "VALIDATING",
    "RETRYING",
    "BLOCKED",
    "INTERRUPTED",
    "CANCELLED",
  ),
  BLOCKED: targets("PENDING", "READY", "RUNNING", "VALIDATING", "RETRYING", "CANCELLED"),
  INTERRUPTED: targets("READY", "RETRYING", "BLOCKED", "CANCELLED"),
  COMPLETED: targets<TaskState>(),
  CANCELLED: targets<TaskState>(),
});

export type StateEntityType = "project" | "phase" | "task";

export interface StateTransitionContext {
  readonly actor: string;
  readonly occurredAt: string;
  readonly reason?: string;
}

interface StateTransitionPayload<State extends string> {
  readonly previousState: State;
  readonly state: State;
  readonly reason?: string;
}

export interface ProjectStateTransitionEventDraft {
  readonly projectId: Project["id"];
  readonly type: "PROJECT_STATE_CHANGED";
  readonly schemaVersion: 1;
  readonly occurredAt: string;
  readonly actor: string;
  readonly payload: Readonly<StateTransitionPayload<ProjectState>>;
}

export interface PhaseStateTransitionEventDraft {
  readonly projectId: Phase["projectId"];
  readonly phaseId: Phase["id"];
  readonly type: "PHASE_STATE_CHANGED";
  readonly schemaVersion: 1;
  readonly occurredAt: string;
  readonly actor: string;
  readonly payload: Readonly<StateTransitionPayload<PhaseState>>;
}

export interface TaskStateTransitionEventDraft {
  readonly projectId: Task["projectId"];
  readonly phaseId: Task["phaseId"];
  readonly taskId: Task["id"];
  readonly type: "TASK_STATE_CHANGED";
  readonly schemaVersion: 1;
  readonly occurredAt: string;
  readonly actor: string;
  readonly payload: Readonly<StateTransitionPayload<TaskState>>;
}

export interface ProjectStateTransition {
  readonly entityType: "project";
  readonly previousState: ProjectState;
  readonly state: ProjectState;
  readonly entity: Project;
  readonly event: Readonly<ProjectStateTransitionEventDraft>;
}

export interface PhaseStateTransition {
  readonly entityType: "phase";
  readonly previousState: PhaseState;
  readonly state: PhaseState;
  readonly entity: Phase;
  readonly event: Readonly<PhaseStateTransitionEventDraft>;
}

export interface TaskStateTransition {
  readonly entityType: "task";
  readonly previousState: TaskState;
  readonly state: TaskState;
  readonly entity: Task;
  readonly event: Readonly<TaskStateTransitionEventDraft>;
}

export class InvalidStateTransitionError extends Error {
  readonly code = "INVALID_STATE_TRANSITION" as const;

  constructor(
    readonly entityType: StateEntityType,
    readonly entityId: string,
    readonly previousState: ProjectState | PhaseState | TaskState,
    readonly requestedState: ProjectState | PhaseState | TaskState,
  ) {
    super(`Cannot transition ${entityType} ${entityId} from ${previousState} to ${requestedState}`);
    this.name = "InvalidStateTransitionError";
  }
}

function canTransition<State extends string>(
  table: TransitionTable<State>,
  previousState: State,
  requestedState: State,
): boolean {
  return table[previousState].includes(requestedState);
}

function transitionPayload<State extends string>(
  previousState: State,
  state: State,
  reason: string | undefined,
): Readonly<StateTransitionPayload<State>> {
  return Object.freeze(
    reason === undefined ? { previousState, state } : { previousState, state, reason },
  );
}

/**
 * The sole Core domain boundary for deciding project, phase, and task status changes.
 * Persistence consumes the returned immutable entity and event draft in one transaction.
 */
export class StateTransitionService {
  canTransitionProject(previousState: ProjectState, requestedState: ProjectState): boolean {
    return canTransition(projectStateTransitions, previousState, requestedState);
  }

  canTransitionPhase(previousState: PhaseState, requestedState: PhaseState): boolean {
    return canTransition(phaseStateTransitions, previousState, requestedState);
  }

  canTransitionTask(previousState: TaskState, requestedState: TaskState): boolean {
    return canTransition(taskStateTransitions, previousState, requestedState);
  }

  transitionProject(
    project: Project,
    requestedState: ProjectState,
    context: StateTransitionContext,
  ): Readonly<ProjectStateTransition> {
    if (!this.canTransitionProject(project.state, requestedState)) {
      throw new InvalidStateTransitionError("project", project.id, project.state, requestedState);
    }

    const entity = projectSchema.parse({
      ...project,
      state: requestedState,
      updatedAt: context.occurredAt,
    });
    const event = Object.freeze({
      projectId: project.id,
      type: "PROJECT_STATE_CHANGED" as const,
      schemaVersion: 1 as const,
      occurredAt: context.occurredAt,
      actor: context.actor,
      payload: transitionPayload(project.state, requestedState, context.reason),
    });

    return Object.freeze({
      entityType: "project" as const,
      previousState: project.state,
      state: requestedState,
      entity,
      event,
    });
  }

  transitionPhase(
    phase: Phase,
    requestedState: PhaseState,
    context: StateTransitionContext,
  ): Readonly<PhaseStateTransition> {
    if (!this.canTransitionPhase(phase.state, requestedState)) {
      throw new InvalidStateTransitionError("phase", phase.id, phase.state, requestedState);
    }

    const entity = phaseSchema.parse({
      ...phase,
      state: requestedState,
      updatedAt: context.occurredAt,
    });
    const event = Object.freeze({
      projectId: phase.projectId,
      phaseId: phase.id,
      type: "PHASE_STATE_CHANGED" as const,
      schemaVersion: 1 as const,
      occurredAt: context.occurredAt,
      actor: context.actor,
      payload: transitionPayload(phase.state, requestedState, context.reason),
    });

    return Object.freeze({
      entityType: "phase" as const,
      previousState: phase.state,
      state: requestedState,
      entity,
      event,
    });
  }

  transitionTask(
    task: Task,
    requestedState: TaskState,
    context: StateTransitionContext,
  ): Readonly<TaskStateTransition> {
    if (!this.canTransitionTask(task.state, requestedState)) {
      throw new InvalidStateTransitionError("task", task.id, task.state, requestedState);
    }

    const entity = taskSchema.parse({
      ...task,
      state: requestedState,
      updatedAt: context.occurredAt,
    });
    const event = Object.freeze({
      projectId: task.projectId,
      phaseId: task.phaseId,
      taskId: task.id,
      type: "TASK_STATE_CHANGED" as const,
      schemaVersion: 1 as const,
      occurredAt: context.occurredAt,
      actor: context.actor,
      payload: transitionPayload(task.state, requestedState, context.reason),
    });

    return Object.freeze({
      entityType: "task" as const,
      previousState: task.state,
      state: requestedState,
      entity,
      event,
    });
  }
}

export const stateTransitionService = Object.freeze(new StateTransitionService());
