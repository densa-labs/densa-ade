import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MAX_VALIDATION_DIAGNOSTICS_BYTES, ValidationPipeline } from "@densa-ade/core";
import { DensaAdeDatabase } from "@densa-ade/core/persistence";

const createdAt = "2026-08-27T01:00:00.000Z";

function monotonicClock() {
  let offset = 0;
  return () => {
    const timestamp = new Date(Date.parse(createdAt) + offset).toISOString();
    offset += 1_000;
    return timestamp;
  };
}

function seedTask(database, suffix = "pipeline") {
  const project = {
    id: `project-${suffix}`,
    name: "Validation pipeline",
    state: "DRAFT",
    executionMode: "guided",
    createdAt,
    updatedAt: createdAt,
  };
  const phase = {
    id: `phase-${suffix}`,
    projectId: project.id,
    title: "Validate independently",
    state: "PENDING",
    position: 0,
    createdAt,
    updatedAt: createdAt,
  };
  const task = {
    id: `task-${suffix}`,
    projectId: project.id,
    phaseId: phase.id,
    title: "Compose validators",
    state: "PENDING",
    position: 0,
    acceptanceCriteria: ["The build passes.", "Behavior is independently checked."],
    dependencyIds: [],
    createdAt,
    updatedAt: createdAt,
  };
  database.repositories.projects.create(project);
  database.repositories.phases.create(phase);
  database.repositories.tasks.create(task);
  return { project, task };
}

