import {
  agentRunSchema,
  attemptSchema,
  checkpointSchema,
  decisionSchema,
  eventSchema,
  isoTimestampSchema,
  jsonObjectSchema,
  phaseSchema,
  projectSchema,
  roadmapRevisionSchema,
  taskSchema,
  validationRunSchema,
  type AgentRun,
  type Attempt,
  type Checkpoint,
  type Decision,
  type Event,
  type JsonObject,
  type Phase,
  type Project,
  type RoadmapRevision,
  type Task,
  type ValidationRun,
} from "@densa/protocol";

import {
  PersistenceError,
  type SqliteConnection,
  optionalBoolean,
  optionalString,
  requiredNumber,
  requiredString,
} from "./sqlite-connection.js";

export interface SpecificationRecord {
  readonly projectId: Project["id"];
  readonly content: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TaskDependencyRecord {
  readonly taskId: Task["id"];
  readonly dependencyTaskId: Task["id"];
}

export interface AcceptanceCriterionRecord {
  readonly taskId: Task["id"];
  readonly position: number;
  readonly description: string;
}

export interface ProjectSettingsRecord {
  readonly projectId: Project["id"];
  readonly values: Readonly<JsonObject>;
  readonly updatedAt: string;
}

export interface ProjectRepository {
  create(project: Project): Project;
  findById(id: Project["id"]): Project | undefined;
}

export interface SpecificationRepository {
  set(specification: SpecificationRecord): SpecificationRecord;
  findByProjectId(projectId: Project["id"]): SpecificationRecord | undefined;
}

export interface PhaseRepository {
  create(phase: Phase): Phase;
  findById(id: Phase["id"]): Phase | undefined;
}

export interface TaskRepository {
  create(task: Task): Task;
  findById(id: Task["id"]): Task | undefined;
}

export interface TaskDependencyRepository {
  listForTask(taskId: Task["id"]): readonly TaskDependencyRecord[];
}

export interface AcceptanceCriterionRepository {
  listForTask(taskId: Task["id"]): readonly AcceptanceCriterionRecord[];
}

export type NewAttempt = Omit<Attempt, "agentRunId"> & { readonly agentRunId?: never };

export interface AttemptRepository {
  create(attempt: NewAttempt): Attempt;
  findById(id: Attempt["id"]): Attempt | undefined;
}

export interface AgentRunRepository {
  create(run: AgentRun): AgentRun;
  findById(id: AgentRun["id"]): AgentRun | undefined;
}

export interface ValidationRunRepository {
  create(run: ValidationRun): ValidationRun;
  findById(id: ValidationRun["id"]): ValidationRun | undefined;
}

export interface DecisionRepository {
  create(decision: Decision): Decision;
  findById(id: Decision["id"]): Decision | undefined;
}

export interface RoadmapRevisionRepository {
  create(revision: RoadmapRevision): RoadmapRevision;
  findById(id: RoadmapRevision["id"]): RoadmapRevision | undefined;
}

export interface CheckpointRepository {
  create(checkpoint: Checkpoint): Checkpoint;
  findById(id: Checkpoint["id"]): Checkpoint | undefined;
}

export interface EventRepository {
  append(event: Event): Event;
  findById(id: Event["id"]): Event | undefined;
}

export interface ProjectSettingsRepository {
  set(settings: ProjectSettingsRecord): ProjectSettingsRecord;
  findByProjectId(projectId: Project["id"]): ProjectSettingsRecord | undefined;
}

export interface DensaRepositories {
  readonly projects: ProjectRepository;
  readonly specifications: SpecificationRepository;
  readonly phases: PhaseRepository;
  readonly tasks: TaskRepository;
  readonly taskDependencies: TaskDependencyRepository;
  readonly acceptanceCriteria: AcceptanceCriterionRepository;
  readonly attempts: AttemptRepository;
  readonly agentRuns: AgentRunRepository;
  readonly validationRuns: ValidationRunRepository;
  readonly decisions: DecisionRepository;
  readonly roadmapRevisions: RoadmapRevisionRepository;
  readonly checkpoints: CheckpointRepository;
  readonly events: EventRepository;
  readonly projectSettings: ProjectSettingsRepository;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new PersistenceError("Persisted JSON is malformed", { cause: error });
  }
}

function requireNonEmpty(value: string, field: string): string {
  if (value.length === 0) {
    throw new PersistenceError(`${field} must not be empty`);
  }
  return value;
}

