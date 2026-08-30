import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ProjectValidationDetector } from "@densa-ade/core";

const workspaces = [];

function fixture(name) {
  const workspace = mkdtempSync(join(tmpdir(), `densa-validation-detection-${name}-`));
  workspaces.push(workspace);
  return workspace;
}

function writeJson(workspace, path, value) {
  writeFileSync(join(workspace, path), `${JSON.stringify(value, null, 2)}\n`);
}

test.after(() => {
  for (const workspace of workspaces) rmSync(workspace, { force: true, recursive: true });
});

test("Node and TypeScript fixtures produce deterministic structured validation plans", async () => {
  const workspace = fixture("node-typescript");
  writeJson(workspace, "package.json", {
    packageManager: "npm@11.9.0",
    scripts: {
      test: "node --test",
      lint: "eslint .",
      typecheck: "tsc --noEmit",
      build: "tsc -b",
    },
  });
  writeJson(workspace, "tsconfig.json", { compilerOptions: { strict: true } });

  const result = await new ProjectValidationDetector().detect({ workspacePath: workspace });

  assert.equal(result.status, "detected");
  assert.equal(result.ecosystem, "node-typescript");
  assert.deepEqual(
    result.commands.map(({ id, category, argv, cwd, source }) => ({
      id,
      category,
      argv,
      cwd,
      source,
    })),
    [
      {
        id: "node-script:build",
        category: "build",
        argv: ["npm", "run", "build"],
        cwd: ".",
        source: "detected",
      },
      {
        id: "node-script:typecheck",
        category: "typecheck",
        argv: ["npm", "run", "typecheck"],
        cwd: ".",
        source: "detected",
      },
      {
        id: "node-script:lint",
        category: "lint",
        argv: ["npm", "run", "lint"],
        cwd: ".",
        source: "detected",
      },
      {
        id: "node-script:test",
        category: "test",
        argv: ["npm", "run", "test"],
        cwd: ".",
        source: "detected",
      },
    ],
  );
  assert.equal(result.auditFacts.length, 0);
  assert.ok(Object.isFrozen(result.commands));
  assert.ok(Object.isFrozen(result.commands[0].argv));
});

