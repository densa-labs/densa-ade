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
  IdeCoreConnection,
  WELCOME_ACTIONS,
  WELCOME_DENSA_COMMANDS,
  WELCOME_EDITOR_COMMANDS,
  buildWelcomeModel,
  resolveWelcomeCoreAction,
  toWelcomeRecentProjects,
  welcomeActionById,
} from "../apps/ide-extension/dist/index.js";

const TIMESTAMP = "2026-09-03T00:00:00.000Z";

function makeSummary(id, extra = {}) {
  return {
    project: {
      id,
      name: `Welcome ${id}`,
      state: "DRAFT",
      executionMode: "phase",
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    },
    workspacePath: `/tmp/densa-welcome-${id}`,
    completedTaskCount: 0,
    totalTaskCount: 0,
    attentionRequired: false,
    ...extra,
  };
}

function actionMap(model) {
  return new Map(model.actions.map((entry) => [entry.id, entry]));
}

test("welcome catalog provides all nine Home actions without blocking editor flows", () => {
  const ids = WELCOME_ACTIONS.map((entry) => entry.id);
  for (const expected of [
    "open-folder",
    "open-file",
    "new-window",
    "start-project",
    "open-dashboard",
    "open-roadmap",
    "open-master-agent",
    "resume-project",
    "recent-projects",
  ]) {
    assert.ok(ids.includes(expected), expected);
  }
  assert.equal(WELCOME_ACTIONS.length, 9);

  const byId = new Map(WELCOME_ACTIONS.map((entry) => [entry.id, entry]));
  assert.equal(byId.get("open-folder").command, WELCOME_EDITOR_COMMANDS.openFolder);
  assert.equal(byId.get("open-file").command, WELCOME_EDITOR_COMMANDS.openFile);
  assert.equal(byId.get("new-window").command, WELCOME_EDITOR_COMMANDS.newWindow);
  assert.equal(byId.get("start-project").command, WELCOME_DENSA_COMMANDS.startProject);
  assert.equal(byId.get("open-dashboard").command, WELCOME_DENSA_COMMANDS.openDashboard);
  assert.equal(byId.get("open-roadmap").command, WELCOME_DENSA_COMMANDS.openRoadmap);
  assert.equal(byId.get("open-master-agent").command, WELCOME_DENSA_COMMANDS.openMasterAgent);
  assert.equal(byId.get("resume-project").command, WELCOME_DENSA_COMMANDS.resumeProject);

  for (const editorId of ["open-folder", "open-file", "new-window"]) {
    const entry = byId.get(editorId);
    assert.equal(entry.kind, "editor-native");
    assert.equal(entry.requiresCore, false);
    assert.equal(entry.coreMethod, undefined);
  }
  assert.equal(byId.get("start-project").coreMethod, "projects.create");
  assert.equal(byId.get("open-dashboard").coreMethod, "dashboard.get");
  assert.equal(byId.get("open-roadmap").coreMethod, "roadmaps.get");
  assert.equal(byId.get("open-master-agent").coreMethod, "master.send");
  assert.equal(byId.get("resume-project").coreMethod, "projects.resume");
  assert.equal(byId.get("recent-projects").coreMethod, "projects.list");
});

test("standard editor use is not blocked by Densa ADE setup", () => {
  for (const connectionState of [
    "disconnected",
    "connecting",
    "connected",
    "version-mismatch",
    "auth-failed",
  ]) {
    const model = buildWelcomeModel({ connectionState, projects: [] });
    const actions = actionMap(model);
    for (const editorId of ["open-folder", "open-file", "new-window"]) {
      assert.equal(actions.get(editorId).enabled, true, `${connectionState}/${editorId}`);
      assert.equal(actions.get(editorId).reason, undefined);
    }
  }

  const connectedEmpty = buildWelcomeModel({ connectionState: "connected", projects: [] });
  const emptyActions = actionMap(connectedEmpty);
  assert.equal(emptyActions.get("start-project").enabled, true);
  assert.equal(emptyActions.get("open-dashboard").enabled, false);
  assert.equal(emptyActions.get("resume-project").enabled, false);
  assert.equal(emptyActions.get("recent-projects").enabled, false);
});

