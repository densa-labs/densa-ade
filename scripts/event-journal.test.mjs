import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { MAX_EVENT_PAYLOAD_BYTES } from "@densa-ade/core";
import { DensaAdeDatabase, PersistenceError } from "@densa-ade/core/persistence";

import { schemaMigrations } from "../packages/core/dist/persistence/migrations.js";

const occurredAt = "2026-08-26T08:00:00.000Z";

function makeProject(id) {
  return {
    id,
    name: `Event project ${id}`,
    state: "DRAFT",
    executionMode: "guided",
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
}

function makeEvent({
  id,
  projectId,
  type = "PROJECT_STARTED",
  at = occurredAt,
  phaseId,
  taskId,
  payload = {},
}) {
  return {
    id,
    projectId,
    type,
    eventVersion: 1,
    occurredAt: at,
    actor: "densa-core:test",
    payload,
    ...(phaseId === undefined ? {} : { phaseId }),
    ...(taskId === undefined ? {} : { taskId }),
  };
}

function seedProjectGraph(database, projectId = "project-events") {
  const phaseId = `phase-${projectId}`;
  const taskId = `task-${projectId}`;
  database.repositories.projects.create(makeProject(projectId));
  database.repositories.phases.create({
    id: phaseId,
    projectId,
    title: "Journal facts",
    state: "PENDING",
    position: 0,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  });
  database.repositories.tasks.create({
    id: taskId,
    projectId,
    phaseId,
    title: "Record ordered events",
    state: "PENDING",
    position: 0,
    acceptanceCriteria: ["Events replay in order"],
    dependencyIds: [],
    createdAt: occurredAt,
    updatedAt: occurredAt,
  });
  return { projectId, phaseId, taskId };
}

function withDatabase(work) {
  const database = DensaAdeDatabase.openInMemory();
  try {
    return work(database);
  } finally {
    database.close();
  }
}

test("sequence numbers are deterministic per project and replay resumes after an exclusive cursor", () => {
  withDatabase((database) => {
    const first = seedProjectGraph(database, "project-first");
    const second = seedProjectGraph(database, "project-second");

    const firstOne = database.eventJournal.append(
      makeEvent({
        id: "event-first-1",
        projectId: first.projectId,
        at: "2026-08-26T09:00:00.000Z",
      }),
    );
    const secondOne = database.eventJournal.append(
      makeEvent({ id: "event-second-1", projectId: second.projectId }),
    );
    const firstTwo = database.eventJournal.append(
      makeEvent({
        id: "event-first-2",
        projectId: first.projectId,
        type: "TASK_STARTED",
        at: "2026-08-26T07:00:00.000Z",
        phaseId: first.phaseId,
        taskId: first.taskId,
      }),
    );
    const firstThree = database.eventJournal.append(
      makeEvent({
        id: "event-first-3",
        projectId: first.projectId,
        type: "TASK_COMPLETED",
        phaseId: first.phaseId,
        taskId: first.taskId,
      }),
    );

    assert.deepEqual(
      [
        firstOne.sequenceNumber,
        secondOne.sequenceNumber,
        firstTwo.sequenceNumber,
        firstThree.sequenceNumber,
      ],
      [1, 1, 2, 3],
    );
    assert.deepEqual(
      database.eventJournal
        .replay({ projectId: first.projectId, afterSequence: 1 })
        .map((event) => event.id),
      ["event-first-2", "event-first-3"],
    );
  });
});

test("replay filters facts by project, phase, task, and event type", () => {
  withDatabase((database) => {
    const graph = seedProjectGraph(database);
    database.eventJournal.append(makeEvent({ id: "event-project", projectId: graph.projectId }));
    database.eventJournal.append(
      makeEvent({
        id: "event-task-started",
        projectId: graph.projectId,
        type: "TASK_STARTED",
        phaseId: graph.phaseId,
        taskId: graph.taskId,
      }),
    );
    database.eventJournal.append(
      makeEvent({
        id: "event-task-completed",
        projectId: graph.projectId,
        type: "TASK_COMPLETED",
        phaseId: graph.phaseId,
        taskId: graph.taskId,
      }),
    );

    const filtered = database.eventJournal.replay({
      projectId: graph.projectId,
      phaseId: graph.phaseId,
      taskId: graph.taskId,
      types: ["TASK_COMPLETED"],
    });
    assert.deepEqual(
      filtered.map((event) => event.id),
      ["event-task-completed"],
    );
  });
});

test("subscriptions publish in commit order and never expose rolled-back events", () => {
  withDatabase((database) => {
    const graph = seedProjectGraph(database);
    const published = [];
    const unsubscribe = database.eventJournal.subscribe(
      { projectId: graph.projectId, types: ["TASK_STARTED"] },
      (event) => published.push(event),
    );

    database.transaction((repositories) => {
      repositories.events.append(
        makeEvent({
          id: "event-committed",
          projectId: graph.projectId,
          type: "TASK_STARTED",
          phaseId: graph.phaseId,
          taskId: graph.taskId,
        }),
      );
      assert.deepEqual(published, [], "publication must wait for COMMIT");
    });
    assert.deepEqual(
      published.map((event) => event.id),
      ["event-committed"],
    );

    assert.throws(
      () =>
        database.transaction((repositories) => {
          repositories.events.append(
            makeEvent({
              id: "event-rolled-back",
              projectId: graph.projectId,
              type: "TASK_STARTED",
              phaseId: graph.phaseId,
              taskId: graph.taskId,
            }),
          );
          throw new Error("injected rollback");
        }),
      /injected rollback/u,
    );
    assert.equal(database.eventJournal.findById("event-rolled-back"), undefined);
    assert.deepEqual(
      published.map((event) => event.id),
      ["event-committed"],
    );
    unsubscribe();
  });
});

test("reentrant subscribers cannot reorder committed sequence delivery", () => {
  withDatabase((database) => {
    const graph = seedProjectGraph(database);
    const observed = [];
    database.eventJournal.subscribe({ projectId: graph.projectId }, (event) => {
      observed.push(event.sequenceNumber);
      if (event.sequenceNumber === 1) {
        database.eventJournal.append(
          makeEvent({ id: "event-reentrant-3", projectId: graph.projectId }),
        );
      }
    });

    database.transaction((repositories) => {
      repositories.events.append(
        makeEvent({ id: "event-reentrant-1", projectId: graph.projectId }),
      );
      repositories.events.append(
        makeEvent({ id: "event-reentrant-2", projectId: graph.projectId }),
      );
    });

    assert.deepEqual(observed, [1, 2, 3]);
  });
});

test("payload and replay bounds fail closed before an event is persisted", () => {
  withDatabase((database) => {
    const graph = seedProjectGraph(database);
    assert.throws(
      () =>
        database.eventJournal.append(
          makeEvent({
            id: "event-oversized",
            projectId: graph.projectId,
            payload: { log: "x".repeat(MAX_EVENT_PAYLOAD_BYTES) },
          }),
        ),
      (error) => error instanceof PersistenceError && error.code === "PERSISTENCE_FAILURE",
    );
    assert.equal(database.eventJournal.findById("event-oversized"), undefined);
    assert.throws(
      () => database.eventJournal.replay({ afterSequence: 0 }),
      /requires a projectId/u,
    );
    assert.throws(
      () => database.eventJournal.replay({ projectId: graph.projectId, limit: 1_001 }),
      /between 1 and 1000/u,
    );
  });
});

test("migration 2 preserves version-1 facts and assigns deterministic project sequences", () => {
  const directory = mkdtempSync(join(tmpdir(), "densa-p2m2-migration-"));
  const path = join(directory, "runtime.sqlite");
  try {
    const migration = schemaMigrations[0];
    assert.ok(migration);
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TABLE _densa_migrations (
        version INTEGER PRIMARY KEY CHECK (version > 0),
        name TEXT NOT NULL UNIQUE,
        checksum TEXT NOT NULL CHECK (length(checksum) = 64),
        applied_at TEXT NOT NULL CHECK (length(applied_at) >= 20)
      ) STRICT;
    `);
    raw.exec(migration.sql);
    raw
      .prepare(
        "INSERT INTO _densa_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        migration.version,
        migration.name,
        createHash("sha256").update(migration.sql).digest("hex"),
        occurredAt,
      );
    raw
      .prepare(
        `INSERT INTO projects (id, name, state, execution_mode, created_at, updated_at)
       VALUES (?, ?, 'DRAFT', 'guided', ?, ?)`,
      )
      .run("project-migration", "Migration", occurredAt, occurredAt);
    const insert = raw.prepare(
      `INSERT INTO events
       (id, project_id, type, schema_version, occurred_at, actor, payload_json)
       VALUES (?, 'project-migration', 'PROJECT_STARTED', 1, ?, 'densa-core:test', '{}')`,
    );
    insert.run("event-later-id", "2026-08-26T10:00:00.000Z");
    insert.run("event-earlier-id", "2026-08-26T07:00:00.000Z");
    raw.close();

    const database = DensaAdeDatabase.open(path);
    assert.equal(database.schemaVersion, 16);
    assert.deepEqual(
      database.eventJournal.replay({ projectId: "project-migration" }).map((event) => ({
        id: event.id,
        sequenceNumber: event.sequenceNumber,
        eventVersion: event.eventVersion,
      })),
      [
        { id: "event-earlier-id", sequenceNumber: 1, eventVersion: 1 },
        { id: "event-later-id", sequenceNumber: 2, eventVersion: 1 },
      ],
    );
    database.close();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("database triggers prevent committed event facts from being updated or deleted", () => {
  const directory = mkdtempSync(join(tmpdir(), "densa-p2m2-append-only-"));
  const path = join(directory, "runtime.sqlite");
  try {
    const database = DensaAdeDatabase.open(path);
    const graph = seedProjectGraph(database);
    database.eventJournal.append(makeEvent({ id: "event-immutable", projectId: graph.projectId }));
    database.close();

    const raw = new DatabaseSync(path);
    assert.throws(() =>
      raw.prepare("UPDATE events SET actor = 'other' WHERE id = ?").run("event-immutable"),
    );
    assert.throws(() => raw.prepare("DELETE FROM events WHERE id = ?").run("event-immutable"));
    raw.close();

    const reopened = DensaAdeDatabase.open(path);
    assert.equal(reopened.eventJournal.findById("event-immutable").actor, "densa-core:test");
    reopened.close();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

for (const transactional of [false, true]) {
  test(`all subscribers retain commit order through ${transactional ? "transactional" : "autocommit"} reentrant writes`, () => {
    withDatabase((database) => {
      const { projectId } = seedProjectGraph(database);
      const observed = [];
      database.eventJournal.subscribe({ projectId }, (event) => {
        if (event.sequenceNumber === 1) {
          database.transaction(() => {
            database.eventJournal.append(makeEvent({ id: "reentrant", projectId }));
          });
        }
      });
      database.eventJournal.subscribe({ projectId }, (event) =>
        observed.push(event.sequenceNumber),
      );
      const append = () => {
        database.eventJournal.append(makeEvent({ id: "first", projectId }));
        if (transactional) database.eventJournal.append(makeEvent({ id: "second", projectId }));
      };
      if (transactional) database.transaction(append);
      else append();
      assert.deepEqual(observed, transactional ? [1, 2, 3] : [1, 2]);
    });
  });
}

test("subscriber mutations cannot change committed facts delivered to other subscribers", () => {
  withDatabase((database) => {
    const { projectId } = seedProjectGraph(database);
    const observed = [];
    database.eventJournal.subscribe({ projectId }, (event) => {
      event.payload.nested.value = "altered";
    });
    database.eventJournal.subscribe({ projectId }, (event) =>
      observed.push(event.payload.nested.value),
    );
    database.eventJournal.append(
      makeEvent({ id: "immutable-payload", projectId, payload: { nested: { value: "fact" } } }),
    );
    assert.deepEqual(observed, ["fact"]);
  });
});

test("savepoint rollback discards only failed nested notifications", () => {
  withDatabase((database) => {
    const { projectId } = seedProjectGraph(database);
    const observed = [];
    database.eventJournal.subscribe({ projectId }, (event) => observed.push(event.id));
    database.transaction(() => {
      database.eventJournal.append(makeEvent({ id: "outer-before", projectId }));
      assert.throws(() =>
        database.transaction(() => {
          database.eventJournal.append(makeEvent({ id: "inner-rollback", projectId }));
          throw new Error("injected nested rollback");
        }),
      );
      database.transaction(() =>
        database.eventJournal.append(makeEvent({ id: "inner-commit", projectId })),
      );
      assert.deepEqual(observed, []);
    });
    assert.deepEqual(observed, ["outer-before", "inner-commit"]);
    assert.deepEqual(
      database.eventJournal.replay({ projectId }).map((event) => event.sequenceNumber),
      [1, 2],
    );
  });
});

test("latest scoped lifecycle lookup is not limited to the first replay page", () => {
  withDatabase((database) => {
    const { projectId, phaseId, taskId } = seedProjectGraph(database);
    database.transaction(() => {
      for (let index = 0; index < 1001; index++) {
        database.eventJournal.append(makeEvent({ id: `page-event-${index}`, projectId }));
      }
      database.eventJournal.append(
        makeEvent({
          id: "latest-task-event",
          projectId,
          phaseId,
          taskId,
          type: "TASK_STATE_CHANGED",
          payload: { previousState: "PENDING", state: "READY" },
        }),
      );
    });
    assert.equal(
      database.repositories.events.latest(projectId, { taskId, types: ["TASK_STATE_CHANGED"] }).id,
      "latest-task-event",
    );
  });
});
