import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CoreDaemon, CoreIpcClient } from "@densa-ade/core";
import { DensaAdeDatabase } from "@densa-ade/core/persistence";
import { CoreV1Client } from "@densa-ade/protocol";

// A real-daemon routing prerequisite, not a substitute for end-to-end behavioral acceptance.
// Only read operations are invoked; no provider, user workspace, or saved Core state is touched.
const runtimeDirectory = await mkdtemp(join(tmpdir(), "densa-v1-runtime-acceptance-"));
const database = DensaAdeDatabase.openInMemory();
let daemon;
const transport = new CoreIpcClient({ runtimeDirectory });
let requestNumber = 0;
const client = new CoreV1Client(transport, () => `runtime-acceptance-${++requestNumber}`);
const projectId = "project-absent-runtime-acceptance";
const checks = [];

try {
  daemon = await CoreDaemon.start({ runtimeDirectory, database });
  const requests = [
    ["system.bootstrap", {}],
    ["projects.list", {}],
    ["projects.get", { projectId }],
    ["projects.specification.get", { projectId }],
    ["dashboard.get", { projectId }],
    ["decisions.list", { projectId }],
    ["roadmaps.get", { projectId }],
    ["roadmaps.revisions.list", { projectId }],
    ["phases.report.get", { projectId, phaseId: "phase-absent" }],
    ["settings.get", { projectId }],
    ["usage.get", { projectId }],
    ["events.replay", { projectId, afterSequence: 0 }],
    ["logs.list", { projectId }],
    ["git.status", { projectId, workspacePath: runtimeDirectory }],
    ["git.commit.get", { projectId, sha: "0".repeat(40) }],
    ["attempts.list", { projectId, taskId: "task-absent" }],
    ["validation.list", { projectId, taskId: "task-absent" }],
    ["validation.get", { projectId, validationRunId: "validation-absent" }],
  ];
  for (const [method, payload] of requests) {
    try {
      await client.request(method, payload);
      checks.push({ method, status: "ROUTED" });
    } catch (error) {
      const code = error.protocolError?.code;
      const message = error.protocolError?.message ?? error.message;
      const unsupported = message.startsWith("Unsupported Core method:");
      // Missing-project domain rejection is acceptable only for this routing probe. Bootstrap
      // and project listing must succeed; arbitrary/internal errors never establish routing.
      const handledMissingProject =
        !unsupported &&
        method !== "system.bootstrap" &&
        method !== "projects.list" &&
        code === "USER_CONFIGURATION_ERROR";
      checks.push({
        method,
        status: unsupported
          ? "UNIMPLEMENTED"
          : handledMissingProject
            ? "ROUTED_DOMAIN_REJECTION"
            : "FAILED",
        code,
        message,
      });
    }
  }
  const failed = checks.some(
    (check) => check.status === "UNIMPLEMENTED" || check.status === "FAILED",
  );
  process.stdout.write(
    `${JSON.stringify({ verdict: failed ? "FAIL" : "PASS", scope: "real daemon read-routing prerequisite only", checks }, null, 2)}\n`,
  );
  process.exitCode = failed ? 1 : 0;
} finally {
  transport.disconnect();
  await daemon?.stop();
  database.close();
  await rm(runtimeDirectory, { recursive: true, force: true });
}
