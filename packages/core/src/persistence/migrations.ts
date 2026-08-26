import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface SchemaMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const initialSchema = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  name TEXT NOT NULL CHECK (length(name) > 0),
  state TEXT NOT NULL CHECK (state IN (
    'DRAFT', 'PLANNING', 'READY', 'RUNNING', 'PAUSED', 'WAITING_FOR_USER',
    'WAITING_FOR_USAGE', 'BLOCKED', 'COMPLETED', 'FAILED'
  )),
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('guided', 'phase', 'continuous')),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20)
) STRICT;

CREATE TABLE specifications (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20)
) STRICT;

CREATE TABLE phases (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(title) > 0),
  state TEXT NOT NULL CHECK (state IN (
    'PENDING', 'READY', 'RUNNING', 'VALIDATING', 'AWAITING_APPROVAL', 'COMPLETED', 'BLOCKED'
  )),
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20),
  UNIQUE (project_id, position),
  UNIQUE (project_id, id)
) STRICT;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  project_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) > 0),
  state TEXT NOT NULL CHECK (state IN (
    'PENDING', 'READY', 'RUNNING', 'VALIDATING', 'RETRYING', 'WAITING_FOR_USER',
    'WAITING_FOR_USAGE', 'BLOCKED', 'INTERRUPTED', 'COMPLETED', 'CANCELLED'
  )),
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20),
  FOREIGN KEY (project_id, phase_id) REFERENCES phases(project_id, id) ON DELETE CASCADE,
  UNIQUE (phase_id, position),
  UNIQUE (project_id, id),
  UNIQUE (project_id, phase_id, id)
) STRICT;

CREATE TABLE task_dependencies (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  dependency_task_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (task_id, dependency_task_id),
  UNIQUE (task_id, position),
  FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, dependency_task_id) REFERENCES tasks(project_id, id) ON DELETE RESTRICT,
  CHECK (task_id <> dependency_task_id)
) STRICT;

CREATE TABLE acceptance_criteria (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  description TEXT NOT NULL CHECK (length(description) > 0),
  PRIMARY KEY (task_id, position),
  FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE attempts (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  number INTEGER NOT NULL CHECK (number > 0),
  started_at TEXT NOT NULL CHECK (length(started_at) >= 20),
  completed_at TEXT CHECK (completed_at IS NULL OR length(completed_at) >= 20),
  UNIQUE (task_id, number),
  UNIQUE (task_id, id)
) STRICT;

CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id) ON DELETE CASCADE,
  adapter_id TEXT NOT NULL CHECK (length(adapter_id) > 0),
  started_at TEXT NOT NULL CHECK (length(started_at) >= 20),
  completed_at TEXT CHECK (completed_at IS NULL OR length(completed_at) >= 20),
  adapter_run_id TEXT CHECK (adapter_run_id IS NULL OR length(adapter_run_id) > 0)
) STRICT;

CREATE TABLE validation_runs (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt_id TEXT,
  validator_id TEXT NOT NULL CHECK (length(validator_id) > 0),
  started_at TEXT NOT NULL CHECK (length(started_at) >= 20),
  completed_at TEXT CHECK (completed_at IS NULL OR length(completed_at) >= 20),
  passed INTEGER CHECK (passed IS NULL OR passed IN (0, 1)),
  FOREIGN KEY (task_id, attempt_id) REFERENCES attempts(task_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE decisions (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(title) > 0),
  rationale TEXT NOT NULL CHECK (length(rationale) > 0),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20)
) STRICT;

CREATE TABLE roadmap_revisions (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  classification TEXT NOT NULL CHECK (classification IN ('minor', 'significant', 'scope')),
  reason TEXT NOT NULL CHECK (length(reason) > 0),
  actor TEXT NOT NULL CHECK (length(actor) > 0),
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  affected_phase_ids_json TEXT NOT NULL CHECK (json_valid(affected_phase_ids_json)),
  affected_task_ids_json TEXT NOT NULL CHECK (json_valid(affected_task_ids_json)),
  old_value_json TEXT NOT NULL CHECK (json_valid(old_value_json)),
  new_value_json TEXT NOT NULL CHECK (json_valid(new_value_json))
) STRICT;

CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL CHECK (length(created_at) >= 20),
  description TEXT CHECK (description IS NULL OR length(description) > 0)
) STRICT;

CREATE TABLE events (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  phase_id TEXT,
  task_id TEXT,
  type TEXT NOT NULL CHECK (type GLOB '[A-Z]*'),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) >= 20),
  actor TEXT NOT NULL CHECK (length(actor) > 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  FOREIGN KEY (project_id, phase_id) REFERENCES phases(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, phase_id, task_id)
    REFERENCES tasks(project_id, phase_id, id) ON DELETE CASCADE,
  CHECK (task_id IS NULL OR phase_id IS NOT NULL)
) STRICT;

CREATE TRIGGER events_are_append_only_on_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER events_are_append_only_on_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TABLE project_settings (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  values_json TEXT NOT NULL CHECK (json_valid(values_json)),
  updated_at TEXT NOT NULL CHECK (length(updated_at) >= 20)
) STRICT;
`;

export const schemaMigrations: readonly SchemaMigration[] = Object.freeze([
  Object.freeze({ version: 1, name: "authoritative_runtime_schema", sql: initialSchema }),
]);

export const latestSchemaVersion = schemaMigrations.at(-1)?.version ?? 0;

function checksum(migration: SchemaMigration): string {
  return createHash("sha256").update(migration.sql).digest("hex");
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // Preserve the original migration failure when SQLite already rolled back.
  }
}

export function migrate(database: DatabaseSync, now: () => string): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS _densa_migrations (
      version INTEGER PRIMARY KEY CHECK (version > 0),
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL CHECK (length(checksum) = 64),
      applied_at TEXT NOT NULL CHECK (length(applied_at) >= 20)
    ) STRICT;
  `);

  const applied = database
    .prepare("SELECT version, name, checksum FROM _densa_migrations ORDER BY version")
    .all();

  for (const row of applied) {
    const version = row["version"];
    const migration =
      typeof version === "number"
        ? schemaMigrations.find((candidate) => candidate.version === version)
        : undefined;
    if (
      migration === undefined ||
      row["name"] !== migration.name ||
      row["checksum"] !== checksum(migration)
    ) {
      throw new Error(`Applied SQLite migration ${String(version)} does not match this build`);
    }
  }

  for (const migration of schemaMigrations.slice(applied.length)) {
    if (migration.version !== applied.length + 1) {
      throw new Error(`SQLite migrations must be contiguous at version ${migration.version}`);
    }

    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.sql);
      database
        .prepare(
          "INSERT INTO _densa_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
        )
        .run(migration.version, migration.name, checksum(migration), now());
      database.exec("COMMIT");
    } catch (error) {
      rollback(database);
      throw error;
    }
  }
}