function validateSpecification(specification: SpecificationRecord): SpecificationRecord {
  requireNonEmpty(specification.projectId, "Specification projectId");
  isoTimestampSchema.parse(specification.createdAt);
  isoTimestampSchema.parse(specification.updatedAt);
  return Object.freeze({ ...specification });
}

function validateSettings(settings: ProjectSettingsRecord): ProjectSettingsRecord {
  requireNonEmpty(settings.projectId, "Project settings projectId");
  isoTimestampSchema.parse(settings.updatedAt);
  const values = Object.freeze(jsonObjectSchema.parse(settings.values));
  return Object.freeze({ ...settings, values });
}

class SqliteProjectRepository implements ProjectRepository {
  constructor(private readonly connection: SqliteConnection) {}

  create(input: Project): Project {
    const project = projectSchema.parse(input);
    if (project.state !== "DRAFT") {
      throw new PersistenceError("New projects must begin in DRAFT");
    }
    this.connection.run(
      `INSERT INTO projects (id, name, state, execution_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      project.id,
      project.name,
      project.state,
      project.executionMode,
      project.createdAt,
      project.updatedAt,
    );
    return project;
  }

  findById(id: Project["id"]): Project | undefined {
    const row = this.connection.get("SELECT * FROM projects WHERE id = ?", id);
    return row === undefined
      ? undefined
      : projectSchema.parse({
          id: requiredString(row, "id"),
          name: requiredString(row, "name"),
          state: requiredString(row, "state"),
          executionMode: requiredString(row, "execution_mode"),
          createdAt: requiredString(row, "created_at"),
          updatedAt: requiredString(row, "updated_at"),
        });
  }
}

class SqliteSpecificationRepository implements SpecificationRepository {
  constructor(private readonly connection: SqliteConnection) {}

  set(input: SpecificationRecord): SpecificationRecord {
    const specification = validateSpecification(input);
    this.connection.run(
      `INSERT INTO specifications (project_id, content, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
      specification.projectId,
      specification.content,
      specification.createdAt,
      specification.updatedAt,
    );
    const stored = this.findByProjectId(specification.projectId);
    if (stored === undefined) {
      throw new PersistenceError("Specification write did not produce a stored record");
    }
    return stored;
  }

  findByProjectId(projectId: Project["id"]): SpecificationRecord | undefined {
    const row = this.connection.get("SELECT * FROM specifications WHERE project_id = ?", projectId);
    return row === undefined
      ? undefined
      : validateSpecification({
          projectId: requiredString(row, "project_id") as Project["id"],
          content: requiredString(row, "content"),
          createdAt: requiredString(row, "created_at"),
          updatedAt: requiredString(row, "updated_at"),
        });
  }
}

class SqlitePhaseRepository implements PhaseRepository {
  constructor(private readonly connection: SqliteConnection) {}

  create(input: Phase): Phase {
    const phase = phaseSchema.parse(input);
    if (phase.state !== "PENDING") {
      throw new PersistenceError("New phases must begin in PENDING");
    }
    this.connection.run(
      `INSERT INTO phases (id, project_id, title, state, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      phase.id,
      phase.projectId,
      phase.title,
      phase.state,
      phase.position,
      phase.createdAt,
      phase.updatedAt,
    );
    return phase;
  }

  findById(id: Phase["id"]): Phase | undefined {
    const row = this.connection.get("SELECT * FROM phases WHERE id = ?", id);
    return row === undefined
      ? undefined
      : phaseSchema.parse({
          id: requiredString(row, "id"),
          projectId: requiredString(row, "project_id"),
          title: requiredString(row, "title"),
          state: requiredString(row, "state"),
          position: requiredNumber(row, "position"),
          createdAt: requiredString(row, "created_at"),
          updatedAt: requiredString(row, "updated_at"),
        });
  }
}

class SqliteTaskDependencyRepository implements TaskDependencyRepository {
  constructor(private readonly connection: SqliteConnection) {}

  listForTask(taskId: Task["id"]): readonly TaskDependencyRecord[] {
    return Object.freeze(
      this.connection
        .all(
          `SELECT task_id, dependency_task_id FROM task_dependencies
           WHERE task_id = ? ORDER BY position`,
          taskId,
        )
        .map((row) =>
          Object.freeze({
            taskId: requiredString(row, "task_id") as Task["id"],
            dependencyTaskId: requiredString(row, "dependency_task_id") as Task["id"],
          }),
        ),
    );
  }
}

class SqliteAcceptanceCriterionRepository implements AcceptanceCriterionRepository {
  constructor(private readonly connection: SqliteConnection) {}

  listForTask(taskId: Task["id"]): readonly AcceptanceCriterionRecord[] {
    return Object.freeze(
      this.connection
        .all(
          `SELECT task_id, position, description FROM acceptance_criteria
           WHERE task_id = ? ORDER BY position`,
          taskId,
        )
        .map((row) =>
          Object.freeze({
            taskId: requiredString(row, "task_id") as Task["id"],
            position: requiredNumber(row, "position"),
            description: requiredString(row, "description"),
          }),
        ),
    );
  }
}

class SqliteTaskRepository implements TaskRepository {
  constructor(
    private readonly connection: SqliteConnection,
    private readonly dependencies: TaskDependencyRepository,
    private readonly criteria: AcceptanceCriterionRepository,
  ) {}

  create(input: Task): Task {
    const task = taskSchema.parse(input);
    if (task.state !== "PENDING") {
      throw new PersistenceError("New tasks must begin in PENDING");
    }
    return this.connection.transaction(() => {
      this.connection.run(
        `INSERT INTO tasks (id, project_id, phase_id, title, state, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        task.id,
        task.projectId,
        task.phaseId,
        task.title,
        task.state,
        task.position,
        task.createdAt,
        task.updatedAt,
      );
      for (const [position, description] of task.acceptanceCriteria.entries()) {
        this.connection.run(
          `INSERT INTO acceptance_criteria (project_id, task_id, position, description)
           VALUES (?, ?, ?, ?)`,
          task.projectId,
          task.id,
          position,
          description,
        );
      }
      for (const [position, dependencyId] of task.dependencyIds.entries()) {
        this.connection.run(
          `INSERT INTO task_dependencies (project_id, task_id, dependency_task_id, position)
           VALUES (?, ?, ?, ?)`,
          task.projectId,
          task.id,
          dependencyId,
          position,
        );
      }
      return task;
    });
  }

