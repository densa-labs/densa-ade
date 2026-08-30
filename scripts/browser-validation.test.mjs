import assert from "node:assert/strict";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  BrowserValidationDetector,
  BrowserValidationValidator,
  ValidationPipeline,
} from "@densa-ade/core";
import { DensaAdeDatabase } from "@densa-ade/core/persistence";

const workspaces = [];
const createdAt = "2026-08-28T00:00:00.000Z";

function fixture(name) {
  const workspace = mkdtempSync(join(tmpdir(), `densa-browser-${name}-`));
  workspaces.push(workspace);
  return workspace;
}

function writeJson(workspace, path, value) {
  writeFileSync(join(workspace, path), `${JSON.stringify(value, null, 2)}\n`);
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("fixture port unavailable");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function createWebFixture(workspace, port, { noisy = false } = {}) {
  const pidPath = join(workspace, "server.pid");
  const scriptPath = join(workspace, "server.mjs");
  const launcherPath = join(workspace, "launcher.mjs");
  writeFileSync(
    scriptPath,
    `import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
const [port, pidPath] = process.argv.slice(2);
writeFileSync(pidPath, String(process.pid));
${noisy ? 'console.error("Bearer fixture-secret " + "x".repeat(100000));' : ""}
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end('<!doctype html><title>Densa ADE fixture</title><main><h1 data-testid="heading">Browser proof</h1></main>');
});
server.listen(Number(port), "127.0.0.1");
const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
`,
  );
  writeFileSync(
    launcherPath,
    `import { spawn } from "node:child_process";
const child = spawn(process.execPath, process.argv.slice(2), { stdio: "inherit" });
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
setInterval(() => {}, 1000);
`,
  );
  return { launcherPath, pidPath, scriptPath };
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function assertServerStopped(pidPath) {
  const pid = Number(readFileSync(pidPath, "utf8"));
  assert.equal(processIsAlive(pid), false, `dev server ${String(pid)} is still running`);
}

function seedTask(database, suffix) {
  const project = {
    id: `project-${suffix}`,
    name: "Browser validation fixture",
    state: "DRAFT",
    executionMode: "guided",
    createdAt,
    updatedAt: createdAt,
  };
  const phase = {
    id: `phase-${suffix}`,
    projectId: project.id,
    title: "Browser proof",
    state: "PENDING",
    position: 0,
    createdAt,
    updatedAt: createdAt,
  };
  const task = {
    id: `task-${suffix}`,
    projectId: project.id,
    phaseId: phase.id,
    title: "Render the page",
    state: "PENDING",
    position: 0,
    acceptanceCriteria: ["The browser shows the expected heading."],
    dependencyIds: [],
    createdAt,
    updatedAt: createdAt,
  };
  database.repositories.projects.create(project);
  database.repositories.phases.create(phase);
  database.repositories.tasks.create(task);
  return { project, task };
}

test.after(() => {
  for (const workspace of workspaces) rmSync(workspace, { force: true, recursive: true });
});

test("browser target detection is explicit, safe, and disabled for irrelevant tasks", async () => {
  const detector = new BrowserValidationDetector();
  const irrelevant = fixture("irrelevant");
  const external = fixture("external");
  writeFileSync(join(external, "package.json"), "{not-json");
  symlinkSync(join(external, "package.json"), join(irrelevant, "package.json"));

  assert.deepEqual(await detector.detect({ workspacePath: irrelevant, browserRelevant: false }), {
    version: 1,
    status: "not_applicable",
    issues: [],
  });

  const relevant = fixture("detected");
  writeJson(relevant, "package.json", {
    packageManager: "npm@11.9.0",
    scripts: { dev: "node server.mjs", test: "node --test" },
  });
  const detected = await detector.detect({
    workspacePath: relevant,
    browserRelevant: true,
    appUrl: "http://127.0.0.1:4310",
  });
  assert.equal(detected.status, "detected");
  assert.deepEqual(detected.target.startCommand.argv, ["npm", "run", "dev"]);
  assert.equal(detected.target.url, "http://127.0.0.1:4310/");

  const pnpm = fixture("pnpm-detected");
  writeJson(pnpm, "package.json", { scripts: { preview: "vite preview" } });
  writeFileSync(join(pnpm, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  const pnpmDetected = await detector.detect({
    workspacePath: pnpm,
    browserRelevant: true,
    appUrl: "http://localhost:4173",
  });
  assert.deepEqual(pnpmDetected.target.startCommand.argv, ["pnpm", "run", "preview"]);

  const missingUrl = await detector.detect({ workspacePath: relevant, browserRelevant: true });
  assert.equal(missingUrl.status, "manual_configuration_required");
  assert.ok(missingUrl.issues.some((candidate) => candidate.code === "APP_URL_REQUIRED"));

  await assert.rejects(
    () =>
      detector.detect({
        workspacePath: relevant,
        browserRelevant: true,
        appUrl: "https://example.com/?token=secret",
      }),
    /credential-free loopback HTTP URLs/u,
  );
  await assert.rejects(
    () =>
      detector.detect({
        workspacePath: relevant,
        browserRelevant: true,
        appUrl: "http://127.0.0.1:4310",
        configuredStartCommand: { argv: ["sh", "-c", "node server.mjs"] },
      }),
    /no shell evaluation/u,
  );
});

test("a real Playwright fixture starts, validates, stops, and satisfies acceptance evidence", async () => {
  const workspace = fixture("passing");
  const port = await reservePort();
  const { launcherPath, pidPath, scriptPath } = createWebFixture(workspace, port);
  const detector = new BrowserValidationDetector();
  const detection = await detector.detect({
    workspacePath: workspace,
    browserRelevant: true,
    appUrl: `http://127.0.0.1:${String(port)}`,
    configuredStartCommand: {
      argv: [process.execPath, launcherPath, scriptPath, String(port), pidPath],
    },
  });
  assert.equal(detection.status, "configured");

  const database = DensaAdeDatabase.openInMemory();
  try {
    const { project, task } = seedTask(database, "passing");
    const validator = new BrowserValidationValidator(
      detection.target,
      [
        { kind: "page_load", path: "/", expectedStatus: 200 },
        { kind: "visible_text", path: "/", text: "Browser proof" },
        { kind: "visible_selector", path: "/", selector: '[data-testid="heading"]' },
      ],
      {
        artifactRoot: join(workspace, "artifacts"),
        artifactId: () => "passing",
        runTimeoutMs: 5_000,
      },
    );
    const outcome = await new ValidationPipeline(database, { now: () => createdAt }).execute({
      runId: "validation-browser-passing",
      projectId: project.id,
      taskId: task.id,
      workspacePath: workspace,
      plan: {
        id: "browser-acceptance",
        version: "1",
        validators: [
          {
            validator,
            evidenceSource: "browser_test",
            policy: "required",
            relatedAcceptanceCriteria: [task.acceptanceCriteria[0]],
          },
        ],
      },
    });

    assert.equal(outcome.passed, true);
    assert.equal(outcome.canComplete, true);
    assert.equal(outcome.acceptanceReport.criteria[0].state, "satisfied");
    assert.equal(outcome.acceptanceReport.criteria[0].evidence[0].source, "browser_test");
    assert.equal(outcome.results[0].validatorId, "browser/playwright");
    assert.equal(outcome.results[0].config.checkCount, 3);
    assertServerStopped(pidPath);
  } finally {
    database.close();
  }
});

test("a failing browser check records bounded logs, screenshot, and trace artifacts", async () => {
  const workspace = fixture("failing");
  const port = await reservePort();
  const { launcherPath, pidPath, scriptPath } = createWebFixture(workspace, port, { noisy: true });
  const target = {
    url: `http://127.0.0.1:${String(port)}/`,
    source: "user-configured",
    startCommand: {
      argv: [process.execPath, launcherPath, scriptPath, String(port), pidPath],
      cwd: ".",
    },
  };
  const validator = new BrowserValidationValidator(
    target,
    [{ kind: "visible_text", path: "/", text: "This text is absent" }],
    {
      artifactRoot: join(workspace, "artifacts"),
      artifactId: () => "failing",
      runTimeoutMs: 1_000,
    },
  );

  const result = await validator.validate({
    projectId: "project-failing",
    taskId: "task-failing",
    workspacePath: workspace,
    relatedAcceptanceCriteria: ["The expected text is visible."],
  });

  assert.equal(result.status, "failed");
  assert.equal(result.retryRelevant, true);
  assert.equal(result.config.serverLogsTruncated, true);
  assert.ok(result.diagnostics.some((candidate) => candidate.code === "BROWSER_CHECK_FAILED"));
  assert.ok(result.diagnostics.every((candidate) => !candidate.message.includes("fixture-secret")));
  assert.deepEqual(result.config.artifacts.map((artifact) => artifact.kind).sort(), [
    "screenshot",
    "trace",
  ]);
  for (const artifact of result.config.artifacts) {
    assert.equal(existsSync(artifact.path), true);
  }
  assertServerStopped(pidPath);
});

test("runner crashes and cancellation still clean up the owned dev-server process group", async () => {
  for (const scenario of ["crash", "cancel"]) {
    const workspace = fixture(scenario);
    const port = await reservePort();
    const { launcherPath, pidPath, scriptPath } = createWebFixture(workspace, port);
    const controller = new globalThis.AbortController();
    const runner =
      scenario === "crash"
        ? { run: async () => Promise.reject(new Error("fixture runner crashed")) }
        : {
            run: async ({ signal }) =>
              new Promise((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
                globalThis.setTimeout(
                  () => controller.abort(new Error("fixture cancellation")),
                  50,
                );
              }),
          };
    const validator = new BrowserValidationValidator(
      {
        url: `http://127.0.0.1:${String(port)}/`,
        source: "user-configured",
        startCommand: {
          argv: [process.execPath, launcherPath, scriptPath, String(port), pidPath],
          cwd: ".",
        },
      },
      [{ kind: "page_load", path: "/" }],
      {
        runner,
        artifactRoot: join(workspace, "artifacts"),
        artifactId: () => scenario,
        stopGraceMs: 250,
      },
    );
    const result = await validator.validate({
      projectId: `project-${scenario}`,
      taskId: `task-${scenario}`,
      workspacePath: workspace,
      relatedAcceptanceCriteria: [],
      ...(scenario === "cancel" ? { signal: controller.signal } : {}),
    });

    assert.equal(result.status, "error");
    assertServerStopped(pidPath);
  }
});
