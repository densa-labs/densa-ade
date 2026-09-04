import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  eventIdSchema,
  jsonObjectSchema,
  projectIdSchema,
  type DensaAdeErrorCode,
  type JsonObject,
  type Project,
  type ProjectId,
} from "@densa-ade/protocol";
import type { DensaAdeDatabase } from "./persistence/database.js";
import { redactSensitiveText } from "./secret-redaction.js";
import { stateTransitionService } from "./state-transitions.js";

export class CoreRuntimeError extends Error {
  constructor(
    readonly code: DensaAdeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CoreRuntimeError";
  }
}

/** Versioned runtime metadata lives in the existing transactional project-settings repository. */
export interface CoreRuntimeState {
  formatVersion: 1;
  workspacePath: string;
  initialIdea: string;
  actor: string;
  initialization: "pending" | "complete";
  lastError?: string;
  executionRequested?: boolean;
  taskApproval?: string;
  phaseApproval?: string;
}

export class CoreRuntimeStore {
  constructor(
    readonly database: DensaAdeDatabase,
    readonly now: () => string,
  ) {}

  project(id: string): Project {
    const project = this.database.repositories.projects.findById(projectIdSchema.parse(id));
    if (project === undefined)
      throw new CoreRuntimeError("USER_CONFIGURATION_ERROR", `Project ${id} does not exist`);
    return project;
  }

  state(id: ProjectId): CoreRuntimeState {
    this.project(id);
    const value =
      this.database.repositories.projectSettings.findByProjectId(id)?.values["coreRuntime"];
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      value["formatVersion"] !== 1 ||
      typeof value["workspacePath"] !== "string" ||
      !isAbsolute(value["workspacePath"]) ||
      typeof value["initialIdea"] !== "string" ||
      typeof value["actor"] !== "string" ||
      !["pending", "complete"].includes(String(value["initialization"])) ||
      (value["executionRequested"] !== undefined &&
        typeof value["executionRequested"] !== "boolean") ||
      ["lastError", "taskApproval", "phaseApproval"].some(
        (key) => value[key] !== undefined && typeof value[key] !== "string",
      )
    ) {
      throw new CoreRuntimeError(
        "PERSISTENCE_FAILURE",
        `Project ${id} has no valid Core v1 workspace binding; explicit initialization/migration is required`,
      );
    }
    return value as unknown as CoreRuntimeState;
  }

  write(id: ProjectId, state: CoreRuntimeState): void {
    const previous = this.database.repositories.projectSettings.findByProjectId(id);
    const old = previous?.values["coreRuntime"];
    if (
      old !== undefined &&
      typeof old === "object" &&
      old !== null &&
      !Array.isArray(old) &&
      old["workspacePath"] !== state.workspacePath
    ) {
      throw new CoreRuntimeError(
        "WORKSPACE_CONFLICT",
        "A canonical project workspace cannot be reassigned",
      );
    }
    this.database.repositories.projectSettings.set({
      projectId: id,
      updatedAt: this.now(),
      values: { ...previous?.values, coreRuntime: jsonObjectSchema.parse(state) },
    });
  }

  async workspace(id: ProjectId, requested?: string): Promise<string> {
    const expected = this.state(id).workspacePath;
    try {
      const current = await realpath(expected);
      if (current !== expected) {
        throw new CoreRuntimeError(
          "WORKSPACE_CONFLICT",
          "Requested workspace does not match the canonical project root",
        );
      }
      if (requested !== undefined) {
        if (!isAbsolute(requested)) {
          throw new CoreRuntimeError(
            "WORKSPACE_CONFLICT",
            "Requested workspace does not match the canonical project root",
          );
        }
        let resolved: string;
        try {
          resolved = await realpath(requested);
        } catch {
          throw new CoreRuntimeError(
            "WORKSPACE_CONFLICT",
            "Requested workspace does not match the canonical project root",
          );
        }
        if (resolved !== expected) {
          throw new CoreRuntimeError(
            "WORKSPACE_CONFLICT",
            "Requested workspace does not match the canonical project root",
          );
        }
      }
      return current;
    } catch (error) {
      if (error instanceof CoreRuntimeError) throw error;
      throw new CoreRuntimeError(
        "WORKSPACE_CONFLICT",
        "Canonical workspace is unavailable; revalidate the project binding",
      );
    }
  }

  event(id: ProjectId, type: string, actor: string, payload: JsonObject = {}): void {
    this.database.repositories.events.append({
      id: eventIdSchema.parse(`runtime-${randomUUID()}`),
      projectId: id,
      type,
      eventVersion: 1,
      occurredAt: this.now(),
      actor: redactSensitiveText(actor),
      payload,
    });
  }

  transition(id: ProjectId, next: Project["state"], actor: string, reason: string): void {
    const project = this.project(id);
    if (project.state === next) return;
    this.database.persistStateTransition(
      stateTransitionService.transitionProject(project, next, {
        actor: redactSensitiveText(actor),
        occurredAt: this.now(),
        reason,
      }),
      eventIdSchema.parse(`runtime-${randomUUID()}`),
    );
  }
}

export function jsonValue(value: unknown): JsonObject {
  return jsonObjectSchema.parse(JSON.parse(JSON.stringify(value)));
}

/** Cursor binds its position to the requested collection, never to a caller-selected DB query. */
export function paginate<T>(
  values: readonly T[],
  scope: string,
  cursor?: string,
  limit = 50,
): {
  items: readonly T[];
  page: { hasMore: boolean; nextCursor?: string };
} {
  const digest = createHash("sha256").update(scope).digest("hex").slice(0, 24);
  let offset = 0;
  if (cursor !== undefined) {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const match = new RegExp(`^${digest}:([0-9]+)$`, "u").exec(decoded);
    offset = Number(match?.[1]);
    if (
      match === null ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > values.length ||
      Buffer.from(decoded).toString("base64url") !== cursor
    ) {
      throw new CoreRuntimeError(
        "USER_CONFIGURATION_ERROR",
        "Invalid or differently scoped pagination cursor",
      );
    }
  }
  const items = values.slice(offset, offset + limit);
  const end = offset + items.length;
  return {
    items,
    page:
      end < values.length
        ? { hasMore: true, nextCursor: Buffer.from(`${digest}:${end}`).toString("base64url") }
        : { hasMore: false },
  };
}

export async function canonicalWorkspace(path: string): Promise<string> {
  if (!isAbsolute(path))
    throw new CoreRuntimeError("USER_CONFIGURATION_ERROR", "Workspace must be absolute");
  return await realpath(resolve(path));
}