  findById(id: Task["id"]): Task | undefined {
    const row = this.connection.get("SELECT * FROM tasks WHERE id = ?", id);
    if (row === undefined) {
      return undefined;
    }
    return taskSchema.parse({
      id: requiredString(row, "id"),
      projectId: requiredString(row, "project_id"),
      phaseId: requiredString(row, "phase_id"),
      title: requiredString(row, "title"),
      state: requiredString(row, "state"),
      position: requiredNumber(row, "position"),
      acceptanceCriteria: this.criteria.listForTask(id).map((criterion) => criterion.description),
      dependencyIds: this.dependencies
        .listForTask(id)
        .map((dependency) => dependency.dependencyTaskId),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at"),
    });
  }
}

class SqliteAttemptRepository implements AttemptRepository {
  constructor(private readonly connection: SqliteConnection) {}

  create(input: NewAttempt): Attempt {
    const attempt = attemptSchema.parse(input);
    if (attempt.agentRunId !== undefined) {
      throw new PersistenceError("Create an attempt before attaching its agent run");
    }
    this.connection.run(
      `INSERT INTO attempts (id, task_id, number, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?)`,
      attempt.id,
      attempt.taskId,
      attempt.number,
      attempt.startedAt,
      attempt.completedAt ?? null,
    );
    return attempt;
  }

  findById(id: Attempt["id"]): Attempt | undefined {
    const row = this.connection.get(
      `SELECT attempts.*, agent_runs.id AS agent_run_id
       FROM attempts LEFT JOIN agent_runs ON agent_runs.attempt_id = attempts.id
       WHERE attempts.id = ?`,
      id,
    );
    if (row === undefined) {
      return undefined;
    }
    const completedAt = optionalString(row, "completed_at");
    const agentRunId = optionalString(row, "agent_run_id");
    return attemptSchema.parse({
      id: requiredString(row, "id"),
      taskId: requiredString(row, "task_id"),
      number: requiredNumber(row, "number"),
      startedAt: requiredString(row, "started_at"),
      ...(completedAt === undefined ? {} : { completedAt }),
      ...(agentRunId === undefined ? {} : { agentRunId }),
    });
  }
}

class SqliteAgentRunRepository implements AgentRunRepository {
  constructor(private readonly connection: SqliteConnection) {}

