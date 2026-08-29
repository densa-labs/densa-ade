import {
  agentRunSchema,
  attemptSchema,
  checkpointSchema,
  decisionSchema,
  eventSchema,
  isoTimestampSchema,
  independentReviewOutputSchema,
  independentReviewSchema,
  jsonObjectSchema,
  masterRoadmapRecordSchema,
  manualAcceptanceReviewSchema,
  phaseReportSchema,
  phaseSchema,
  projectSpecificationSchema,
  projectSchema,
  roadmapRevisionSchema,
  taskSchema,
  validationResultSchema,
  validationRunSchema,
  type AgentRun,
  type Attempt,
  type Checkpoint,
  type Decision,
  type Event,
  type JsonObject,
  type IndependentReview,
  type IndependentReviewOutput,
  type MasterRoadmapRecord,
  type ManualAcceptanceReview,
  type Phase,
  type PhaseReport,
  type Project,
  type ProjectSpecification,
  type RoadmapRevision,
  type Task,
  type ValidationResult,
  type ValidationRun,
} from "@densa/protocol";

import {
  DEFAULT_EVENT_REPLAY_LIMIT,
  MAX_EVENT_PAYLOAD_BYTES,
  MAX_EVENT_REPLAY_LIMIT,
  type EventReplayFilter,
  type PersistedEvent,
} from "../event-publisher.js";

import {
  PersistenceError,
  type SqliteConnection,
  type SqliteRow,
  optionalBoolean,
  optionalNumber,
  optionalString,
  requiredNumber,
  requiredString,
} from "./sqlite-connection.js";

export interface SpecificationRecord {
  readonly projectId: Project["id"];
  readonly specification: ProjectSpecification;
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

export interface MasterRoadmapRepository {
  create(roadmap: MasterRoadmapRecord): MasterRoadmapRecord;
  replace(roadmap: MasterRoadmapRecord, expectedRevisionNumber: number): MasterRoadmapRecord;
  findByProjectId(projectId: Project["id"]): MasterRoadmapRecord | undefined;
}

export interface PhaseRepository {
  create(phase: Phase): Phase;
  findById(id: Phase["id"]): Phase | undefined;
  listByProjectId(projectId: Project["id"]): readonly Phase[];
}

export interface TaskRepository {
  create(task: Task): Task;
  findById(id: Task["id"]): Task | undefined;
  listByProjectId(projectId: Project["id"]): readonly Task[];
}

export interface TaskDependencyRepository {
  listForTask(taskId: Task["id"]): readonly TaskDependencyRecord[];
}

export interface AcceptanceCriterionRepository {
  listForTask(taskId: Task["id"]): readonly AcceptanceCriterionRecord[];
}

export type NewAttempt = Omit<Attempt, "agentRunId" | "commitSha"> & {
  readonly agentRunId?: never;
  readonly commitSha?: never;
};

export interface AttemptRepository {
  create(attempt: NewAttempt): Attempt;
  findById(id: Attempt["id"]): Attempt | undefined;
  listByTaskId(taskId: Task["id"]): readonly Attempt[];
  recordCompleted(id: Attempt["id"], completedAt: string): Attempt;
  recordCommit(id: Attempt["id"], taskId: Task["id"], commitSha: string): Attempt;
}

export interface AgentRunRepository {
  create(run: AgentRun): AgentRun;
  findById(id: AgentRun["id"]): AgentRun | undefined;
  findByAttemptId(attemptId: Attempt["id"]): AgentRun | undefined;
  recordCompleted(id: AgentRun["id"], completedAt: string): AgentRun;
}

export interface ValidationRunRepository {
  create(run: ValidationRun): ValidationRun;
  findById(id: ValidationRun["id"]): ValidationRun | undefined;
  listByTaskId(taskId: Task["id"]): readonly ValidationRun[];
  recordCompleted(id: ValidationRun["id"], completedAt: string, passed: boolean): ValidationRun;
}

export interface ValidationResultRepository {
  create(result: ValidationResult): ValidationResult;
  findById(id: ValidationResult["id"]): ValidationResult | undefined;
  listByRunId(validationRunId: ValidationRun["id"]): readonly ValidationResult[];
}

export interface ManualAcceptanceReviewRepository {
  create(review: ManualAcceptanceReview): ManualAcceptanceReview;
  findById(id: ManualAcceptanceReview["id"]): ManualAcceptanceReview | undefined;
  listByRunId(validationRunId: ValidationRun["id"]): readonly ManualAcceptanceReview[];
}

export interface IndependentReviewRepository {
  create(review: IndependentReview): IndependentReview;
  findById(id: IndependentReview["id"]): IndependentReview | undefined;
  listByTaskId(taskId: Task["id"]): readonly IndependentReview[];
  listByPhaseId(phaseId: Phase["id"]): readonly IndependentReview[];
  complete(
    id: IndependentReview["id"],
    completedAt: string,
    output: IndependentReviewOutput,
  ): IndependentReview;
}

export interface DecisionRepository {
  create(decision: Decision): Decision;
  findById(id: Decision["id"]): Decision | undefined;
  listByProjectId(projectId: Project["id"]): readonly Decision[];
  markSuperseded(id: Decision["id"], supersededAt: string): Decision;
}

export interface RoadmapRevisionRepository {
  create(revision: RoadmapRevision): RoadmapRevision;
  findById(id: RoadmapRevision["id"]): RoadmapRevision | undefined;
  listByProjectId(projectId: Project["id"]): readonly RoadmapRevision[];
}

export type DensaRunBranchStatus = "CREATING" | "ACTIVE" | "FAILED";

export interface DensaRunBranchRecord {
  readonly projectId: Project["id"];
  readonly workspacePath: string;
  readonly branchName: string;
  readonly sourceBranch: string;
  readonly startingCommit: string;
  readonly status: DensaRunBranchStatus;
  readonly createdAt: string;
  readonly activatedAt?: string;
  readonly failureReason?: string;
}

export type NewDensaRunBranchRecord = Omit<
  DensaRunBranchRecord,
  "status" | "activatedAt" | "failureReason"
>;

export interface DensaRunBranchRepository {
  createCreating(run: NewDensaRunBranchRecord): DensaRunBranchRecord;
  findByProjectId(projectId: Project["id"]): DensaRunBranchRecord | undefined;
  findByBranchName(branchName: string): DensaRunBranchRecord | undefined;
  activate(projectId: Project["id"], activatedAt: string): DensaRunBranchRecord;
  fail(projectId: Project["id"], failureReason: string): DensaRunBranchRecord;
}

export interface TaskCommitIntentRecord {
  readonly attemptId: Attempt["id"];
  readonly projectId: Project["id"];
  readonly taskId: Task["id"];
  readonly workspacePath: string;
  readonly branchName: string;
  readonly expectedHead: string;
  readonly commitMessage: string;
  readonly intendedPaths: readonly string[];
  readonly createdAt: string;
  readonly commitSha?: string;
  readonly committedAt?: string;
}

export type NewTaskCommitIntentRecord = Omit<TaskCommitIntentRecord, "commitSha" | "committedAt">;

export interface TaskCommitIntentRepository {
  create(intent: NewTaskCommitIntentRecord): TaskCommitIntentRecord;
  findByAttemptId(attemptId: Attempt["id"]): TaskCommitIntentRecord | undefined;
  recordCommit(
    attemptId: Attempt["id"],
    commitSha: string,
    committedAt: string,
  ): TaskCommitIntentRecord;
}

export type RollbackPathKind = "ABSENT" | "FILE" | "SYMLINK";

export interface RollbackPathSnapshot {
  readonly path: string;
  readonly kind: RollbackPathKind;
  readonly contentHash?: string;
  readonly indexHash?: string;
  readonly temporary: boolean;
}

export interface AttemptRollbackPlanRecord {
  readonly attemptId: Attempt["id"];
  readonly agentRunId: AgentRun["id"];
  readonly projectId: Project["id"];
  readonly taskId: Task["id"];
  readonly workspacePath: string;
  readonly branchName: string;
  readonly checkpointHead: string;
  readonly ownedPaths: readonly RollbackPathSnapshot[];
  readonly diagnostics: Readonly<JsonObject>;
  readonly recordedAt: string;
  readonly failureRecordedAt?: string;
  readonly appliedAt?: string;
}

export type NewAttemptRollbackPlanRecord = Omit<
  AttemptRollbackPlanRecord,
  "diagnostics" | "failureRecordedAt" | "appliedAt"
>;

export interface AttemptRollbackPlanRepository {
  create(plan: NewAttemptRollbackPlanRecord): AttemptRollbackPlanRecord;
  findByAttemptId(attemptId: Attempt["id"]): AttemptRollbackPlanRecord | undefined;
  recordFailure(
    attemptId: Attempt["id"],
    diagnostics: Readonly<JsonObject>,
    failureRecordedAt: string,
  ): AttemptRollbackPlanRecord;
  recordApplied(attemptId: Attempt["id"], appliedAt: string): AttemptRollbackPlanRecord;
}

export interface CheckpointRepository {
  create(checkpoint: Checkpoint): Checkpoint;
  findById(id: Checkpoint["id"]): Checkpoint | undefined;
  findByAttemptId(attemptId: Attempt["id"]): Checkpoint | undefined;
  listByProjectId(projectId: Project["id"]): readonly Checkpoint[];
  listByTaskId(taskId: Task["id"]): readonly Checkpoint[];
}

export interface EventRepository {
  append(event: Event): PersistedEvent;
  findById(id: Event["id"]): PersistedEvent | undefined;
  latest(projectId: Project["id"]): PersistedEvent | undefined;
  replay(filter?: EventReplayFilter): readonly PersistedEvent[];
}

export interface ProjectSettingsRepository {
  set(settings: ProjectSettingsRecord): ProjectSettingsRecord;
  findByProjectId(projectId: Project["id"]): ProjectSettingsRecord | undefined;
  list(): readonly ProjectSettingsRecord[];
}

export interface PhaseReportRepository {
  create(report: PhaseReport): PhaseReport;
  findByPhaseId(phaseId: Phase["id"]): PhaseReport | undefined;
  listByProjectId(projectId: Project["id"]): readonly PhaseReport[];
}

export interface DensaRepositories {
  readonly projects: ProjectRepository;
  readonly specifications: SpecificationRepository;
  readonly masterRoadmaps: MasterRoadmapRepository;
  readonly phases: PhaseRepository;
  readonly tasks: TaskRepository;
  readonly taskDependencies: TaskDependencyRepository;
  readonly acceptanceCriteria: AcceptanceCriterionRepository;
  readonly attempts: AttemptRepository;
  readonly agentRuns: AgentRunRepository;
  readonly validationRuns: ValidationRunRepository;
  readonly validationResults: ValidationResultRepository;
  readonly manualAcceptanceReviews: ManualAcceptanceReviewRepository;
  readonly independentReviews: IndependentReviewRepository;
  readonly decisions: DecisionRepository;
  readonly roadmapRevisions: RoadmapRevisionRepository;
  readonly densaRunBranches: DensaRunBranchRepository;
  readonly taskCommitIntents: TaskCommitIntentRepository;
  readonly attemptRollbackPlans: AttemptRollbackPlanRepository;
  readonly checkpoints: CheckpointRepository;
  readonly events: EventRepository;
  readonly projectSettings: ProjectSettingsRepository;
  readonly phaseReports: PhaseReportRepository;
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
  return Object.freeze({
    ...specification,
    specification: projectSpecificationSchema.parse(specification.specification),
  });
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
      `INSERT INTO specifications (project_id, specification_json, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         specification_json = excluded.specification_json,
         updated_at = excluded.updated_at`,
      specification.projectId,
      JSON.stringify(specification.specification),
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
          specification: projectSpecificationSchema.parse(
            parseJson(requiredString(row, "specification_json")),
          ),
          createdAt: requiredString(row, "created_at"),
          updatedAt: requiredString(row, "updated_at"),
        });
  }
}

