import assert from "node:assert/strict";
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DensaDatabase,
  PortableProjectSynchronizer,
  PortableProjectSyncError,
  atomicReplaceFile,
} from "@densa/core/persistence";

const createdAt = "2026-08-26T08:00:00.000Z";
const updatedAt = "2026-08-26T08:30:00.000Z";
const projectId = "project-portable";
const managedFiles = ["project.json", "SPEC.md", "ROADMAP.md", "DECISIONS.md", "config.json"];

async function withWorkspace(work) {
  const workspace = await mkdtemp(join(tmpdir(), "densa-p2m3-"));
  const database = DensaDatabase.openInMemory({ now: () => createdAt });
  try {
    return await work({ database, workspace });
  } finally {
    database.close();
    await rm(workspace, { force: true, recursive: true });
  }
}

function seedPortableProject(repositories) {
  repositories.projects.create({
    id: projectId,
    name: "Portable project",
    state: "DRAFT",
    executionMode: "phase",
    createdAt,
    updatedAt: createdAt,
  });
  repositories.specifications.set({
    projectId,
    content:
      "# Build intent\r\n\r\nCreate an offline tool. api_key=sk-proj-AAAAAAAAAAAAAAAAAAAA\r\n",
    createdAt,
    updatedAt,
  });
  repositories.phases.create({
    id: "phase-portable",
    projectId,
    title: "Portable intent",
    state: "PENDING",
    position: 0,
    createdAt,
    updatedAt: createdAt,
  });
  repositories.tasks.create({
    id: "task-foundation",
    projectId,
    phaseId: "phase-portable",
    title: "Create the foundation",
    state: "PENDING",
    position: 0,
    acceptanceCriteria: ["Foundation exists"],
    dependencyIds: [],
    createdAt,
    updatedAt: createdAt,
  });
  repositories.tasks.create({
    id: "task-export",
    projectId,
    phaseId: "phase-portable",
    title: "Export the intent",
    state: "PENDING",
    position: 1,
    acceptanceCriteria: ["Files are deterministic", "password: super-secret-password"],
    dependencyIds: ["task-foundation"],
    createdAt,
    updatedAt: createdAt,
  });
  repositories.decisions.create({
    id: "decision-portable",
    projectId,
    title: "Keep state local",
    rationale: "Use SQLite. Bearer abcdefghijklmnopqrstuvwxyz must remain private.",
    createdAt,
  });
  repositories.roadmapRevisions.create({
    id: "revision-portable",
    projectId,
    classification: "minor",
    reason: "Split export from foundation",
    actor: "densa-core:test",
    createdAt,
    affectedPhaseIds: ["phase-portable"],
    affectedTaskIds: ["task-export"],
    oldValue: { title: "One task", credential: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234" },
    newValue: { title: "Two tasks" },
  });
  repositories.projectSettings.set({
    projectId,
    values: {
      keepAwake: true,
      nested: { apiKey: "sk-proj-BBBBBBBBBBBBBBBBBBBB" },
    },
    updatedAt,
  });
}

async function readManaged(directory) {
  return Object.fromEntries(
    await Promise.all(
      managedFiles.map(async (name) => [name, await readFile(join(directory, name), "utf8")]),
    ),
  );
}

test("SQLite project intent exports to a deterministic, understandable .densa tree", async () => {
  await withWorkspace(async ({ database, workspace }) => {
    seedPortableProject(database.repositories);
    const synchronizer = new PortableProjectSynchronizer(database.repositories);

    const first = await synchronizer.synchronize(workspace, projectId);
    assert.equal(first.status, "synchronized");
    assert.deepEqual(first.written, [...managedFiles, ".sync-state.json"]);
    assert.equal((await lstat(join(workspace, ".densa", "reports"))).isDirectory(), true);
    assert.equal((await lstat(join(workspace, ".densa", "logs"))).isDirectory(), true);
    assert.equal((await lstat(join(workspace, ".densa", "project.json"))).mode & 0o777, 0o600);

    const directory = join(workspace, ".densa");
    const files = await readManaged(directory);
    assert.deepEqual(JSON.parse(files["project.json"]), {
      formatVersion: 1,
      id: projectId,
      name: "Portable project",
      state: "DRAFT",
      executionMode: "phase",
      createdAt,
      updatedAt: createdAt,
    });
    assert.match(files["SPEC.md"], /^# Build intent\n\nCreate an offline tool\./u);
    assert.match(files["ROADMAP.md"], /## Phase 1: Portable intent/u);
    assert.match(files["ROADMAP.md"], /### Task 2: Export the intent/u);
    assert.match(files["ROADMAP.md"], /Foundation exists/u);
    assert.match(files["ROADMAP.md"], /Roadmap revision history/u);
    assert.match(files["DECISIONS.md"], /## Keep state local/u);
    assert.deepEqual(JSON.parse(files["config.json"]), {
      formatVersion: 1,
      projectId,
      settings: { keepAwake: true, nested: { apiKey: "[REDACTED]" } },
      updatedAt,
    });

    const second = await synchronizer.synchronize(workspace, projectId);
    assert.equal(second.status, "synchronized");
    assert.deepEqual(second.written, []);
    assert.deepEqual(second.unchanged, [...managedFiles, ".sync-state.json"]);
    assert.deepEqual(await readManaged(directory), files);
  });
});

test("secret-like values are redacted from every exported portable file", async () => {
  await withWorkspace(async ({ database, workspace }) => {
    seedPortableProject(database.repositories);
    const result = await new PortableProjectSynchronizer(database.repositories).synchronize(
      workspace,
      projectId,
    );
    const directory = join(workspace, ".densa");
    const exported = [
      ...(await Promise.all(managedFiles.map((name) => readFile(join(directory, name), "utf8")))),
      await readFile(join(directory, ".sync-state.json"), "utf8"),
    ].join("\n");

    assert.equal(result.redactedValueCount >= 5, true);
    assert.doesNotMatch(exported, /sk-proj-[AB]+/u);
    assert.doesNotMatch(exported, /ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234/u);
    assert.doesNotMatch(exported, /abcdefghijklmnopqrstuvwxyz/u);
    assert.doesNotMatch(exported, /super-secret-password/u);
    assert.match(exported, /\[REDACTED/u);
  });
});

test("meaningful human edits are reported and no managed file is overwritten", async () => {
  await withWorkspace(async ({ database, workspace }) => {
    seedPortableProject(database.repositories);
    const synchronizer = new PortableProjectSynchronizer(database.repositories);
    await synchronizer.synchronize(workspace, projectId);
    const directory = join(workspace, ".densa");
    await appendFile(join(directory, "ROADMAP.md"), "\nHuman planning note.\n", "utf8");
    const before = await readManaged(directory);

    const result = await synchronizer.synchronize(workspace, projectId);

    assert.equal(result.status, "conflict");
    assert.deepEqual(result.written, []);
    assert.deepEqual(result.conflicts, [{ path: "ROADMAP.md", reason: "human-edit" }]);
    assert.deepEqual(await readManaged(directory), before);
  });
});

test("an existing portable file without a trusted manifest is preserved as a human edit", async () => {
  await withWorkspace(async ({ database, workspace }) => {
    seedPortableProject(database.repositories);
    const directory = join(workspace, ".densa");
    await writeFile(join(workspace, "placeholder"), "workspace", "utf8");
    await mkdir(directory);
    await writeFile(join(directory, "SPEC.md"), "# Human specification\n", "utf8");

    const result = await new PortableProjectSynchronizer(database.repositories).synchronize(
      workspace,
      projectId,
    );

    assert.equal(result.status, "conflict");
    assert.deepEqual(result.conflicts, [{ path: "SPEC.md", reason: "human-edit" }]);
    assert.equal(await readFile(join(directory, "SPEC.md"), "utf8"), "# Human specification\n");
    assert.equal((await readdir(directory)).includes("project.json"), false);
  });
});

test("a missing .densa folder is recreated on the next synchronization", async () => {
  await withWorkspace(async ({ database, workspace }) => {
    seedPortableProject(database.repositories);
    const synchronizer = new PortableProjectSynchronizer(database.repositories);
    await synchronizer.synchronize(workspace, projectId);
    await rm(join(workspace, ".densa"), { recursive: true });

    const result = await synchronizer.synchronize(workspace, projectId);

    assert.equal(result.status, "synchronized");
    assert.deepEqual(result.written, [...managedFiles, ".sync-state.json"]);
    assert.equal(
      JSON.parse(await readFile(join(result.directory, "project.json"), "utf8")).id,
      projectId,
    );
  });
});

test("atomic replacement leaves the prior JSON intact when interrupted before rename", async () => {
  await withWorkspace(async ({ workspace }) => {
    const target = join(workspace, "project.json");
    await writeFile(target, '{"state":"old"}\n', "utf8");

    await assert.rejects(
      atomicReplaceFile(target, '{"state":"new"}\n', {
        beforeRename: () => {
          throw new Error("injected write interruption");
        },
      }),
      /injected write interruption/u,
    );

    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { state: "old" });
    assert.deepEqual((await readdir(workspace)).sort(), ["project.json"]);
  });
});

test("unsafe .densa symlinks fail closed", async () => {
  await withWorkspace(async ({ database, workspace }) => {
    seedPortableProject(database.repositories);
    const outside = await mkdtemp(join(tmpdir(), "densa-p2m3-outside-"));
    try {
      await symlink(outside, join(workspace, ".densa"));
      await assert.rejects(
        new PortableProjectSynchronizer(database.repositories).synchronize(workspace, projectId),
        (error) => error instanceof PortableProjectSyncError && error.code === "WORKSPACE_CONFLICT",
      );
      assert.deepEqual(await readdir(outside), []);
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });
});

test("exporting an unknown project fails with a stable persistence error", async () => {
  await withWorkspace(async ({ database, workspace }) => {
    await assert.rejects(
      new PortableProjectSynchronizer(database.repositories).synchronize(workspace, "missing"),
      (error) => error instanceof PortableProjectSyncError && error.code === "PERSISTENCE_FAILURE",
    );
  });
});
