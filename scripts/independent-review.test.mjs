import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  FreshContextPhaseValidator,
  FreshContextTaskLifecycleValidator,
  IndependentReviewService,
  IndependentReviewValidator,
  ValidationPipeline,
  requiresIndependentReview,
  withDefaultIndependentReview,
} from "@densa-ade/core";
import { DensaAdeDatabase } from "@densa-ade/core/persistence";
import { FakeAgentAdapter } from "@densa-ade/testing";

const createdAt = "2026-08-28T01:00:00.000Z";

function git(repository, args) {
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdio: "pipe",
  });
}

function gitWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "densa-independent-review-fingerprint-"));
  git(root, ["init", "--quiet", "--initial-branch=main"]);
  writeFileSync(join(root, ".gitignore"), "ignored.txt\n", "utf8");
  writeFileSync(join(root, "tracked.txt"), "baseline\n", "utf8");
  writeFileSync(join(root, "ignored.txt"), "ignored-a\n", "utf8");
  git(root, ["add", ".gitignore", "tracked.txt"]);
  git(root, [
    "-c",
    "user.name=Densa ADE Fixture",
    "-c",
    "user.email=densa-fixture@localhost",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  return root;
}

function clock() {
  let offset = 0;
  return () => new Date(Date.parse(createdAt) + offset++ * 1_000).toISOString();
}

function reviewService(database) {
  return new IndependentReviewService(database, {
    now: clock(),
    workspaceFingerprint: async () => "unchanged",
  });
}

function seed(database, suffix) {
  const project = {
    id: `project-${suffix}`,
    name: "Independent review proof",
    state: "DRAFT",
    executionMode: "continuous",
    createdAt,
    updatedAt: createdAt,
  };
  const phase = {
    id: `phase-${suffix}`,
    projectId: project.id,
    title: "Review a phase",
    state: "PENDING",
    position: 0,
    createdAt,
    updatedAt: createdAt,
  };
  const task = {
    id: `task-${suffix}`,
    projectId: project.id,
    phaseId: phase.id,
    title: "Review a risky change",
    state: "PENDING",
    position: 0,
    acceptanceCriteria: ["The implementation preserves the architecture boundary."],
    dependencyIds: [],
    createdAt,
    updatedAt: createdAt,
  };
  database.repositories.projects.create(project);
  database.repositories.phases.create(phase);
  database.repositories.tasks.create(task);
  const validationRunId = `fixture-validation-${suffix}`;
  database.repositories.validationRuns.create({
    id: validationRunId,
    taskId: task.id,
    validatorId: "independent-review-fixture",
    startedAt: createdAt,
  });
  const phaseValidationEventId = `phase-validation-${suffix}`;
  database.repositories.events.append({
    id: phaseValidationEventId,
    projectId: project.id,
    phaseId: phase.id,
    type: "PHASE_VALIDATION_STARTED",
    eventVersion: 1,
    occurredAt: createdAt,
    actor: "independent-review:test",
    payload: { validatorId: "independent-review-fixture" },
  });
  return { project, phase, task, validationRunId, phaseValidationEventId };
}

function output(verdict) {
  const severity = verdict === "fail" ? "error" : verdict === "advisory" ? "warning" : "info";
  return {
    verdict,
    summary:
      verdict === "pass"
        ? "The change satisfies the supplied evidence."
        : verdict === "advisory"
          ? "The change passes with a bounded follow-up."
          : "The change violates an architecture constraint.",
    findings: [
      {
        severity,
        title: `${verdict} finding`,
        detail: "Finding derived from the supplied diff and deterministic evidence.",
        criterionPosition: 0,
      },
    ],
    criteria: [
      {
        criterionPosition: 0,
        assessment: verdict === "fail" ? "failed" : "satisfied",
        rationale: "The evidence was mapped directly to this criterion.",
      },
    ],
    confidence: verdict === "pass" ? 0.9 : 0.75,
    unknowns: verdict === "advisory" ? ["A non-blocking edge case remains."] : [],
  };
}

function request({ project, task, validationRunId }, adapter, verdict) {
  return {
    id: `review-${verdict}`,
    reviewerRunId: `reviewer-run-${verdict}`,
    projectId: project.id,
    taskId: task.id,
    validationRunId,
    workspacePath: "/tmp/densa-independent-review",
    goal: "Preserve Densa ADE Core as the authoritative state owner.",
    acceptanceCriteria: task.acceptanceCriteria,
    relevantDiff: "diff --git a/core.ts b/core.ts\n+export const authoritative = true;",
    deterministicResults: [
      {
        validatorId: "typecheck",
        status: "passed",
        required: true,
        summary: "Typecheck passed.",
      },
    ],
    architectureConstraints: ["Renderer state must not become authoritative."],
    adapter,
    implementingWorkerRunId: "worker-run-1",
  };
}

for (const verdict of ["pass", "advisory", "fail"]) {
  test(`fresh-context reviewer persists a structured ${verdict} outcome`, async () => {
    const database = DensaAdeDatabase.openInMemory();
    try {
      const fixture = seed(database, verdict);
      const adapter = new FakeAgentAdapter({ finalMessage: JSON.stringify(output(verdict)) });
      const review = await reviewService(database).execute(request(fixture, adapter, verdict));

      assert.equal(review.output.verdict, verdict);
      assert.equal(review.reviewerRunId, `reviewer-run-${verdict}`);
      assert.equal(review.validationRunId, fixture.validationRunId);
      assert.equal(review.contextHash.length, 64);
      assert.deepEqual(database.repositories.independentReviews.findById(review.id), review);
      assert.equal(adapter.requests.length, 1);
      assert.equal(adapter.requests[0].runId, `reviewer-run-${verdict}`);
      assert.equal(adapter.requests[0].accessMode, "read-only");
      assert.equal(adapter.requests[0].outputSchema.properties.verdict.type, "string");
      assert.deepEqual(adapter.requests[0].outputSchema.properties.findings.items.required, [
        "severity",
        "title",
        "detail",
        "criterionPosition",
      ]);
      assert.match(
        adapter.requests[0].prompt,
        /Do not defend or continue the implementing worker/u,
      );
    } finally {
      database.close();
    }
  });
}

test("a passing reviewer cannot override a required deterministic failure", async () => {
  const database = DensaAdeDatabase.openInMemory();
  try {
    const fixture = seed(database, "no-override");
    const service = reviewService(database);
    const adapter = new FakeAgentAdapter({ finalMessage: JSON.stringify(output("pass")) });
    const reviewer = new IndependentReviewValidator({
      service,
      createReviewIdentity: () => ({
        id: "review-no-override",
        reviewerRunId: "reviewer-run-no-override",
      }),
      goal: "Keep Core authoritative.",
      relevantDiff: "+ unsafe renderer mutation",
      architectureConstraints: ["Core is authoritative."],
      adapter,
      implementingWorkerRunId: "worker-run-no-override",
    });
    const result = await new ValidationPipeline(database, { now: clock() }).execute({
      runId: "validation-no-override",
      projectId: fixture.project.id,
      taskId: fixture.task.id,
      workspacePath: "/tmp/densa-independent-review",
      plan: {
        id: "required-review-plan",
        version: "1",
        validators: [
          {
            validator: {
              id: "unit-test",
              version: "1",
              async validate() {
                return { status: "failed", diagnostics: [], retryRelevant: true };
              },
            },
            evidenceSource: "deterministic_validator",
            policy: "required",
            relatedAcceptanceCriteria: fixture.task.acceptanceCriteria,
          },
          {
            validator: reviewer,
            evidenceSource: "independent_review",
            policy: "required",
            relatedAcceptanceCriteria: fixture.task.acceptanceCriteria,
          },
        ],
      },
    });

    assert.equal(result.results[1].status, "passed");
    assert.equal(result.passed, false);
    assert.equal(result.canComplete, false);
    assert.match(adapter.requests[0].prompt, /unit-test@1/u);
    assert.match(adapter.requests[0].prompt, /"status":"failed"/u);
  } finally {
    database.close();
  }
});

test("malformed reviewer terminal streams persist fail-closed evidence", async () => {
  const database = DensaAdeDatabase.openInMemory();
  try {
    const fixture = seed(database, "malformed-stream");
    const scripts = [
      async function* (runId) {
        yield {
          type: "run.terminal",
          runId: `${runId}-wrong`,
          occurredAt: createdAt,
          outcome: "succeeded",
          finalMessage: JSON.stringify(output("pass")),
        };
      },
      async function* (runId) {
        for (let index = 0; index < 2; index += 1) {
          yield {
            type: "run.terminal",
            runId,
            occurredAt: createdAt,
            outcome: "succeeded",
            finalMessage: JSON.stringify(output("pass")),
          };
        }
      },
      async function* (runId) {
        yield {
          type: "run.terminal",
          runId,
          occurredAt: createdAt,
          outcome: "succeeded",
          finalMessage: JSON.stringify(output("pass")),
        };
        throw new Error("stream failed after terminal");
      },
    ];
    for (const [index, script] of scripts.entries()) {
      const adapter = {
        adapterId: `malformed-${String(index)}`,
        detect: async () => ({
          status: "available",
          adapterId: "fake",
          command: "fake",
          version: "1",
        }),
        getStatus: async () => ({ status: "available", version: "1" }),
        execute({ runId }) {
          return script(runId);
        },
        cancel: async () => undefined,
        getUsageState: async () => ({ status: "available" }),
      };
      const review = await reviewService(database).execute({
        ...request(fixture, adapter, `malformed-${String(index)}`),
        id: `review-malformed-${String(index)}`,
        reviewerRunId: `reviewer-run-malformed-${String(index)}`,
      });
      assert.equal(review.output.verdict, "fail");
    }
  } finally {
    database.close();
  }
});

test("workspace mutation invalidates an otherwise passing review", async () => {
  const database = DensaAdeDatabase.openInMemory();
  try {
    const fixture = seed(database, "workspace-mutation");
    let fingerprintCall = 0;
    const service = new IndependentReviewService(database, {
      now: clock(),
      workspaceFingerprint: async () => `fingerprint-${String(fingerprintCall++)}`,
    });
    const review = await service.execute(
      request(
        fixture,
        new FakeAgentAdapter({ finalMessage: JSON.stringify(output("pass")) }),
        "workspace-mutation",
      ),
    );
    assert.equal(review.output.verdict, "fail");
    assert.match(review.output.findings[0].detail, /changed the validated workspace/u);
  } finally {
    database.close();
  }
});

for (const [name, prepare, mutate] of [
  [
    "HEAD",
    () => undefined,
    (workspace) => {
      writeFileSync(join(workspace, "tracked.txt"), "committed\n", "utf8");
      git(workspace, ["add", "tracked.txt"]);
      git(workspace, [
        "-c",
        "user.name=Densa ADE Fixture",
        "-c",
        "user.email=densa-fixture@localhost",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        "unauthorized reviewer commit",
      ]);
    },
  ],
  [
    "index",
    (workspace) => writeFileSync(join(workspace, "tracked.txt"), "staged later\n", "utf8"),
    (workspace) => git(workspace, ["add", "tracked.txt"]),
  ],
  [
    "ignored files",
    () => undefined,
    (workspace) => writeFileSync(join(workspace, "ignored.txt"), "ignored-b\n", "utf8"),
  ],
]) {
  test(`real workspace fingerprint rejects reviewer mutation of ${name}`, async () => {
    const database = DensaAdeDatabase.openInMemory();
    const workspace = gitWorkspace();
    try {
      const fixture = seed(database, `fingerprint-${name.replaceAll(" ", "-")}`);
      prepare(workspace);
      const adapter = new FakeAgentAdapter({
        finalMessage: JSON.stringify(output("pass")),
        onExecute() {
          mutate(workspace);
        },
      });
      const review = await new IndependentReviewService(database, { now: clock() }).execute({
        ...request(fixture, adapter, `fingerprint-${name}`),
        id: `review-fingerprint-${name.replaceAll(" ", "-")}`,
        reviewerRunId: `reviewer-run-fingerprint-${name.replaceAll(" ", "-")}`,
        workspacePath: workspace,
      });

      assert.equal(review.output.verdict, "fail");
      assert.match(review.output.findings[0].detail, /changed the validated workspace/u);
    } finally {
      database.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
}

test("Core redacts reviewer output before authoritative persistence", async () => {
  const database = DensaAdeDatabase.openInMemory();
  try {
    const fixture = seed(database, "redacted-output");
    const secret = "sk-proj-reviewerSecret123456789";
    const unsafe = {
      ...output("advisory"),
      summary: `Observed ${secret}.`,
      findings: [
        {
          severity: "warning",
          title: `Credential ${secret}`,
          detail: `Do not persist ${secret}.`,
          criterionPosition: 0,
        },
      ],
      criteria: [
        {
          criterionPosition: 0,
          assessment: "satisfied",
          rationale: `Evidence did not require ${secret}.`,
        },
      ],
      unknowns: [`Whether ${secret} is still active.`],
    };
    const review = await reviewService(database).execute(
      request(
        fixture,
        new FakeAgentAdapter({ finalMessage: JSON.stringify(unsafe) }),
        "redacted-output",
      ),
    );
    const serialized = JSON.stringify(review);

    assert.doesNotMatch(serialized, /sk-proj-reviewerSecret/u);
    assert.match(serialized, /REDACTED/u);
  } finally {
    database.close();
  }
});

test("an adapter that ignores cancellation cannot return an accepted review", async () => {
  const database = DensaAdeDatabase.openInMemory();
  try {
    const fixture = seed(database, "ignored-cancellation");
    const controller = new globalThis.AbortController();
    const adapter = {
      adapterId: "ignores-cancellation",
      detect: async () => ({
        status: "available",
        adapterId: "fake",
        command: "fake",
        version: "1",
      }),
      getStatus: async () => ({ status: "available", version: "1" }),
      async *execute({ runId }) {
        controller.abort();
        yield {
          type: "run.terminal",
          runId,
          occurredAt: createdAt,
          outcome: "succeeded",
          finalMessage: JSON.stringify(output("pass")),
        };
      },
      cancel: async () => undefined,
      getUsageState: async () => ({ status: "available" }),
    };
    const review = await reviewService(database).execute({
      ...request(fixture, adapter, "ignored-cancellation"),
      signal: controller.signal,
    });

    assert.equal(review.output.verdict, "fail");
    assert.match(review.output.findings[0].detail, /cancelled/u);
  } finally {
    database.close();
  }
});

test("cancellation cannot strand Core when a reviewer stream never settles", async () => {
  const database = DensaAdeDatabase.openInMemory();
  try {
    const fixture = seed(database, "stranded-cancellation");
    const controller = new globalThis.AbortController();
    const adapter = {
      adapterId: "stranded-reviewer",
      detect: async () => ({
        status: "available",
        adapterId: "stranded-reviewer",
        command: "fake",
        version: "1",
      }),
      getStatus: async () => ({ status: "available", version: "1" }),
      execute() {
        return {
          [Symbol.asyncIterator]() {
            return {
              next() {
                controller.abort("fixture cancellation");
                return new Promise(() => undefined);
              },
            };
          },
        };
      },
      cancel: async () => undefined,
      getUsageState: async () => ({ status: "available" }),
    };
    const review = await reviewService(database).execute({
      ...request(fixture, adapter, "stranded-cancellation"),
      signal: controller.signal,
    });

    assert.equal(review.output.verdict, "fail");
    assert.match(review.output.findings[0].detail, /cancel/u);
  } finally {
    database.close();
  }
});

test("review requests reject missing diff, deterministic evidence, or architecture constraints", async () => {
  const database = DensaAdeDatabase.openInMemory();
  try {
    const fixture = seed(database, "complete-inputs");
    const adapter = new FakeAgentAdapter({ finalMessage: JSON.stringify(output("pass")) });
    for (const override of [
      { relevantDiff: "" },
      { deterministicResults: [] },
      { architectureConstraints: [] },
    ]) {
      await assert.rejects(() =>
        reviewService(database).execute({
          ...request(fixture, adapter, "complete-inputs"),
          ...override,
        }),
      );
    }
    assert.equal(database.repositories.independentReviews.listByTaskId(fixture.task.id).length, 0);
  } finally {
    database.close();
  }
});

test("criterion positions support duplicate and oversized criterion text", async () => {
  const database = DensaAdeDatabase.openInMemory();
  try {
    const fixture = seed(database, "criterion-position");
    const duplicate = "The same phase criterion.";
    const duplicateOutput = {
      verdict: "pass",
      summary: "Both positional criteria pass.",
      findings: [],
      criteria: [0, 1].map((criterionPosition) => ({
        criterionPosition,
        assessment: "satisfied",
        rationale: "Mapped by stable position.",
      })),
      confidence: 0.9,
      unknowns: [],
    };
    const phaseRequest = {
      ...request(
        fixture,
        new FakeAgentAdapter({ finalMessage: JSON.stringify(duplicateOutput) }),
        "duplicate-criteria",
      ),
      id: "review-duplicate-criteria",
      reviewerRunId: "reviewer-run-duplicate-criteria",
      taskId: undefined,
      phaseId: fixture.phase.id,
      validationRunId: undefined,
      validationEventId: fixture.phaseValidationEventId,
      acceptanceCriteria: [duplicate, duplicate],
    };
    const duplicateReview = await reviewService(database).execute(phaseRequest);
    assert.equal(duplicateReview.output.verdict, "pass");

    const longReview = await reviewService(database).execute({
      ...phaseRequest,
      id: "review-long-criterion",
      reviewerRunId: "reviewer-run-long-criterion",
      acceptanceCriteria: ["x".repeat(8_192)],
      adapter: new FakeAgentAdapter({ finalMessage: "{}" }),
    });
    assert.equal(longReview.output.verdict, "fail");
    assert.equal(longReview.output.criteria[0].criterionPosition, 0);
  } finally {
    database.close();
  }
});

test("review cancellation terminates the fresh adapter run and persists fail-closed evidence", async () => {
  const database = DensaAdeDatabase.openInMemory();
  try {
    const fixture = seed(database, "cancelled");
    const controller = new globalThis.AbortController();
    const adapter = new FakeAgentAdapter({
      holdOpen: true,
      onExecute() {
        controller.abort();
      },
    });
    const review = await reviewService(database).execute({
      ...request(fixture, adapter, "cancelled"),
      id: "review-cancelled",
      reviewerRunId: "reviewer-run-cancelled",
      signal: controller.signal,
    });

    assert.deepEqual(adapter.cancelledRunIds, ["reviewer-run-cancelled"]);
    assert.equal(review.output.verdict, "fail");
    assert.match(review.output.summary, /not confirmed/u);
  } finally {
    database.close();
  }
});

test("fresh review identity and project ownership fail closed", async () => {
  const database = DensaAdeDatabase.openInMemory();
  try {
    const first = seed(database, "ownership-a");
    const second = seed(database, "ownership-b");
    const adapter = new FakeAgentAdapter({ finalMessage: JSON.stringify(output("pass")) });
    await assert.rejects(() =>
      reviewService(database).execute({
        ...request(first, adapter, "same-run"),
        id: "review-same-run",
        reviewerRunId: "worker-run-1",
      }),
    );
    assert.throws(() =>
      database.repositories.independentReviews.create({
        id: "review-cross-project",
        projectId: first.project.id,
        taskId: second.task.id,
        validationRunId: second.validationRunId,
        adapterId: "fake",
        reviewerRunId: "reviewer-run-cross-project",
        contextHash: "b".repeat(64),
        requestedAt: createdAt,
      }),
    );
  } finally {
    database.close();
  }
});

test("review chronology compares ISO offsets by instant in protocol and SQLite", () => {
  const database = DensaAdeDatabase.openInMemory();
  try {
    const fixture = seed(database, "timestamp-offset");
    database.repositories.independentReviews.create({
      id: "review-timestamp-offset",
      projectId: fixture.project.id,
      taskId: fixture.task.id,
      validationRunId: fixture.validationRunId,
      adapterId: "fake",
      reviewerRunId: "reviewer-run-timestamp-offset",
      contextHash: "e".repeat(64),
      requestedAt: "2026-08-28T10:00:00+08:00",
    });
    const completed = database.repositories.independentReviews.complete(
      "review-timestamp-offset",
      "2026-08-28T03:00:00Z",
      output("pass"),
    );
    assert.equal(completed.completedAt, "2026-08-28T03:00:00Z");

    const reversedValidationRunId = "validation-timestamp-reversed";
    database.repositories.validationRuns.create({
      id: reversedValidationRunId,
      taskId: fixture.task.id,
      validatorId: "timestamp-test",
      startedAt: createdAt,
    });
    database.repositories.independentReviews.create({
      id: "review-timestamp-reversed",
      projectId: fixture.project.id,
      taskId: fixture.task.id,
      validationRunId: reversedValidationRunId,
      adapterId: "fake",
      reviewerRunId: "reviewer-run-timestamp-reversed",
      contextHash: "f".repeat(64),
      requestedAt: "2026-08-28T03:00:00Z",
    });
    assert.throws(() =>
      database.repositories.independentReviews.complete(
        "review-timestamp-reversed",
        "2026-08-28T10:00:00+08:00",
        output("pass"),
      ),
    );
  } finally {
    database.close();
  }
});

test("default policy requires review for high-risk and phase-final validation", () => {
  const basePlan = {
    id: "base",
    version: "1",
    validators: [
      {
        validator: { id: "build", version: "1", validate: async () => output("pass") },
        evidenceSource: "deterministic_validator",
        policy: "required",
        relatedAcceptanceCriteria: [],
      },
    ],
  };
  const reviewer = { id: "review", version: "1", validate: async () => output("pass") };
  assert.equal(requiresIndependentReview({ riskLevel: "medium" }), false);
  assert.equal(requiresIndependentReview({ riskLevel: "high" }), true);
  assert.equal(requiresIndependentReview({ riskLevel: "low", phaseFinal: true }), true);
  assert.throws(() =>
    withDefaultIndependentReview({
      plan: basePlan,
      riskLevel: "critical",
      relatedAcceptanceCriteria: [],
    }),
  );
  const composed = withDefaultIndependentReview({
    plan: basePlan,
    riskLevel: "low",
    phaseFinal: true,
    reviewer,
    relatedAcceptanceCriteria: [],
  });
  assert.equal(composed.validators.length, 2);
  assert.equal(composed.validators[1].evidenceSource, "independent_review");
  assert.equal(composed.validators[1].policy, "required");

  const existingAdvisory = {
    ...basePlan,
    validators: [
      {
        validator: reviewer,
        evidenceSource: "independent_review",
        policy: "advisory",
        relatedAcceptanceCriteria: ["criterion-a"],
      },
      ...basePlan.validators,
    ],
  };
  const upgraded = withDefaultIndependentReview({
    plan: existingAdvisory,
    riskLevel: "high",
    relatedAcceptanceCriteria: ["criterion-a", "criterion-b"],
  });
  assert.equal(upgraded.validators.length, 2);
  assert.equal(upgraded.validators[1].policy, "required");
  assert.deepEqual(upgraded.validators[1].relatedAcceptanceCriteria, [
    "criterion-a",
    "criterion-b",
  ]);
});

for (const [name, reviewOutput] of [
  [
    "unknown criterion",
    {
      ...output("pass"),
      criteria: [
        {
          criterionPosition: 0,
          assessment: "unknown",
          rationale: "Evidence is incomplete.",
        },
      ],
      unknowns: ["The criterion is unresolved."],
    },
  ],
  [
    "failed advisory criterion",
    {
      ...output("advisory"),
      criteria: [
        {
          criterionPosition: 0,
          assessment: "failed",
          rationale: "The criterion is not satisfied.",
        },
      ],
    },
  ],
]) {
  test(`review validation fails closed for a ${name}`, async () => {
    const database = DensaAdeDatabase.openInMemory();
    try {
      const fixture = seed(database, name.replaceAll(" ", "-"));
      const validator = new IndependentReviewValidator({
        service: reviewService(database),
        createReviewIdentity: () => ({
          id: `review-${name.replaceAll(" ", "-")}`,
          reviewerRunId: `reviewer-run-${name.replaceAll(" ", "-")}`,
        }),
        goal: "Keep Core authoritative.",
        relevantDiff: "+ change",
        architectureConstraints: ["Core is authoritative."],
        adapter: new FakeAgentAdapter({ finalMessage: JSON.stringify(reviewOutput) }),
      });
      const outcome = await validator.validate({
        projectId: fixture.project.id,
        taskId: fixture.task.id,
        validationRunId: fixture.validationRunId,
        workspacePath: "/tmp/densa-independent-review",
        relatedAcceptanceCriteria: fixture.task.acceptanceCriteria,
        priorResults: [
          {
            validatorId: "unit-test",
            validatorVersion: "1",
            status: "passed",
            policy: "required",
            diagnostics: [],
          },
        ],
      });

      assert.equal(outcome.status, "failed");
      assert.equal(outcome.retryRelevant, true);
    } finally {
      database.close();
    }
  });
}

test("phase-final wrapper keeps deterministic failure authoritative and stores phase review", async () => {
  const database = DensaAdeDatabase.openInMemory();
  try {
    const fixture = seed(database, "phase-final");
    const validator = new FreshContextPhaseValidator({
      deterministic: {
        validatorId: "phase-suite",
        async validate() {
          return {
            passed: false,
            summary: "Phase suite failed.",
            checks: [{ validatorId: "integration", passed: false, summary: "Integration failed." }],
          };
        },
      },
      service: reviewService(database),
      adapter: new FakeAgentAdapter({ finalMessage: JSON.stringify(output("pass")) }),
      createReviewIdentity: () => ({
        id: "review-phase-final",
        reviewerRunId: "reviewer-run-phase-final",
      }),
      buildReviewInput: () => ({
        goal: "Finish the phase safely.",
        acceptanceCriteria: fixture.task.acceptanceCriteria,
        relevantDiff: "+ phase change",
        architectureConstraints: ["Core remains authoritative."],
      }),
    });
    const result = await validator.validate({
      projectId: fixture.project.id,
      phase: fixture.phase,
      tasks: [fixture.task],
      validationEventId: fixture.phaseValidationEventId,
      workspacePath: "/tmp/densa-independent-review",
    });

    assert.equal(result.passed, false);
    assert.match(result.summary, /cannot override/u);
    assert.equal(
      database.repositories.independentReviews.listByPhaseId(fixture.phase.id).length,
      1,
    );
  } finally {
    database.close();
  }
});

test("fresh task wrapper passes live deterministic evidence to a distinct Reviewer", async () => {
  const database = DensaAdeDatabase.openInMemory();
  try {
    const fixture = seed(database, "task-wrapper");
    const adapter = new FakeAgentAdapter({ finalMessage: JSON.stringify(output("pass")) });
    const validator = new FreshContextTaskLifecycleValidator({
      deterministic: {
        validatorId: "task-suite",
        async validate() {
          return { passed: true, diagnostics: { summary: "Task suite passed live." } };
        },
      },
      service: reviewService(database),
      adapter,
      createReviewIdentity: () => ({
        id: "review-task-wrapper",
        reviewerRunId: "reviewer-run-task-wrapper",
      }),
      buildReviewInput: () => ({
        goal: "Review the risky task.",
        relevantDiff: "+ task change",
        architectureConstraints: ["Core remains authoritative."],
        implementingWorkerRunId: "worker-run-task-wrapper",
      }),
    });
    const result = await validator.validate({
      projectId: fixture.project.id,
      task: fixture.task,
      attempt: {
        id: "attempt-task-wrapper",
        taskId: fixture.task.id,
        number: 1,
        startedAt: createdAt,
      },
      validationRunId: fixture.validationRunId,
      workspacePath: "/tmp/densa-independent-review",
    });

    assert.equal(result.passed, true);
    assert.equal(result.independentReviewId, "review-task-wrapper");
    assert.match(adapter.requests[0].prompt, /Task suite passed live/u);
    assert.equal(adapter.requests[0].accessMode, "read-only");
  } finally {
    database.close();
  }
});

test("one phase validator creates fresh identities and context for every phase call", async () => {
  const database = DensaAdeDatabase.openInMemory();
  try {
    const first = seed(database, "phase-one");
    const second = seed(database, "phase-two");
    const validator = new FreshContextPhaseValidator({
      deterministic: {
        validatorId: "phase-suite",
        async validate() {
          return {
            passed: true,
            summary: "Phase suite passed.",
            checks: [{ validatorId: "integration", passed: true, summary: "Passed." }],
          };
        },
      },
      service: reviewService(database),
      adapter: new FakeAgentAdapter({ finalMessage: JSON.stringify(output("pass")) }),
      buildReviewInput: ({ phase, tasks }) => ({
        goal: `Review ${phase.id}.`,
        acceptanceCriteria: tasks.flatMap((task) => task.acceptanceCriteria),
        relevantDiff: `+ change for ${phase.id}`,
        architectureConstraints: ["Core remains authoritative."],
      }),
    });

    const firstResult = await validator.validate({
      projectId: first.project.id,
      phase: first.phase,
      tasks: [first.task],
      validationEventId: first.phaseValidationEventId,
      workspacePath: "/tmp/densa-independent-review",
    });
    const secondResult = await validator.validate({
      projectId: second.project.id,
      phase: second.phase,
      tasks: [second.task],
      validationEventId: second.phaseValidationEventId,
      workspacePath: "/tmp/densa-independent-review",
    });

    assert.equal(firstResult.passed, true);
    assert.equal(secondResult.passed, true);
    assert.notEqual(firstResult.independentReviewId, secondResult.independentReviewId);
    const reviews = [
      database.repositories.independentReviews.findById(firstResult.independentReviewId),
      database.repositories.independentReviews.findById(secondResult.independentReviewId),
    ];
    assert.notEqual(reviews[0].reviewerRunId, reviews[1].reviewerRunId);
    assert.notEqual(reviews[0].contextHash, reviews[1].contextHash);
  } finally {
    database.close();
  }
});

test("phase validation cancellation reaches the fresh reviewer adapter", async () => {
  const database = DensaAdeDatabase.openInMemory();
  try {
    const fixture = seed(database, "phase-cancelled");
    const controller = new globalThis.AbortController();
    const adapter = new FakeAgentAdapter({
      holdOpen: true,
      onExecute() {
        controller.abort();
      },
    });
    const validator = new FreshContextPhaseValidator({
      deterministic: {
        validatorId: "phase-suite",
        async validate() {
          return {
            passed: true,
            summary: "Phase suite passed.",
            checks: [{ validatorId: "integration", passed: true, summary: "Passed." }],
          };
        },
      },
      service: reviewService(database),
      adapter,
      createReviewIdentity: () => ({
        id: "review-phase-cancelled",
        reviewerRunId: "reviewer-run-phase-cancelled",
      }),
      buildReviewInput: () => ({
        goal: "Review cancellation.",
        acceptanceCriteria: fixture.task.acceptanceCriteria,
        relevantDiff: "+ phase change",
        architectureConstraints: ["Core remains authoritative."],
      }),
    });

    const result = await validator.validate({
      projectId: fixture.project.id,
      phase: fixture.phase,
      tasks: [fixture.task],
      validationEventId: fixture.phaseValidationEventId,
      workspacePath: "/tmp/densa-independent-review",
      signal: controller.signal,
    });

    assert.equal(result.passed, false);
    assert.deepEqual(adapter.cancelledRunIds, ["reviewer-run-phase-cancelled"]);
  } finally {
    database.close();
  }
});
