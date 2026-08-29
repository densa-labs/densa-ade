import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  AuthorizedOperationContext,
  PermissionPolicyError,
  PermissionPolicyService,
  RunCheckpointService,
  assertAuthorizedOperation,
  evaluatePermissionPolicy,
  permissionPresetDisposition,
} from "@densa/core";
import { DensaDatabase } from "@densa/core/persistence";
import { permissionOperationSchema } from "@densa/protocol";

const createdAt = "2026-08-29T01:00:00.000Z";
const projectId = "project-permission-policy";

const expectedMatrix = {
  cautious: {
    read_workspace: "allow",
    write_workspace: "ask_user",
    access_outside_workspace: "deny",
    install_dependency: "ask_user",
    network_access: "ask_user",
    git_mutation: "ask_user",
    destructive_file_operation: "ask_user",
    secret_access: "deny",
    privilege_escalation: "deny",
    roadmap_significant_change: "ask_user",
    roadmap_scope_change: "ask_user",
    remote_push: "deny",
  },
  standard: {
    read_workspace: "allow",
    write_workspace: "allow",
    access_outside_workspace: "ask_user",
    install_dependency: "ask_user",
    network_access: "ask_user",
    git_mutation: "allow",
    destructive_file_operation: "allow",
    secret_access: "ask_user",
    privilege_escalation: "ask_user",
    roadmap_significant_change: "ask_user",
    roadmap_scope_change: "ask_user",
    remote_push: "ask_user",
  },
  autonomous: {
    read_workspace: "allow",
    write_workspace: "allow",
    access_outside_workspace: "ask_user",
    install_dependency: "allow",
    network_access: "allow",
    git_mutation: "allow",
    destructive_file_operation: "allow",
    secret_access: "ask_user",
    privilege_escalation: "ask_user",
    roadmap_significant_change: "allow",
    roadmap_scope_change: "ask_user",
    remote_push: "ask_user",
  },
};

function project() {
  return {
    id: projectId,
    name: "Permission policy proof",
    state: "DRAFT",
    executionMode: "guided",
    createdAt,
    updatedAt: createdAt,
  };
}

function eventIdFactory(prefix = "event-policy") {
  let index = 0;
  return () => `${prefix}-${String(++index)}`;
}

function decisionIdFactory() {
  let index = 0;
  return () => `permission-decision-${String(++index)}`;
}

function service(database, prefix) {
  return new PermissionPolicyService(database, {
    eventIdFactory: eventIdFactory(prefix),
    decisionIdFactory: decisionIdFactory(),
  });
}

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

test("all presets define every operation, including non-overridable sensitive categories", () => {
  for (const [preset, expected] of Object.entries(expectedMatrix)) {
    assert.deepEqual(Object.keys(expected).sort(), [...permissionOperationSchema.options].sort());
    for (const operation of permissionOperationSchema.options) {
      assert.equal(permissionPresetDisposition(preset, operation), expected[operation]);
      assert.equal(
        evaluatePermissionPolicy({ formatVersion: 1, preset, overrides: [] }, operation)
          .disposition,
        expected[operation],
      );
    }
  }
  for (const operation of [
    "access_outside_workspace",
    "secret_access",
    "privilege_escalation",
    "roadmap_scope_change",
    "remote_push",
  ]) {
    assert.notEqual(permissionPresetDisposition("autonomous", operation), "allow");
  }
});

test("ask and deny decisions are audited, while explicit approvals issue unforgeable contexts", () => {
  const database = DensaDatabase.openInMemory();
  database.repositories.projects.create(project());
  database.repositories.decisions.create({
    id: "decision-user-approved-scope",
    projectId,
    kind: "decision",
    statement: "Approve one scope change.",
    title: "Approve one scope change",
    rationale: "The user explicitly accepted this bounded operation.",
    category: "approval.roadmap-scope-change",
    source: "user",
    scope: "project",
    status: "active",
    affectedPhaseIds: [],
    affectedTaskIds: [],
    createdAt,
  });
  const policy = service(database, "event-policy-decision");
  policy.setPreset({
    projectId,
    preset: "cautious",
    actor: "user:test",
    reason: "Use the most restrictive preset",
    occurredAt: "2026-08-29T01:01:00.000Z",
  });

  const ask = policy.authorize({
    projectId,
    operation: "write_workspace",
    actor: "worker:test",
    reason: "Write a generated file",
    occurredAt: "2026-08-29T01:02:00.000Z",
  });
  assert.equal(ask.decision.disposition, "ask_user");
  assert.equal(ask.authorization, undefined);

  const denied = policy.authorize({
    projectId,
    operation: "privilege_escalation",
    actor: "worker:test",
    reason: "Attempt an elevated command",
    occurredAt: "2026-08-29T01:03:00.000Z",
  });
  assert.equal(denied.decision.disposition, "deny");

  const approved = policy.authorize({
    projectId,
    operation: "roadmap_scope_change",
    actor: "master:test",
    reason: "Apply the specifically approved scope change",
    occurredAt: "2026-08-29T01:04:00.000Z",
    approvalDecisionId: "decision-user-approved-scope",
  });
  assert.equal(approved.decision.disposition, "allow");
  assert.equal(approved.decision.source, "user_approval");
  assertAuthorizedOperation(approved.authorization, projectId, "roadmap_scope_change");
  assert.throws(
    () => assertAuthorizedOperation({}, projectId, "roadmap_scope_change"),
    PermissionPolicyError,
  );
  assert.throws(
    () => new AuthorizedOperationContext(approved.decision, Symbol("forged")),
    PermissionPolicyError,
  );
  assert.throws(
    () => assertAuthorizedOperation(approved.authorization, projectId, "remote_push"),
    PermissionPolicyError,
  );

  assert.deepEqual(
    database.repositories.events
      .replay({ projectId })
      .map((event) => [event.type, event.payload.disposition]),
    [
      ["PERMISSION_POLICY_PRESET_CHANGED", undefined],
      ["PERMISSION_DECISION_RECORDED", "ask_user"],
      ["PERMISSION_DECISION_RECORDED", "deny"],
      ["PERMISSION_DECISION_RECORDED", "allow"],
    ],
  );
  database.close();
});

