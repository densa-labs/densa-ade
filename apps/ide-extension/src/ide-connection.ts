// Copyright 2026 Densa Labs
// SPDX-License-Identifier: Apache-2.0

/**
 * Protocol-only IDE connection to Densa ADE Core (Phase 10 Milestone 1).
 *
 * The IDE is a disposable client of the durable Core daemon:
 *
 * - discovery: probe the user-local Unix socket (`core.status`); a missing
 *   socket with no live owner PID means `stopped`, a live owner PID with no
 *   endpoint is an explicit error, never a silent `stopped`;
 * - start: delegate to an injected starter (tests use the real Core daemon,
 *   production shells to `densa-ade core start` or a detached daemon entry).
 *   The connection layer never imports `@densa-ade/core` or SQLite;
 * - handshake: `core.status` + `system.bootstrap` version check. A mismatch
 *   fails closed with `PROTOCOL_VERSION_MISMATCH` and leaves cached project
 *   truth untouched;
 * - reconnect: disposable socket, durable Core. Reconnect replays from the
 *   last durably applied per-project sequence and re-subscribes; duplicates
 *   are ignored, gaps require a fresh replay;
 * - commands: every mutation goes through the versioned `CoreV1Client`
 *   facade. The IDE never invents project state locally.
 *
 * Closing the IDE window calls `disconnect()` only. Core keeps running while
 * project policy allows it; connection loss never changes project truth.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  CORE_EVENT_NOTIFICATION,
  CORE_V1_METHODS,
  PROTOCOL_VERSION,
  CoreV1Client,
  coreDaemonStatusSchema,
  coreV1PersistedEventSchema,
  parseCoreV1Notification,
  requestEnvelopeSchema,
  type CoreDaemonLifecycleStatus,
  type CoreDaemonStatus,
  type CoreV1Method,
  type CoreV1Payload,
  type CoreV1Result,
  type CoreV1PersistedEvent,
  type JsonValue,
  type NotificationEnvelope,
  type RequestEnvelope,
} from "@densa-ade/protocol";

import { IdeProjectEventCache, IdeEventCache } from "./event-cache.js";
import { IdeCoreIpcError, IdeCoreIpcTransport } from "./ide-transport.js";
import {
  ideCoreProcessExists,
  ideCoreRuntimePaths,
  parseIdeCoreProcessState,
} from "./runtime-paths.js";
import { assertCompatibleProtocol } from "./connection.js";

export type IdeConnectionState =
  "disconnected" | "connecting" | "connected" | "version-mismatch" | "auth-failed";

export interface IdeConnectionStatus {
  readonly state: IdeConnectionState;
  readonly instanceId?: string;
  readonly protocolVersion?: string;
  readonly detail?: string;
}

export interface IdeCoreStarter {
  /** Start Core when discovery reports `stopped`. Must resolve once `core.status` succeeds. */
  start(): Promise<void>;
}

export interface IdeCoreSessionOptions {
  readonly runtimeDirectory?: string;
  readonly connectTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly createRequestId?: () => string;
  readonly transport?: IdeCoreIpcTransport;
  readonly starter?: IdeCoreStarter;
}

function createRequestIdFallback(): string {
  return randomUUID();
}

function asRecord(value: JsonValue): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new IdeCoreIpcError({
      code: "USER_CONFIGURATION_ERROR",
      message: "Malformed Core response: expected an object result",
    });
  }
  return value as Record<string, unknown>;
}

