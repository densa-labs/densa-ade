import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";

import { migrate } from "./migrations.js";

export type SqliteRow = Record<string, SQLOutputValue>;

export class PersistenceError extends Error {
  readonly code = "PERSISTENCE_FAILURE" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PersistenceError";
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

function tryExec(database: DatabaseSync, sql: string): void {
  try {
    database.exec(sql);
  } catch {
    // Preserve the failure that caused the rollback path.
  }
}

/** Internal SQLite connection. Raw SQL is deliberately not exported by the Core package. */
export class SqliteConnection {
  readonly database: DatabaseSync;
  #transactionDepth = 0;
  #savepointCounter = 0;
  readonly #afterCommitFrames: Array<Array<() => void>> = [];
  #activeAfterCommitQueue: Array<() => void> | undefined;

  constructor(path: string, now: () => string) {
    const database = new DatabaseSync(path, {
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
    });
    this.database = database;
    try {
      database.exec("PRAGMA foreign_keys = ON");
      database.exec("PRAGMA busy_timeout = 5000");
      if (path !== ":memory:") {
        database.exec("PRAGMA journal_mode = WAL");
        database.exec("PRAGMA synchronous = FULL");
      }
      migrate(database, now);
    } catch (error) {
      database.close();
      throw new PersistenceError("Could not open and migrate the Densa SQLite database", {
        cause: error,
      });
    }
  }

  close(): void {
    this.database.close();
  }

  run(sql: string, ...parameters: SQLInputValue[]): number {
    const changes = this.database.prepare(sql).run(...parameters).changes;
    return typeof changes === "bigint" ? Number(changes) : changes;
  }

  get(sql: string, ...parameters: SQLInputValue[]): SqliteRow | undefined {
    return this.database.prepare(sql).get(...parameters);
  }

  all(sql: string, ...parameters: SQLInputValue[]): SqliteRow[] {
    return this.database.prepare(sql).all(...parameters);
  }

  afterCommit(callback: () => void): void {
    const frame = this.#afterCommitFrames.at(-1);
    if (frame !== undefined) {
      frame.push(callback);
      return;
    }
    if (this.#activeAfterCommitQueue !== undefined) {
      this.#activeAfterCommitQueue.push(callback);
      return;
    }
    callback();
  }

  transaction<Result>(work: () => Result): Result {
    const outermost = this.#transactionDepth === 0;
    const savepoint = `densa_savepoint_${this.#savepointCounter++}`;
    this.database.exec(outermost ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.#transactionDepth += 1;
    this.#afterCommitFrames.push([]);

    try {
      const result = work();
      if (isPromiseLike(result)) {
        throw new PersistenceError("SQLite transaction callbacks must be synchronous");
      }
      const callbacks = this.#afterCommitFrames.at(-1);
      const parentFrame = outermost ? undefined : this.#afterCommitFrames.at(-2);
      if (callbacks === undefined || (!outermost && parentFrame === undefined)) {
        throw new PersistenceError("SQLite transaction commit hooks became inconsistent");
      }
      this.database.exec(outermost ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
      this.#transactionDepth -= 1;
      this.#afterCommitFrames.pop();
      if (outermost) {
        this.#activeAfterCommitQueue = callbacks;
        for (let index = 0; index < callbacks.length; index += 1) {
          try {
            callbacks[index]?.();
          } catch {
            // The transaction is already durable; observer failures cannot roll it back.
          }
        }
        this.#activeAfterCommitQueue = undefined;
      } else if (parentFrame !== undefined) {
        parentFrame.push(...callbacks);
      }
      return result;
    } catch (error) {
      this.#transactionDepth -= 1;
      this.#afterCommitFrames.pop();
      if (outermost) {
        tryExec(this.database, "ROLLBACK");
      } else {
        tryExec(this.database, `ROLLBACK TO SAVEPOINT ${savepoint}`);
        tryExec(this.database, `RELEASE SAVEPOINT ${savepoint}`);
      }
      throw error;
    }
  }
}

export function requiredString(row: SqliteRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new PersistenceError(`Expected SQLite column ${column} to be text`);
  }
  return value;
}

export function optionalString(row: SqliteRow, column: string): string | undefined {
  const value = row[column];
  if (value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new PersistenceError(`Expected SQLite column ${column} to be nullable text`);
  }
  return value;
}

export function requiredNumber(row: SqliteRow, column: string): number {
  const value = row[column];
  if (typeof value !== "number") {
    throw new PersistenceError(`Expected SQLite column ${column} to be numeric`);
  }
  return value;
}

export function optionalNumber(row: SqliteRow, column: string): number | undefined {
  const value = row[column];
  if (value === null) {
    return undefined;
  }
  if (typeof value !== "number") {
    throw new PersistenceError(`Expected SQLite column ${column} to be nullable numeric`);
  }
  return value;
}

export function optionalBoolean(row: SqliteRow, column: string): boolean | undefined {
  const value = row[column];
  if (value === null) {
    return undefined;
  }
  if (value !== 0 && value !== 1) {
    throw new PersistenceError(`Expected SQLite column ${column} to be nullable boolean`);
  }
  return value === 1;
}