test("explicit overrides persist across restart and cannot silently allow dangerous categories", () => {
  const root = mkdtempSync(join(tmpdir(), "densa-permission-policy-persistence-"));
  const databasePath = join(root, "runtime.sqlite");
  try {
    let database = DensaDatabase.open(databasePath);
    database.repositories.projects.create(project());
    const policy = service(database, "event-policy-override");
    const configured = policy.setOverride({
      projectId,
      operation: "install_dependency",
      disposition: "allow",
      actor: "user:test",
      reason: "Allow dependency installation for this project",
      occurredAt: "2026-08-29T01:05:00.000Z",
    });
    assert.equal(configured.overrides[0].operation, "install_dependency");
    assert.throws(
      () =>
        policy.setOverride({
          projectId,
          operation: "remote_push",
          disposition: "allow",
          actor: "user:test",
          reason: "Attempt a broad push override",
          occurredAt: "2026-08-29T01:06:00.000Z",
        }),
      /per-operation user decision/u,
    );
    database.close();

    database = DensaDatabase.open(databasePath);
    const reopened = service(database, "event-policy-reopened");
    assert.equal(reopened.getConfiguration(projectId).overrides[0].disposition, "allow");
    const allowed = reopened.authorize({
      projectId,
      operation: "install_dependency",
      actor: "worker:test",
      reason: "Install the accepted dependency",
      occurredAt: "2026-08-29T01:07:00.000Z",
    });
    assert.equal(allowed.decision.disposition, "allow");
    assert.equal(allowed.decision.source, "override");
    assertAuthorizedOperation(allowed.authorization, projectId, "install_dependency");
    database.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a sensitive Git boundary stops before mutation when policy does not issue a context", async () => {
  const root = mkdtempSync(join(tmpdir(), "densa-permission-policy-boundary-"));
  const repository = join(root, "workspace");
  try {
    git(root, ["init", "--quiet", "--initial-branch=main", repository]);
    writeFileSync(join(repository, "tracked.txt"), "baseline\n", "utf8");
    git(repository, ["add", "--all"]);
    git(repository, [
      "-c",
      "user.name=Densa Fixture",
      "-c",
      "user.email=densa-fixture@localhost",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "fixture: baseline",
    ]);
    const database = DensaDatabase.openInMemory();
    database.repositories.projects.create(project());
    const phase = {
      id: "phase-policy-boundary",
      projectId,
      title: "Policy boundary",
      state: "PENDING",
      position: 0,
      createdAt,
      updatedAt: createdAt,
    };
    const taskRecord = {
      id: "task-policy-boundary",
      projectId,
      phaseId: phase.id,
      title: "Do not bypass policy",
      state: "PENDING",
      position: 0,
      acceptanceCriteria: ["The branch is not mutated"],
      dependencyIds: [],
      createdAt,
      updatedAt: createdAt,
    };
    database.repositories.phases.create(phase);
    database.repositories.tasks.create(taskRecord);
    database.repositories.attempts.create({
      id: "attempt-policy-boundary",
      taskId: taskRecord.id,
      number: 1,
      startedAt: createdAt,
    });
    service(database, "event-policy-boundary").setPreset({
      projectId,
      preset: "cautious",
      actor: "user:test",
      reason: "Require approval for Git changes",
      occurredAt: "2026-08-29T01:08:00.000Z",
    });
    const initialBranch = git(repository, ["branch", "--show-current"]).trim();
    const result = await new RunCheckpointService(database).prepareTask({
      projectId,
      taskId: taskRecord.id,
      attemptId: "attempt-policy-boundary",
      checkpointId: "checkpoint-policy-boundary",
      runActivatedEventId: "event-run-policy-boundary",
      checkpointEventId: "event-checkpoint-policy-boundary",
      workspacePath: repository,
      createdAt: "2026-08-29T01:09:00.000Z",
      actor: "densa-core:test",
    });
    assert.equal(result.status, "STOPPED");
    assert.equal(result.code, "POLICY_ASK_USER");
    assert.equal(git(repository, ["branch", "--show-current"]).trim(), initialBranch);
    assert.equal(git(repository, ["branch", "--list", "densa/run/*"]).trim(), "");
    assert.equal(database.repositories.densaRunBranches.findByProjectId(projectId), undefined);
    assert.equal(
      database.repositories.events.replay({ projectId }).at(-1).payload.disposition,
      "ask_user",
    );
    database.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
