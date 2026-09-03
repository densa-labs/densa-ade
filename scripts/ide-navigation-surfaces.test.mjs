import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { URL } from "node:url";

import { CoreDaemon } from "../packages/core/dist/index.js";
import { DensaAdeDatabase } from "../packages/core/dist/persistence/index.js";
import { CORE_V1_METHODS } from "../packages/protocol/dist/index.js";
import {
  ACTIVITY_BAR_CONTAINER_ID,
  SURFACE_COMMAND_CATEGORY,
  SURFACE_DEFINITIONS,
  SURFACE_LIFECYCLE,
  IdeCoreConnection,
  buildSurfaceAvailability,
  resolveSurfaceOpenRefresh,
  surfaceById,
  surfaceForActivityBarView,
  surfaceForCommand,
  surfaceForEditorViewType,
} from "../apps/ide-extension/dist/index.js";

test("navigation shells cover Dashboard, Roadmap, and Master Agent as editor-area tabs", () => {
  assert.equal(SURFACE_DEFINITIONS.length, 3);
  const ids = SURFACE_DEFINITIONS.map((entry) => entry.id);
  assert.deepEqual(ids, ["dashboard", "roadmap", "master"]);

  for (const definition of SURFACE_DEFINITIONS) {
    assert.equal(definition.area, "editor-tab");
    assert.ok(definition.title.length > 0);
    assert.ok(definition.command.startsWith("densa-ade."));
    assert.ok(definition.activityBarViewId.startsWith("densa-ade."));
    assert.ok(definition.editorViewType.startsWith("densa-ade."));
    assert.equal(definition.requiresProjectSelection, true);
  }

  assert.equal(surfaceById("dashboard").command, "densa-ade.showDashboard");
  assert.equal(surfaceById("roadmap").command, "densa-ade.showRoadmap");
  assert.equal(surfaceById("master").command, "densa-ade.showMasterAgent");

  assert.equal(surfaceForCommand("densa-ade.showDashboard").id, "dashboard");
  assert.equal(surfaceForCommand("densa-ade.showRoadmap").id, "roadmap");
  assert.equal(surfaceForCommand("densa-ade.showMasterAgent").id, "master");

  assert.equal(surfaceForActivityBarView("densa-ade.dashboard").id, "dashboard");
  assert.equal(surfaceForActivityBarView("densa-ade.roadmap").id, "roadmap");
  assert.equal(surfaceForActivityBarView("densa-ade.master").id, "master");

  assert.equal(surfaceForEditorViewType("densa-ade.dashboard").id, "dashboard");
  assert.equal(surfaceForEditorViewType("densa-ade.roadmap").id, "roadmap");
  assert.equal(surfaceForEditorViewType("densa-ade.master").id, "master");

  assert.throws(() => surfaceById("chat-sidebar"), /Unknown/u);
  assert.throws(
    () => surfaceForCommand("workbench.action.files.openFolder"),
    /No Densa ADE surface/u,
  );
  assert.throws(() => surfaceForActivityBarView("densa-ade.unknown"), /No Densa ADE surface/u);
  assert.throws(() => surfaceForEditorViewType("densa-ade.unknown"), /No Densa ADE surface/u);
});

test("surfaces resolve to existing Core v1 operations and never invent state", () => {
  for (const definition of SURFACE_DEFINITIONS) {
    for (const method of [...definition.openRefreshMethods, ...definition.capabilityMethods]) {
      assert.ok(CORE_V1_METHODS.includes(method), `${definition.id}/${method}`);
    }
  }

  const dashboard = resolveSurfaceOpenRefresh("dashboard", { projectId: "project-m3-a" });
  assert.equal(dashboard.kind, "snapshot-refresh");
  assert.equal(dashboard.method, "dashboard.get");
  assert.equal(dashboard.projectId, "project-m3-a");
  assert.equal(dashboard.editorViewType, "densa-ade.dashboard");
  assert.equal(dashboard.area, "editor-tab");

  const roadmap = resolveSurfaceOpenRefresh("roadmap", { projectId: "project-m3-a" });
  assert.equal(roadmap.kind, "snapshot-refresh");
  assert.equal(roadmap.method, "roadmaps.get");
  assert.equal(roadmap.projectId, "project-m3-a");

  const master = resolveSurfaceOpenRefresh("master", { projectId: "project-m3-a" });
  assert.equal(master.kind, "deferred-interaction");
  assert.equal(master.capability, "master.send");
  assert.equal(master.projectId, "project-m3-a");

  assert.throws(() => resolveSurfaceOpenRefresh("dashboard"), /requires a persisted projectId/u);
  assert.throws(
    () => resolveSurfaceOpenRefresh("roadmap", { projectId: "   " }),
    /requires a persisted projectId/u,
  );
  assert.throws(() => resolveSurfaceOpenRefresh("unknown-surface", { projectId: "x" }), /Unknown/u);
});

