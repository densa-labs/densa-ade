import { randomUUID } from "node:crypto";

import {
  eventIdSchema,
  isoTimestampSchema,
  jsonObjectSchema,
  permissionDecisionSchema,
  permissionDispositionSchema,
  permissionOperationSchema,
  permissionOverrideSchema,
  permissionPolicyConfigurationSchema,
  permissionPolicyPresetSchema,
  projectIdSchema,
  type DecisionId,
  type PermissionDecision,
  type PermissionDisposition,
  type PermissionOperation,
  type PermissionOverride,
  type PermissionPolicyConfiguration,
  type PermissionPolicyPreset,
  type ProjectId,
} from "@densa-ade/protocol";

import type { DensaAdeDatabase } from "./persistence/database.js";
import { redactSensitiveText } from "./secret-redaction.js";

const POLICY_SETTINGS_KEY = "permissionPolicy";

const PRESET_MATRIX = Object.freeze({
  cautious: Object.freeze({
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
  }),
  standard: Object.freeze({
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
  }),
  autonomous: Object.freeze({
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
  }),
} satisfies Readonly<
  Record<PermissionPolicyPreset, Readonly<Record<PermissionOperation, PermissionDisposition>>>
>);

/** These categories must retain a per-operation user decision even under Autonomous. */
const NEVER_PERSISTENTLY_ALLOW = new Set<PermissionOperation>([
  "access_outside_workspace",
  "secret_access",
  "privilege_escalation",
  "roadmap_scope_change",
  "remote_push",
]);

const issuedAuthorizations = new WeakSet<object>();
const AUTHORIZATION_ISSUER = Symbol("densa.permission-policy.issuer");

export class AuthorizedOperationContext {
  readonly projectId: ProjectId;
  readonly operation: PermissionOperation;
  readonly decisionId: string;
  readonly actor: string;
  readonly issuedAt: string;

  constructor(decision: PermissionDecision, issuer: symbol) {
    if (issuer !== AUTHORIZATION_ISSUER || decision.disposition !== "allow") {
      throw new PermissionPolicyError("Only the permission policy may issue authorization");
    }
    this.projectId = projectIdSchema.parse(decision.projectId);
    this.operation = decision.operation;
    this.decisionId = decision.decisionId;
    this.actor = decision.actor;
    this.issuedAt = decision.occurredAt;
    Object.freeze(this);
    issuedAuthorizations.add(this);
  }
}

function issueAuthorization(decision: PermissionDecision): AuthorizedOperationContext {
  return new AuthorizedOperationContext(decision, AUTHORIZATION_ISSUER);
}

export function assertAuthorizedOperation(
  authorization: AuthorizedOperationContext,
  projectId: ProjectId,
  operation: PermissionOperation,
): void {
  if (
    !issuedAuthorizations.has(authorization) ||
    authorization.projectId !== projectId ||
    authorization.operation !== operation
  ) {
    throw new PermissionPolicyError(
      `A valid ${operation} authorization for project ${projectId} is required`,
    );
  }
}

export interface PermissionAuthorizationRequest {
  readonly projectId: ProjectId;
  readonly operation: PermissionOperation;
  readonly actor: string;
  readonly reason: string;
  readonly occurredAt: string;
  readonly approvalDecisionId?: DecisionId;
  /** Exact persisted decision category that binds a one-operation approval to this request. */
  readonly approvalCategory?: string;
}

export type PermissionAuthorizationResult =
  | Readonly<{ decision: PermissionDecision; authorization: AuthorizedOperationContext }>
  | Readonly<{ decision: PermissionDecision; authorization?: never }>;

export interface PermissionPolicyChangeRequest {
  readonly projectId: ProjectId;
  readonly actor: string;
  readonly reason: string;
  readonly occurredAt: string;
}

export interface SetPermissionPresetRequest extends PermissionPolicyChangeRequest {
  readonly preset: PermissionPolicyPreset;
}

export interface SetPermissionOverrideRequest extends PermissionPolicyChangeRequest {
  readonly operation: PermissionOperation;
  readonly disposition: PermissionDisposition;
}

