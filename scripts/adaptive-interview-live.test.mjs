import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { CodexAdapter } from "@densa-ade/agent-sdk";
import { AdaptiveInterviewPlanner, AgentAdapterMasterInterviewAgent } from "@densa-ade/core";

const liveEnabled = process.env.DENSA_LIVE_CODEX_INTERVIEW === "1";

test(
  "opt-in Codex Master interview returns a validated adaptive snapshot",
  {
    skip: liveEnabled
      ? false
      : "set DENSA_LIVE_CODEX_INTERVIEW=1 to run against the installed Codex CLI",
  },
  async (t) => {
    const cwd = await mkdtemp(path.join(tmpdir(), "densa-live-interview-"));
    t.after(async () => await rm(cwd, { recursive: true, force: true }));
    const adapter = new CodexAdapter();
    const planner = new AdaptiveInterviewPlanner(
      new AgentAdapterMasterInterviewAgent(adapter, { cwd }),
    );

    const result = await planner.start(
      "Build an offline macOS field-notes app for biologists; all observations must remain on the device.",
    );

    assert.equal(result.specification.projectGoal.includes("offline macOS"), true);
    assert.equal(result.specification.formatVersion, 1);
    assert.match(result.specificationMarkdown, /^# Project Specification/u);
  },
);