test("unavailable surfaces explain what is needed without blocking editor flows", () => {
  for (const connectionState of ["disconnected", "connecting", "version-mismatch", "auth-failed"]) {
    const availability = buildSurfaceAvailability({ connectionState, selectedProjectId: "p" });
    for (const entry of availability) {
      assert.equal(entry.enabled, false, `${connectionState}/${entry.id}`);
      assert.ok(typeof entry.reason === "string" && entry.reason.length > 0);
    }
  }

  const disconnected = buildSurfaceAvailability({ connectionState: "disconnected" });
  assert.match(disconnected[0].reason, /densa-ade core start/u);

  const mismatch = buildSurfaceAvailability({ connectionState: "version-mismatch" });
  assert.match(mismatch[0].reason, /protocol mismatch/iu);

  const auth = buildSurfaceAvailability({ connectionState: "auth-failed" });
  assert.match(auth[0].reason, /rejected.*session|local trust/iu);

  const noSelection = buildSurfaceAvailability({ connectionState: "connected" });
  for (const entry of noSelection) {
    assert.equal(entry.enabled, false, entry.id);
    assert.match(entry.reason, /No Densa ADE project is open/u);
  }

  const selected = buildSurfaceAvailability({
    connectionState: "connected",
    selectedProjectId: "project-m3-a",
  });
  for (const entry of selected) {
    assert.equal(entry.enabled, true, entry.id);
    assert.equal(entry.reason, undefined, entry.id);
    assert.equal(entry.area, "editor-tab");
  }
});

test("surface views are disposable while Core execution is durable", () => {
  assert.equal(SURFACE_LIFECYCLE.closeDisposes, "view-handle-only");
  assert.equal(SURFACE_LIFECYCLE.coreContinuesAfterClose, true);
  assert.equal(SURFACE_LIFECYCLE.reopenRefreshesSnapshot, true);
  assert.equal(SURFACE_LIFECYCLE.optimisticComplete, false);
});

test("extension manifest wires palette group, activity bar, and editor-area tabs", () => {
  assert.equal(SURFACE_COMMAND_CATEGORY, "Densa ADE");
  assert.equal(ACTIVITY_BAR_CONTAINER_ID, "densa-ade");

  const manifest = JSON.parse(
    readFileSync(new URL("../apps/ide-extension/package.json", import.meta.url), "utf8"),
  );
  const commands = manifest.contributes.commands;
  for (const command of [
    "densa-ade.showDashboard",
    "densa-ade.showRoadmap",
    "densa-ade.showMasterAgent",
    "densa-ade.startProject",
    "densa-ade.resumeProject",
  ]) {
    const entry = commands.find((item) => item.command === command);
    assert.ok(entry, command);
    assert.equal(entry.category, "Densa ADE", command);
  }

  const containers = manifest.contributes.viewsContainers.activitybar;
  assert.ok(containers.some((entry) => entry.id === "densa-ade"));

  const views = manifest.contributes.views["densa-ade"];
  for (const view of ["densa-ade.dashboard", "densa-ade.roadmap", "densa-ade.master"]) {
    assert.ok(
      views.some((entry) => entry.id === view),
      view,
    );
    assert.equal(surfaceForActivityBarView(view).activityBarViewId, view);
  }

  for (const viewType of ["densa-ade.dashboard", "densa-ade.roadmap", "densa-ade.master"]) {
    const editor = manifest.contributes.customEditors.find((entry) => entry.viewType === viewType);
    assert.ok(editor, viewType);
    assert.ok(editor.displayName.length > 0);
    assert.ok(Array.isArray(editor.selector) && editor.selector.length > 0);
    assert.equal(surfaceForEditorViewType(viewType).editorViewType, viewType);
    assert.equal(surfaceForEditorViewType(viewType).area, "editor-tab");
  }

  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), ["@densa-ade/protocol"]);
});

