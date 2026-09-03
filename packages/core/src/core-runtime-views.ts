import {
  CORE_V1_METHODS,
  PROTOCOL_VERSION,
  parseCoreV1Payload,
  projectIdSchema,
  phaseIdSchema,
  taskIdSchema,
  validationRunIdSchema,
  usageStateSchema,
  type CoreV1PendingApproval,
  type ProjectId,
  type RequestEnvelope,
  type UsageState,
} from "@densa-ade/protocol";
import type { KeepAwakeManager } from "./keep-awake.js";
import { PermissionPolicyService } from "./permission-policy.js";
import { CoreRuntimeError, CoreRuntimeStore, paginate } from "./core-runtime-state.js";
import { WorkspacePreflight } from "./workspace-preflight.js";
import { runProofCommand } from "./task-proof-harness.js";
import { SecretRedactor } from "./secret-redaction.js";

/** Read views derive from persisted facts. They never manufacture completion or availability. */
export class CoreRuntimeViews {
  constructor(
    readonly store: CoreRuntimeStore,
    readonly keepAwake: KeepAwakeManager,
    readonly instanceId: string,
  ) {}

  get db() {
    return this.store.database;
  }

  usage(id: ProjectId): UsageState {
    const project = this.store.project(id);
    if (project.state === "WAITING_FOR_USAGE") {
      const event = this.db.repositories.events.latest(id, { types: ["USAGE_LIMIT_REACHED"] });
      const parsed = usageStateSchema.safeParse(event?.payload["usageState"]);
      if (parsed.success && parsed.data.status === "limited") return parsed.data;
      return {
        status: "unknown",
        reason: "Usage wait has no valid persisted provider observation",
      };
    }
    return { status: "unknown", reason: "No current provider availability observation" };
  }

  approvals(id: ProjectId): CoreV1PendingApproval[] {
    const result: CoreV1PendingApproval[] = [];
    const project = this.store.project(id);
    for (const phase of this.db.repositories.phases.listByProjectId(id)) {
      if (phase.state === "AWAITING_APPROVAL")
        result.push({
          kind: "phase",
          projectId: id,
          phaseId: phase.id,
          requestedAt: phase.updatedAt,
          summary: `Approve validated phase: ${phase.title}`,
        });
    }
    if (project.executionMode === "guided") {
      for (const task of this.db.repositories.tasks.listByProjectId(id)) {
        const requested = this.db.repositories.events.latest(id, {
          taskId: task.id,
          types: ["GUIDED_TASK_APPROVAL_REQUIRED", "TASK_APPROVAL_REQUIRED"],
        });
        const approved = this.db.repositories.events.latest(id, {
          taskId: task.id,
          types: [
            "GUIDED_TASK_APPROVED",
            "GUIDED_TASK_APPROVAL_SUPERSEDED",
            "TASK_APPROVED",
            "TASK_APPROVAL_SUPERSEDED",
          ],
        });
        if (
          requested !== undefined &&
          (approved === undefined || approved.sequenceNumber < requested.sequenceNumber)
        ) {
          result.push({
            kind: "task",
            projectId: id,
            phaseId: task.phaseId,
            taskId: task.id,
            requestedAt: requested.occurredAt,
            summary: `Continue after validated task: ${task.title}`,
          });
        }
      }
    }
    for (const proposal of this.db.repositories.roadmapRevisionProposals.listByProjectId(id)) {
      if (proposal.status === "awaiting_approval")
        result.push({
          kind: "roadmap_revision",
          projectId: id,
          proposal,
          requestedAt: proposal.createdAt,
          summary: proposal.rationale,
        });
    }
    const requests = this.db.eventJournal.replay({
      projectId: id,
      types: ["RUNTIME_PERMISSION_REQUESTED", "PERMISSION_DECISION_RECORDED"],
      limit: 1_000,
    });
    const resolutions = this.db.eventJournal.replay({
      projectId: id,
      types: ["RUNTIME_PERMISSION_RESOLVED"],
      limit: 1_000,
    });
    for (const request of requests) {
      if (
        request.type === "PERMISSION_DECISION_RECORDED" &&
        request.payload["disposition"] !== "ask_user"
      )
        continue;
      const key =
        request.type === "RUNTIME_PERMISSION_REQUESTED"
          ? request.id
          : String(request.payload["decisionId"] ?? request.id);
      const isResolved = resolutions.some(
        (entry) =>
          String(entry.payload["decisionId"] ?? "") === key &&
          entry.sequenceNumber > request.sequenceNumber,
      );
      if (!isResolved) {
        const reason =
          typeof request.payload["reason"] === "string"
            ? String(request.payload["reason"])
            : `Resolve permission request ${request.id}`;
        result.push({
          kind: "permission",
          projectId: id,
          decisionId: key,
          requestedAt: request.occurredAt,
          summary: reason.slice(0, 1024) || `Resolve permission request ${request.id}`,
        });
      }
    }
    return result;
  }