test("unavailable project actions explain what is needed", () => {
  const disconnected = actionMap(
    buildWelcomeModel({ connectionState: "disconnected", projects: [] }),
  );
  assert.match(disconnected.get("start-project").reason, /densa-ade core start/u);
  assert.match(disconnected.get("resume-project").reason, /not connected/u);

  const mismatch = actionMap(
    buildWelcomeModel({ connectionState: "version-mismatch", projects: [] }),
  );
  assert.match(mismatch.get("start-project").reason, /protocol mismatch/iu);

  const auth = actionMap(buildWelcomeModel({ connectionState: "auth-failed", projects: [] }));
  assert.match(auth.get("start-project").reason, /rejected.*session|local trust/iu);

  const noProjects = actionMap(buildWelcomeModel({ connectionState: "connected", projects: [] }));
  assert.match(noProjects.get("recent-projects").reason, /No Densa ADE projects yet/u);
  assert.match(noProjects.get("open-dashboard").reason, /No Densa ADE project is open/u);

  const projects = [makeSummary("project-welcome-a")];
  const noSelection = actionMap(buildWelcomeModel({ connectionState: "connected", projects }));
  assert.match(noSelection.get("open-dashboard").reason, /Select a Densa ADE project/u);

  const stale = actionMap(
    buildWelcomeModel({
      connectionState: "connected",
      projects,
      selectedProjectId: "project-unknown",
    }),
  );
  assert.equal(stale.get("open-dashboard").enabled, false);
  assert.match(stale.get("open-dashboard").reason, /not in the Core project list/u);
  assert.equal(stale.get("resume-project").enabled, false);

  const selected = actionMap(
    buildWelcomeModel({
      connectionState: "connected",
      projects,
      selectedProjectId: "project-welcome-a",
    }),
  );
  for (const id of ["open-dashboard", "open-roadmap", "open-master-agent", "resume-project"]) {
    assert.equal(selected.get(id).enabled, true, id);
    assert.equal(selected.get(id).reason, undefined, id);
  }
  assert.equal(selected.get("recent-projects").enabled, true);
});

test("welcome resolutions map to existing Core v1 operations and never invent state", () => {
  for (const definition of WELCOME_ACTIONS) {
    if (definition.coreMethod !== undefined) {
      assert.ok(CORE_V1_METHODS.includes(definition.coreMethod), definition.coreMethod);
    }
  }

  assert.equal(resolveWelcomeCoreAction("start-project").method, "projects.create");
  assert.equal(
    resolveWelcomeCoreAction("open-dashboard", { projectId: "project-x" }).method,
    "dashboard.get",
  );
  assert.equal(
    resolveWelcomeCoreAction("open-roadmap", { projectId: "project-x" }).method,
    "roadmaps.get",
  );
  assert.equal(
    resolveWelcomeCoreAction("open-master-agent", { projectId: "project-x" }).method,
    "master.send",
  );
  const resume = resolveWelcomeCoreAction("resume-project", { projectId: "project-x" });
  assert.equal(resume.method, "projects.resume");
  assert.equal(resume.projectId, "project-x");
  assert.equal(resolveWelcomeCoreAction("recent-projects").method, "projects.list");

  assert.throws(() => resolveWelcomeCoreAction("open-folder"), /editor-native/u);
  assert.throws(
    () => resolveWelcomeCoreAction("resume-project"),
    /requires a persisted projectId/u,
  );
  assert.throws(
    () => resolveWelcomeCoreAction("open-dashboard", { projectId: "   " }),
    /requires a persisted projectId/u,
  );
  assert.throws(() => resolveWelcomeCoreAction("unknown-action"), /Unknown/u);

  const model = buildWelcomeModel({
    connectionState: "connected",
    projects: [makeSummary("project-welcome-a")],
    selectedProjectId: "project-welcome-a",
  });
  assert.equal(welcomeActionById(model, "resume-project").enabled, true);
  assert.throws(() => welcomeActionById(model, "unknown-action"), /Unknown/u);
});

test("recent projects project Core truth verbatim in Core order", () => {
  const empty = buildWelcomeModel({ connectionState: "connected", projects: [] });
  assert.equal(empty.hasProjects, false);
  assert.deepEqual(empty.recentProjects, []);

  const summaries = [
    makeSummary("project-welcome-1", { attentionRequired: true }),
    makeSummary("project-welcome-2", { currentPhaseId: "phase-1" }),
  ];
  const model = buildWelcomeModel({ connectionState: "connected", projects: summaries });
  assert.equal(model.hasProjects, true);
  assert.equal(model.recentProjects.length, 2);
  assert.equal(model.recentProjects[0].projectId, "project-welcome-1");
  assert.equal(model.recentProjects[0].attentionRequired, true);
  assert.equal(model.recentProjects[1].currentPhaseId, "phase-1");

  const many = Array.from({ length: 12 }, (_, index) =>
    makeSummary(`project-welcome-many-${index}`),
  );
  assert.equal(toWelcomeRecentProjects(many).length, 10);
});

