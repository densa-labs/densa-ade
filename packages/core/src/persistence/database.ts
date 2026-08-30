import {
  executionModeSchema,
  eventSchema,
  eventIdSchema,
  isoTimestampSchema,
  phaseSchema,
  projectSchema,
  taskSchema,
  type AttemptId,
  type EventId,
  type Event,
  type ExecutionMode,
  type MasterRoadmapRecord,
  type ProjectId,
  type RoadmapRevision,
  type RoadmapRevisionProposal,
  type ValidationRunId,
} from "@densa/protocol";

import type {
  PhaseStateTransition,
  ProjectStateTransition,
  TaskStateTransition,
} from "../state-transitions.js";
import { buildAcceptanceReport } from "../acceptance-evidence.js";
import { EventPublisher, type PersistedEvent } from "../event-publisher.js";
import { EventJournal } from "./event-journal.js";
import { latestSchemaVersion } from "./migrations.js";
import { createRepositories, type DensaRepositories } from "./repositories.js";
import {
  PersistenceError,
  SqliteConnection,
  requiredNumber,
  requiredString,
} from "./sqlite-connection.js";

export interface DensaDatabaseOptions {
  readonly now?: () => string;
}

export type StateTransition = ProjectStateTransition | PhaseStateTransition | TaskStateTransition;

export interface PersistTaskCommitCompletionRequest {
  readonly attemptId: AttemptId;
  readonly validationRunId: ValidationRunId;
  readonly commitSha: string;
  readonly commitRecordedEventId: EventId;
  readonly completionEventId: EventId;
  readonly attemptCompletedEventId: EventId;
  readonly transition: TaskStateTransition;
}

export type AttemptCompletionOutcome =
  "blocked" | "cancelled" | "failed" | "interrupted" | "retrying";

export interface PersistAttemptCompletionRequest {
  readonly attemptId: AttemptId;
  readonly completedAt: string;
  readonly outcome: AttemptCompletionOutcome;
  readonly eventId: EventId;
  readonly actor: string;
  readonly transition?: TaskStateTransition;
}

export interface PersistRoadmapMutationRequest {
  readonly expectedRevisionNumber: number;
  readonly roadmap: MasterRoadmapRecord;
  readonly revision: RoadmapRevision;
  readonly event: Event;
  readonly proposalResolution?: Readonly<{
    proposal: RoadmapRevisionProposal;
    expectedStatus: RoadmapRevisionProposal["status"];
  }>;
}

export interface PersistRoadmapRevisionProposalRequest {
  readonly proposal: RoadmapRevisionProposal;
  readonly event: Event;
}

export interface PersistRoadmapRevisionProposalResolutionRequest {
  readonly proposal: RoadmapRevisionProposal;
  readonly expectedStatus: RoadmapRevisionProposal["status"];
  readonly event: Event;
}

export interface PersistExecutionModeChangeRequest {
  readonly projectId: ProjectId;
  readonly previousMode: ExecutionMode;
  readonly mode: ExecutionMode;
  readonly occurredAt: string;
  readonly actor: string;
  readonly eventId: EventId;
}

function assertEventMatchesTransition(transition: StateTransition): void {
  const payload = transition.event.payload;
  if (
    payload.previousState !== transition.previousState ||
    payload.state !== transition.state ||
    transition.event.occurredAt !== transition.entity.updatedAt
  ) {
    throw new PersistenceError("State transition entity and event draft disagree");
  }
}

/**
 * Core-owned authoritative SQLite database.
 *
 * The raw connection and status-update statements stay private. Callers create records through
 * repositories and persist StateTransitionService results through persistStateTransition().
 */
export class DensaDatabase {
  readonly repositories: DensaRepositories;
  readonly eventJournal: EventJournal;
  readonly #connection: SqliteConnection;