class SqliteMasterRoadmapRepository implements MasterRoadmapRepository {
  constructor(private readonly connection: SqliteConnection) {}

  create(input: MasterRoadmapRecord): MasterRoadmapRecord {
    const record = masterRoadmapRecordSchema.parse(input);
    if (record.revisionNumber !== 0) {
      throw new PersistenceError("Initial master roadmap revision number must be zero");
    }
    this.connection.run(
      `INSERT INTO master_roadmaps
       (project_id, roadmap_json, revision_number, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      record.projectId,
      JSON.stringify(record.roadmap),
      record.revisionNumber,
      record.createdAt,
      record.updatedAt,
    );
    return record;
  }

  replace(input: MasterRoadmapRecord, expectedRevisionNumber: number): MasterRoadmapRecord {
    const record = masterRoadmapRecordSchema.parse(input);
    if (record.revisionNumber !== expectedRevisionNumber + 1) {
      throw new PersistenceError("Master roadmap replacement must advance exactly one revision");
    }
    const changes = this.connection.run(
      `UPDATE master_roadmaps
       SET roadmap_json = ?, revision_number = ?, updated_at = ?
       WHERE project_id = ? AND revision_number = ?`,
      JSON.stringify(record.roadmap),
      record.revisionNumber,
      record.updatedAt,
      record.projectId,
      expectedRevisionNumber,
    );
    if (changes !== 1) {
      throw new PersistenceError(
        `Could not replace master roadmap revision ${expectedRevisionNumber}`,
      );
    }
    return record;
  }

  findByProjectId(projectId: Project["id"]): MasterRoadmapRecord | undefined {
    const row = this.connection.get(
      "SELECT * FROM master_roadmaps WHERE project_id = ?",
      projectId,
    );
    return row === undefined
      ? undefined
      : masterRoadmapRecordSchema.parse({
          projectId: requiredString(row, "project_id"),
          roadmap: parseJson(requiredString(row, "roadmap_json")),
          revisionNumber: requiredNumber(row, "revision_number"),
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
    return row === undefined ? undefined : this.parse(row);
  }

  listByProjectId(projectId: Project["id"]): readonly Phase[] {
    return Object.freeze(
      this.connection
        .all("SELECT * FROM phases WHERE project_id = ? ORDER BY position, id", projectId)
        .map((row) => this.parse(row)),
    );
  }

  private parse(row: SqliteRow): Phase {
    return phaseSchema.parse({
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
    return row === undefined ? undefined : this.parse(row);
  }

  listByProjectId(projectId: Project["id"]): readonly Task[] {
    return Object.freeze(
      this.connection
        .all("SELECT * FROM tasks WHERE project_id = ? ORDER BY phase_id, position, id", projectId)
        .map((row) => this.parse(row)),
    );
  }

  private parse(row: SqliteRow): Task {
    const id = requiredString(row, "id") as Task["id"];
    return taskSchema.parse({
      id,
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
    if (attempt.agentRunId !== undefined || attempt.commitSha !== undefined) {
      throw new PersistenceError("Create an attempt before attaching runtime outcomes");
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
    return row === undefined ? undefined : this.parse(row);
  }

  listByTaskId(taskId: Task["id"]): readonly Attempt[] {
    return Object.freeze(
      this.connection
        .all(
          `SELECT attempts.*, agent_runs.id AS agent_run_id
           FROM attempts LEFT JOIN agent_runs ON agent_runs.attempt_id = attempts.id
           WHERE attempts.task_id = ? ORDER BY attempts.number, attempts.id`,
          taskId,
        )
        .map((row) => this.parse(row)),
    );
  }

  recordCompleted(id: Attempt["id"], completedAt: string): Attempt {
    isoTimestampSchema.parse(completedAt);
    const existing = this.findById(id);
    if (existing === undefined) throw new PersistenceError("Attempt is missing");
    if (existing.completedAt !== undefined) {
      if (existing.completedAt !== completedAt) {
        throw new PersistenceError("Attempt already records a different completion time");
      }
      return existing;
    }
    const changes = this.connection.run(
      "UPDATE attempts SET completed_at = ? WHERE id = ? AND completed_at IS NULL",
      completedAt,
      id,
    );
    if (changes !== 1) throw new PersistenceError("Could not complete the attempt");
    const stored = this.findById(id);
    if (stored === undefined) throw new PersistenceError("Completed attempt is missing");
    return stored;
  }

  recordCommit(id: Attempt["id"], taskId: Task["id"], commitSha: string): Attempt {
    requireNonEmpty(commitSha, "Attempt commit SHA");
    const existing = this.findById(id);
    if (existing?.taskId !== taskId) {
      throw new PersistenceError("Commit attempt does not belong to the task");
    }
    if (existing.commitSha !== undefined) {
      if (existing.commitSha !== commitSha) {
        throw new PersistenceError("Attempt already records a different commit SHA");
      }
      return existing;
    }
    const changes = this.connection.run(
      "UPDATE attempts SET commit_sha = ? WHERE id = ? AND task_id = ? AND commit_sha IS NULL",
      commitSha,
      id,
      taskId,
    );
    if (changes !== 1) throw new PersistenceError("Could not record the attempt commit SHA");
    const stored = this.findById(id);
    if (stored === undefined) throw new PersistenceError("Committed attempt is missing");
    return stored;
  }

  private parse(row: SqliteRow): Attempt {
    const completedAt = optionalString(row, "completed_at");
    const agentRunId = optionalString(row, "agent_run_id");
    const commitSha = optionalString(row, "commit_sha");
    return attemptSchema.parse({
      id: requiredString(row, "id"),
      taskId: requiredString(row, "task_id"),
      number: requiredNumber(row, "number"),
      startedAt: requiredString(row, "started_at"),
      ...(completedAt === undefined ? {} : { completedAt }),
      ...(agentRunId === undefined ? {} : { agentRunId }),
      ...(commitSha === undefined ? {} : { commitSha }),
    });
  }
}

class SqliteAgentRunRepository implements AgentRunRepository {
  constructor(private readonly connection: SqliteConnection) {}

  create(input: AgentRun): AgentRun {
    const run = agentRunSchema.parse(input);
    this.connection.run(
      `INSERT INTO agent_runs
       (id, attempt_id, adapter_id, started_at, completed_at, adapter_run_id, process_id,
        process_identity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      run.id,
      run.attemptId,
      run.adapterId,
      run.startedAt,
      run.completedAt ?? null,
      run.adapterRunId ?? null,
      run.processId ?? null,
      run.processIdentity ?? null,
    );
    return run;
  }

  findById(id: AgentRun["id"]): AgentRun | undefined {
    const row = this.connection.get("SELECT * FROM agent_runs WHERE id = ?", id);
    return row === undefined ? undefined : this.parse(row);
  }

  findByAttemptId(attemptId: Attempt["id"]): AgentRun | undefined {
    const row = this.connection.get("SELECT * FROM agent_runs WHERE attempt_id = ?", attemptId);
    return row === undefined ? undefined : this.parse(row);
  }

  recordCompleted(id: AgentRun["id"], completedAt: string): AgentRun {
    isoTimestampSchema.parse(completedAt);
    const changes = this.connection.run(
      `UPDATE agent_runs SET completed_at = ?
       WHERE id = ? AND completed_at IS NULL`,
      completedAt,
      id,
    );
    if (changes !== 1) {
      throw new PersistenceError("Agent run is missing or already completed");
    }
    const stored = this.findById(id);
    if (stored === undefined) throw new PersistenceError("Completed agent run is missing");
    return stored;
  }

  private parse(row: SqliteRow): AgentRun {
    const completedAt = optionalString(row, "completed_at");
    const adapterRunId = optionalString(row, "adapter_run_id");
    const processId = optionalNumber(row, "process_id");
    const processIdentity = optionalString(row, "process_identity");
    return agentRunSchema.parse({
      id: requiredString(row, "id"),
      attemptId: requiredString(row, "attempt_id"),
      adapterId: requiredString(row, "adapter_id"),
      startedAt: requiredString(row, "started_at"),
      ...(completedAt === undefined ? {} : { completedAt }),
      ...(adapterRunId === undefined ? {} : { adapterRunId }),
      ...(processId === undefined ? {} : { processId }),
      ...(processIdentity === undefined ? {} : { processIdentity }),
    });
  }
}

class SqliteValidationRunRepository implements ValidationRunRepository {
  constructor(private readonly connection: SqliteConnection) {}