  summary(id: ProjectId) {
    const project = this.store.project(id);
    const phases = this.db.repositories.phases.listByProjectId(id);
    const tasks = this.db.repositories.tasks.listByProjectId(id);
    const phase = phases.find((entry) => entry.state !== "COMPLETED");
    let workspacePath: string;
    try {
      workspacePath = this.store.state(id).workspacePath;
    } catch {
      const run = this.db.repositories.densaAdeRunBranches.findByProjectId(id);
      workspacePath =
        run?.sourceWorkspacePath ?? run?.workspacePath ?? `/tmp/densa-ade-unbound-${String(id)}`;
    }
    return {
      project,
      workspacePath,
      ...(phase === undefined ? {} : { currentPhaseId: phase.id }),
      completedTaskCount: tasks.filter((task) => task.state === "COMPLETED").length,
      totalTaskCount: tasks.length,
      attentionRequired:
        ["BLOCKED", "FAILED", "WAITING_FOR_USER"].includes(project.state) ||
        this.approvals(id).length > 0,
    };
  }

  settings(id: ProjectId) {
    const project = this.store.project(id);
    return {
      projectId: id,
      executionMode: project.executionMode,
      permissionPolicy: new PermissionPolicyService(this.db).getConfiguration(id),
      keepAwakeBatteryPolicy: this.keepAwake.status(id).batteryPolicy,
      telemetryEnabled: false as const,
      updatedAt:
        this.db.repositories.projectSettings.findByProjectId(id)?.updatedAt ?? project.updatedAt,
    };
  }

  assertTask(id: ProjectId, taskId: string) {
    const task = this.db.repositories.tasks.findById(taskIdSchema.parse(taskId));
    if (task?.projectId !== id)
      throw new CoreRuntimeError(
        "USER_CONFIGURATION_ERROR",
        "Task does not belong to the selected project",
      );
    return task;
  }