/** Protocol-only discovery: running vs stopped, without importing Core. */
export async function discoverIdeCoreStatus(options: {
  readonly runtimeDirectory?: string;
  readonly connectTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
}): Promise<CoreDaemonLifecycleStatus> {
  const transport = new IdeCoreIpcTransport({
    ...(options.runtimeDirectory === undefined
      ? {}
      : { runtimeDirectory: options.runtimeDirectory }),
    ...(options.connectTimeoutMs === undefined
      ? {}
      : { connectTimeoutMs: options.connectTimeoutMs }),
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
  });
  try {
    const result = await transport.request(
      requestEnvelopeSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        kind: "request",
        requestId: randomUUID(),
        method: "core.status",
        payload: {},
      }),
    );
    return coreDaemonStatusSchema.parse(result);
  } catch (error) {
    if (error instanceof IdeCoreIpcError) {
      throw error;
    }
    const paths = ideCoreRuntimePaths(
      options.runtimeDirectory === undefined ? {} : { runtimeDirectory: options.runtimeDirectory },
    );
    let raw: string | undefined;
    try {
      raw = await readFile(paths.pid, "utf8");
    } catch (readError) {
      if ((readError as NodeJS.ErrnoException).code === "ENOENT") {
        return { state: "stopped" };
      }
      throw error;
    }
    try {
      const state = parseIdeCoreProcessState(raw);
      if (ideCoreProcessExists(state.pid)) {
        throw new Error(
          `Densa ADE Core owner process ${String(state.pid)} is live but its authenticated endpoint is unavailable`,
          { cause: error },
        );
      }
    } catch (parseError) {
      if (parseError instanceof Error && parseError.message.includes("owner process")) {
        throw parseError;
      }
      // Malformed PID metadata cannot prove a live owner; report the
      // transport failure so callers retry discovery after recovery.
      throw error;
    }
    return { state: "stopped" };
  } finally {
    transport.disconnect();
  }
}

export class IdeCoreConnection {
  readonly #transport: IdeCoreIpcTransport;
  readonly #createRequestId: () => string;
  readonly #starter: IdeCoreStarter | undefined;
  readonly #runtimeDirectory: string | undefined;
  readonly #events = new IdeEventCache();
  readonly #subscribed = new Set<string>();
  readonly #bufferedDuringSync = new Map<string, CoreV1PersistedEvent[]>();
  readonly #syncing = new Set<string>();
  #status: IdeConnectionStatus = { state: "disconnected" };
  #instanceId: string | undefined;
  #handshakeCapabilities: readonly string[] = [];
  #unsubscribeTransport: (() => void) | undefined;