  create(input: ValidationRun): ValidationRun {
    const run = validationRunSchema.parse(input);
    this.connection.run(
      `INSERT INTO validation_runs
       (id, task_id, attempt_id, validator_id, plan_id, plan_version,
        manual_review_criteria_json, started_at, completed_at, passed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      run.id,
      run.taskId,
      run.attemptId ?? null,
      run.validatorId,
      run.planId ?? null,
      run.planVersion ?? null,
      JSON.stringify(run.manualReviewCriteria),
      run.startedAt,
      run.completedAt ?? null,
      run.passed === undefined ? null : Number(run.passed),
    );
    return run;
  }

  findById(id: ValidationRun["id"]): ValidationRun | undefined {
    const row = this.connection.get("SELECT * FROM validation_runs WHERE id = ?", id);
    return row === undefined ? undefined : this.parse(row);
  }

  listByTaskId(taskId: Task["id"]): readonly ValidationRun[] {
    return Object.freeze(
      this.connection
        .all("SELECT * FROM validation_runs WHERE task_id = ? ORDER BY started_at, id", taskId)
        .map((row) => this.parse(row)),
    );
  }

  recordCompleted(id: ValidationRun["id"], completedAt: string, passed: boolean): ValidationRun {
    isoTimestampSchema.parse(completedAt);
    const existing = this.findById(id);
    if (existing === undefined) throw new PersistenceError("Validation run is missing");
    if (existing.completedAt !== undefined || existing.passed !== undefined) {
      if (existing.completedAt !== completedAt || existing.passed !== passed) {
        throw new PersistenceError("Validation run already records a different outcome");
      }
      return existing;
    }
    const changes = this.connection.run(
      `UPDATE validation_runs SET completed_at = ?, passed = ?
       WHERE id = ? AND completed_at IS NULL AND passed IS NULL`,
      completedAt,
      Number(passed),
      id,
    );
    if (changes !== 1) throw new PersistenceError("Could not complete the validation run");
    const stored = this.findById(id);
    if (stored === undefined) throw new PersistenceError("Completed validation run is missing");
    return stored;
  }

  private parse(row: SqliteRow): ValidationRun {
    const attemptId = optionalString(row, "attempt_id");
    const planId = optionalString(row, "plan_id");
    const planVersion = optionalString(row, "plan_version");
    const completedAt = optionalString(row, "completed_at");
    const passed = optionalBoolean(row, "passed");
    return validationRunSchema.parse({
      id: requiredString(row, "id"),
      taskId: requiredString(row, "task_id"),
      validatorId: requiredString(row, "validator_id"),
      ...(planId === undefined ? {} : { planId }),
      ...(planVersion === undefined ? {} : { planVersion }),
      manualReviewCriteria: parseJson(requiredString(row, "manual_review_criteria_json")),
      startedAt: requiredString(row, "started_at"),
      ...(attemptId === undefined ? {} : { attemptId }),
      ...(completedAt === undefined ? {} : { completedAt }),
      ...(passed === undefined ? {} : { passed }),
    });
  }
}

class SqliteValidationResultRepository implements ValidationResultRepository {
  constructor(private readonly connection: SqliteConnection) {}

  create(input: ValidationResult): ValidationResult {
    const result = validationResultSchema.parse(input);
    this.connection.run(
      `INSERT INTO validation_results
       (id, validation_run_id, position, validator_id, validator_version, policy, status,
        started_at, completed_at, command_json, config_json, exit_code, diagnostics_json,
        related_acceptance_criteria_json, retry_relevant, evidence_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      result.id,
      result.validationRunId,
      result.position,
      result.validatorId,
      result.validatorVersion,
      result.policy,
      result.status,
      result.startedAt,
      result.completedAt,
      result.command === undefined ? null : JSON.stringify(result.command),
      result.config === undefined ? null : JSON.stringify(result.config),
      result.exitCode ?? null,
      JSON.stringify(result.diagnostics),
      JSON.stringify(result.relatedAcceptanceCriteria),
      Number(result.retryRelevant),
      result.evidenceSource,
    );
    return result;
  }

  findById(id: ValidationResult["id"]): ValidationResult | undefined {
    const row = this.connection.get("SELECT * FROM validation_results WHERE id = ?", id);
    return row === undefined ? undefined : this.parse(row);
  }

  listByRunId(validationRunId: ValidationRun["id"]): readonly ValidationResult[] {
    return Object.freeze(
      this.connection
        .all(
          `SELECT * FROM validation_results
           WHERE validation_run_id = ? ORDER BY position, id`,
          validationRunId,
        )
        .map((row) => this.parse(row)),
    );
  }

  private parse(row: SqliteRow): ValidationResult {
    const command = optionalString(row, "command_json");
    const config = optionalString(row, "config_json");
    const exitCode = optionalNumber(row, "exit_code");
    return validationResultSchema.parse({
      id: requiredString(row, "id"),
      validationRunId: requiredString(row, "validation_run_id"),
      position: requiredNumber(row, "position"),
      validatorId: requiredString(row, "validator_id"),
      validatorVersion: requiredString(row, "validator_version"),
      evidenceSource: requiredString(row, "evidence_source"),
      policy: requiredString(row, "policy"),
      status: requiredString(row, "status"),
      startedAt: requiredString(row, "started_at"),
      completedAt: requiredString(row, "completed_at"),
      ...(command === undefined ? {} : { command: parseJson(command) }),
      ...(config === undefined ? {} : { config: parseJson(config) }),
      ...(exitCode === undefined ? {} : { exitCode }),
      diagnostics: parseJson(requiredString(row, "diagnostics_json")),
      relatedAcceptanceCriteria: parseJson(requiredString(row, "related_acceptance_criteria_json")),
      retryRelevant: requiredNumber(row, "retry_relevant") === 1,
    });
  }
}

class SqliteIndependentReviewRepository implements IndependentReviewRepository {
  constructor(private readonly connection: SqliteConnection) {}

