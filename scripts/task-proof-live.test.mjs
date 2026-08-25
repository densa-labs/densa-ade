import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { test } from "node:test";

import { CodexAdapter } from "../packages/agent-sdk/dist/index.js";
import { runTemporaryRepoTaskProof } from "../packages/core/dist/index.js";

const liveEnabled = process.env.DENSA_LIVE_CODEX_TASK_PROOF === "1";

test(
  "opt-in Codex run changes and independently validates the temporary fixture",
  {
    skip: liveEnabled
      ? false
      : "set DENSA_LIVE_CODEX_TASK_PROOF=1 to run against the installed Codex CLI",
    timeout: 120_000,
  },
  async (t) => {
    const result = await runTemporaryRepoTaskProof({
      adapter: new CodexAdapter(),
      runId: "live-codex-task-proof",
    });
    t.after(async () => {
      await Promise.all([
        rm(result.temporaryRoot, { recursive: true, force: true }),
        rm(result.diagnosticsRoot, { recursive: true, force: true }),
      ]);
    });

    assert.equal(result.verdict, "PASS", JSON.stringify(result.failureReasons));
    assert.equal(result.acceptanceResults[0].passed, true);
    assert.ok(result.changes.modified.includes("src/sum.js"));
  },
);