  async dispatch(request: RequestEnvelope): Promise<unknown | undefined> {
    switch (request.method) {
      case "system.bootstrap": {
        parseCoreV1Payload("system.bootstrap", request.payload);
        const page = paginate(this.db.repositories.projects.list(), "projects");
        return {
          protocolVersion: PROTOCOL_VERSION,
          serverInstanceId: this.instanceId,
          capabilities: [...CORE_V1_METHODS],
          projects: page.items.map((project) => this.summary(project.id)),
          projectsPage: page.page,
        };
      }
      case "projects.list": {
        const p = parseCoreV1Payload("projects.list", request.payload);
        const page = paginate(this.db.repositories.projects.list(), "projects", p.cursor, p.limit);
        return { projects: page.items.map((project) => this.summary(project.id)), page: page.page };
      }
      case "projects.get": {
        const p = parseCoreV1Payload("projects.get", request.payload);
        const id = projectIdSchema.parse(p.projectId);
        const specification =
          this.db.repositories.specifications.findByProjectId(id)?.specification;
        const roadmap = this.db.repositories.masterRoadmaps.findByProjectId(id);
        return {
          summary: this.summary(id),
          ...(specification === undefined ? {} : { specification }),
          ...(roadmap === undefined ? {} : { roadmap }),
          phases: this.db.repositories.phases.listByProjectId(id),
          tasks: this.db.repositories.tasks.listByProjectId(id),
          pendingApprovals: this.approvals(id),
          usage: this.usage(id),
          latestEventSequence: this.db.repositories.events.latest(id)?.sequenceNumber ?? 0,
        };
      }
      case "projects.specification.get": {
        const p = parseCoreV1Payload("projects.specification.get", request.payload);
        const projectId = this.store.project(p.projectId).id;
        const specification =
          this.db.repositories.specifications.findByProjectId(projectId)?.specification;
        if (specification === undefined)
          throw new CoreRuntimeError(
            "USER_CONFIGURATION_ERROR",
            "Project interview has not completed",
          );
        return { projectId, specification };
      }
      case "roadmaps.get": {
        const p = parseCoreV1Payload("roadmaps.get", request.payload);
        const id = this.store.project(p.projectId).id;
        const roadmap = this.db.repositories.masterRoadmaps.findByProjectId(id);
        if (roadmap === undefined)
          throw new CoreRuntimeError("USER_CONFIGURATION_ERROR", "Project has no approved roadmap");
        return roadmap;
      }
      case "dashboard.get": {
        const p = parseCoreV1Payload("dashboard.get", request.payload);
        const id = this.store.project(p.projectId).id;
        const phases = this.db.repositories.phases.listByProjectId(id);
        const tasks = this.db.repositories.tasks.listByProjectId(id);
        const runs = tasks.flatMap((task) =>
          this.db.repositories.validationRuns.listByTaskId(task.id),
        );
        const attempts = tasks.flatMap((task) =>
          this.db.repositories.attempts.listByTaskId(task.id),
        );
        const counts = (records: readonly { state: string }[]) =>
          [...new Set(records.map((r) => r.state))].map((state) => ({
            state,
            count: records.filter((r) => r.state === state).length,
          }));
        const currentPhase = phases.find((phase) => phase.state !== "COMPLETED");
        const currentTask = tasks.find((task) =>
          ["RUNNING", "VALIDATING", "RETRYING", "WAITING_FOR_USAGE"].includes(task.state),
        );
        return {
          project: this.summary(id),
          phaseCounts: counts(phases),
          taskCounts: counts(tasks),
          ...(currentPhase === undefined ? {} : { currentPhase }),
          ...(currentTask === undefined ? {} : { currentTask }),
          pendingApprovals: this.approvals(id),
          recentFailureCount: runs.filter((run) => run.passed === false).length,
          retryCount: attempts.filter((attempt) => attempt.number > 1).length,
          validation: {
            passed: runs.filter((run) => run.passed === true).length,
            failed: runs.filter((run) => run.passed === false).length,
            incomplete: runs.filter((run) => run.completedAt === undefined).length,
          },
          usage: this.usage(id),
          keepAwake: this.keepAwake.status(id),
          latestEventSequence: this.db.repositories.events.latest(id)?.sequenceNumber ?? 0,
        };
      }
      case "settings.get": {
        const p = parseCoreV1Payload("settings.get", request.payload);
        return this.settings(this.store.project(p.projectId).id);
      }
      case "usage.get": {
        const p = parseCoreV1Payload("usage.get", request.payload);
        const id = this.store.project(p.projectId).id;
        const event = this.db.repositories.events.latest(id, { types: ["USAGE_LIMIT_REACHED"] });
        return {
          projectId: id,
          usage: this.usage(id),
          observedAt: event?.occurredAt ?? this.store.now(),
        };
      }
      case "phases.report.get": {
        const p = parseCoreV1Payload("phases.report.get", request.payload);
        this.store.project(p.projectId);
        const report = this.db.repositories.phaseReports.findByPhaseId(
          phaseIdSchema.parse(p.phaseId),
        );
        if (report?.projectId !== p.projectId)
          throw new CoreRuntimeError(
            "USER_CONFIGURATION_ERROR",
            "Phase report does not exist in this project",
          );
        return report;
      }
      case "decisions.list": {
        const p = parseCoreV1Payload("decisions.list", request.payload);
        const id = this.store.project(p.projectId).id;
        const page = paginate(
          this.db.repositories.decisions.listByProjectId(id),
          `decisions:${id}`,
          p.cursor,
          p.limit,
        );
        return { decisions: page.items, page: page.page };
      }
      case "roadmaps.revisions.list": {
        const p = parseCoreV1Payload("roadmaps.revisions.list", request.payload);
        const id = this.store.project(p.projectId).id;
        const page = paginate(
          this.db.repositories.roadmapRevisions.listByProjectId(id),
          `revisions:${id}`,
          p.cursor,
          p.limit,
        );
        return { revisions: page.items, page: page.page };
      }
      case "attempts.list":
      case "validation.list": {
        const method = request.method;
        const p = parseCoreV1Payload(method, request.payload);
        const id = this.store.project(p.projectId).id;
        const task = this.assertTask(id, p.taskId);
        if (method === "attempts.list") {
          const page = paginate(
            this.db.repositories.attempts.listByTaskId(task.id),
            `attempts:${id}:${task.id}`,
            p.cursor,
            p.limit,
          );
          return { attempts: page.items, page: page.page };
        }
        const page = paginate(
          this.db.repositories.validationRuns.listByTaskId(task.id),
          `validation:${id}:${task.id}`,
          p.cursor,
          p.limit,
        );
        return { runs: page.items, page: page.page };
      }
      case "validation.get": {
        const p = parseCoreV1Payload("validation.get", request.payload);
        const id = this.store.project(p.projectId).id;
        const run = this.db.repositories.validationRuns.findById(
          validationRunIdSchema.parse(p.validationRunId),
        );
        if (run === undefined)
          throw new CoreRuntimeError("USER_CONFIGURATION_ERROR", "Validation run does not exist");
        this.assertTask(id, String(run.taskId));
        return { run, results: this.db.repositories.validationResults.listByRunId(run.id) };
      }
      case "logs.list": {
        const p = parseCoreV1Payload("logs.list", request.payload);
        const id = this.store.project(p.projectId).id;
        if (p.taskId !== undefined) this.assertTask(id, p.taskId);
        const events = [];
        let afterSequence = 0;
        for (;;) {
          const batch = this.db.eventJournal.replay({ projectId: id, afterSequence, limit: 1_000 });
          events.push(...batch);
          if (events.length > 100_000)
            throw new CoreRuntimeError(
              "USER_CONFIGURATION_ERROR",
              "Log history requires a narrower retained window",
            );
          if (batch.length < 1_000) break;
          afterSequence = batch.at(-1)?.sequenceNumber ?? afterSequence;
        }
        const filtered = events.filter(
          (event) =>
            (p.phaseId === undefined || event.phaseId === p.phaseId) &&
            (p.taskId === undefined || event.taskId === p.taskId) &&
            (p.attemptId === undefined || event.payload["attemptId"] === p.attemptId),
        );
        const scope = `logs:${id}:${p.phaseId ?? ""}:${p.taskId ?? ""}:${p.attemptId ?? ""}`;
        const page = paginate(filtered, scope, p.cursor, p.limit);
        return {
          entries: page.items.map((event) => ({
            cursor: Buffer.from(`${scope}:${event.sequenceNumber}`).toString("base64url"),
            projectId: id,
            occurredAt: event.occurredAt,
            source: event.type === "RUN_LOG_APPENDED" ? "worker" : "core",
            level: /FAILED|ERROR/u.test(event.type) ? "error" : "info",
            message: new SecretRedactor()
              .text(
                typeof event.payload["message"] === "string"
                  ? event.payload["message"]
                  : event.type,
              )
              .slice(0, 16 * 1_024),
            ...(event.phaseId === undefined ? {} : { phaseId: event.phaseId }),
            ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
            ...(p.attemptId === undefined ? {} : { attemptId: p.attemptId }),
            redacted: true,
          })),
          page: page.page,
        };
      }
      case "git.status": {
        const p = parseCoreV1Payload("git.status", request.payload);
        const id = this.store.project(p.projectId).id;
        const workspacePath = await this.store.workspace(id, p.workspacePath);
        const probe = await new WorkspacePreflight().inspect(workspacePath);
        const changedPaths = [
          ...new Set([
            ...probe.changes.staged.map((c) => c.path),
            ...probe.changes.unstaged.map((c) => c.path),
            ...probe.changes.untracked,
          ]),
        ];
        if (changedPaths.length > 200)
          throw new CoreRuntimeError(
            "USER_CONFIGURATION_ERROR",
            "Git status exceeds the 200-path view bound",
          );
        return {
          projectId: id,
          workspacePath,
          available: probe.head.commit !== undefined,
          ...(probe.head.commit === undefined
            ? { reason: probe.decision.reason }
            : { headSha: probe.head.commit }),
          ...(probe.head.branch === undefined ? {} : { branch: probe.head.branch }),
          dirty: probe.changes.dirty,
          changedPaths,
          observedAt: this.store.now(),
        };
      }
      case "git.commit.get": {
        const p = parseCoreV1Payload("git.commit.get", request.payload);
        const id = this.store.project(p.projectId).id;
        const root = await this.store.workspace(id);
        const detail = await runProofCommand(
          "git",
          ["-c", "core.fsmonitor=false", "show", "-s", "--format=%H%n%s%n%aI", `${p.sha}^{commit}`],
          root,
        );
        if (detail.exitCode !== 0 || detail.timedOut || detail.stdoutTruncated)
          throw new CoreRuntimeError(
            "GIT_FAILURE",
            "Commit detail could not be read unambiguously",
          );
        const [sha, subject, authoredAt] = detail.stdout.trim().split("\n");
        if (sha === undefined) throw new CoreRuntimeError("GIT_FAILURE", "Missing commit SHA");
        const reachable = await runProofCommand(
          "git",
          ["merge-base", "--is-ancestor", sha, "HEAD"],
          root,
        );
        if (reachable.exitCode !== 0 && reachable.exitCode !== 1)
          throw new CoreRuntimeError("GIT_FAILURE", "Commit reachability inspection failed");
        const paths = await runProofCommand(
          "git",
          ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", sha],
          root,
        );
        if (paths.exitCode !== 0 || paths.stdoutTruncated)
          throw new CoreRuntimeError("GIT_FAILURE", "Commit paths could not be read completely");
        const attempt = this.db.repositories.tasks
          .listByProjectId(id)
          .flatMap((task) => this.db.repositories.attempts.listByTaskId(task.id))
          .find((a) => a.commitSha === sha);
        return {
          sha,
          subject,
          authoredAt,
          reachable: reachable.exitCode === 0,
          changedPaths: paths.stdout.split("\0").filter(Boolean),
          ...(attempt === undefined ? {} : { taskId: attempt.taskId, attemptId: attempt.id }),
        };
      }
      default:
        return undefined;
    }
  }
}