  create(input: IndependentReview): IndependentReview {
    const review = independentReviewSchema.parse(input);
    this.connection.run(
      `INSERT INTO independent_reviews
       (id, project_id, task_id, phase_id, validation_run_id, validation_event_id, adapter_id,
        reviewer_run_id, context_hash, requested_at, completed_at, output_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      review.id,
      review.projectId,
      review.taskId ?? null,
      review.phaseId ?? null,
      review.validationRunId ?? null,
      review.validationEventId ?? null,
      review.adapterId,
      review.reviewerRunId,
      review.contextHash,
      review.requestedAt,
      review.completedAt ?? null,
      review.output === undefined ? null : JSON.stringify(review.output),
    );
    return review;
  }

  findById(id: IndependentReview["id"]): IndependentReview | undefined {
    const row = this.connection.get("SELECT * FROM independent_reviews WHERE id = ?", id);
    return row === undefined ? undefined : this.parse(row);
  }

  listByTaskId(taskId: Task["id"]): readonly IndependentReview[] {
    return Object.freeze(
      this.connection
        .all(
          `SELECT * FROM independent_reviews
           WHERE task_id = ? ORDER BY requested_at, id`,
          taskId,
        )
        .map((row) => this.parse(row)),
    );
  }

  listByPhaseId(phaseId: Phase["id"]): readonly IndependentReview[] {
    return Object.freeze(
      this.connection
        .all(
          `SELECT * FROM independent_reviews
           WHERE phase_id = ? ORDER BY requested_at, id`,
          phaseId,
        )
        .map((row) => this.parse(row)),
    );
  }

  complete(
    id: IndependentReview["id"],
    completedAt: string,
    output: IndependentReviewOutput,
  ): IndependentReview {
    isoTimestampSchema.parse(completedAt);
    const parsedOutput = independentReviewOutputSchema.parse(output);
    const existing = this.findById(id);
    if (existing === undefined) throw new PersistenceError("Independent review is missing");
    if (existing.completedAt !== undefined || existing.output !== undefined) {
      if (
        existing.completedAt !== completedAt ||
        JSON.stringify(existing.output) !== JSON.stringify(parsedOutput)
      ) {
        throw new PersistenceError("Independent review already records a different outcome");
      }
      return existing;
    }
    const changes = this.connection.run(
      `UPDATE independent_reviews SET completed_at = ?, output_json = ?
       WHERE id = ? AND completed_at IS NULL AND output_json IS NULL`,
      completedAt,
      JSON.stringify(parsedOutput),
      id,
    );
    if (changes !== 1) throw new PersistenceError("Could not complete independent review");
    const stored = this.findById(id);
    if (stored === undefined) throw new PersistenceError("Completed independent review is missing");
    return stored;
  }

  private parse(row: SqliteRow): IndependentReview {
    const taskId = optionalString(row, "task_id");
    const phaseId = optionalString(row, "phase_id");
    const completedAt = optionalString(row, "completed_at");
    const output = optionalString(row, "output_json");
    const validationRunId = optionalString(row, "validation_run_id");
    const validationEventId = optionalString(row, "validation_event_id");
    return independentReviewSchema.parse({
      id: requiredString(row, "id"),
      projectId: requiredString(row, "project_id"),
      ...(taskId === undefined ? {} : { taskId }),
      ...(phaseId === undefined ? {} : { phaseId }),
      ...(validationRunId === undefined ? {} : { validationRunId }),
      ...(validationEventId === undefined ? {} : { validationEventId }),
      adapterId: requiredString(row, "adapter_id"),
      reviewerRunId: requiredString(row, "reviewer_run_id"),
      contextHash: requiredString(row, "context_hash"),
      requestedAt: requiredString(row, "requested_at"),
      ...(completedAt === undefined ? {} : { completedAt }),
      ...(output === undefined ? {} : { output: parseJson(output) }),
    });
  }
}

class SqliteManualAcceptanceReviewRepository implements ManualAcceptanceReviewRepository {
  constructor(private readonly connection: SqliteConnection) {}

  create(input: ManualAcceptanceReview): ManualAcceptanceReview {
    const review = manualAcceptanceReviewSchema.parse(input);
    this.connection.run(
      `INSERT INTO manual_acceptance_reviews
       (id, validation_run_id, criterion_position, criterion, decision, actor, reason, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      review.id,
      review.validationRunId,
      review.criterionPosition,
      review.criterion,
      review.decision,
      review.actor,
      review.reason,
      review.occurredAt,
    );
    return review;
  }

  findById(id: ManualAcceptanceReview["id"]): ManualAcceptanceReview | undefined {
    const row = this.connection.get("SELECT * FROM manual_acceptance_reviews WHERE id = ?", id);
    return row === undefined ? undefined : this.parse(row);
  }

  listByRunId(validationRunId: ValidationRun["id"]): readonly ManualAcceptanceReview[] {
    return Object.freeze(
      this.connection
        .all(
          `SELECT * FROM manual_acceptance_reviews
           WHERE validation_run_id = ? ORDER BY criterion_position, id`,
          validationRunId,
        )
        .map((row) => this.parse(row)),
    );
  }

  private parse(row: SqliteRow): ManualAcceptanceReview {
    return manualAcceptanceReviewSchema.parse({
      id: requiredString(row, "id"),
      validationRunId: requiredString(row, "validation_run_id"),
      criterionPosition: requiredNumber(row, "criterion_position"),
      criterion: requiredString(row, "criterion"),
      decision: requiredString(row, "decision"),
      actor: requiredString(row, "actor"),
      reason: requiredString(row, "reason"),
      occurredAt: requiredString(row, "occurred_at"),
    });
  }
}

class SqliteDecisionRepository implements DecisionRepository {
  constructor(private readonly connection: SqliteConnection) {}

