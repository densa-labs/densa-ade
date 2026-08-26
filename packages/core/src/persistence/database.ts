import {
  eventSchema,
  isoTimestampSchema,
  phaseSchema,
  projectSchema,
  taskSchema,
  type EventId,
} from "@densa/protocol";

import type {
  PhaseStateTransition,
  ProjectStateTransition,
  TaskStateTransition,
} from "../state-transitions.js";
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
}
