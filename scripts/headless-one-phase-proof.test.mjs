import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { runHeadlessOnePhaseProof } from "@densa-ade/core";

function reviewerOutput() {
  return {
    verdict: "pass",
    summary: "The committed utility satisfies the phase criterion and deterministic evidence.",
    findings: [],
    criteria: [
      {
        criterionPosition: 0,
        assessment: "satisfied",
        rationale: "The complete node:test suite passed against the committed implementation.",
      },
    ],
    confidence: 0.98,
    unknowns: [],
  };
}

class ImplementingProofAdapter {
  adapterId = "fake-p9m0-proof";
  workerRuns = 0;
  reviewerRuns = 0;

  async detect() {
    return { status: "available", adapterId: this.adapterId, command: "fake", version: "1" };
  }

  async getStatus() {
    return { status: "available", version: "1" };
  }

  async getUsageState() {
    return { status: "available" };
  }

  async cancel() {}

  async *execute(request) {
    yield { type: "run.started", runId: request.runId, occurredAt: new Date().toISOString() };
    if (request.outputSchema !== undefined) {
      this.reviewerRuns += 1;
      yield {
        type: "run.terminal",
        runId: request.runId,
        occurredAt: new Date().toISOString(),
        outcome: "succeeded",
        exitCode: 0,
        finalMessage: JSON.stringify(reviewerOutput()),
      };
      return;
    }

    this.workerRuns += 1;
    await writeFile(
      join(request.cwd, "src/normalize-name.js"),
      [
        "export function normalizeName(value) {",
        '  if (typeof value !== "string") throw new TypeError("value must be a string");',
        '  return value.trim().split(/\\s+/u).map((part) => part.toLowerCase()).join("-");',
        "}",
        "",
      ].join("\n"),
    );
    yield {
      type: "run.terminal",
      runId: request.runId,
      occurredAt: new Date().toISOString(),
      outcome: "succeeded",
      exitCode: 0,
      finalMessage: "Implemented the requested source change.",
    };
  }
}

test("the P9M0 proof survives restarts and stops at an independently validated phase boundary", async (t) => {
  const adapter = new ImplementingProofAdapter();
  const result = await runHeadlessOnePhaseProof({ adapter, retainArtifacts: true });
  t.after(async () => rm(dirname(result.workspacePath), { recursive: true, force: true }));

  assert.equal(result.verdict, "PASS", JSON.stringify(result.failureReasons));
  assert.equal(result.restartCount, 2);
  assert.equal(result.finalProjectState, "RUNNING");
  assert.equal(result.finalPhaseState, "AWAITING_APPROVAL");
  assert.equal(result.finalTaskState, "COMPLETED");
  assert.equal(result.phaseReport.outcome, "awaiting_approval");
  assert.equal(result.phaseReport.phaseValidation.status, "passed");
  assert.equal(result.phaseReport.commits[0]?.sha, result.taskCommitSha);
  assert.match(result.gitSubjects[0] ?? "", /^densa-ade: task\.normalize-name /u);
  assert.equal(adapter.workerRuns, 1);
  assert.equal(adapter.reviewerRuns, 1);

  const diagnostics = JSON.parse(await readFile(result.diagnosticsPath, "utf8"));
  assert.equal(diagnostics.verdict, "PASS");
  assert.equal(diagnostics.taskCommitSha, result.taskCommitSha);
});