  create(input: Decision): Decision {
    const decision = decisionSchema.parse(input);
    this.connection.run(
      `INSERT INTO decisions
       (id, project_id, kind, statement, title, rationale, category, source, scope, status,
        supersedes_id, affected_phase_ids_json, affected_task_ids_json, created_at, superseded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      decision.id,
      decision.projectId,
      decision.kind,
      decision.statement,
      decision.title,
      decision.rationale,
      decision.category,
      decision.source,
      decision.scope,
      decision.status,
      decision.supersedesId ?? null,
      JSON.stringify(decision.affectedPhaseIds),
      JSON.stringify(decision.affectedTaskIds),
      decision.createdAt,
      decision.supersededAt ?? null,
    );
    return decision;
  }

  findById(id: Decision["id"]): Decision | undefined {
    const row = this.connection.get("SELECT * FROM decisions WHERE id = ?", id);
    return row === undefined ? undefined : this.parse(row);
  }

  listByProjectId(projectId: Project["id"]): readonly Decision[] {
    return Object.freeze(
      this.connection
        .all("SELECT * FROM decisions WHERE project_id = ? ORDER BY created_at, id", projectId)
        .map((row) => this.parse(row)),
    );
  }

  markSuperseded(id: Decision["id"], supersededAtInput: string): Decision {
    const supersededAt = isoTimestampSchema.parse(supersededAtInput);
    const changes = this.connection.run(
      `UPDATE decisions SET status = 'superseded', superseded_at = ?
       WHERE id = ? AND status = 'active'`,
      supersededAt,
      id,
    );
    if (changes !== 1) {
      throw new PersistenceError(`Decision ${id} is missing or is no longer active`);
    }
    const decision = this.findById(id);
    if (decision === undefined) {
      throw new PersistenceError(`Decision ${id} disappeared after supersession`);
    }
    return decision;
  }

  private parse(row: SqliteRow): Decision {
    const supersedesId = optionalString(row, "supersedes_id");
    const supersededAt = optionalString(row, "superseded_at");
    return decisionSchema.parse({
      id: requiredString(row, "id"),
      projectId: requiredString(row, "project_id"),
      kind: requiredString(row, "kind"),
      statement: requiredString(row, "statement"),
      title: requiredString(row, "title"),
      rationale: requiredString(row, "rationale"),
      category: requiredString(row, "category"),
      source: requiredString(row, "source"),
      scope: requiredString(row, "scope"),
      status: requiredString(row, "status"),
      ...(supersedesId === undefined ? {} : { supersedesId }),
      affectedPhaseIds: parseJson(requiredString(row, "affected_phase_ids_json")),
      affectedTaskIds: parseJson(requiredString(row, "affected_task_ids_json")),
      createdAt: requiredString(row, "created_at"),
      ...(supersededAt === undefined ? {} : { supersededAt }),
    });
  }
}

class SqliteRoadmapRevisionRepository implements RoadmapRevisionRepository {
  constructor(private readonly connection: SqliteConnection) {}

  create(input: RoadmapRevision): RoadmapRevision {
    const revision = roadmapRevisionSchema.parse(input);
    this.connection.run(
      `INSERT INTO roadmap_revisions
       (id, project_id, classification, reason, actor, session_id, created_at,
        affected_phase_ids_json, affected_task_ids_json, old_value_json, new_value_json,
        operation_json, approval_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      revision.id,
      revision.projectId,
      revision.classification,
      revision.reason,
      revision.actor,
      revision.sessionId ?? null,
      revision.createdAt,
      JSON.stringify(revision.affectedPhaseIds),
      JSON.stringify(revision.affectedTaskIds),
      JSON.stringify(revision.oldValue),
      JSON.stringify(revision.newValue),
      revision.operation === undefined ? null : JSON.stringify(revision.operation),
      revision.approval === undefined ? null : JSON.stringify(revision.approval),
    );
    return revision;
  }

  findById(id: RoadmapRevision["id"]): RoadmapRevision | undefined {
    const row = this.connection.get("SELECT * FROM roadmap_revisions WHERE id = ?", id);
    return row === undefined ? undefined : this.parse(row);
  }

  listByProjectId(projectId: Project["id"]): readonly RoadmapRevision[] {
    return Object.freeze(
      this.connection
        .all(
          "SELECT * FROM roadmap_revisions WHERE project_id = ? ORDER BY created_at, id",
          projectId,
        )
        .map((row) => this.parse(row)),
    );
  }

  private parse(row: SqliteRow): RoadmapRevision {
    const sessionId = optionalString(row, "session_id");
    const operation = optionalString(row, "operation_json");
    const approval = optionalString(row, "approval_json");
    return roadmapRevisionSchema.parse({
      id: requiredString(row, "id"),
      projectId: requiredString(row, "project_id"),
      classification: requiredString(row, "classification"),
      reason: requiredString(row, "reason"),
      actor: requiredString(row, "actor"),
      ...(sessionId === undefined ? {} : { sessionId }),
      createdAt: requiredString(row, "created_at"),
      affectedPhaseIds: parseJson(requiredString(row, "affected_phase_ids_json")),
      affectedTaskIds: parseJson(requiredString(row, "affected_task_ids_json")),
      oldValue: parseJson(requiredString(row, "old_value_json")),
      newValue: parseJson(requiredString(row, "new_value_json")),
      ...(operation === undefined ? {} : { operation: parseJson(operation) }),
      ...(approval === undefined ? {} : { approval: parseJson(approval) }),
    });
  }
}

class SqliteCheckpointRepository implements CheckpointRepository {
  constructor(private readonly connection: SqliteConnection) {}