async function withSurfaceDaemon(run) {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "densa-surface-m3-"));
  const workspace = await mkdtemp(join(tmpdir(), "densa-surface-ws-"));
  const database = DensaAdeDatabase.openInMemory();
  const daemon = await CoreDaemon.start({ runtimeDirectory, database });
  let requestNumber = 0;
  const connection = new IdeCoreConnection({
    runtimeDirectory,
    createRequestId: () => `surface-m3-${String((requestNumber += 1))}`,
  });
  try {
    await connection.connect();
    await run({ connection, database, daemon, workspace, runtimeDirectory });
  } finally {
    connection.dispose();
    await daemon.stop().catch(() => undefined);
    database.close();
    await rm(runtimeDirectory, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
}

test("closing and reopening surfaces does not affect Core execution", async () => {
  await withSurfaceDaemon(async ({ connection, daemon, workspace, runtimeDirectory }) => {
    const created = await connection.request("projects.create", {
      name: "Surface M3 fixture",
      workspacePath: workspace,
      idea: "Prove surface open/close leaves Core execution untouched",
      executionMode: "phase",
      actor: "test",
    });
    const projectId = created.project.id;

    const dashboardOpen = resolveSurfaceOpenRefresh("dashboard", { projectId });
    assert.equal(dashboardOpen.kind, "snapshot-refresh");
    const before = await connection.request(dashboardOpen.method, { projectId });
    assert.equal(before.project.project.id, projectId);

    // The fixture has no approved roadmap yet. The Roadmap surface resolves to
    // the real Core operation and reports that honestly instead of inventing
    // roadmap content.
    const roadmapOpen = resolveSurfaceOpenRefresh("roadmap", { projectId });
    assert.equal(roadmapOpen.kind, "snapshot-refresh");
    await assert.rejects(
      connection.request(roadmapOpen.method, { projectId }),
      /no approved roadmap/iu,
    );

    const masterOpen = resolveSurfaceOpenRefresh("master", { projectId });
    assert.equal(masterOpen.kind, "deferred-interaction");

    // Closing a surface issues no Core request: the daemon keeps running and
    // the persisted project is untouched by the close itself.
    assert.equal(daemon.status().state, "running");
    const listedWhileClosed = await connection.request("projects.list", {});
    assert.ok(listedWhileClosed.projects.some((entry) => entry.project.id === projectId));

    // Reopening refreshes the same authoritative snapshot.
    const after = await connection.request("dashboard.get", { projectId });
    assert.equal(after.project.project.id, before.project.project.id);
    assert.equal(after.project.project.state, before.project.project.state);
    assert.equal(after.project.workspacePath, before.project.workspacePath);

    // Closing the IDE connection (all surfaces) still leaves Core running,
    // and a fresh window reconnects to the same project truth.
    connection.dispose();
    assert.equal(daemon.status().state, "running");
    let reopenedNumber = 0;
    const reopened = new IdeCoreConnection({
      runtimeDirectory,
      createRequestId: () => `surface-m3-reopen-${String((reopenedNumber += 1))}`,
    });
    try {
      await reopened.connect();
      const relisted = await reopened.request("projects.list", {});
      assert.ok(relisted.projects.some((entry) => entry.project.id === projectId));
      const reread = await reopened.request("dashboard.get", { projectId });
      assert.equal(reread.project.project.id, projectId);
      assert.equal(reread.project.project.state, before.project.project.state);
    } finally {
      reopened.dispose();
    }
  });
});

test("surface extension sources stay protocol-only", () => {
  const extensionDir = new URL("../apps/ide-extension/src/", import.meta.url);
  const sources = [
    "index.ts",
    "connection.ts",
    "runtime-paths.ts",
    "ide-transport.ts",
    "event-cache.ts",
    "ide-connection.ts",
    "welcome.ts",
    "surfaces.ts",
  ]
    .map((file) => readFileSync(new URL(file, extensionDir), "utf8"))
    .join("\n");
  const forbidden = [
    /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']@densa-ade\/core(?:\/[^"']*)?["']/u,
    /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*vs\/workbench[^"']*["']/u,
    /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']vscode["']/u,
    /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*sqlite[^"']*["']/iu,
    /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']@densa-ade\/cli(?:\/[^"']*)?["']/u,
  ];
  for (const pattern of forbidden) {
    assert.ok(!pattern.test(sources), String(pattern));
  }
});