export interface ClearPermissionOverrideRequest extends PermissionPolicyChangeRequest {
  readonly operation: PermissionOperation;
}

export interface PermissionPolicyServiceOptions {
  readonly decisionIdFactory?: () => string;
  readonly eventIdFactory?: () => string;
}

export class PermissionPolicyError extends Error {
  readonly code = "PERMISSION_DENIED" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PermissionPolicyError";
  }
}

function defaultConfiguration(): PermissionPolicyConfiguration {
  return permissionPolicyConfigurationSchema.parse({
    formatVersion: 1,
    preset: "standard",
    overrides: [],
  });
}

function parseConfiguration(value: unknown): PermissionPolicyConfiguration {
  if (value === undefined) return defaultConfiguration();
  const parsed = permissionPolicyConfigurationSchema.safeParse(value);
  if (!parsed.success) {
    throw new PermissionPolicyError("Persisted permission policy configuration is malformed", {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

export function permissionPresetDisposition(
  presetInput: PermissionPolicyPreset,
  operationInput: PermissionOperation,
): PermissionDisposition {
  const preset = permissionPolicyPresetSchema.parse(presetInput);
  const operation = permissionOperationSchema.parse(operationInput);
  return PRESET_MATRIX[preset][operation];
}

export function evaluatePermissionPolicy(
  configurationInput: PermissionPolicyConfiguration,
  operationInput: PermissionOperation,
): Readonly<{
  preset: PermissionPolicyPreset;
  operation: PermissionOperation;
  disposition: PermissionDisposition;
  source: "preset" | "override";
}> {
  const configuration = permissionPolicyConfigurationSchema.parse(configurationInput);
  const operation = permissionOperationSchema.parse(operationInput);
  const override = configuration.overrides.find((candidate) => candidate.operation === operation);
  return Object.freeze({
    preset: configuration.preset,
    operation,
    disposition:
      override?.disposition ?? permissionPresetDisposition(configuration.preset, operation),
    source: override === undefined ? ("preset" as const) : ("override" as const),
  });
}

function immutableOverrides(overrides: readonly PermissionOverride[]): PermissionOverride[] {
  return [...overrides].sort((left, right) => left.operation.localeCompare(right.operation));
}

/** Core-owned policy boundary. It is the only issuer of side-effect authorization contexts. */
export class PermissionPolicyService {
  readonly #decisionIdFactory: () => string;
  readonly #eventIdFactory: () => string;

  constructor(
    private readonly database: DensaAdeDatabase,
    options: PermissionPolicyServiceOptions = {},
  ) {
    this.#decisionIdFactory =
      options.decisionIdFactory ?? (() => `permission-decision-${randomUUID()}`);
    this.#eventIdFactory = options.eventIdFactory ?? (() => `event-${randomUUID()}`);
  }

  getConfiguration(projectIdInput: ProjectId): PermissionPolicyConfiguration {
    const projectId = projectIdSchema.parse(projectIdInput);
    if (this.database.repositories.projects.findById(projectId) === undefined) {
      throw new PermissionPolicyError(`Permission policy project ${projectId} does not exist`);
    }
    return this.#configuration(projectId);
  }

  setPreset(request: SetPermissionPresetRequest): PermissionPolicyConfiguration {
    const projectId = projectIdSchema.parse(request.projectId);
    const preset = permissionPolicyPresetSchema.parse(request.preset);
    this.#validateChangeRequest(request);
    return this.#persistConfigurationChange(
      {
        ...request,
        projectId,
        actor: redactSensitiveText(request.actor),
        reason: redactSensitiveText(request.reason),
      },
      "PERMISSION_POLICY_PRESET_CHANGED",
      (current) => ({
        ...current,
        preset,
        updatedAt: request.occurredAt,
        updatedBy: redactSensitiveText(request.actor),
      }),
      { preset },
    );
  }

  setOverride(request: SetPermissionOverrideRequest): PermissionPolicyConfiguration {
    const projectId = projectIdSchema.parse(request.projectId);
    const operation = permissionOperationSchema.parse(request.operation);
    const disposition = permissionDispositionSchema.parse(request.disposition);
    this.#validateChangeRequest(request);
    if (disposition === "allow" && NEVER_PERSISTENTLY_ALLOW.has(operation)) {
      throw new PermissionPolicyError(
        `${operation} cannot be persistently allowed; it requires a per-operation user decision`,
      );
    }
    const override = permissionOverrideSchema.parse({
      operation,
      disposition,
      actor: redactSensitiveText(request.actor),
      reason: redactSensitiveText(request.reason),
      updatedAt: request.occurredAt,
    });
    return this.#persistConfigurationChange(
      {
        ...request,
        projectId,
        actor: redactSensitiveText(request.actor),
        reason: redactSensitiveText(request.reason),
      },
      "PERMISSION_POLICY_OVERRIDE_CHANGED",
      (current) => ({
        ...current,
        overrides: immutableOverrides([
          ...current.overrides.filter((candidate) => candidate.operation !== operation),
          override,
        ]),
        updatedAt: request.occurredAt,
        updatedBy: redactSensitiveText(request.actor),
      }),
      { operation, disposition },
    );
  }

  clearOverride(request: ClearPermissionOverrideRequest): PermissionPolicyConfiguration {
    const projectId = projectIdSchema.parse(request.projectId);
    const operation = permissionOperationSchema.parse(request.operation);
    this.#validateChangeRequest(request);
    return this.#persistConfigurationChange(
      {
        ...request,
        projectId,
        actor: redactSensitiveText(request.actor),
        reason: redactSensitiveText(request.reason),
      },
      "PERMISSION_POLICY_OVERRIDE_CLEARED",
      (current) => ({
        ...current,
        overrides: immutableOverrides(
          current.overrides.filter((candidate) => candidate.operation !== operation),
        ),
        updatedAt: request.occurredAt,
        updatedBy: redactSensitiveText(request.actor),
      }),
      { operation },
    );
  }

  authorize(requestInput: PermissionAuthorizationRequest): PermissionAuthorizationResult {
    const request = {
      ...requestInput,
      projectId: projectIdSchema.parse(requestInput.projectId),
      operation: permissionOperationSchema.parse(requestInput.operation),
      occurredAt: isoTimestampSchema.parse(requestInput.occurredAt),
      actor: redactSensitiveText(requestInput.actor),
      reason: redactSensitiveText(requestInput.reason),
    };
    if (request.actor.trim().length === 0 || request.reason.trim().length === 0) {
      throw new PermissionPolicyError("Permission decisions require a non-empty actor and reason");
    }
    if ((request.approvalDecisionId === undefined) !== (request.approvalCategory === undefined)) {
      throw new PermissionPolicyError(
        "Permission approvals require both a decision id and an exact approval category",
      );
    }
    if (this.database.repositories.projects.findById(request.projectId) === undefined) {
      throw new PermissionPolicyError(
        `Permission policy project ${request.projectId} does not exist`,
      );
    }
    return this.database.transaction((repositories) => {
      const configuration = this.#configuration(request.projectId);
      const evaluated = evaluatePermissionPolicy(configuration, request.operation);
      let disposition = evaluated.disposition;
      let source: PermissionDecision["source"] = evaluated.source;
      if (request.approvalDecisionId !== undefined) {
        const approval = repositories.decisions.findById(request.approvalDecisionId);
        if (
          approval?.projectId !== request.projectId ||
          approval.kind !== "decision" ||
          approval.source !== "user" ||
          approval.status !== "active"
        ) {
          throw new PermissionPolicyError(
            `Approval decision ${request.approvalDecisionId} is not an active user decision for project ${request.projectId}`,
          );
        }
        if (approval.category !== request.approvalCategory) {
          throw new PermissionPolicyError(
            `Approval decision ${request.approvalDecisionId} does not approve ${request.operation}`,
          );
        }
        if (disposition === "ask_user") {
          disposition = "allow";
          source = "user_approval";
        }
      }
      const decision = permissionDecisionSchema.parse({
        decisionId: this.#decisionIdFactory(),
        projectId: request.projectId,
        preset: configuration.preset,
        operation: request.operation,
        disposition,
        source,
        actor: request.actor,
        reason: request.reason,
        occurredAt: request.occurredAt,
        ...(request.approvalDecisionId === undefined
          ? {}
          : { approvalDecisionId: request.approvalDecisionId }),
      });
      if (decision.disposition !== "allow" || decision.source === "user_approval") {
        repositories.events.append({
          id: eventIdSchema.parse(this.#eventIdFactory()),
          projectId: request.projectId,
          type: "PERMISSION_DECISION_RECORDED",
          eventVersion: 1,
          occurredAt: request.occurredAt,
          actor: request.actor,
          payload: {
            decisionId: decision.decisionId,
            preset: decision.preset,
            operation: decision.operation,
            disposition: decision.disposition,
            source: decision.source,
            reason: decision.reason,
            ...(decision.approvalDecisionId === undefined
              ? {}
              : { approvalDecisionId: decision.approvalDecisionId }),
          },
        });
      }
      return decision.disposition === "allow"
        ? Object.freeze({ decision, authorization: issueAuthorization(decision) })
        : Object.freeze({ decision });
    });
  }

  #configuration(projectId: ProjectId): PermissionPolicyConfiguration {
    const settings = this.database.repositories.projectSettings.findByProjectId(projectId);
    const configured = settings?.values[POLICY_SETTINGS_KEY];
    if (
      configured === undefined &&
      settings?.values["allowSignificantRoadmapMutationAutoApply"] === true
    ) {
      return permissionPolicyConfigurationSchema.parse({
        formatVersion: 1,
        preset: "standard",
        overrides: [
          {
            operation: "roadmap_significant_change",
            disposition: "allow",
            actor: "densa-core:legacy-policy-migration",
            reason: "Preserve the explicit persisted significant-roadmap auto-apply setting",
            updatedAt: settings.updatedAt,
          },
        ],
        updatedAt: settings.updatedAt,
        updatedBy: "densa-core:legacy-policy-migration",
      });
    }
    return parseConfiguration(configured);
  }

  #validateChangeRequest(request: PermissionPolicyChangeRequest): void {
    projectIdSchema.parse(request.projectId);
    isoTimestampSchema.parse(request.occurredAt);
    if (request.actor.trim().length === 0 || request.reason.trim().length === 0) {
      throw new PermissionPolicyError("Permission policy changes require an actor and reason");
    }
  }

  #persistConfigurationChange(
    request: PermissionPolicyChangeRequest,
    eventType: string,
    mutate: (current: PermissionPolicyConfiguration) => PermissionPolicyConfiguration,
    payload: Readonly<Record<string, string>>,
  ): PermissionPolicyConfiguration {
    return this.database.transaction((repositories) => {
      if (repositories.projects.findById(request.projectId) === undefined) {
        throw new PermissionPolicyError(
          `Permission policy project ${request.projectId} does not exist`,
        );
      }
      const settings = repositories.projectSettings.findByProjectId(request.projectId);
      const safeActor = redactSensitiveText(request.actor);
      const safeReason = redactSensitiveText(request.reason);
      const current = parseConfiguration(settings?.values[POLICY_SETTINGS_KEY]);
      const next = permissionPolicyConfigurationSchema.parse(mutate(current));
      repositories.projectSettings.set({
        projectId: request.projectId,
        values: {
          ...(settings?.values ?? {}),
          [POLICY_SETTINGS_KEY]: jsonObjectSchema.parse(JSON.parse(JSON.stringify(next))),
        },
        updatedAt: request.occurredAt,
      });
      repositories.events.append({
        id: eventIdSchema.parse(this.#eventIdFactory()),
        projectId: request.projectId,
        type: eventType,
        eventVersion: 1,
        occurredAt: request.occurredAt,
        actor: safeActor,
        payload: { ...payload, reason: safeReason },
      });
      return next;
    });
  }
}
