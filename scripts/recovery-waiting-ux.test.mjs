import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  RECOVERY_CANONICAL_PROJECT_STATES,
  RECOVERY_CANONICAL_TASK_STATES,
  RECOVERY_CAPABILITY_METHODS,
  RECOVERY_HOST_COMMAND,
  RECOVERY_HOST_VIEW_TYPE,
  RECOVERY_KINDS,
  RECOVERY_LIFECYCLE,
  RECOVERY_OPEN_REFRESH_METHODS,
  applyRecoveryControlOutcome,
  buildRecoveryModel,
  recoveryEventIsRefreshHint,
  resolveRecoveryAutoResumeIntent,
  resolveRecoveryDrilldown,
  resolveRecoveryPhaseApproval,
  resolveRecoveryPermissionResolve,
  resolveRecoveryReconnect,
  resolveRecoveryReopenRefresh,
  resolveRecoveryResume,
  resolveRecoveryTaskApproval,
} from "../apps/ide-extension/dist/index.js";

const PROJECT_ID = "project-recovery-m3";
const PHASE_ID = "phase-recovery-m3";
const TASK_ID = "task-recovery-m3";
const WORKSPACE = "/tmp/densa-recovery-m3";
const TIMESTAMP = "2026-09-03T00:00:00.000Z";
const RESET_AT = "2026-09-03T05:00:00.000Z";
const HEAD_SHA = "abcdef1234567890abcdef1234567890abcdef12";