  create(input: Checkpoint): Checkpoint {
    const checkpoint = checkpointSchema.parse(input);
    this.connection.run(
      `INSERT INTO checkpoints
       (id, project_id, task_id, attempt_id, run_branch, created_at, description,
        git_head, git_status, workspace_fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      checkpoint.id,
      checkpoint.projectId,
      checkpoint.taskId ?? null,
      checkpoint.attemptId ?? null,
      checkpoint.runBranch ?? null,
      checkpoint.createdAt,
      checkpoint.description ?? null,
      checkpoint.gitHead ?? null,
      checkpoint.gitStatus ?? null,
      checkpoint.workspaceFingerprint ?? null,
    );
    return checkpoint;
  }

  findById(id: Checkpoint["id"]): Checkpoint | undefined {
    const row = this.connection.get("SELECT * FROM checkpoints WHERE id = ?", id);
    return row === undefined ? undefined : this.parse(row);
  }

  findByAttemptId(attemptId: Attempt["id"]): Checkpoint | undefined {
    const row = this.connection.get("SELECT * FROM checkpoints WHERE attempt_id = ?", attemptId);
    return row === undefined ? undefined : this.parse(row);
  }

  listByProjectId(projectId: Project["id"]): readonly Checkpoint[] {
    return Object.freeze(
      this.connection
        .all("SELECT * FROM checkpoints WHERE project_id = ? ORDER BY created_at, id", projectId)
        .map((row) => this.parse(row)),
    );
  }

  listByTaskId(taskId: Task["id"]): readonly Checkpoint[] {
    return Object.freeze(
      this.connection
        .all("SELECT * FROM checkpoints WHERE task_id = ? ORDER BY created_at, id", taskId)
        .map((row) => this.parse(row)),
    );
  }

  private parse(row: SqliteRow): Checkpoint {
    const taskId = optionalString(row, "task_id");
    const attemptId = optionalString(row, "attempt_id");
    const runBranch = optionalString(row, "run_branch");
    const description = optionalString(row, "description");
    const gitHead = optionalString(row, "git_head");
    const gitStatus = optionalString(row, "git_status");
    const workspaceFingerprint = optionalString(row, "workspace_fingerprint");
    return checkpointSchema.parse({
      id: requiredString(row, "id"),
      projectId: requiredString(row, "project_id"),
      ...(taskId === undefined ? {} : { taskId }),
      ...(attemptId === undefined ? {} : { attemptId }),
      ...(runBranch === undefined ? {} : { runBranch }),
      createdAt: requiredString(row, "created_at"),
      ...(description === undefined ? {} : { description }),
      ...(gitHead === undefined ? {} : { gitHead }),
      ...(gitStatus === undefined ? {} : { gitStatus }),
      ...(workspaceFingerprint === undefined ? {} : { workspaceFingerprint }),
    });
  }
}

function validateRunBranch(input: DensaRunBranchRecord): DensaRunBranchRecord {
  requireNonEmpty(input.projectId, "Densa run projectId");
  requireNonEmpty(input.workspacePath, "Densa run workspacePath");
  requireNonEmpty(input.branchName, "Densa run branchName");
  requireNonEmpty(input.sourceBranch, "Densa run sourceBranch");
  requireNonEmpty(input.startingCommit, "Densa run startingCommit");
  isoTimestampSchema.parse(input.createdAt);
  if (!input.branchName.startsWith("densa/run/")) {
    throw new PersistenceError("Densa run branch must use the reserved namespace");
  }
  if (!(["CREATING", "ACTIVE", "FAILED"] as const).includes(input.status)) {
    throw new PersistenceError("Densa run branch has an invalid status");
  }
  if (input.activatedAt !== undefined) isoTimestampSchema.parse(input.activatedAt);
  if (input.failureReason !== undefined) requireNonEmpty(input.failureReason, "failureReason");
  if ((input.status === "ACTIVE") !== (input.activatedAt !== undefined)) {
    throw new PersistenceError("Only active Densa runs have an activation timestamp");
  }
  if ((input.status === "FAILED") !== (input.failureReason !== undefined)) {
    throw new PersistenceError("Only failed Densa runs have a failure reason");
  }
  return Object.freeze({ ...input });
}

class SqliteDensaRunBranchRepository implements DensaRunBranchRepository {
  constructor(private readonly connection: SqliteConnection) {}

  createCreating(input: NewDensaRunBranchRecord): DensaRunBranchRecord {
    const run = validateRunBranch({ ...input, status: "CREATING" });
    this.connection.run(
      `INSERT INTO densa_run_branches
       (project_id, workspace_path, branch_name, source_branch, starting_commit, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      run.projectId,
      run.workspacePath,
      run.branchName,
      run.sourceBranch,
      run.startingCommit,
      run.status,
      run.createdAt,
    );
    return run;
  }

  findByProjectId(projectId: Project["id"]): DensaRunBranchRecord | undefined {
    const row = this.connection.get(
      "SELECT * FROM densa_run_branches WHERE project_id = ?",
      projectId,
    );
    return row === undefined ? undefined : this.parse(row);
  }

  findByBranchName(branchName: string): DensaRunBranchRecord | undefined {
    const row = this.connection.get(
      "SELECT * FROM densa_run_branches WHERE branch_name = ?",
      branchName,
    );
    return row === undefined ? undefined : this.parse(row);
  }

  activate(projectId: Project["id"], activatedAt: string): DensaRunBranchRecord {
    isoTimestampSchema.parse(activatedAt);
    const changes = this.connection.run(
      `UPDATE densa_run_branches SET status = 'ACTIVE', activated_at = ?
       WHERE project_id = ? AND status = 'CREATING'`,
      activatedAt,
      projectId,
    );
    if (changes !== 1) {
      throw new PersistenceError("Densa run branch could not transition from CREATING to ACTIVE");
    }
    const stored = this.findByProjectId(projectId);
    if (stored === undefined) throw new PersistenceError("Activated Densa run branch is missing");
    return stored;
  }

  fail(projectId: Project["id"], failureReason: string): DensaRunBranchRecord {
    requireNonEmpty(failureReason, "Densa run failure reason");
    const changes = this.connection.run(
      `UPDATE densa_run_branches SET status = 'FAILED', failure_reason = ?
       WHERE project_id = ? AND status = 'CREATING'`,
      failureReason,
      projectId,
    );
    if (changes !== 1) {
      throw new PersistenceError("Densa run branch could not transition from CREATING to FAILED");
    }
    const stored = this.findByProjectId(projectId);
    if (stored === undefined) throw new PersistenceError("Failed Densa run branch is missing");
    return stored;
  }

  private parse(row: SqliteRow): DensaRunBranchRecord {
    const activatedAt = optionalString(row, "activated_at");
    const failureReason = optionalString(row, "failure_reason");
    return validateRunBranch({
      projectId: requiredString(row, "project_id") as Project["id"],
      workspacePath: requiredString(row, "workspace_path"),
      branchName: requiredString(row, "branch_name"),
      sourceBranch: requiredString(row, "source_branch"),
      startingCommit: requiredString(row, "starting_commit"),
      status: requiredString(row, "status") as DensaRunBranchStatus,
      createdAt: requiredString(row, "created_at"),
      ...(activatedAt === undefined ? {} : { activatedAt }),
      ...(failureReason === undefined ? {} : { failureReason }),
    });
  }
}

function validateTaskCommitIntent(
  input: TaskCommitIntentRecord | NewTaskCommitIntentRecord,
): TaskCommitIntentRecord {
  const commitSha = "commitSha" in input ? input.commitSha : undefined;
  const committedAt = "committedAt" in input ? input.committedAt : undefined;
  requireNonEmpty(input.attemptId, "Task commit attemptId");
  requireNonEmpty(input.projectId, "Task commit projectId");
  requireNonEmpty(input.taskId, "Task commit taskId");
  requireNonEmpty(input.workspacePath, "Task commit workspacePath");
  requireNonEmpty(input.branchName, "Task commit branchName");
  requireNonEmpty(input.expectedHead, "Task commit expectedHead");
  requireNonEmpty(input.commitMessage, "Task commit message");
  isoTimestampSchema.parse(input.createdAt);
  if (input.intendedPaths.length === 0 || input.intendedPaths.some((path) => path.length === 0)) {
    throw new PersistenceError("Task commit intendedPaths must contain non-empty paths");
  }
  if ((commitSha === undefined) !== (committedAt === undefined)) {
    throw new PersistenceError("Task commit SHA and committedAt must be recorded together");
  }
  if (commitSha !== undefined) requireNonEmpty(commitSha, "Task commit SHA");
  if (committedAt !== undefined) isoTimestampSchema.parse(committedAt);
  return Object.freeze({ ...input, intendedPaths: Object.freeze([...input.intendedPaths]) });
}

class SqliteTaskCommitIntentRepository implements TaskCommitIntentRepository {
  constructor(private readonly connection: SqliteConnection) {}