async function withWelcomeDaemon(run) {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "densa-welcome-m2-"));
  const workspace = await mkdtemp(join(tmpdir(), "densa-welcome-ws-"));
  const database = DensaAdeDatabase.openInMemory();
  const daemon = await CoreDaemon.start({ runtimeDirectory, database });
  let requestNumber = 0;
  const connection = new IdeCoreConnection({
    runtimeDirectory,
    createRequestId: () => `welcome-m2-${String((requestNumber += 1))}`,
  });
  try {
    await connection.connect();
    await run({ connection, database, daemon, runtimeDirectory, workspace });
  } finally {
    connection.dispose();
    await daemon.stop().catch(() => undefined);
    database.close();
    await rm(runtimeDirectory, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
}

test("Start Project reaches the existing Core project creation flow", async () => {
  await withWelcomeDaemon(async ({ connection, workspace }) => {
    const start = resolveWelcomeCoreAction("start-project");
    assert.equal(start.method, "projects.create");

    const created = await connection.request(start.method, {
      name: "Welcome M2 fixture",
      workspacePath: workspace,
      idea: "Prove welcome Start Project reaches Core project creation",
      executionMode: "phase",
      actor: "test",
    });
    assert.match(created.project.id, /^project-/u);

    const listed = await connection.request("projects.list", {});
    assert.ok(listed.projects.some((entry) => entry.project.id === created.project.id));

    const model = buildWelcomeModel({
      connectionState: "connected",
      projects: listed.projects,
    });
    assert.equal(model.hasProjects, true);
    assert.ok(model.recentProjects.some((entry) => entry.projectId === created.project.id));
    assert.equal(actionMap(model).get("recent-projects").enabled, true);
    assert.equal(actionMap(model).get("start-project").enabled, true);
  });
});

test("Resume opens the persisted project correctly", async () => {
  await withWelcomeDaemon(async ({ connection, workspace }) => {
    const created = await connection.request("projects.create", {
      name: "Welcome resume fixture",
      workspacePath: workspace,
      idea: "Prove welcome Resume re-opens persisted Core truth",
      executionMode: "phase",
      actor: "test",
    });
    const listed = await connection.request("projects.list", {});
    const model = buildWelcomeModel({
      connectionState: connection.connectionStatus.state,
      projects: listed.projects,
      selectedProjectId: created.project.id,
    });
    const actions = actionMap(model);
    assert.equal(actions.get("resume-project").enabled, true);
    assert.equal(actions.get("open-dashboard").enabled, true);
    assert.equal(actions.get("open-roadmap").enabled, true);
    assert.equal(actions.get("open-master-agent").enabled, true);

    const resume = resolveWelcomeCoreAction("resume-project", {
      projectId: created.project.id,
    });
    assert.equal(resume.method, "projects.resume");

    const snapshot = await connection.request("projects.get", {
      projectId: created.project.id,
    });
    assert.equal(snapshot.summary.project.id, created.project.id);
    // Core canonicalizes workspace paths (macOS /var -> /private/var); the
    // welcome recent entry must match the authoritative snapshot, not the raw input.
    assert.ok(snapshot.summary.workspacePath.length > 0);
    const recent = model.recentProjects.find((entry) => entry.projectId === created.project.id);
    assert.equal(recent.name, snapshot.summary.project.name);
    assert.equal(recent.state, snapshot.summary.project.state);
    assert.equal(recent.workspacePath, snapshot.summary.workspacePath);
  });
});

test("welcome extension sources stay protocol-only", () => {
  const extensionDir = new URL("../apps/ide-extension/src/", import.meta.url);
  const sources = [
    "index.ts",
    "connection.ts",
    "runtime-paths.ts",
    "ide-transport.ts",
    "event-cache.ts",
    "ide-connection.ts",
    "welcome.ts",
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
  const manifest = JSON.parse(
    readFileSync(new URL("../apps/ide-extension/package.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), ["@densa-ade/protocol"]);
  const commands = manifest.contributes.commands.map((entry) => entry.command);
  for (const command of [
    "densa-ade.showDashboard",
    "densa-ade.showRoadmap",
    "densa-ade.showMasterAgent",
    "densa-ade.startProject",
    "densa-ade.resumeProject",
  ]) {
    assert.ok(commands.includes(command), command);
  }
});