test("lockfiles choose a supported package manager and fallback test scripts stay ordered", async () => {
  const workspace = fixture("pnpm");
  writeJson(workspace, "package.json", {
    scripts: { "test:integration": "vitest", "test:unit": "vitest", lint: "eslint ." },
  });
  writeFileSync(join(workspace, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

  const result = await new ProjectValidationDetector().detect({ workspacePath: workspace });

  assert.deepEqual(
    result.commands.map((command) => command.argv),
    [
      ["pnpm", "run", "lint"],
      ["pnpm", "run", "test:unit"],
      ["pnpm", "run", "test:integration"],
    ],
  );
});

test("a TypeScript-only project uses only a verified workspace-local compiler", async () => {
  const workspace = fixture("typescript-local");
  writeJson(workspace, "tsconfig.json", { compilerOptions: { strict: true } });
  mkdirSync(join(workspace, "node_modules/.bin"), { recursive: true });
  writeFileSync(join(workspace, "node_modules/.bin/tsc"), "fixture compiler");

  const result = await new ProjectValidationDetector().detect({ workspacePath: workspace });

  assert.equal(result.ecosystem, "typescript");
  assert.deepEqual(result.commands[0].argv, [
    "./node_modules/.bin/tsc",
    "--project",
    "tsconfig.json",
    "--noEmit",
  ]);
});

test("malicious metadata cannot add an executable or shell argument to a detected plan", async () => {
  const workspace = fixture("malicious");
  writeJson(workspace, "package.json", {
    packageManager: "npm; touch /tmp/densa-injected@1.0.0",
    scripts: {
      "lint; touch /tmp/densa-injected": "eslint .",
      "test && touch /tmp/densa-injected": "node --test",
    },
  });

  const result = await new ProjectValidationDetector().detect({ workspacePath: workspace });

  assert.equal(result.status, "manual_configuration_required");
  assert.deepEqual(result.commands, []);
  assert.ok(result.issues.some((issue) => issue.code === "UNSUPPORTED_PACKAGE_MANAGER"));
  assert.equal(result.commands.flatMap((command) => command.argv).includes("touch"), false);
});

test("unknown, malformed, ambiguous, and symlinked metadata fail closed", async () => {
  const unknown = fixture("unknown");
  const unknownResult = await new ProjectValidationDetector().detect({ workspacePath: unknown });
  assert.deepEqual(
    {
      status: unknownResult.status,
      ecosystem: unknownResult.ecosystem,
      commands: unknownResult.commands,
    },
    { status: "unknown", ecosystem: "unknown", commands: [] },
  );

  const malformed = fixture("malformed");
  writeFileSync(join(malformed, "package.json"), "{not json");
  const malformedResult = await new ProjectValidationDetector().detect({
    workspacePath: malformed,
  });
  assert.equal(malformedResult.status, "manual_configuration_required");
  assert.ok(malformedResult.issues.some((issue) => issue.code === "INVALID_PACKAGE_JSON"));

  const ambiguous = fixture("ambiguous");
  writeJson(ambiguous, "package.json", { scripts: { test: "node --test" } });
  writeFileSync(join(ambiguous, "package-lock.json"), "{}\n");
  writeFileSync(join(ambiguous, "yarn.lock"), "# fixture\n");
  const ambiguousResult = await new ProjectValidationDetector().detect({
    workspacePath: ambiguous,
  });
  assert.equal(ambiguousResult.status, "manual_configuration_required");
  assert.deepEqual(ambiguousResult.commands, []);
  assert.ok(ambiguousResult.issues.some((issue) => issue.code === "AMBIGUOUS_PACKAGE_MANAGER"));

  const symlinked = fixture("symlinked");
  const external = fixture("external-manifest");
  writeJson(external, "package.json", { scripts: { test: "node --test" } });
  symlinkSync(join(external, "package.json"), join(symlinked, "package.json"));
  const symlinkedResult = await new ProjectValidationDetector().detect({
    workspacePath: symlinked,
  });
  assert.equal(symlinkedResult.status, "manual_configuration_required");
  assert.deepEqual(symlinkedResult.commands, []);
  assert.ok(symlinkedResult.issues.some((issue) => issue.code === "UNSAFE_PROJECT_METADATA"));

  const unsafeLockfile = fixture("unsafe-lockfile");
  writeJson(unsafeLockfile, "package.json", { scripts: { test: "node --test" } });
  const externalLockfile = join(fixture("external-lockfile"), "pnpm-lock.yaml");
  writeFileSync(externalLockfile, "lockfileVersion: '9.0'\n");
  symlinkSync(externalLockfile, join(unsafeLockfile, "pnpm-lock.yaml"));
  const unsafeLockfileResult = await new ProjectValidationDetector().detect({
    workspacePath: unsafeLockfile,
  });
  assert.equal(unsafeLockfileResult.status, "manual_configuration_required");
  assert.deepEqual(unsafeLockfileResult.commands, []);

  const unsafeTypescript = fixture("unsafe-typescript");
  symlinkSync(join(external, "package.json"), join(unsafeTypescript, "tsconfig.json"));
  const unsafeTypescriptResult = await new ProjectValidationDetector().detect({
    workspacePath: unsafeTypescript,
  });
  assert.equal(unsafeTypescriptResult.status, "manual_configuration_required");
});

test("user-configured argv replaces guesses and emits a versioned audit fact", async () => {
  const workspace = fixture("override");
  writeJson(workspace, "package.json", { scripts: { build: "tsc -b", test: "node --test" } });
  const recorded = [];
  const detector = new ProjectValidationDetector({
    now: () => "2026-08-27T08:00:00.000Z",
    auditSink: { record: (fact) => recorded.push(fact) },
  });

  const result = await detector.detect({
    workspacePath: workspace,
    userConfiguredCommands: [
      {
        id: "project-check",
        category: "custom",
        argv: ["node", "scripts/check.mjs", "value; still-one-argument"],
        policy: "required",
      },
    ],
    overrideAudit: { actor: "user:local", reason: "Project has one authoritative check command." },
  });

  assert.deepEqual(
    result.commands.map((command) => command.argv),
    [["node", "scripts/check.mjs", "value; still-one-argument"]],
  );
  assert.equal(result.commands[0].source, "user-configured");
  assert.deepEqual(result.auditFacts[0], {
    type: "VALIDATION_COMMANDS_OVERRIDDEN",
    eventVersion: 1,
    occurredAt: "2026-08-27T08:00:00.000Z",
    actor: "user:local",
    reason: "Project has one authoritative check command.",
    replacedCommandIds: ["node-script:build", "node-script:test"],
    configuredCommands: [
      {
        id: "project-check",
        category: "custom",
        policy: "required",
        cwd: ".",
        argumentCount: 3,
        argvSha256: "116988bc182ee25bcbd0f49722cc1ccd98f8e60fe620b08590318eccaeb65a84",
      },
    ],
  });
  assert.deepEqual(recorded, result.auditFacts);
});

test("overrides require audit context and reject shell evaluation or workspace escape", async () => {
  const workspace = fixture("invalid-overrides");
  const detector = new ProjectValidationDetector({ auditSink: { record: () => undefined } });
  await assert.rejects(
    () =>
      detector.detect({
        workspacePath: workspace,
        userConfiguredCommands: [
          { id: "unsafe", category: "custom", argv: ["sh", "-c", "echo x"] },
        ],
        overrideAudit: { actor: "user:local", reason: "fixture" },
      }),
    /no shell evaluation/u,
  );
  await assert.rejects(
    () =>
      detector.detect({
        workspacePath: workspace,
        userConfiguredCommands: [
          { id: "escape", category: "custom", argv: ["node", "check.mjs"], cwd: "../outside" },
        ],
        overrideAudit: { actor: "user:local", reason: "fixture" },
      }),
    /cannot escape the workspace/u,
  );
  await assert.rejects(
    () =>
      detector.detect({
        workspacePath: workspace,
        userConfiguredCommands: [
          { id: "not-audited", category: "custom", argv: ["node", "check.mjs"] },
        ],
      }),
    /require an audit actor and reason/u,
  );
  await assert.rejects(
    () =>
      new ProjectValidationDetector().detect({
        workspacePath: workspace,
        userConfiguredCommands: [
          { id: "not-persisted", category: "custom", argv: ["node", "check.mjs"] },
        ],
        overrideAudit: { actor: "user:local", reason: "fixture" },
      }),
    /require a durable audit sink/u,
  );
  await assert.rejects(
    () =>
      new ProjectValidationDetector({
        auditSink: {
          record: () => {
            throw new Error("audit persistence failed");
          },
        },
      }).detect({
        workspacePath: workspace,
        userConfiguredCommands: [
          { id: "not-recorded", category: "custom", argv: ["node", "check.mjs"] },
        ],
        overrideAudit: { actor: "user:local", reason: "fixture" },
      }),
    /audit persistence failed/u,
  );
  await assert.rejects(
    () =>
      detector.detect({
        workspacePath: workspace,
        userConfiguredCommands: [
          { id: "invalid-category", category: "deploy", argv: ["node", "check.mjs"] },
        ],
        overrideAudit: { actor: "user:local", reason: "fixture" },
      }),
    /unique IDs, bounded argv/u,
  );
});