  create(input: NewTaskCommitIntentRecord): TaskCommitIntentRecord {
    const intent = validateTaskCommitIntent(input);
    this.connection.run(
      `INSERT INTO task_commit_intents
       (attempt_id, project_id, task_id, workspace_path, branch_name, expected_head,
        commit_message, intended_paths_json, created_at, commit_sha, committed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      intent.attemptId,
      intent.projectId,
      intent.taskId,
      intent.workspacePath,
      intent.branchName,
      intent.expectedHead,
      intent.commitMessage,
      JSON.stringify(intent.intendedPaths),
      intent.createdAt,
    );
    return intent;
  }

  findByAttemptId(attemptId: Attempt["id"]): TaskCommitIntentRecord | undefined {
    const row = this.connection.get(
      "SELECT * FROM task_commit_intents WHERE attempt_id = ?",
      attemptId,
    );
    return row === undefined ? undefined : this.parse(row);
  }

  recordCommit(
    attemptId: Attempt["id"],
    commitSha: string,
    committedAt: string,
  ): TaskCommitIntentRecord {
    requireNonEmpty(commitSha, "Task commit SHA");
    isoTimestampSchema.parse(committedAt);
    const existing = this.findByAttemptId(attemptId);
    if (existing === undefined) throw new PersistenceError("Task commit intent is missing");
    if (existing.commitSha !== undefined) {
      if (existing.commitSha !== commitSha) {
        throw new PersistenceError("Task commit intent already records a different commit SHA");
      }
      return existing;
    }
    const changes = this.connection.run(
      `UPDATE task_commit_intents SET commit_sha = ?, committed_at = ?
       WHERE attempt_id = ? AND commit_sha IS NULL AND committed_at IS NULL`,
      commitSha,
      committedAt,
      attemptId,
    );
    if (changes !== 1) throw new PersistenceError("Could not record the task commit outcome");
    const stored = this.findByAttemptId(attemptId);
    if (stored === undefined) throw new PersistenceError("Recorded task commit intent is missing");
    return stored;
  }

  private parse(row: SqliteRow): TaskCommitIntentRecord {
    const intendedPaths = parseJson(requiredString(row, "intended_paths_json"));
    if (
      !Array.isArray(intendedPaths) ||
      intendedPaths.some((path): boolean => typeof path !== "string")
    ) {
      throw new PersistenceError("Persisted task commit paths are malformed");
    }
    const commitSha = optionalString(row, "commit_sha");
    const committedAt = optionalString(row, "committed_at");
    return validateTaskCommitIntent({
      attemptId: requiredString(row, "attempt_id") as Attempt["id"],
      projectId: requiredString(row, "project_id") as Project["id"],
      taskId: requiredString(row, "task_id") as Task["id"],
      workspacePath: requiredString(row, "workspace_path"),
      branchName: requiredString(row, "branch_name"),
      expectedHead: requiredString(row, "expected_head"),
      commitMessage: requiredString(row, "commit_message"),
      intendedPaths,
      createdAt: requiredString(row, "created_at"),
      ...(commitSha === undefined ? {} : { commitSha }),
      ...(committedAt === undefined ? {} : { committedAt }),
    });
  }
}

function validateRollbackPathSnapshot(input: RollbackPathSnapshot): RollbackPathSnapshot {
  requireNonEmpty(input.path, "Rollback path");
  if (!(input.kind === "ABSENT" || input.kind === "FILE" || input.kind === "SYMLINK")) {
    throw new PersistenceError("Rollback path has an invalid kind");
  }
  if ((input.kind === "ABSENT") !== (input.contentHash === undefined)) {
    throw new PersistenceError("Only present rollback paths have a content hash");
  }
  if (input.contentHash !== undefined && !/^[a-f0-9]{64}$/u.test(input.contentHash)) {
    throw new PersistenceError("Rollback path content hash must be SHA-256");
  }
  if (input.indexHash !== undefined && !/^[a-f0-9]{64}$/u.test(input.indexHash)) {
    throw new PersistenceError("Rollback path index hash must be SHA-256");
  }
  return Object.freeze({ ...input });
}

function validateAttemptRollbackPlan(
  input: AttemptRollbackPlanRecord | NewAttemptRollbackPlanRecord,
): AttemptRollbackPlanRecord {
  const appliedAt = "appliedAt" in input ? input.appliedAt : undefined;
  const failureRecordedAt = "failureRecordedAt" in input ? input.failureRecordedAt : undefined;
  requireNonEmpty(input.attemptId, "Rollback attemptId");
  requireNonEmpty(input.agentRunId, "Rollback agentRunId");
  requireNonEmpty(input.projectId, "Rollback projectId");
  requireNonEmpty(input.taskId, "Rollback taskId");
  requireNonEmpty(input.workspacePath, "Rollback workspacePath");
  requireNonEmpty(input.branchName, "Rollback branchName");
  requireNonEmpty(input.checkpointHead, "Rollback checkpointHead");
  isoTimestampSchema.parse(input.recordedAt);
  if (failureRecordedAt !== undefined) isoTimestampSchema.parse(failureRecordedAt);
  if (appliedAt !== undefined) isoTimestampSchema.parse(appliedAt);
  if (input.ownedPaths.length === 0) {
    throw new PersistenceError("Rollback plan must contain at least one owned path");
  }
  const ownedPaths = Object.freeze(input.ownedPaths.map(validateRollbackPathSnapshot));
  if (new Set(ownedPaths.map((entry) => entry.path)).size !== ownedPaths.length) {
    throw new PersistenceError("Rollback plan paths must be unique");
  }
  const diagnostics = Object.freeze(
    jsonObjectSchema.parse("diagnostics" in input ? input.diagnostics : {}),
  );
  if (failureRecordedAt === undefined && Object.keys(diagnostics).length !== 0) {
    throw new PersistenceError("Rollback diagnostics require a recorded failure boundary");
  }
  if (appliedAt !== undefined && failureRecordedAt === undefined) {
    throw new PersistenceError("Rollback cannot be applied before failure is recorded");
  }
  return Object.freeze({ ...input, ownedPaths, diagnostics });
}

class SqliteAttemptRollbackPlanRepository implements AttemptRollbackPlanRepository {
  constructor(private readonly connection: SqliteConnection) {}

  create(input: NewAttemptRollbackPlanRecord): AttemptRollbackPlanRecord {
    const plan = validateAttemptRollbackPlan(input);
    this.connection.run(
      `INSERT INTO attempt_rollback_plans
       (attempt_id, agent_run_id, project_id, task_id, workspace_path, branch_name, checkpoint_head,
        owned_paths_json, diagnostics_json, recorded_at, failure_recorded_at, applied_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, NULL, NULL)`,
      plan.attemptId,
      plan.agentRunId,
      plan.projectId,
      plan.taskId,
      plan.workspacePath,
      plan.branchName,
      plan.checkpointHead,
      JSON.stringify(plan.ownedPaths),
      plan.recordedAt,
    );
    return plan;
  }

  findByAttemptId(attemptId: Attempt["id"]): AttemptRollbackPlanRecord | undefined {
    const row = this.connection.get(
      "SELECT * FROM attempt_rollback_plans WHERE attempt_id = ?",
      attemptId,
    );
    if (row === undefined) return undefined;
    const ownedPaths = parseJson(requiredString(row, "owned_paths_json"));
    if (!Array.isArray(ownedPaths)) {
      throw new PersistenceError("Persisted rollback paths are malformed");
    }
    const appliedAt = optionalString(row, "applied_at");
    const failureRecordedAt = optionalString(row, "failure_recorded_at");
    return validateAttemptRollbackPlan({
      attemptId: requiredString(row, "attempt_id") as Attempt["id"],
      agentRunId: requiredString(row, "agent_run_id") as AgentRun["id"],
      projectId: requiredString(row, "project_id") as Project["id"],
      taskId: requiredString(row, "task_id") as Task["id"],
      workspacePath: requiredString(row, "workspace_path"),
      branchName: requiredString(row, "branch_name"),
      checkpointHead: requiredString(row, "checkpoint_head"),
      ownedPaths: ownedPaths as RollbackPathSnapshot[],
      diagnostics: jsonObjectSchema.parse(parseJson(requiredString(row, "diagnostics_json"))),
      recordedAt: requiredString(row, "recorded_at"),
      ...(failureRecordedAt === undefined ? {} : { failureRecordedAt }),
      ...(appliedAt === undefined ? {} : { appliedAt }),
    });
  }

  recordFailure(
    attemptId: Attempt["id"],
    diagnostics: Readonly<JsonObject>,
    failureRecordedAt: string,
  ): AttemptRollbackPlanRecord {
    isoTimestampSchema.parse(failureRecordedAt);
    const validatedDiagnostics = jsonObjectSchema.parse(diagnostics);
    const existing = this.findByAttemptId(attemptId);
    if (existing === undefined) throw new PersistenceError("Attempt output evidence is missing");
    if (existing.failureRecordedAt !== undefined) {
      if (
        existing.failureRecordedAt !== failureRecordedAt ||
        JSON.stringify(existing.diagnostics) !== JSON.stringify(validatedDiagnostics)
      ) {
        throw new PersistenceError("Attempt already records different failure evidence");
      }
      return existing;
    }
    const changes = this.connection.run(
      `UPDATE attempt_rollback_plans
       SET diagnostics_json = ?, failure_recorded_at = ?
       WHERE attempt_id = ? AND failure_recorded_at IS NULL`,
      JSON.stringify(validatedDiagnostics),
      failureRecordedAt,
      attemptId,
    );
    if (changes !== 1) throw new PersistenceError("Could not record failed-attempt diagnostics");
    const stored = this.findByAttemptId(attemptId);
    if (stored === undefined) throw new PersistenceError("Recorded failed-attempt plan is missing");
    return stored;
  }

  recordApplied(attemptId: Attempt["id"], appliedAt: string): AttemptRollbackPlanRecord {
    isoTimestampSchema.parse(appliedAt);
    const existing = this.findByAttemptId(attemptId);
    if (existing === undefined) throw new PersistenceError("Attempt rollback plan is missing");
    if (existing.failureRecordedAt === undefined) {
      throw new PersistenceError("Attempt failure must be recorded before rollback is applied");
    }
    if (existing.appliedAt !== undefined) return existing;
    const changes = this.connection.run(
      `UPDATE attempt_rollback_plans SET applied_at = ?
       WHERE attempt_id = ? AND applied_at IS NULL`,
      appliedAt,
      attemptId,
    );
    if (changes !== 1) throw new PersistenceError("Could not record rollback outcome");
    const stored = this.findByAttemptId(attemptId);
    if (stored === undefined) throw new PersistenceError("Applied rollback plan is missing");
    return stored;
  }
}

class SqliteEventRepository implements EventRepository {
  constructor(
    private readonly connection: SqliteConnection,
    private readonly publish: (event: Readonly<PersistedEvent>) => void,
  ) {}

  append(input: Event): PersistedEvent {
    const event = eventSchema.parse(input);
    const payloadJson = JSON.stringify(event.payload);
    if (Buffer.byteLength(payloadJson, "utf8") > MAX_EVENT_PAYLOAD_BYTES) {
      throw new PersistenceError(
        `Event payload exceeds the ${String(MAX_EVENT_PAYLOAD_BYTES)} byte limit`,
      );
    }
    this.connection.run(
      `INSERT INTO events
       (id, project_id, sequence_number, phase_id, task_id, type, event_version,
        occurred_at, actor, payload_json)
       SELECT ?, ?, COALESCE(MAX(sequence_number), 0) + 1, ?, ?, ?, ?, ?, ?, ?
       FROM events WHERE project_id = ?`,
      event.id,
      event.projectId,
      event.phaseId ?? null,
      event.taskId ?? null,
      event.type,
      event.eventVersion,
      event.occurredAt,
      event.actor,
      payloadJson,
      event.projectId,
    );
    const stored = this.findById(event.id);
    if (stored === undefined) {
      throw new PersistenceError("Event append did not produce a stored record");
    }
    this.connection.afterCommit(() => this.publish(stored));
    return stored;
  }

  findById(id: Event["id"]): PersistedEvent | undefined {
    const row = this.connection.get("SELECT * FROM events WHERE id = ?", id);
    return row === undefined ? undefined : this.parseRow(row);
  }

  latest(projectId: Project["id"]): PersistedEvent | undefined {
    const row = this.connection.get(
      "SELECT * FROM events WHERE project_id = ? ORDER BY sequence_number DESC LIMIT 1",
      projectId,
    );
    return row === undefined ? undefined : this.parseRow(row);
  }

  replay(filter: EventReplayFilter = {}): readonly PersistedEvent[] {
    if (filter.afterSequence !== undefined && filter.projectId === undefined) {
      throw new PersistenceError("Event replay afterSequence requires a projectId");
    }
    if (
      filter.afterSequence !== undefined &&
      (!Number.isSafeInteger(filter.afterSequence) || filter.afterSequence < 0)
    ) {
      throw new PersistenceError("Event replay afterSequence must be a nonnegative safe integer");
    }
    const limit = filter.limit ?? DEFAULT_EVENT_REPLAY_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENT_REPLAY_LIMIT) {
      throw new PersistenceError(
        `Event replay limit must be between 1 and ${String(MAX_EVENT_REPLAY_LIMIT)}`,
      );
    }
    if (filter.types !== undefined && filter.types.length === 0) {
      throw new PersistenceError("Event replay types must not be empty");
    }

    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    const addClause = (clause: string, value: string | number): void => {
      clauses.push(clause);
      parameters.push(value);
    };
    if (filter.projectId !== undefined) {
      addClause("project_id = ?", filter.projectId);
    }
    if (filter.phaseId !== undefined) {
      addClause("phase_id = ?", filter.phaseId);
    }
    if (filter.taskId !== undefined) {
      addClause("task_id = ?", filter.taskId);
    }
    if (filter.afterSequence !== undefined) {
      addClause("sequence_number > ?", filter.afterSequence);
    }
    if (filter.types !== undefined) {
      for (const type of filter.types) {
        if (!/^[A-Z][A-Z0-9_]*$/u.test(type)) {
          throw new PersistenceError(`Invalid event type filter: ${type}`);
        }
      }
      clauses.push(`type IN (${filter.types.map(() => "?").join(", ")})`);
      parameters.push(...filter.types);
    }

    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    const order =
      filter.projectId === undefined ? "project_id, sequence_number" : "sequence_number";
    const rows = this.connection.all(
      `SELECT * FROM events ${where} ORDER BY ${order} LIMIT ?`,
      ...parameters,
      limit,
    );
    return Object.freeze(rows.map((row) => this.parseRow(row)));
  }

  private parseRow(row: Parameters<typeof requiredString>[0]): PersistedEvent {
    const phaseId = optionalString(row, "phase_id");
    const taskId = optionalString(row, "task_id");
    const event = eventSchema.parse({
      id: requiredString(row, "id"),
      projectId: requiredString(row, "project_id"),
      type: requiredString(row, "type"),
      eventVersion: requiredNumber(row, "event_version"),
      occurredAt: requiredString(row, "occurred_at"),
      actor: requiredString(row, "actor"),
      payload: parseJson(requiredString(row, "payload_json")),
      ...(phaseId === undefined ? {} : { phaseId }),
      ...(taskId === undefined ? {} : { taskId }),
    });
    return Object.freeze({ ...event, sequenceNumber: requiredNumber(row, "sequence_number") });
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

  list(): readonly ProjectSettingsRecord[] {
    return Object.freeze(
      this.connection.all("SELECT * FROM project_settings ORDER BY project_id").map((row) =>
        validateSettings({
          projectId: requiredString(row, "project_id") as Project["id"],
          values: jsonObjectSchema.parse(parseJson(requiredString(row, "values_json"))),
          updatedAt: requiredString(row, "updated_at"),
        }),
      ),
    );
  }
}

class SqlitePhaseReportRepository implements PhaseReportRepository {
  constructor(private readonly connection: SqliteConnection) {}

  create(input: PhaseReport): PhaseReport {
    const report = phaseReportSchema.parse(input);
    this.connection.run(
      `INSERT INTO phase_reports
       (phase_id, project_id, outcome, report_path, report_json, generated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      report.phaseId,
      report.projectId,
      report.outcome,
      report.reportPath,
      JSON.stringify(report),
      report.generatedAt,
    );
    return report;
  }

  findByPhaseId(phaseId: Phase["id"]): PhaseReport | undefined {
    const row = this.connection.get(
      "SELECT report_json FROM phase_reports WHERE phase_id = ?",
      phaseId,
    );
    return row === undefined
      ? undefined
      : phaseReportSchema.parse(parseJson(requiredString(row, "report_json")));
  }

  listByProjectId(projectId: Project["id"]): readonly PhaseReport[] {
    return Object.freeze(
      this.connection
        .all(
          `SELECT report_json FROM phase_reports
           WHERE project_id = ? ORDER BY generated_at, phase_id`,
          projectId,
        )
        .map((row) => phaseReportSchema.parse(parseJson(requiredString(row, "report_json")))),
    );
  }
}

export function createRepositories(
  connection: SqliteConnection,
  publishEvent: (event: Readonly<PersistedEvent>) => void = () => undefined,
): DensaRepositories {
  const taskDependencies = new SqliteTaskDependencyRepository(connection);
  const acceptanceCriteria = new SqliteAcceptanceCriterionRepository(connection);
  return Object.freeze({
    projects: new SqliteProjectRepository(connection),
    specifications: new SqliteSpecificationRepository(connection),
    masterRoadmaps: new SqliteMasterRoadmapRepository(connection),
    phases: new SqlitePhaseRepository(connection),
    tasks: new SqliteTaskRepository(connection, taskDependencies, acceptanceCriteria),
    taskDependencies,
    acceptanceCriteria,
    attempts: new SqliteAttemptRepository(connection),
    agentRuns: new SqliteAgentRunRepository(connection),
    validationRuns: new SqliteValidationRunRepository(connection),
    validationResults: new SqliteValidationResultRepository(connection),
    manualAcceptanceReviews: new SqliteManualAcceptanceReviewRepository(connection),
    independentReviews: new SqliteIndependentReviewRepository(connection),
    decisions: new SqliteDecisionRepository(connection),
    roadmapRevisions: new SqliteRoadmapRevisionRepository(connection),
    densaRunBranches: new SqliteDensaRunBranchRepository(connection),
    taskCommitIntents: new SqliteTaskCommitIntentRepository(connection),
    attemptRollbackPlans: new SqliteAttemptRollbackPlanRepository(connection),
    checkpoints: new SqliteCheckpointRepository(connection),
    events: new SqliteEventRepository(connection, publishEvent),
    projectSettings: new SqliteProjectSettingsRepository(connection),
    phaseReports: new SqlitePhaseReportRepository(connection),
  });
}