  private constructor(path: string, options: DensaDatabaseOptions) {
    const clock = options.now ?? (() => new Date().toISOString());
    const now = () => isoTimestampSchema.parse(clock());
    this.#connection = new SqliteConnection(path, now);
    const eventPublisher = new EventPublisher();
    this.repositories = createRepositories(this.#connection, (event) =>
      eventPublisher.publish(event),
    );
    this.eventJournal = new EventJournal(this.repositories.events, eventPublisher);
  }

  static open(path: string, options: DensaDatabaseOptions = {}): DensaDatabase {
    return new DensaDatabase(path, options);
  }

  static openInMemory(options: DensaDatabaseOptions = {}): DensaDatabase {
    return new DensaDatabase(":memory:", options);
  }

  close(): void {
    this.#connection.close();
  }

  get schemaVersion(): number {
    const row = this.#connection.get(
      "SELECT COALESCE(MAX(version), 0) AS schema_version FROM _densa_migrations",
    );
    if (row === undefined) {
      throw new PersistenceError("SQLite migration registry is unavailable");
    }
    return requiredNumber(row, "schema_version");
  }

  get expectedSchemaVersion(): number {
    return latestSchemaVersion;
  }

  listUserTables(): readonly string[] {
    return Object.freeze(
      this.#connection
        .all(
          `SELECT name FROM sqlite_schema
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_densa_migrations'
           ORDER BY name`,
        )
        .map((row) => requiredString(row, "name")),
    );
  }

  transaction<Result>(work: (repositories: DensaRepositories) => Result): Result {
    return this.#connection.transaction(() => work(this.repositories));
  }

  persistInitialMasterRoadmap(record: MasterRoadmapRecord): MasterRoadmapRecord {
    return this.#connection.transaction(() => this.repositories.masterRoadmaps.create(record));
  }

  /** Atomically records an inspectable roadmap proposal and its append-only audit fact. */
  persistRoadmapRevisionProposal(request: PersistRoadmapRevisionProposalRequest): PersistedEvent {
    if (
      request.event.type !== "ROADMAP_REVISION_PROPOSED" ||
      request.event.id !== request.proposal.proposalEventId ||
      request.event.projectId !== request.proposal.projectId
    ) {
      throw new PersistenceError("Roadmap revision proposal persistence request is inconsistent");
    }
    return this.#connection.transaction(() => {
      const event = this.repositories.events.append(request.event);
      this.repositories.roadmapRevisionProposals.create(request.proposal);
      return event;
    });
  }

  /** Atomically resolves a non-applied proposal and records why it stopped. */
  persistRoadmapRevisionProposalResolution(
    request: PersistRoadmapRevisionProposalResolutionRequest,
  ): PersistedEvent {
    if (
      request.event.projectId !== request.proposal.projectId ||
      !["ROADMAP_REVISION_REJECTED", "ROADMAP_REVISION_STALE"].includes(request.event.type)
    ) {
      throw new PersistenceError("Roadmap proposal resolution request is inconsistent");
    }
    return this.#connection.transaction(() => {
      this.repositories.roadmapRevisionProposals.replace(request.proposal, request.expectedStatus);
      return this.repositories.events.append(request.event);
    });
  }

  /** Atomically replaces one authoritative roadmap revision and appends its complete audit fact. */
  persistRoadmapMutation(request: PersistRoadmapMutationRequest): PersistedEvent {
    if (
      request.roadmap.projectId !== request.revision.projectId ||
      request.event.projectId !== request.revision.projectId ||
      request.event.type !== "ROADMAP_CHANGED" ||
      request.roadmap.revisionNumber !== request.expectedRevisionNumber + 1
    ) {
      throw new PersistenceError("Roadmap mutation persistence request is inconsistent");
    }
    return this.#connection.transaction(() => {
      this.repositories.masterRoadmaps.replace(request.roadmap, request.expectedRevisionNumber);
      this.repositories.roadmapRevisions.create(request.revision);
      if (request.proposalResolution !== undefined) {
        if (
          request.proposalResolution.proposal.projectId !== request.revision.projectId ||
          request.proposalResolution.proposal.status !== "applied" ||
          request.proposalResolution.proposal.appliedRevisionId !== request.revision.id
        ) {
          throw new PersistenceError("Applied roadmap proposal does not match its revision");
        }
        this.repositories.roadmapRevisionProposals.replace(
          request.proposalResolution.proposal,
          request.proposalResolution.expectedStatus,
        );
      }
      return this.repositories.events.append(request.event);
    });
  }

  /** Atomically updates the durable execution mode and appends its audit fact. */
  persistExecutionModeChange(request: PersistExecutionModeChangeRequest): PersistedEvent {
    const previousMode = executionModeSchema.parse(request.previousMode);
    const mode = executionModeSchema.parse(request.mode);
    isoTimestampSchema.parse(request.occurredAt);
    if (previousMode === mode || request.actor.trim().length === 0) {
      throw new PersistenceError("Execution mode changes require distinct modes and an actor");
    }
    const project = this.repositories.projects.findById(request.projectId);
    if (project === undefined || project.executionMode !== previousMode) {
      throw new PersistenceError(
        "Execution mode change does not match authoritative project state",
      );
    }

    return this.#connection.transaction(() => {
      const changes = this.#connection.run(
        `UPDATE projects SET execution_mode = ?, updated_at = ?
         WHERE id = ? AND execution_mode = ?`,
        mode,
        request.occurredAt,
        request.projectId,
        previousMode,
      );
      if (changes !== 1) {
        throw new PersistenceError("Could not atomically persist the execution mode change");
      }
      return this.repositories.events.append({
        id: request.eventId,
        projectId: request.projectId,
        type: "EXECUTION_MODE_CHANGED",
        eventVersion: 1,
        occurredAt: request.occurredAt,
        actor: request.actor,
        payload: { previousMode, mode, effectiveAt: "safe_boundary" },
      });
    });
  }

  persistStateTransition(transition: StateTransition, eventId: EventId): PersistedEvent {
    assertEventMatchesTransition(transition);
    const event = eventSchema.parse({ id: eventId, ...transition.event });

    return this.#connection.transaction(() => {
      let changes: number;
      switch (transition.entityType) {
        case "project": {
          const entity = projectSchema.parse(transition.entity);
          changes = this.#connection.run(
            `UPDATE projects SET state = ?, updated_at = ? WHERE id = ? AND state = ?`,
            entity.state,
            entity.updatedAt,
            entity.id,
            transition.previousState,
          );
          break;
        }
        case "phase": {
          const entity = phaseSchema.parse(transition.entity);
          changes = this.#connection.run(
            `UPDATE phases SET state = ?, updated_at = ? WHERE id = ? AND state = ?`,
            entity.state,
            entity.updatedAt,
            entity.id,
            transition.previousState,
          );
          break;
        }
        case "task": {
          const entity = taskSchema.parse(transition.entity);
          changes = this.#connection.run(
            `UPDATE tasks SET state = ?, updated_at = ? WHERE id = ? AND state = ?`,
            entity.state,
            entity.updatedAt,
            entity.id,
            transition.previousState,
          );
          break;
        }
      }

      if (changes !== 1) {
        throw new PersistenceError(
          `Could not atomically persist ${transition.entityType} transition from ${transition.previousState}`,
        );
      }
      return this.repositories.events.append(event);
    });
  }

  /** Atomically closes an attempt, appends its outcome, and optionally changes task state. */
  persistAttemptCompletion(request: PersistAttemptCompletionRequest): PersistedEvent {
    isoTimestampSchema.parse(request.completedAt);
    if (request.actor.trim().length === 0) {
      throw new PersistenceError("Attempt completion actor must not be empty");
    }
    const attempt = this.repositories.attempts.findById(request.attemptId);
    if (attempt === undefined)
      throw new PersistenceError("Attempt completion is missing its attempt");
    if (
      request.transition !== undefined &&
      (request.transition.entity.id !== attempt.taskId ||
        request.transition.event.occurredAt !== request.completedAt)
    ) {
      throw new PersistenceError("Attempt completion and task transition disagree");
    }
    const task = this.repositories.tasks.findById(attempt.taskId);
    if (task === undefined) throw new PersistenceError("Attempt completion is missing its task");

    return this.#connection.transaction(() => {
      this.repositories.attempts.recordCompleted(request.attemptId, request.completedAt);
      const event = this.repositories.events.append({
        id: request.eventId,
        projectId: task.projectId,
        phaseId: task.phaseId,
        taskId: task.id,
        type: "ATTEMPT_COMPLETED",
        eventVersion: 1,
        occurredAt: request.completedAt,
        actor: request.actor,
        payload: { attemptId: request.attemptId, outcome: request.outcome },
      });
      if (request.transition !== undefined) {
        this.persistStateTransition(
          request.transition,
          eventIdSchema.parse(`${request.eventId}:task-state`),
        );
      }
      return event;
    });
  }

  /** Atomically records a verified Git outcome and the task's terminal state transition. */
  persistTaskCommitCompletion(request: PersistTaskCommitCompletionRequest): PersistedEvent {
    const transition = request.transition;
    if (transition.previousState !== "VALIDATING" || transition.state !== "COMPLETED") {
      throw new PersistenceError("Task commit completion requires VALIDATING to COMPLETED");
    }
    const attempt = this.repositories.attempts.findById(request.attemptId);
    const validation = this.repositories.validationRuns.findById(request.validationRunId);
    const intent = this.repositories.taskCommitIntents.findByAttemptId(request.attemptId);
    if (attempt?.taskId !== transition.entity.id) {
      throw new PersistenceError("Task commit attempt does not belong to the transitioning task");
    }
    if (
      validation?.taskId !== transition.entity.id ||
      validation.attemptId !== request.attemptId ||
      validation.completedAt === undefined ||
      validation.passed !== true
    ) {
      throw new PersistenceError("Task commit completion requires a passing validation outcome");
    }
    if (validation.planId !== undefined) {
      const acceptanceReport = buildAcceptanceReport({
        task: transition.entity,
        run: validation,
        results: this.repositories.validationResults.listByRunId(validation.id),
        manualReviews: this.repositories.manualAcceptanceReviews.listByRunId(validation.id),
        generatedAt: transition.event.occurredAt,
      });
      if (!acceptanceReport.canComplete) {
        throw new PersistenceError(
          "Task commit completion requires every acceptance criterion to be satisfied",
        );
      }
    }
    if (intent?.commitSha !== request.commitSha) {
      throw new PersistenceError("Task commit intent does not record the verified commit SHA");
    }

    return this.#connection.transaction(() => {
      this.repositories.attempts.recordCompleted(request.attemptId, transition.event.occurredAt);
      this.repositories.events.append({
        id: request.attemptCompletedEventId,
        projectId: transition.entity.projectId,
        phaseId: transition.entity.phaseId,
        taskId: transition.entity.id,
        type: "ATTEMPT_COMPLETED",
        eventVersion: 1,
        occurredAt: transition.event.occurredAt,
        actor: transition.event.actor,
        payload: { attemptId: request.attemptId, outcome: "completed" },
      });
      this.repositories.attempts.recordCommit(
        request.attemptId,
        transition.entity.id,
        request.commitSha,
      );
      this.repositories.events.append({
        id: request.commitRecordedEventId,
        projectId: transition.entity.projectId,
        phaseId: transition.entity.phaseId,
        taskId: transition.entity.id,
        type: "TASK_COMMITTED",
        eventVersion: 1,
        occurredAt: transition.event.occurredAt,
        actor: transition.event.actor,
        payload: {
          attemptId: request.attemptId,
          validationRunId: request.validationRunId,
          commitSha: request.commitSha,
          branchName: intent.branchName,
          intendedPaths: [...intent.intendedPaths],
        },
      });
      return this.persistStateTransition(transition, request.completionEventId);
    });
  }
}