function fakeValidator(id, outcome, calls) {
  return {
    id,
    version: "1.0.0",
    async validate(context) {
      calls.push({ id, context });
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

test("fake validators run deterministically and advisory failure does not fail the plan", async () => {
  const database = DensaAdeDatabase.openInMemory();
  try {
    const { project, task } = seedTask(database, "ordering");
    const calls = [];
    const plan = {
      id: "task-validation",
      version: "1",
      validators: [
        {
          validator: fakeValidator(
            "command/build",
            {
              status: "passed",
              command: ["npm", "run", "build"],
              config: { cwd: "." },
              exitCode: 0,
              diagnostics: [{ severity: "info", message: "Build completed." }],
              retryRelevant: false,
            },
            calls,
          ),
          evidenceSource: "deterministic_validator",
          policy: "required",
          relatedAcceptanceCriteria: [task.acceptanceCriteria[0]],
        },
        {
          validator: fakeValidator(
            "lint",
            {
              status: "failed",
              exitCode: 1,
              diagnostics: [{ severity: "warning", message: "Advisory lint finding." }],
              retryRelevant: true,
            },
            calls,
          ),
          evidenceSource: "deterministic_validator",
          policy: "advisory",
          relatedAcceptanceCriteria: [],
        },
        {
          validator: fakeValidator(
            "structured-acceptance",
            { status: "passed", diagnostics: [], retryRelevant: false },
            calls,
          ),
          evidenceSource: "targeted_check",
          policy: "required",
          relatedAcceptanceCriteria: [task.acceptanceCriteria[1]],
        },
      ],
    };

    const result = await new ValidationPipeline(database, { now: monotonicClock() }).execute({
      runId: "validation-ordering",
      projectId: project.id,
      taskId: task.id,
      workspacePath: "/tmp/densa-validation-fixture",
      plan,
    });

    assert.equal(result.passed, true);
    assert.deepEqual(
      calls.map((call) => call.id),
      ["command/build", "lint", "structured-acceptance"],
    );
    assert.deepEqual(
      result.results.map(({ position, validatorId, policy, status }) => ({
        position,
        validatorId,
        policy,
        status,
      })),
      [
        { position: 0, validatorId: "command/build", policy: "required", status: "passed" },
        { position: 1, validatorId: "lint", policy: "advisory", status: "failed" },
        {
          position: 2,
          validatorId: "structured-acceptance",
          policy: "required",
          status: "passed",
        },
      ],
    );
    assert.deepEqual(result.results[0].command, ["npm", "run", "build"]);
    assert.deepEqual(result.results[0].config, { cwd: "." });
    assert.deepEqual(result.results[0].relatedAcceptanceCriteria, [task.acceptanceCriteria[0]]);
    assert.equal(result.run.planId, plan.id);
    assert.equal(result.run.planVersion, plan.version);
  } finally {
    database.close();
  }
});

test("a required failure or provider error fails the plan while later evidence still runs", async () => {
  const database = DensaAdeDatabase.openInMemory();
  try {
    const { project, task } = seedTask(database, "required-failure");
    const calls = [];
    const result = await new ValidationPipeline(database, { now: monotonicClock() }).execute({
      runId: "validation-required-failure",
      projectId: project.id,
      taskId: task.id,
      workspacePath: "/tmp/densa-validation-fixture",
      plan: {
        id: "failure-proof",
        version: "1",
        validators: [
          {
            validator: fakeValidator(
              "unit-test",
              { status: "failed", diagnostics: [], retryRelevant: true },
              calls,
            ),
            evidenceSource: "deterministic_validator",
            policy: "required",
            relatedAcceptanceCriteria: [task.acceptanceCriteria[0]],
          },
          {
            validator: fakeValidator("independent-review", new Error("review crashed"), calls),
            evidenceSource: "independent_review",
            policy: "required",
            relatedAcceptanceCriteria: [task.acceptanceCriteria[1]],
          },
          {
            validator: fakeValidator(
              "post-failure-check",
              { status: "passed", diagnostics: [], retryRelevant: false },
              calls,
            ),
            evidenceSource: "targeted_check",
            policy: "required",
            relatedAcceptanceCriteria: [],
          },
        ],
      },
    });

    assert.equal(result.passed, false);
    assert.deepEqual(
      calls.map((call) => call.id),
      ["unit-test", "independent-review", "post-failure-check"],
    );
    assert.equal(result.results[1].status, "error");
    assert.equal(result.results[1].diagnostics[0].code, "VALIDATOR_EXECUTION_FAILED");
    assert.equal(result.run.passed, false);
  } finally {
    database.close();
  }
});

test("diagnostics are bounded before persistence", async () => {
  const database = DensaAdeDatabase.openInMemory();
  try {
    const { project, task } = seedTask(database, "bounds");
    const calls = [];
    const result = await new ValidationPipeline(database, { now: monotonicClock() }).execute({
      runId: "validation-bounds",
      projectId: project.id,
      taskId: task.id,
      workspacePath: "/tmp/densa-validation-fixture",
      plan: {
        id: "bounded-evidence",
        version: "1",
        validators: [
          {
            validator: fakeValidator(
              "noisy-validator",
              {
                status: "failed",
                diagnostics: Array.from({ length: 32 }, (_, index) => ({
                  severity: "error",
                  code: `E${String(index)}`,
                  message: "x".repeat(4_096),
                })),
                retryRelevant: true,
              },
              calls,
            ),
            evidenceSource: "deterministic_validator",
            policy: "required",
            relatedAcceptanceCriteria: [],
          },
        ],
      },
    });

    const diagnostics = result.results[0].diagnostics;
    assert.ok(
      Buffer.byteLength(JSON.stringify(diagnostics), "utf8") <= MAX_VALIDATION_DIAGNOSTICS_BYTES,
    );
    assert.equal(diagnostics.at(-1).code, "DIAGNOSTICS_TRUNCATED");
  } finally {
    database.close();
  }
});

test("detailed validation evidence persists and replays after Core restarts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "densa-validation-replay-"));
  const path = join(directory, "runtime.sqlite");
  try {
    const first = DensaAdeDatabase.open(path);
    const { project, task } = seedTask(first, "replay");
    const calls = [];
    const completed = await new ValidationPipeline(first, { now: monotonicClock() }).execute({
      runId: "validation-replay",
      projectId: project.id,
      taskId: task.id,
      workspacePath: "/tmp/densa-validation-fixture",
      plan: {
        id: "restart-proof",
        version: "2",
        validators: [
          {
            validator: fakeValidator(
              "integration-test",
              {
                status: "passed",
                exitCode: 0,
                diagnostics: [{ severity: "info", message: "Integration checks passed." }],
                retryRelevant: false,
              },
              calls,
            ),
            evidenceSource: "deterministic_validator",
            policy: "required",
            relatedAcceptanceCriteria: [...task.acceptanceCriteria],
          },
        ],
      },
    });
    first.close();

    const reopened = DensaAdeDatabase.open(path);
    const replay = new ValidationPipeline(reopened).replay("validation-replay");
    assert.deepEqual(replay, { run: completed.run, results: completed.results });
    reopened.close();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("plans reject duplicate plugins and acceptance criteria from another task", async () => {
  const database = DensaAdeDatabase.openInMemory();
  try {
    const { project, task } = seedTask(database, "invalid-plan");
    const calls = [];
    const duplicate = fakeValidator(
      "duplicate",
      { status: "passed", diagnostics: [], retryRelevant: false },
      calls,
    );
    await assert.rejects(
      () =>
        new ValidationPipeline(database).execute({
          runId: "validation-invalid-plan",
          projectId: project.id,
          taskId: task.id,
          workspacePath: "/tmp/densa-validation-fixture",
          plan: {
            id: "invalid",
            version: "1",
            validators: [
              {
                validator: duplicate,
                evidenceSource: "deterministic_validator",
                policy: "required",
                relatedAcceptanceCriteria: [],
              },
              {
                validator: duplicate,
                evidenceSource: "targeted_check",
                policy: "advisory",
                relatedAcceptanceCriteria: ["A criterion this task never promised."],
              },
            ],
          },
        }),
      /unique versioned validators and task-owned acceptance criteria/u,
    );
    assert.equal(
      database.repositories.validationRuns.findById("validation-invalid-plan"),
      undefined,
    );
  } finally {
    database.close();
  }
});
