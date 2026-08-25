import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { CodexAdapter, isTerminalAgentEvent } from "../packages/agent-sdk/dist/index.js";

const liveEnabled = process.env.DENSA_LIVE_CODEX === "1";

test(
  "opt-in authenticated Codex smoke test executes a trivial task",
  { skip: liveEnabled ? false : "set DENSA_LIVE_CODEX=1 to run against the installed Codex CLI" },
  async (t) => {
    const cwd = await mkdtemp(path.join(tmpdir(), "densa-live-codex-"));
    t.after(async () => await rm(cwd, { recursive: true, force: true }));
    const adapter = new CodexAdapter();

    const detection = await adapter.detect();
    assert.equal(detection.status, "available");
    const status = await adapter.getStatus();
    assert.equal(status.status, "available");

    const events = [];
    for await (const event of adapter.execute({
      runId: "live-codex-smoke",
      cwd,
      prompt: "Respond with exactly DENSA_CODEX_ADAPTER_OK and do not use tools.",
    })) {
      events.push(event);
    }

    const terminal = events.find(isTerminalAgentEvent);
    assert.equal(terminal.outcome, "succeeded");
    assert.match(terminal.finalMessage, /DENSA_CODEX_ADAPTER_OK/u);
  },
);