  create(input: AgentRun): AgentRun {
    const run = agentRunSchema.parse(input);
    this.connection.run(
      `INSERT INTO agent_runs
       (id, attempt_id, adapter_id, started_at, completed_at, adapter_run_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      run.id,
      run.attemptId,
      run.adapterId,
      run.startedAt,
      run.completedAt ?? null,
      run.adapterRunId ?? null,
    );
    return run;
  }

  findById(id: AgentRun["id"]): AgentRun | undefined {
    const row = this.connection.get("SELECT * FROM agent_runs WHERE id = ?", id);
    if (row === undefined) {
      return undefined;
    }
    const completedAt = optionalString(row, "completed_at");
    const adapterRunId = optionalString(row, "adapter_run_id");
    return agentRunSchema.parse({
      id: requiredString(row, "id"),
      attemptId: requiredString(row, "attempt_id"),
      adapterId: requiredString(row, "adapter_id"),
      startedAt: requiredString(row, "started_at"),
      ...(completedAt === undefined ? {} : { completedAt }),
      ...(adapterRunId === undefined ? {} : { adapterRunId }),
    });
  }
}

class SqliteValidationRunRepository implements ValidationRunRepository {
  constructor(private readonly connection: SqliteConnection) {}

  create(input: ValidationRun): ValidationRun {
    const run = validationRunSchema.parse(input);
    this.connection.run(
      `INSERT INTO validation_runs
       (id, task_id, attempt_id, validator_id, started_at, completed_at, passed)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      run.id,
      run.taskId,
      run.attemptId ?? null,
      run.validatorId,
      run.startedAt,
      run.completedAt ?? null,
      run.passed === undefined ? null : Number(run.passed),
    );
    return run;
  }

  findById(id: ValidationRun["id"]): ValidationRun | undefined {
    const row = this.connection.get("SELECT * FROM validation_runs WHERE id = ?", id);
    if (row === undefined) {
      return undefined;
    }
    const attemptId = optionalString(row, "attempt_id");
    const completedAt = optionalString(row, "completed_at");
    const passed = optionalBoolean(row, "passed");
    return validationRunSchema.parse({
      id: requiredString(row, "id"),
      taskId: requiredString(row, "task_id"),
      validatorId: requiredString(row, "validator_id"),
      startedAt: requiredString(row, "started_at"),
      ...(attemptId === undefined ? {} : { attemptId }),
      ...(completedAt === undefined ? {} : { completedAt }),
      ...(passed === undefined ? {} : { passed }),
    });
  }
}

class SqliteDecisionRepository implements DecisionRepository {
  constructor(private readonly connection: SqliteConnection) {}

  create(input: Decision): Decision {
    const decision = decisionSchema.parse(input);
    this.connection.run(
      `INSERT INTO decisions (id, project_id, title, rationale, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      decision.id,
      decision.projectId,
      decision.title,
      decision.rationale,
      decision.createdAt,
    );
    return decision;
  }

  findById(id: Decision["id"]): Decision | undefined {
    const row = this.connection.get("SELECT * FROM decisions WHERE id = ?", id);
    return row === undefined
      ? undefined
      : decisionSchema.parse({
          id: requiredString(row, "id"),
          projectId: requiredString(row, "project_id"),
          title: requiredString(row, "title"),
          rationale: requiredString(row, "rationale"),
          createdAt: requiredString(row, "created_at"),
        });
  }
}

class SqliteRoadmapRevisionRepository implements RoadmapRevisionRepository {
  constructor(private readonly connection: SqliteConnection) {}

  create(input: RoadmapRevision): RoadmapRevision {
    const revision = roadmapRevisionSchema.parse(input);
    this.connection.run(
      `INSERT INTO roadmap_revisions
       (id, project_id, classification, reason, actor, created_at, affected_phase_ids_json,
        affected_task_ids_json, old_value_json, new_value_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      revision.id,
      revision.projectId,
      revision.classification,
      revision.reason,
      revision.actor,
      revision.createdAt,
      JSON.stringify(revision.affectedPhaseIds),
      JSON.stringify(revision.affectedTaskIds),
      JSON.stringify(revision.oldValue),
      JSON.stringify(revision.newValue),
    );
    return revision;
  }

  findById(id: RoadmapRevision["id"]): RoadmapRevision | undefined {
    const row = this.connection.get("SELECT * FROM roadmap_revisions WHERE id = ?", id);
    return row === undefined
      ? undefined
      : roadmapRevisionSchema.parse({
          id: requiredString(row, "id"),
          projectId: requiredString(row, "project_id"),
          classification: requiredString(row, "classification"),
          reason: requiredString(row, "reason"),
          actor: requiredString(row, "actor"),
          createdAt: requiredString(row, "created_at"),
          affectedPhaseIds: parseJson(requiredString(row, "affected_phase_ids_json")),
          affectedTaskIds: parseJson(requiredString(row, "affected_task_ids_json")),
          oldValue: parseJson(requiredString(row, "old_value_json")),
          newValue: parseJson(requiredString(row, "new_value_json")),
        });
  }
}

class SqliteCheckpointRepository implements CheckpointRepository {
  constructor(private readonly connection: SqliteConnection) {}