function makeSnapshot(overrides = {}) {
  return {
    summary: {
      project: {
        id: PROJECT_ID,
        name: "Recovery fixture",
        state: "RUNNING",
        executionMode: "phase",
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
      workspacePath: WORKSPACE,
      currentPhaseId: PHASE_ID,
      completedTaskCount: 0,
      totalTaskCount: 1,
      attentionRequired: false,
    },
    phases: [
      {
        id: PHASE_ID,
        projectId: PROJECT_ID,
        title: "Recovery phase",
        goal: "Prove recovery UX reflects Core truth",
        position: 0,
        state: "RUNNING",
        required: true,
        completionCriteria: ["Every task completes with passing validation"],
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
    ],
    tasks: [
      {
        id: TASK_ID,
        projectId: PROJECT_ID,
        phaseId: PHASE_ID,
        title: "Recovery task",
        goal: "Do the recoverable work",
        executable: true,
        dependencyIds: [],
        acceptanceCriteria: ["work is validated"],
        riskLevel: "low",
        expectedValidators: ["unit_test"],
        state: "RUNNING",
        position: 0,
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
    ],
    pendingApprovals: [],
    usage: { status: "available" },
    latestEventSequence: 11,
    ...overrides,
  };
}

function withProjectState(state) {
  const snapshot = makeSnapshot();
  return {
    ...snapshot,
    summary: {
      ...snapshot.summary,
      project: { ...snapshot.summary.project, state },
    },
  };
}

function withTaskState(state) {
  const snapshot = makeSnapshot();
  return { ...snapshot, tasks: snapshot.tasks.map((task) => ({ ...task, state })) };
}

function makeDashboard(overrides = {}) {
  const snapshot = makeSnapshot();
  return {
    project: snapshot.summary,
    phaseCounts: [{ state: "RUNNING", count: 1 }],
    taskCounts: [{ state: "RUNNING", count: 1 }],
    currentPhase: snapshot.phases[0],
    currentTask: snapshot.tasks[0],
    pendingApprovals: [],
    recentFailureCount: 0,
    retryCount: 0,
    validation: { passed: 0, failed: 0, incomplete: 1 },
    usage: { status: "available" },
    latestEventSequence: 11,
    ...overrides,
  };
}

function makeGitStatus(overrides = {}) {
  return {
    projectId: PROJECT_ID,
    workspacePath: WORKSPACE,
    available: true,
    headSha: HEAD_SHA,
    branch: "densa-ade/run/project-recovery-m3",
    dirty: false,
    changedPaths: [],
    observedAt: TIMESTAMP,
    ...overrides,
  };
}

function makeUsageObservation(usage, overrides = {}) {
  return {
    projectId: PROJECT_ID,
    usage,
    observedAt: TIMESTAMP,
    ...overrides,
  };
}

function kindsOf(model) {
  return model.cards.map((card) => card.kind);
}

test("recovery catalog methods exist in the frozen Core v1 protocol", () => {
  for (const method of [...RECOVERY_OPEN_REFRESH_METHODS, ...RECOVERY_CAPABILITY_METHODS]) {
    assert.ok(CORE_V1_METHODS.includes(method), method);
  }
  assert.ok(RECOVERY_OPEN_REFRESH_METHODS.includes("projects.get"));
  assert.ok(RECOVERY_OPEN_REFRESH_METHODS.includes("dashboard.get"));
  assert.ok(RECOVERY_OPEN_REFRESH_METHODS.includes("events.replay"));
  assert.ok(RECOVERY_OPEN_REFRESH_METHODS.includes("usage.get"));
  assert.ok(RECOVERY_CAPABILITY_METHODS.includes("projects.resume"));
  assert.ok(RECOVERY_CAPABILITY_METHODS.includes("permissions.resolve"));
  assert.ok(RECOVERY_CAPABILITY_METHODS.includes("tasks.approve"));
  assert.ok(RECOVERY_CAPABILITY_METHODS.includes("phases.approve"));
  assert.ok(RECOVERY_CAPABILITY_METHODS.includes("attempts.list"));
  assert.ok(RECOVERY_CAPABILITY_METHODS.includes("validation.list"));
  assert.ok(RECOVERY_CAPABILITY_METHODS.includes("logs.list"));
  assert.ok(RECOVERY_CAPABILITY_METHODS.includes("git.status"));
  assert.ok(RECOVERY_CAPABILITY_METHODS.includes("usage.get"));
  assert.equal(RECOVERY_LIFECYCLE.optimisticComplete, false);
  assert.equal(RECOVERY_LIFECYCLE.closeDisposes, "view-handle-only");
  assert.equal(RECOVERY_LIFECYCLE.coreContinuesAfterClose, true);
  assert.equal(RECOVERY_LIFECYCLE.createsNewAuthoritativeState, false);
  assert.equal(RECOVERY_LIFECYCLE.issuesCoreRequest, false);
});

test("recovery covers every milestone kind and canonical state verbatim", () => {
  assert.deepEqual(
    [...RECOVERY_KINDS].sort(),
    [
      "blocked-after-retries",
      "codex-auth-required",
      "core-auth-failed",
      "core-disconnected",
      "core-reconnecting",
      "core-version-mismatch",
      "interrupted-recovered",
      "permission-required",
      "steady",
      "user-decision-required",
      "waiting-for-usage-known-reset",
      "waiting-for-usage-unknown",
      "workspace-divergence",
    ].sort(),
  );
  assert.deepEqual(
    [...RECOVERY_CANONICAL_PROJECT_STATES],
    [
      "DRAFT",
      "PLANNING",
      "READY",
      "RUNNING",
      "PAUSED",
      "WAITING_FOR_USER",
      "WAITING_FOR_USAGE",
      "BLOCKED",
      "COMPLETED",
      "FAILED",
    ],
  );
  assert.deepEqual(
    [...RECOVERY_CANONICAL_TASK_STATES],
    [
      "PENDING",
      "READY",
      "RUNNING",
      "VALIDATING",
      "RETRYING",
      "WAITING_FOR_USER",
      "WAITING_FOR_USAGE",
      "BLOCKED",
      "INTERRUPTED",
      "COMPLETED",
      "CANCELLED",
    ],
  );
  for (const state of RECOVERY_CANONICAL_PROJECT_STATES) {
    const model = buildRecoveryModel({ snapshot: withProjectState(state) });
    assert.equal(model.projectState, state);
  }
});

test("core disconnected, reconnecting, version-mismatch, and auth-failed are offline with stale truth", () => {
  const disconnected = buildRecoveryModel({
    snapshot: makeSnapshot(),
    connectionState: "disconnected",
  });
  assert.ok(kindsOf(disconnected).includes("core-disconnected"));
  const offline = disconnected.cards.find((card) => card.kind === "core-disconnected");
  assert.equal(offline.tone, "offline");
  assert.match(offline.detail, /stale, not lost|offline, not broken/iu);
  assert.match(offline.detail, /sequence 11/iu);
  assert.ok(offline.persisted.some((entry) => entry.includes("sequence 11")));
  assert.ok(offline.nextActions.some((entry) => entry.includes("densa-ade core start")));
  assert.equal(disconnected.summary.tone, "offline");
  assert.match(disconnected.summary.detail, /offline, not broken/iu);
  assert.equal(disconnected.enabled, false);
  assert.match(disconnected.reason, /densa-ade core start/iu);

  const reconnecting = buildRecoveryModel({
    snapshot: makeSnapshot(),
    connectionState: "connecting",
  });
  assert.ok(kindsOf(reconnecting).includes("core-reconnecting"));
  assert.equal(reconnecting.cards.find((c) => c.kind === "core-reconnecting").tone, "offline");
  assert.equal(reconnecting.summary.tone, "offline");
  assert.equal(reconnecting.enabled, false);

  const mismatch = buildRecoveryModel({
    snapshot: makeSnapshot(),
    connectionState: "version-mismatch",
    coreDetail: "expected 1.0.0",
  });
  assert.ok(kindsOf(mismatch).includes("core-version-mismatch"));
  assert.match(
    mismatch.cards.find((c) => c.kind === "core-version-mismatch").detail,
    /protocol version/iu,
  );
  assert.equal(mismatch.summary.tone, "offline");

  const authFailed = buildRecoveryModel({
    snapshot: makeSnapshot(),
    connectionState: "auth-failed",
  });
  assert.ok(kindsOf(authFailed).includes("core-auth-failed"));
  assert.match(
    authFailed.cards.find((c) => c.kind === "core-auth-failed").detail,
    /rejected|trust/iu,
  );
  assert.equal(authFailed.summary.tone, "offline");
});

test("interrupted task recovered after restart shows preserved diagnostics", () => {
  const recovered = buildRecoveryModel({
    snapshot: withTaskState("INTERRUPTED"),
    restartObserved: true,
  });
  assert.ok(kindsOf(recovered).includes("interrupted-recovered"));
  const card = recovered.cards.find((c) => c.kind === "interrupted-recovered");
  assert.equal(card.tone, "attention");
  assert.match(card.title, new RegExp(TASK_ID, "u"));
  assert.match(card.detail, /restart/iu);
  assert.match(card.detail, /diagnostics are preserved|preserved/iu);
  assert.ok(card.persisted.some((entry) => entry.includes(TASK_ID)));
  assert.ok(card.nextActions.some((entry) => entry.includes("attempts.list")));
  assert.ok(card.nextActions.some((entry) => entry.includes("git.status")));
  assert.ok(card.drilldowns.some((entry) => entry.method === "attempts.list"));
  assert.ok(card.drilldowns.some((entry) => entry.method === "logs.list"));
  assert.match(card.diagnosticsHint, /never dumped inline|behind the drill-downs/iu);
  assert.equal(recovered.summary.tone, "attention");

  const withoutRestart = buildRecoveryModel({ snapshot: withTaskState("INTERRUPTED") });
  const plain = withoutRestart.cards.find((c) => c.kind === "interrupted-recovered");
  assert.ok(plain);
  assert.match(plain.detail, /INTERRUPTED/iu);
});

test("workspace divergence requires review and preserves manual edits", () => {
  const diverged = buildRecoveryModel({
    snapshot: withProjectState("PAUSED"),
    gitStatus: makeGitStatus({ dirty: true, changedPaths: ["src/manual.ts"] }),
  });
  assert.ok(kindsOf(diverged).includes("workspace-divergence"));
  const card = diverged.cards.find((c) => c.kind === "workspace-divergence");
  assert.equal(card.tone, "attention");
  assert.match(card.detail, /preserved, never overwritten/iu);
  assert.match(card.detail, /INTERVENTION_REQUIRED/iu);
  assert.ok(card.nextActions.some((entry) => entry.includes("acknowledgeIntervention")));
  assert.ok(card.drilldowns.some((entry) => entry.method === "git.status"));

  const runningDirty = buildRecoveryModel({
    snapshot: withTaskState("RUNNING"),
    gitStatus: makeGitStatus({ dirty: true, changedPaths: ["src/manual.ts"] }),
  });
  assert.ok(!kindsOf(runningDirty).includes("workspace-divergence"));

  const cleanPaused = buildRecoveryModel({
    snapshot: withProjectState("PAUSED"),
    gitStatus: makeGitStatus(),
  });
  assert.ok(!kindsOf(cleanPaused).includes("workspace-divergence"));
});

test("waiting with known reset shows the verbatim timestamp and no countdown math", () => {
  const waiting = buildRecoveryModel({
    snapshot: withProjectState("WAITING_FOR_USAGE"),
    dashboard: makeDashboard({
      project: {
        ...makeSnapshot().summary,
        project: { ...makeSnapshot().summary.project, state: "WAITING_FOR_USAGE" },
      },
      usage: { status: "limited", resetAt: RESET_AT },
    }),
    usageObservation: makeUsageObservation({ status: "limited", resetAt: RESET_AT }),
    autoResumeEnabled: false,
  });
  assert.ok(kindsOf(waiting).includes("waiting-for-usage-known-reset"));
  assert.ok(!kindsOf(waiting).includes("waiting-for-usage-unknown"));
  const card = waiting.cards.find((c) => c.kind === "waiting-for-usage-known-reset");
  assert.equal(card.tone, "waiting");
  assert.equal(card.resetKnown, true);
  assert.equal(card.resetAt, RESET_AT);
  assert.match(card.detail, new RegExp(RESET_AT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
  assert.match(card.detail, /not broken/iu);
  assert.match(card.detail, /Auto-resume is disabled/iu);
  assert.equal(card.autoResumeEnabled, false);
  assert.ok(card.nextActions.some((entry) => entry.includes("usage.get")));
  assert.ok(
    !/in \d+ (minutes|hours|seconds)|countdown \d/i.test(card.detail + card.nextActions.join(" ")),
  );
  assert.equal(waiting.summary.tone, "waiting");
  assert.match(waiting.summary.detail, /not broken/iu);
  assert.equal(waiting.usageResetKnown, true);
  assert.equal(waiting.usageResetAt, RESET_AT);
});

test("waiting with unknown reset shows no countdown and honors auto-resume on/off", () => {
  const off = buildRecoveryModel({
    snapshot: withProjectState("WAITING_FOR_USAGE"),
    usageObservation: makeUsageObservation({ status: "unknown", reason: "no stable signal" }),
    autoResumeEnabled: false,
  });
  assert.ok(kindsOf(off).includes("waiting-for-usage-unknown"));
  const offCard = off.cards.find((c) => c.kind === "waiting-for-usage-unknown");
  assert.equal(offCard.tone, "waiting");
  assert.equal(offCard.resetKnown, false);
  assert.equal(offCard.resetAt, undefined);
  assert.match(offCard.detail, /no.*countdown|shows no countdown/iu);
  assert.match(offCard.detail, /not broken/iu);
  assert.match(offCard.detail, /Auto-resume is disabled/iu);
  const combinedOff = `${offCard.title} ${offCard.detail} ${offCard.nextActions.join(" ")}`;
  assert.ok(!/resetAt|in \d+ minutes|countdown \d|resets in/i.test(combinedOff));

  const on = buildRecoveryModel({
    snapshot: withProjectState("WAITING_FOR_USAGE"),
    usageObservation: makeUsageObservation({ status: "limited" }),
    autoResumeEnabled: true,
  });
  const onCard = on.cards.find((c) => c.kind === "waiting-for-usage-unknown");
  assert.equal(onCard.autoResumeEnabled, true);
  assert.match(onCard.detail, /Auto-resume is enabled/iu);
  assert.match(onCard.detail, /revalidating/iu);
  assert.equal(on.summary.tone, "waiting");
});

test("blocked after retries is broken, not waiting, with preserved evidence", () => {
  const blocked = buildRecoveryModel({
    snapshot: {
      ...withProjectState("BLOCKED"),
      tasks: withTaskState("BLOCKED").tasks,
    },
    dashboard: makeDashboard({
      project: {
        ...makeSnapshot().summary,
        project: { ...makeSnapshot().summary.project, state: "BLOCKED" },
      },
      taskCounts: [{ state: "BLOCKED", count: 1 }],
      phaseCounts: [{ state: "BLOCKED", count: 1 }],
      retryCount: 4,
      recentFailureCount: 2,
      validation: { passed: 0, failed: 2, incomplete: 0 },
    }),
  });
  assert.ok(kindsOf(blocked).includes("blocked-after-retries"));
  const card = blocked.cards.find((c) => c.kind === "blocked-after-retries");
  assert.equal(card.tone, "broken");
  assert.match(card.detail, /not waiting|need new evidence/iu);
  assert.match(card.detail, new RegExp(TASK_ID, "u"));
  assert.ok(card.persisted.some((entry) => entry.includes("retries 4")));
  assert.ok(card.nextActions.some((entry) => entry.includes("attempts.list")));
  assert.ok(card.nextActions.some((entry) => entry.includes("validation.list")));
  assert.ok(card.drilldowns.some((entry) => entry.method === "attempts.list"));
  assert.ok(card.drilldowns.some((entry) => entry.method === "validation.list"));
  assert.equal(blocked.summary.tone, "broken");
  assert.match(blocked.summary.detail, /not waiting|blocked, not waiting/iu);
});

test("codex authentication required is attention, unknown stays honest", () => {
  const required = buildRecoveryModel({
    snapshot: makeSnapshot(),
    codexAuth: { status: "required", detail: "stable CLI signal" },
  });
  assert.ok(kindsOf(required).includes("codex-auth-required"));
  const card = required.cards.find((c) => c.kind === "codex-auth-required");
  assert.equal(card.tone, "attention");
  assert.match(card.detail, /official Codex/iu);
  assert.match(card.detail, /not broken|not.*broken|waits with/iu);
  assert.ok(card.nextActions.some((entry) => entry.includes("official Codex")));
  assert.ok(card.nextActions.some((entry) => entry.includes("usage.get")));

  const unknown = buildRecoveryModel({
    snapshot: makeSnapshot(),
    codexAuth: { status: "unknown" },
  });
  assert.ok(!kindsOf(unknown).includes("codex-auth-required"));

  const ready = buildRecoveryModel({
    snapshot: makeSnapshot(),
    codexAuth: { status: "ready" },
  });
  assert.ok(!kindsOf(ready).includes("codex-auth-required"));
});

test("permission and user decisions resolve through auditable Core operations", () => {
  const permissionSnapshot = makeSnapshot({
    pendingApprovals: [
      {
        kind: "permission",
        projectId: PROJECT_ID,
        decisionId: "decision-1",
        requestedAt: TIMESTAMP,
        summary: "Install dependencies with network access",
      },
    ],
  });
  const permission = buildRecoveryModel({ snapshot: permissionSnapshot });
  assert.ok(kindsOf(permission).includes("permission-required"));
  const permissionCard = permission.cards.find((c) => c.kind === "permission-required");
  assert.equal(permissionCard.tone, "attention");
  assert.ok(permissionCard.nextActions.some((entry) => entry.includes("permissions.resolve")));
  assert.ok(permissionCard.drilldowns.some((entry) => entry.method === "decisions.list"));

  const userSnapshot = makeSnapshot({
    summary: {
      ...makeSnapshot().summary,
      project: { ...makeSnapshot().summary.project, state: "WAITING_FOR_USER" },
    },
    pendingApprovals: [
      {
        kind: "phase",
        projectId: PROJECT_ID,
        phaseId: PHASE_ID,
        requestedAt: TIMESTAMP,
        summary: "Approve phase completion",
      },
    ],
  });
  const user = buildRecoveryModel({ snapshot: userSnapshot });
  assert.ok(kindsOf(user).includes("user-decision-required"));
  const userCard = user.cards.find((c) => c.kind === "user-decision-required");
  assert.equal(userCard.tone, "attention");
  assert.match(userCard.detail, /waiting on you, not broken/iu);
  assert.ok(userCard.drilldowns.some((entry) => entry.method === "phases.report.get"));
});

test("steady projects show no recovery and waiting stays distinct from broken", () => {
  const steady = buildRecoveryModel({ snapshot: makeSnapshot() });
  assert.deepEqual(kindsOf(steady), ["steady"]);
  const card = steady.cards[0];
  assert.equal(card.tone, "ok");
  assert.match(card.detail, /No recovery|no interrupted/iu);
  assert.equal(steady.summary.tone, "ok");

  const waiting = buildRecoveryModel({
    snapshot: withProjectState("WAITING_FOR_USAGE"),
    usageObservation: makeUsageObservation({ status: "limited" }),
  });
  const blocked = buildRecoveryModel({
    snapshot: { ...withProjectState("BLOCKED"), tasks: withTaskState("BLOCKED").tasks },
  });
  assert.equal(waiting.summary.tone, "waiting");
  assert.equal(blocked.summary.tone, "broken");
  assert.ok(waiting.summary.detail !== blocked.summary.detail);
});

test("recovery resolvers address Core truth with actor and reason audit", () => {
  const model = buildRecoveryModel({ snapshot: makeSnapshot() });

  const resume = resolveRecoveryResume(model, { actor: "operator" });
  assert.equal(resume.method, "projects.resume");
  assert.equal(resume.projectId, PROJECT_ID);
  assert.equal(resume.workspacePath, WORKSPACE);
  assert.equal(resume.acknowledgeIntervention, undefined);
  const acked = resolveRecoveryResume(model, { actor: "operator", acknowledgeIntervention: true });
  assert.equal(acked.acknowledgeIntervention, true);
  assert.throws(() => resolveRecoveryResume(model, { actor: "  " }), /requires an actor/u);

  const permission = resolveRecoveryPermissionResolve(model, {
    decisionId: "decision-1",
    resolution: "approve",
    actor: "operator",
    reason: "Reviewed network scope",
  });
  assert.equal(permission.method, "permissions.resolve");
  assert.equal(permission.decisionId, "decision-1");
  assert.throws(
    () =>
      resolveRecoveryPermissionResolve(model, {
        decisionId: "",
        resolution: "approve",
        actor: "operator",
        reason: "r",
      }),
    /decisionId/u,
  );
  assert.throws(
    () =>
      resolveRecoveryPermissionResolve(model, {
        decisionId: "d",
        resolution: "approve",
        actor: "operator",
        reason: "",
      }),
    /reason for audit/u,
  );

  const taskApproval = resolveRecoveryTaskApproval(model, {
    phaseId: PHASE_ID,
    taskId: TASK_ID,
    decision: "approve",
    actor: "operator",
    reason: "Evidence reviewed",
  });
  assert.equal(taskApproval.method, "tasks.approve");
  assert.equal(taskApproval.taskId, TASK_ID);

  const phaseApproval = resolveRecoveryPhaseApproval(model, {
    phaseId: PHASE_ID,
    decision: "approve",
    actor: "operator",
    reason: "Phase report reviewed",
  });
  assert.equal(phaseApproval.method, "phases.approve");
  assert.equal(phaseApproval.phaseId, PHASE_ID);

  const reconnect = resolveRecoveryReconnect();
  assert.equal(reconnect.action, "reconnect-and-replay");
  assert.match(reconnect.reason, /replay.*from the last applied sequence/iu);

  const autoOn = resolveRecoveryAutoResumeIntent(true);
  assert.equal(autoOn.storage, "local-only");
  assert.equal(autoOn.enabled, true);
  const autoOff = resolveRecoveryAutoResumeIntent(false);
  assert.equal(autoOff.enabled, false);

  const reopen = resolveRecoveryReopenRefresh(PROJECT_ID);
  assert.equal(reopen.action, "refresh-before-render");
  assert.ok(reopen.refreshMethods.includes("projects.get"));
  assert.ok(reopen.refreshMethods.includes("dashboard.get"));
  assert.ok(reopen.refreshMethods.includes("events.replay"));
  assert.ok(reopen.refreshMethods.includes("usage.get"));
  assert.throws(() => resolveRecoveryReopenRefresh("  "), /persisted projectId/u);

  assert.equal(recoveryEventIsRefreshHint("core.event"), true);
  assert.equal(recoveryEventIsRefreshHint("run.log.appended"), true);
  assert.equal(recoveryEventIsRefreshHint("  "), false);
  assert.equal(recoveryEventIsRefreshHint(undefined), false);
});

test("recovery control effects never invent state and stay idempotent", () => {
  const model = buildRecoveryModel({ snapshot: makeSnapshot() });

  const unchanged = applyRecoveryControlOutcome(model, {
    projectId: PROJECT_ID,
    status: "UNCHANGED",
    reason: "Requested control boundary is already durable",
  });
  assert.equal(unchanged.idempotent, true);
  assert.match(unchanged.notice, /already durable|no new fact/u);

  const resumed = applyRecoveryControlOutcome(model, {
    projectId: PROJECT_ID,
    status: "RESUMED",
    reason: "Project resumed",
  });
  assert.equal(resumed.idempotent, false);
  assert.ok(resumed.refreshMethods.includes("projects.get"));
  assert.ok(resumed.refreshMethods.includes("dashboard.get"));

  const intervention = applyRecoveryControlOutcome(model, {
    projectId: PROJECT_ID,
    status: "INTERVENTION_REQUIRED",
    changedPaths: ["src/manual.ts"],
  });
  assert.deepEqual([...intervention.changedPaths], ["src/manual.ts"]);
  assert.match(intervention.notice, /acknowledgeIntervention/u);

  assert.throws(
    () =>
      applyRecoveryControlOutcome(model, {
        projectId: "other-project",
        status: "RESUMED",
        reason: "crossed",
      }),
    /crossed the requested project boundary/u,
  );
});

test("recovery drill-downs carry persisted IDs and never fetch unscoped logs", () => {
  const model = buildRecoveryModel({ snapshot: makeSnapshot() });

  const snapshot = resolveRecoveryDrilldown(model, { kind: "project-snapshot" });
  assert.equal(snapshot.method, "projects.get");

  const usage = resolveRecoveryDrilldown(model, { kind: "usage" });
  assert.equal(usage.method, "usage.get");

  const changes = resolveRecoveryDrilldown(model, { kind: "changes" });
  assert.equal(changes.method, "git.status");
  assert.equal(changes.workspacePath, WORKSPACE);

  const attempts = resolveRecoveryDrilldown(model, { kind: "attempts", taskId: TASK_ID });
  assert.equal(attempts.method, "attempts.list");

  const runLogs = resolveRecoveryDrilldown(model, { kind: "run-logs", taskId: TASK_ID });
  assert.equal(runLogs.method, "logs.list");

  const events = resolveRecoveryDrilldown(model, { kind: "events" });
  assert.equal(events.method, "events.replay");
  assert.equal(events.afterSequence, 11);

  assert.throws(
    () => resolveRecoveryDrilldown(model, { kind: "run-logs" }),
    /never fetches unscoped run logs/u,
  );
  assert.throws(
    () => resolveRecoveryDrilldown(model, { kind: "git-commit", sha: "  " }),
    /requires a persisted commit SHA/u,
  );
  assert.throws(
    () => resolveRecoveryDrilldown(model, { kind: "events", afterSequence: -1 }),
    /non-negative afterSequence/u,
  );
});

test("recovery never shows token, cost, or fake countdown state", () => {
  const cases = [
    buildRecoveryModel({ snapshot: makeSnapshot() }),
    buildRecoveryModel({
      snapshot: withProjectState("WAITING_FOR_USAGE"),
      usageObservation: makeUsageObservation({ status: "unknown", reason: "no signal" }),
    }),
    buildRecoveryModel({
      snapshot: withProjectState("WAITING_FOR_USAGE"),
      usageObservation: makeUsageObservation({ status: "limited", resetAt: RESET_AT }),
    }),
    buildRecoveryModel({ snapshot: withTaskState("BLOCKED") }),
  ];
  for (const model of cases) {
    const combined = [
      model.summary.title,
      model.summary.detail,
      ...model.cards.flatMap((card) => [
        card.title,
        card.detail,
        ...card.persisted,
        ...card.nextActions,
      ]),
    ].join("\n");
    assert.ok(!/token|cost|prompt transcript|secret/iu.test(combined));
    if (model.usageResetKnown !== true) {
      assert.ok(!/resets in|countdown \d|in \d+ minutes/i.test(combined));
    }
  }
  const unknown = buildRecoveryModel({
    snapshot: withProjectState("WAITING_FOR_USAGE"),
    usageObservation: makeUsageObservation({ status: "limited" }),
  });
  const unknownCard = unknown.cards.find((c) => c.kind === "waiting-for-usage-unknown");
  assert.ok(unknownCard);
  assert.match(unknownCard.detail, /no.*countdown|shows no countdown/iu);
});

test("recovery rejects cross-boundary and unknown-state facts instead of inventing", () => {
  assert.throws(
    () =>
      buildRecoveryModel({
        snapshot: makeSnapshot(),
        gitStatus: makeGitStatus({ projectId: "other-project" }),
      }),
    /Git status crossed/u,
  );
  assert.throws(
    () =>
      buildRecoveryModel({
        snapshot: makeSnapshot(),
        usageObservation: makeUsageObservation({ status: "available" }, { projectId: "other" }),
      }),
    /usage observation crossed|project boundary/iu,
  );
  assert.throws(
    () =>
      buildRecoveryModel({
        snapshot: makeSnapshot(),
        recentEvents: [
          {
            id: "event-1",
            projectId: "other-project",
            type: "PROJECT_STARTED",
            eventVersion: 1,
            occurredAt: TIMESTAMP,
            payload: {},
            sequenceNumber: 1,
          },
        ],
      }),
    /event crossed/u,
  );
  const unknown = withProjectState("RUNNING");
  unknown.summary.project.state = "TIME_TRAVEL";
  assert.throws(() => buildRecoveryModel({ snapshot: unknown }), /unknown state/u);
});

test("recovery reuses the Dashboard tab with zero workbench patches", () => {
  assert.equal(RECOVERY_HOST_COMMAND, "densa-ade.showDashboard");
  assert.equal(RECOVERY_HOST_VIEW_TYPE, "densa-ade.dashboard");
  const manifest = JSON.parse(
    readFileSync(new URL("../apps/ide-extension/package.json", import.meta.url), "utf8"),
  );
  const viewTypes = (manifest.contributes.customEditors ?? []).map((entry) => entry.viewType);
  assert.ok(viewTypes.includes("densa-ade.dashboard"));
  assert.ok(!viewTypes.includes("densa-ade.recovery"));
  const commands = (manifest.contributes.commands ?? []).map((entry) => entry.command);
  assert.ok(commands.includes("densa-ade.showDashboard"));
  assert.ok(!commands.includes("densa-ade.showRecovery"));
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), ["@densa-ade/protocol"]);
});

test("recovery extension sources stay protocol-only", () => {
  const extensionDir = new URL("../apps/ide-extension/src/", import.meta.url);
  const sources = ["index.ts", "recovery.ts"]
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
  assert.ok(
    !/\bfetch\s*\(|\bXMLHttpRequest\b|\bhttps?\.get\s*\(/u.test(sources),
    "recovery model performs no network I/O",
  );
});

test("recovery docs explain Core persistence, honesty, and waiting-vs-broken", () => {
  const doc = readFileSync(new URL("../docs/recovery-waiting-ux.md", import.meta.url), "utf8");
  assert.match(doc, /frozen.*Core v1|Core v1.*frozen/iu);
  assert.match(doc, /no.*countdown|fake countdown/iu);
  assert.match(doc, /Waiting, not broken|waiting.*not broken/iu);
  assert.match(doc, /local-only/iu);
  assert.match(doc, /replay.*subscribe|reconnect/iu);
});

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function withRecoveryDaemon(run) {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "densa-recovery-m3-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "densa-recovery-ws-"));
  const workspace = join(workspaceRoot, "workspace");
  git(workspaceRoot, ["init", "--quiet", "--initial-branch=main", workspace]);
  git(workspace, ["config", "user.name", "Densa ADE Recovery M3 Fixture"]);
  git(workspace, ["config", "user.email", "densa-recovery-m3@localhost"]);
  git(workspace, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(workspace, "baseline.txt"), "baseline\n", "utf8");
  git(workspace, ["add", "--all"]);
  git(workspace, ["commit", "--quiet", "-m", "baseline"]);
  const database = DensaAdeDatabase.openInMemory();
  const daemon = await CoreDaemon.start({ runtimeDirectory, database });
  let requestNumber = 0;
  const connection = new IdeCoreConnection({
    runtimeDirectory,
    createRequestId: () => `recovery-m3-${String((requestNumber += 1))}`,
  });
  try {
    await connection.connect();
    await run({ connection, database, workspace });
  } finally {
    connection.dispose();
    await daemon.stop().catch(() => undefined);
    database.close();
    await rm(runtimeDirectory, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function createRecoveryProject(connection, workspace, name) {
  const created = await connection.request("projects.create", {
    name,
    workspacePath: workspace,
    idea: "Prove recovery waiting UX through Core truth",
    executionMode: "phase",
    actor: "test",
  });
  await connection.request("projects.interview.answer", {
    projectId: created.project.id,
    sessionId: "session-recovery-m3",
    answers: [{ questionId: "scope", answer: "Deterministic recovery proof" }],
  });
  await connection.request("roadmaps.generate", {
    projectId: created.project.id,
    sessionId: "session-recovery-m3",
    actor: "test",
  });
  await connection.request("projects.start", {
    projectId: created.project.id,
    workspacePath: workspace,
    actor: "test",
  });
  return created.project.id;
}

async function readRecoveryModel(connection, projectId, extra = {}) {
  const snapshot = await connection.request("projects.get", { projectId });
  const dashboard = await connection.request("dashboard.get", { projectId });
  const gitStatus = await connection.request("git.status", {
    projectId,
    workspacePath: snapshot.summary.workspacePath,
  });
  const usageObservation = await connection.request("usage.get", { projectId });
  return buildRecoveryModel({
    snapshot,
    dashboard,
    gitStatus,
    usageObservation,
    ...(extra.lastControl === undefined ? {} : {}),
    ...extra,
  });
}

test("live pause is idempotent and manual edits survive for recovery review", async () => {
  await withRecoveryDaemon(async ({ connection, workspace }) => {
    const projectId = await createRecoveryProject(connection, workspace, "Recovery controls");
    let model = await readRecoveryModel(connection, projectId);
    assert.ok(kindsOf(model).includes("steady"));

    const resume = resolveRecoveryResume(model, { actor: "test" });
    assert.equal(resume.method, "projects.resume");

    // Use the persisted canonical workspacePath from Core for every control
    // so macOS /var -> /private/var canonicalization never causes a
    // spurious "Resume workspace differs" BLOCKED.
    const canonicalWorkspace = model.workspacePath;
    const paused = await connection.request("projects.pause", {
      projectId,
      workspacePath: canonicalWorkspace,
      actor: "test",
    });
    assert.equal(paused.projectId, projectId);
    const pausedEffect = applyRecoveryControlOutcome(model, paused);
    assert.equal(pausedEffect.idempotent, false);

    model = await readRecoveryModel(connection, projectId);
    assert.equal(model.projectState, "PAUSED");

    const repeat = await connection.request("projects.pause", {
      projectId,
      workspacePath: model.workspacePath,
      actor: "test",
    });
    assert.equal(repeat.status, "UNCHANGED");
    const repeatEffect = applyRecoveryControlOutcome(model, repeat);
    assert.equal(repeatEffect.idempotent, true);

    await writeFile(join(workspace, "user-note.txt"), "manual work must survive\n", "utf8");
    model = await readRecoveryModel(connection, projectId);
    assert.ok(kindsOf(model).includes("workspace-divergence"));
    const divergence = model.cards.find((c) => c.kind === "workspace-divergence");
    assert.match(divergence.detail, /preserved, never overwritten/iu);

    const reopen = resolveRecoveryReopenRefresh(projectId);
    assert.ok(reopen.refreshMethods.includes("events.replay"));
    const replayed = await connection.request("events.replay", {
      projectId,
      afterSequence: model.latestEventSequence,
    });
    assert.ok(Array.isArray(replayed.events));

    const acked = resolveRecoveryResume(model, {
      actor: "test",
      acknowledgeIntervention: true,
    });
    const { method, ...payload } = acked;
    const resumed = await connection.request(method, payload);
    assert.equal(resumed.status, "RESUMED");
    model = await readRecoveryModel(connection, projectId);
    assert.equal(model.projectState, "RUNNING");
    assert.equal(
      readFileSync(join(workspace, "user-note.txt"), "utf8"),
      "manual work must survive\n",
    );
  });
});