  constructor(options: IdeCoreSessionOptions = {}) {
    this.#transport = options.transport ?? new IdeCoreIpcTransport(options);
    this.#createRequestId = options.createRequestId ?? createRequestIdFallback;
    this.#starter = options.starter;
    this.#runtimeDirectory =
      options.runtimeDirectory ?? options.transport?.runtimeDirectory ?? undefined;
    this.#unsubscribeTransport = this.#transport.onNotification((notification) =>
      this.#routeNotification(notification),
    );
  }

  get connectionStatus(): IdeConnectionStatus {
    return this.#status;
  }

  get connected(): boolean {
    return this.#status.state === "connected" && this.#transport.connected;
  }

  get subscribedProjects(): readonly string[] {
    return [...this.#subscribed];
  }

  get handshakeCapabilities(): readonly string[] {
    return this.#handshakeCapabilities;
  }

  eventCacheFor(projectId: string): IdeProjectEventCache {
    return this.#events.cacheFor(projectId);
  }

  lastAppliedSequence(projectId: string): number {
    return this.#events.lastAppliedSequence(projectId);
  }

  /** Disposable sympathy: close the IDE socket, leave Core running. */
  disconnect(): void {
    this.#transport.disconnect();
    if (this.#status.state === "connected") {
      const instanceId = this.#instanceId;
      this.#status = {
        state: "disconnected",
        ...(instanceId === undefined ? {} : { instanceId }),
        detail: "IDE disconnected; Core continues while project policy allows it.",
      };
    } else if (this.#status.state !== "version-mismatch" && this.#status.state !== "auth-failed") {
      this.#status = { state: "disconnected" };
    }
    this.#syncing.clear();
    this.#bufferedDuringSync.clear();
  }

  dispose(): void {
    this.#unsubscribeTransport?.();
    this.#unsubscribeTransport = undefined;
    this.disconnect();
  }

  async discover(): Promise<CoreDaemonLifecycleStatus> {
    const runtimeDirectory = this.#runtimeDirectory;
    return await discoverIdeCoreStatus(runtimeDirectory === undefined ? {} : { runtimeDirectory });
  }

  /**
   * Discover Core, start it when stopped (via the injected starter), then
   * connect and handshake. Throws a clear error when no starter is
   * configured instead of inventing a daemon.
   */
  async ensureRunning(): Promise<CoreDaemonStatus> {
    const discovered = await this.discover();
    if (discovered.state === "stopped") {
      if (this.#starter === undefined) {
        throw new IdeCoreIpcError({
          code: "AGENT_UNAVAILABLE",
          message: "Densa ADE Core is not running. Start it with `densa-ade core start`.",
        });
      }
      await this.#starter.start();
    }
    return await this.connect();
  }

  async connect(): Promise<CoreDaemonStatus> {
    this.#status = { state: "connecting" };
    try {
      const daemonStatus = await this.#requestDaemonStatus();
      await this.#handshake(daemonStatus);
      const instanceId = daemonStatus.instanceId;
      this.#instanceId = instanceId;
      this.#status = {
        state: "connected",
        instanceId,
        protocolVersion: PROTOCOL_VERSION,
      };
      return daemonStatus;
    } catch (error) {
      if (error instanceof IdeCoreIpcError) {
        if (error.protocolError.code === "PROTOCOL_VERSION_MISMATCH") {
          this.#status = {
            state: "version-mismatch",
            detail: error.protocolError.message,
          };
        } else if (error.protocolError.code === "AUTHENTICATION_REQUIRED") {
          this.#status = { state: "auth-failed", detail: error.protocolError.message };
        } else {
          this.#status = { state: "disconnected", detail: error.protocolError.message };
        }
      } else {
        this.#status = {
          state: "disconnected",
          detail: error instanceof Error ? error.message : "Connection failed",
        };
      }
      this.#transport.disconnect();
      throw error;
    }
  }

  async reconnect(): Promise<CoreDaemonStatus> {
    const subscribed = [...this.#subscribed];
    this.#transport.disconnect();
    this.#status = { state: "connecting" };
    const daemonStatus = await this.connect();
    for (const projectId of subscribed) {
      await this.resync(projectId);
    }
    return daemonStatus;
  }

  /** Every command goes through the versioned Core v1 facade. */
  async request<Method extends CoreV1Method>(
    method: Method,
    payload: CoreV1Payload<Method>,
  ): Promise<CoreV1Result<Method>> {
    if (!this.connected) {
      throw new IdeCoreIpcError({
        code: "AGENT_UNAVAILABLE",
        message: "Densa ADE IDE client is not connected to Core.",
      });
    }
    const client = new CoreV1Client(
      {
        request: async (envelope: RequestEnvelope): Promise<JsonValue> =>
          await this.#transport.request(envelope),
      },
      this.#createRequestId,
    );
    try {
      return await client.request(method, payload);
    } catch (error) {
      if (error instanceof IdeCoreIpcError) {
        if (error.protocolError.code === "PROTOCOL_VERSION_MISMATCH") {
          this.#status = { state: "version-mismatch", detail: error.protocolError.message };
        } else if (error.protocolError.code === "AUTHENTICATION_REQUIRED") {
          this.#status = { state: "auth-failed", detail: error.protocolError.message };
        }
      }
      throw error;
    }
  }

  /**
   * Subscribe to a project: replay from the last applied sequence, then
   * install the live listener. The subscription response page is applied
   * before any buffered live notification so reconnects never double-apply.
   */
  async subscribe(
    projectId: string,
    afterSequence?: number,
  ): Promise<{
    readonly applied: readonly CoreV1PersistedEvent[];
    readonly duplicates: number;
    readonly latestSequence: number;
  }> {
    if (!this.connected) {
      throw new IdeCoreIpcError({
        code: "AGENT_UNAVAILABLE",
        message: "Connect the IDE client before subscribing to project events.",
      });
    }
    const cache = this.#events.cacheFor(projectId);
    const resumeFrom = afterSequence ?? cache.lastAppliedSequence;
    this.#syncing.add(projectId);
    this.#bufferedDuringSync.set(projectId, []);
    try {
      const page = await this.request("events.subscribe", {
        projectId,
        ...(resumeFrom === 0 ? {} : { afterSequence: resumeFrom }),
      });
      const outcome = cache.applyReplayPage(page.events);
      if (outcome.hasGap) {
        throw new IdeCoreIpcError({
          code: "PERSISTENCE_FAILURE",
          message:
            "Core event replay skipped ahead of the last applied sequence. Replay again from the last contiguous sequence.",
        });
      }
      // Drain notifications that arrived while the subscribe round-trip was
      // in flight. They are applied after the replay page in frame order.
      const buffered = this.#bufferedDuringSync.get(projectId) ?? [];
      let duplicates = outcome.duplicates;
      const applied: CoreV1PersistedEvent[] = [...outcome.applied];
      for (const event of buffered) {
        const result = cache.applyNotification(event);
        if (result === "applied") {
          applied.push(event);
        } else if (result === "duplicate") {
          duplicates += 1;
        } else {
          throw new IdeCoreIpcError({
            code: "PERSISTENCE_FAILURE",
            message: "Core event notification arrived ahead of the replay page. Replay again.",
          });
        }
      }
      this.#subscribed.add(projectId);
      return { applied, duplicates, latestSequence: page.latestSequence };
    } finally {
      this.#syncing.delete(projectId);
      this.#bufferedDuringSync.delete(projectId);
    }
  }

  /**
   * Page through `events.replay` from the last applied sequence until
   * `hasMore` is false (the transport frame bound can return short pages).
   */
  async replay(projectId: string): Promise<{
    readonly applied: readonly CoreV1PersistedEvent[];
    readonly duplicates: number;
  }> {
    if (!this.connected) {
      throw new IdeCoreIpcError({
        code: "AGENT_UNAVAILABLE",
        message: "Connect the IDE client before replaying project events.",
      });
    }
    const cache = this.#events.cacheFor(projectId);
    const applied: CoreV1PersistedEvent[] = [];
    let duplicates = 0;
    for (;;) {
      const page = await this.request("events.replay", {
        projectId,
        afterSequence: cache.lastAppliedSequence,
      });
      const outcome = cache.applyReplayPage(page.events);
      applied.push(...outcome.applied);
      duplicates += outcome.duplicates;
      if (outcome.hasGap) {
        throw new IdeCoreIpcError({
          code: "PERSISTENCE_FAILURE",
          message: "Core event replay skipped ahead of the last applied sequence.",
        });
      }
      if (!page.hasMore) {
        break;
      }
      if (page.events.length === 0) {
        break;
      }
    }
    return { applied, duplicates };
  }

  /** Reconnect recipe from `docs/core-v1-protocol.md`: replay, subscribe, refresh. */
  async resync(projectId: string): Promise<void> {
    await this.replay(projectId);
    // Re-subscribe from the newest applied sequence so the live listener
    // resumes without re-applying history.
    this.#subscribed.delete(projectId);
    await this.subscribe(projectId);
    // Refresh the authoritative snapshot before the next mutation whose UI
    // preconditions may have changed while disconnected.
    await this.request("projects.get", { projectId });
  }

  async #requestDaemonStatus(): Promise<CoreDaemonStatus> {
    const envelope = requestEnvelopeSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      kind: "request",
      requestId: this.#createRequestId(),
      method: "core.status",
      payload: {},
    });
    let result: JsonValue;
    try {
      result = await this.#transport.request(envelope);
    } catch (error) {
      if (error instanceof IdeCoreIpcError) {
        throw error;
      }
      throw new IdeCoreIpcError({
        code: "AGENT_UNAVAILABLE",
        message: error instanceof Error ? error.message : "Densa ADE Core is unavailable",
      });
    }
    try {
      return coreDaemonStatusSchema.parse(result);
    } catch {
      // A running Core that answers with an unexpected shape is treated as
      // a version mismatch rather than best-effort decoded.
      throw new IdeCoreIpcError({
        code: "PROTOCOL_VERSION_MISMATCH",
        message: `Densa ADE IDE client protocol mismatch: expected ${PROTOCOL_VERSION}.`,
      });
    }
  }

  async #handshake(daemonStatus: CoreDaemonStatus): Promise<void> {
    if (daemonStatus.protocolVersion !== PROTOCOL_VERSION) {
      throw new IdeCoreIpcError({
        code: "PROTOCOL_VERSION_MISMATCH",
        message: `Densa ADE IDE client protocol mismatch: expected ${PROTOCOL_VERSION}, received ${String(daemonStatus.protocolVersion)}.`,
      });
    }
    assertCompatibleProtocol(daemonStatus.protocolVersion);
    const client = new CoreV1Client(
      {
        request: async (envelope: RequestEnvelope): Promise<JsonValue> =>
          await this.#transport.request(envelope),
      },
      this.#createRequestId,
    );
    let bootstrap: {
      protocolVersion: string;
      serverInstanceId: string;
      capabilities: readonly string[];
    };
    try {
      const result = await client.request("system.bootstrap", {});
      bootstrap = {
        protocolVersion: (result as { protocolVersion: string }).protocolVersion,
        serverInstanceId: (result as { serverInstanceId: string }).serverInstanceId,
        capabilities: [...(result as { capabilities: readonly string[] }).capabilities],
      };
    } catch (error) {
      if (error instanceof IdeCoreIpcError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "Core handshake failed";
      if (message.includes("PROTOCOL_VERSION_MISMATCH") || message.includes("protocol mismatch")) {
        throw new IdeCoreIpcError({
          code: "PROTOCOL_VERSION_MISMATCH",
          message: `Densa ADE IDE client protocol mismatch: expected ${PROTOCOL_VERSION}.`,
        });
      }
      throw error;
    }
    if (bootstrap.protocolVersion !== PROTOCOL_VERSION) {
      throw new IdeCoreIpcError({
        code: "PROTOCOL_VERSION_MISMATCH",
        message: `Densa ADE IDE client protocol mismatch: expected ${PROTOCOL_VERSION}, received ${String(bootstrap.protocolVersion)}.`,
      });
    }
    assertCompatibleProtocol(bootstrap.protocolVersion);
    void daemonStatus.instanceId;
    this.#handshakeCapabilities = Object.freeze([...bootstrap.capabilities]);
    // CORE_V1_METHODS is the frozen catalog; unknown capability names are
    // ignored so additive server methods never break this client.
    void CORE_V1_METHODS;
  }

  #routeNotification(notification: NotificationEnvelope): void {
    let parsed: { event: string; payload: JsonValue } | undefined;
    try {
      const validated = parseCoreV1Notification({
        protocolVersion: notification.protocolVersion,
        kind: notification.kind,
        event: notification.event,
        payload: notification.payload,
      });
      parsed = { event: validated.event, payload: validated.payload as JsonValue };
    } catch {
      // Unknown notification shapes are ignored; authoritative state is
      // always re-read via replay/snapshot, never invented from a hint.
      return;
    }
    if (parsed.event !== CORE_EVENT_NOTIFICATION) {
      return;
    }
    let event: CoreV1PersistedEvent;
    try {
      event = coreV1PersistedEventSchema.parse(parsed.payload);
    } catch {
      return;
    }
    if (this.#syncing.has(event.projectId)) {
      this.#bufferedDuringSync.get(event.projectId)?.push(event);
      return;
    }
    if (!this.#subscribed.has(event.projectId)) {
      return;
    }
    const cache = this.#events.cacheFor(event.projectId);
    const outcome = cache.applyNotification(event);
    if (outcome === "gap") {
      // A gap means the IDE missed committed facts. The next replay from
      // the last contiguous sequence recovers; notifications stay hints.
      void this.replay(event.projectId).catch(() => undefined);
    }
  }
}

export function isIdeCoreIpcError(error: unknown): error is IdeCoreIpcError {
  return error instanceof IdeCoreIpcError;
}

export function unusedCoreV1CatalogForTreeShaking(): readonly string[] {
  return CORE_V1_METHODS;
}

export function parseIdeNotificationForTests(value: unknown): NotificationEnvelope {
  const parsed = parseCoreV1Notification(value);
  return {
    protocolVersion: parsed.protocolVersion,
    kind: "notification",
    event: parsed.event,
    payload: parsed.payload as JsonValue,
  };
}

export function asIdeRecordForTests(value: JsonValue): Record<string, unknown> {
  return asRecord(value);
}