  create(input: Checkpoint): Checkpoint {
    const checkpoint = checkpointSchema.parse(input);
    this.connection.run(
      `INSERT INTO checkpoints (id, project_id, created_at, description) VALUES (?, ?, ?, ?)`,
      checkpoint.id,
      checkpoint.projectId,
      checkpoint.createdAt,
      checkpoint.description ?? null,
    );
    return checkpoint;
  }

  findById(id: Checkpoint["id"]): Checkpoint | undefined {
    const row = this.connection.get("SELECT * FROM checkpoints WHERE id = ?", id);
    if (row === undefined) {
      return undefined;
    }
    const description = optionalString(row, "description");
    return checkpointSchema.parse({
      id: requiredString(row, "id"),
      projectId: requiredString(row, "project_id"),
      createdAt: requiredString(row, "created_at"),
      ...(description === undefined ? {} : { description }),
    });
  }
}

class SqliteEventRepository implements EventRepository {
  constructor(private readonly connection: SqliteConnection) {}

  append(input: Event): Event {
    const event = eventSchema.parse(input);
    this.connection.run(
      `INSERT INTO events
       (id, project_id, phase_id, task_id, type, schema_version, occurred_at, actor, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      event.id,
      event.projectId,
      event.phaseId ?? null,
      event.taskId ?? null,
      event.type,
      event.schemaVersion,
      event.occurredAt,
      event.actor,
      JSON.stringify(event.payload),
    );
    return event;
  }

  findById(id: Event["id"]): Event | undefined {
    const row = this.connection.get("SELECT * FROM events WHERE id = ?", id);
    if (row === undefined) {
      return undefined;
    }
    const phaseId = optionalString(row, "phase_id");
    const taskId = optionalString(row, "task_id");
    return eventSchema.parse({
      id: requiredString(row, "id"),
      projectId: requiredString(row, "project_id"),
      type: requiredString(row, "type"),
      schemaVersion: requiredNumber(row, "schema_version"),
      occurredAt: requiredString(row, "occurred_at"),
      actor: requiredString(row, "actor"),
      payload: parseJson(requiredString(row, "payload_json")),
      ...(phaseId === undefined ? {} : { phaseId }),
      ...(taskId === undefined ? {} : { taskId }),
    });
  }
}

class SqliteProjectSettingsRepository implements ProjectSettingsRepository {
  constructor(private readonly connection: SqliteConnection) {}

  set(input: ProjectSettingsRecord): ProjectSettingsRecord {
    const settings = validateSettings(input);
    this.connection.run(
      `INSERT INTO project_settings (project_id, values_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
       values_json = excluded.values_json, updated_at = excluded.updated_at`,
      settings.projectId,
      JSON.stringify(settings.values),
      settings.updatedAt,
    );
    return settings;
  }

  findByProjectId(projectId: Project["id"]): ProjectSettingsRecord | undefined {
    const row = this.connection.get(
      "SELECT * FROM project_settings WHERE project_id = ?",
      projectId,
    );
    return row === undefined
      ? undefined
      : validateSettings({
          projectId: requiredString(row, "project_id") as Project["id"],
          values: jsonObjectSchema.parse(parseJson(requiredString(row, "values_json"))),
          updatedAt: requiredString(row, "updated_at"),
        });
  }
}

export function createRepositories(connection: SqliteConnection): DensaRepositories {
  const taskDependencies = new SqliteTaskDependencyRepository(connection);
  const acceptanceCriteria = new SqliteAcceptanceCriterionRepository(connection);
  return Object.freeze({
    projects: new SqliteProjectRepository(connection),
    specifications: new SqliteSpecificationRepository(connection),
    phases: new SqlitePhaseRepository(connection),
    tasks: new SqliteTaskRepository(connection, taskDependencies, acceptanceCriteria),
    taskDependencies,
    acceptanceCriteria,
    attempts: new SqliteAttemptRepository(connection),
    agentRuns: new SqliteAgentRunRepository(connection),
    validationRuns: new SqliteValidationRunRepository(connection),
    decisions: new SqliteDecisionRepository(connection),
    roadmapRevisions: new SqliteRoadmapRevisionRepository(connection),
    checkpoints: new SqliteCheckpointRepository(connection),
    events: new SqliteEventRepository(connection),
    projectSettings: new SqliteProjectSettingsRepository(connection),
  });
}
