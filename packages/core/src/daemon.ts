import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { fileURLToPath } from "node:url";

import {
  CORE_EVENT_NOTIFICATION,
  CORE_IPC_EVENT_REPLAY_DEFAULT,
  CORE_IPC_EVENT_REPLAY_LIMIT,
  PROTOCOL_VERSION,
  ProtocolVersionMismatchError,
  coreDaemonStatusSchema,
  eventReplayRequestSchema,
  eventSubscriptionRequestSchema,
  isoTimestampSchema,
  jsonObjectSchema,
  jsonValueSchema,
  parseProtocolEnvelope,
  parseCoreV1Payload,
  parseCoreV1Result,
  requestIdSchema,
  projectIdSchema,
  requestEnvelopeSchema,
  type CoreDaemonLifecycleStatus,
  type CoreDaemonStatus,
  type JsonObject,
  type JsonValue,
  type NotificationEnvelope,
  type ProtocolError,
  type RequestEnvelope,
} from "@densa-ade/protocol";

import { DensaAdeDatabase } from "./persistence/database.js";
import { ProjectExecutionControlService } from "./execution-control.js";
import type { ProjectControlRequest, ResumeProjectRequest } from "./execution-control.js";

const MAX_FRAME_BYTES = 1024 * 1024;
const RUNTIME_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const START_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 5_000;

export interface CoreRuntimePaths {
  readonly directory: string;
  readonly socket: string;
  readonly pid: string;
  readonly token: string;
  readonly database: string;
}

interface PersistedProcessState {
  readonly instanceId: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly socketPath: string;
}

export interface CoreDaemonOptions {
  readonly runtimeDirectory?: string;
  readonly databasePath?: string;
  readonly now?: () => string;
  readonly instanceId?: string;
  readonly ownerPid?: number;
  readonly database?: DensaAdeDatabase;
}

export interface CoreDaemonManagerOptions {
  readonly runtimeDirectory?: string;
  readonly databasePath?: string;
  readonly daemonEntryPath?: string;
  readonly startTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
}

export type CoreNotificationListener = (notification: NotificationEnvelope) => void;

export class CoreIpcError extends Error {
  constructor(readonly protocolError: ProtocolError) {
    super(protocolError.message);
    this.name = "CoreIpcError";
  }
}

function currentUserId(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

export function defaultCoreRuntimeDirectory(): string {
  const configured = process.env["DENSA_CORE_RUNTIME_DIR"];
  return configured === undefined || configured.length === 0
    ? join(homedir(), ".densa-ade", "runtime")
    : resolve(configured);
}

export function coreRuntimePaths(options: CoreDaemonOptions = {}): CoreRuntimePaths {
  const directory = resolve(options.runtimeDirectory ?? defaultCoreRuntimeDirectory());
  return Object.freeze({
    directory,
    socket: join(directory, "core.sock"),
    pid: join(directory, "core.pid"),
    token: join(directory, "core.token"),
    database: resolve(options.databasePath ?? join(directory, "core.sqlite")),
  });
}

async function assertOwnedPath(path: string, kind: "directory" | "file" | "socket"): Promise<void> {
  const metadata = await lstat(path);
  const validKind =
    (kind === "directory" && metadata.isDirectory()) ||
    (kind === "file" && metadata.isFile()) ||
    (kind === "socket" && metadata.isSocket());
  if (!validKind || metadata.isSymbolicLink()) {
    throw new Error(`Densa ADE Core ${kind} path is unsafe: ${path}`);
  }
  const uid = currentUserId();
  if (uid !== undefined && metadata.uid !== uid) {
    throw new Error(`Densa ADE Core ${kind} path is not owned by the current user: ${path}`);
  }
}

async function ensureRuntimeDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: RUNTIME_DIRECTORY_MODE });
  await assertOwnedPath(path, "directory");
  await chmod(path, RUNTIME_DIRECTORY_MODE);
}

async function assertPrivateRuntimeDirectory(path: string): Promise<void> {
  await assertOwnedPath(path, "directory");
  if (((await lstat(path)).mode & 0o077) !== 0) {
    throw new Error(`Densa ADE Core runtime directory is accessible by another user: ${path}`);
  }
}

async function writePrivateFile(path: string, value: string): Promise<void> {
  const handle = await open(path, "wx", PRIVATE_FILE_MODE);
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, PRIVATE_FILE_MODE);
}

async function readPrivateFile(path: string): Promise<string> {
  await assertOwnedPath(path, "file");
  const metadata = await lstat(path);
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`Densa ADE Core credential file is accessible by another user: ${path}`);
  }
  return await readFile(path, "utf8");
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseProcessState(value: string): PersistedProcessState {
  const parsed = JSON.parse(value) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Object.keys(parsed).length !== 4 ||
    !("instanceId" in parsed) ||
    typeof parsed.instanceId !== "string" ||
    parsed.instanceId.length === 0 ||
    !("pid" in parsed) ||
    typeof parsed.pid !== "number" ||
    !Number.isSafeInteger(parsed.pid) ||
    parsed.pid <= 0 ||
    !("startedAt" in parsed) ||
    typeof parsed.startedAt !== "string" ||
    !("socketPath" in parsed) ||
    typeof parsed.socketPath !== "string" ||
    parsed.socketPath.length === 0
  ) {
    throw new Error("Densa ADE Core PID metadata is malformed");
  }
  isoTimestampSchema.parse(parsed.startedAt);
  return {
    instanceId: parsed.instanceId,
    pid: parsed.pid,
    startedAt: parsed.startedAt,
    socketPath: parsed.socketPath,
  };
}

async function readProcessState(
  paths: CoreRuntimePaths,
): Promise<PersistedProcessState | undefined> {
  try {
    return parseProcessState(await readPrivateFile(paths.pid));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function removeIfPresent(path: string, expectedKind: "file" | "socket"): Promise<void> {
  try {
    await assertOwnedPath(path, expectedKind);
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function recoverStaleState(paths: CoreRuntimePaths): Promise<void> {
  const state = await readProcessState(paths);
  if (state !== undefined && processExists(state.pid)) {
    throw new Error(`Densa ADE Core already has a live owner process (${String(state.pid)})`);
  }
  if (state === undefined && (await socketIsLive(paths.socket))) {
    throw new Error(`Densa ADE Core already has a live socket endpoint: ${paths.socket}`);
  }
  await removeIfPresent(paths.socket, "socket");
  await removeIfPresent(paths.token, "file");
  await removeIfPresent(paths.pid, "file");
}

async function socketIsLive(path: string): Promise<boolean> {
  try {
    await assertOwnedPath(path, "socket");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const socket = createConnection(path);
  return await new Promise<boolean>((resolvePromise) => {
    socket.once("connect", () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolvePromise(false);
    });
  });
}

function safeTokenEqual(expected: string, received: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  return (
    expectedBytes.length === receivedBytes.length && timingSafeEqual(expectedBytes, receivedBytes)
  );
}

function responseError(requestId: string, error: ProtocolError): JsonObject {
  return {
    protocolVersion: PROTOCOL_VERSION,
    kind: "response",
    requestId,
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}

function asJson(value: unknown): JsonValue {
  return jsonValueSchema.parse(value);
}

function responseSuccess(requestId: string, result: JsonValue): JsonObject {
  return {
    protocolVersion: PROTOCOL_VERSION,
    kind: "response",
    requestId,
    ok: true,
    result,
  };
}

function writeFrame(socket: Socket, value: JsonValue): void {
  socket.write(`${JSON.stringify(jsonValueSchema.parse(value))}\n`);
}

function normalizedProtocolError(error: unknown): ProtocolError {
  if (error instanceof CoreIpcError) return error.protocolError;
  if (error instanceof ProtocolVersionMismatchError) {
    return {
      code: "PROTOCOL_VERSION_MISMATCH",
      message: error.message,
      details: { receivedVersion: String(error.receivedVersion) },
    };
  }
  if (error instanceof SyntaxError || (error instanceof Error && error.name === "ZodError")) {
    return { code: "USER_CONFIGURATION_ERROR", message: "Malformed Core IPC request" };
  }
  return {
    code: "INTERNAL_INVARIANT_VIOLATION",
    message: error instanceof Error ? error.message : "Unknown Core IPC failure",
  };
}

function jsonRequestId(value: unknown): string {
  if (
    typeof value === "object" &&
    value !== null &&
    "envelope" in value &&
    typeof value.envelope === "object" &&
    value.envelope !== null &&
    "requestId" in value.envelope &&
    typeof value.envelope.requestId === "string" &&
    value.envelope.requestId.length > 0
  ) {
    return value.envelope.requestId;
  }
  return "invalid-request";
}

/** Authoritative local Core process. Clients can disconnect without changing its lifecycle. */
export class CoreDaemon {
  readonly #paths: CoreRuntimePaths;
  readonly #database: DensaAdeDatabase;
  readonly #executionControl: ProjectExecutionControlService;
  readonly #server: Server;
  readonly #token: string;
  readonly #instanceId: string;
  readonly #ownerPid: number;
  readonly #startedAt: string;
  readonly #ownsDatabase: boolean;
  readonly #clients = new Set<Socket>();
  readonly #subscriptions = new Map<Socket, () => void>();
  #stopPromise: Promise<void> | undefined;

  private constructor(
    options: CoreDaemonOptions,
    database: DensaAdeDatabase,
    token: string,
    ownsDatabase: boolean,
  ) {
    this.#paths = coreRuntimePaths(options);
    this.#database = database;
    this.#executionControl = new ProjectExecutionControlService(
      database,
      options.now === undefined ? {} : { now: options.now },
    );
    this.#token = token;
    this.#instanceId = options.instanceId ?? randomUUID();
    this.#ownerPid = options.ownerPid ?? process.pid;
    this.#startedAt = (options.now ?? (() => new Date().toISOString()))();
    this.#ownsDatabase = ownsDatabase;
    this.#server = createServer((socket) => this.#accept(socket));
  }

  static async start(options: CoreDaemonOptions = {}): Promise<CoreDaemon> {
    const paths = coreRuntimePaths(options);
    await ensureRuntimeDirectory(paths.directory);
    await recoverStaleState(paths);
    const token = randomBytes(32).toString("base64url");
    await writePrivateFile(paths.token, token);
    let database: DensaAdeDatabase | undefined;
    try {
      database = options.database ?? DensaAdeDatabase.open(paths.database);
      if (options.database === undefined) await chmod(paths.database, PRIVATE_FILE_MODE);
      const daemon = new CoreDaemon(options, database, token, options.database === undefined);
      await writePrivateFile(
        paths.pid,
        JSON.stringify({
          instanceId: daemon.#instanceId,
          pid: daemon.#ownerPid,
          startedAt: daemon.#startedAt,
          socketPath: paths.socket,
        }),
      );
      await daemon.#listen();
      return daemon;
    } catch (error) {
      if (options.database === undefined) database?.close();
      await removeIfPresent(paths.socket, "socket");
      await removeIfPresent(paths.token, "file");
      await removeIfPresent(paths.pid, "file");
      throw error;
    }
  }

  status(): CoreDaemonStatus {
    return coreDaemonStatusSchema.parse({
      state: "running",
      instanceId: this.#instanceId,
      pid: this.#ownerPid,
      startedAt: this.#startedAt,
      socketPath: this.#paths.socket,
      connectedClients: this.#clients.size,
      protocolVersion: PROTOCOL_VERSION,
    });
  }

  async stop(): Promise<void> {
    this.#stopPromise ??= this.#performStop();
    await this.#stopPromise;
  }

  async #performStop(): Promise<void> {
    for (const unsubscribe of this.#subscriptions.values()) unsubscribe();
    this.#subscriptions.clear();
    for (const client of this.#clients) client.destroy();
    this.#clients.clear();
    await new Promise<void>((resolvePromise, reject) => {
      this.#server.close((error) => (error === undefined ? resolvePromise() : reject(error)));
    });
    if (this.#ownsDatabase) this.#database.close();
    const state = await readProcessState(this.#paths);
    if (state === undefined || state.instanceId === this.#instanceId) {
      await removeIfPresent(this.#paths.socket, "socket");
      await removeIfPresent(this.#paths.token, "file");
      await removeIfPresent(this.#paths.pid, "file");
    }
  }

  async #listen(): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
      const onError = (error: Error): void => reject(error);
      this.#server.once("error", onError);
      this.#server.listen(this.#paths.socket, () => {
        this.#server.off("error", onError);
        resolvePromise();
      });
    });
    await chmod(this.#paths.socket, PRIVATE_FILE_MODE);
    await assertOwnedPath(this.#paths.socket, "socket");
  }

  #accept(socket: Socket): void {
    this.#clients.add(socket);
    let buffer = "";
    const cleanup = (): void => {
      this.#clients.delete(socket);
      this.#subscriptions.get(socket)?.();
      this.#subscriptions.delete(socket);
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) {
        socket.destroy();
        return;
      }
      let boundary = buffer.indexOf("\n");
      while (boundary >= 0) {
        const serialized = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        if (serialized.length > 0) void this.#handleFrame(socket, serialized);
        boundary = buffer.indexOf("\n");
      }
    });
  }

  async #handleFrame(socket: Socket, serialized: string): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(serialized) as unknown;
      if (
        typeof raw !== "object" ||
        raw === null ||
        Object.keys(raw).length !== 2 ||
        !("authToken" in raw) ||
        typeof raw.authToken !== "string" ||
        raw.authToken.length === 0 ||
        !("envelope" in raw)
      ) {
        throw new SyntaxError("Malformed authenticated request frame");
      }
      const frame = { authToken: raw.authToken, envelope: raw.envelope };
      const envelope = parseProtocolEnvelope(frame.envelope);
      if (envelope.kind !== "request") throw new SyntaxError("Expected request envelope");
      if (!safeTokenEqual(this.#token, frame.authToken)) {
        writeFrame(
          socket,
          responseError(envelope.requestId, {
            code: "AUTHENTICATION_REQUIRED",
            message: "Densa ADE Core IPC authentication failed",
          }),
        );
        socket.end();
        return;
      }
      const result = await this.#dispatch(socket, envelope);
      writeFrame(socket, responseSuccess(envelope.requestId, result));
    } catch (error) {
      writeFrame(socket, responseError(jsonRequestId(raw), normalizedProtocolError(error)));
    }
  }

  async #dispatch(socket: Socket, request: RequestEnvelope): Promise<JsonValue> {
    switch (request.method) {
      case "project.pause":
      case "projects.pause":
      case "project.cancel":
      case "project.resume":
      case "projects.resume":
      case "project.stop":
      case "projects.stop": {
        const method = request.method.endsWith("resume")
          ? "projects.resume"
          : request.method.endsWith("stop")
            ? "projects.stop"
            : "projects.pause";
        const payload = parseCoreV1Payload(method, request.payload);
        const controlRequest: ProjectControlRequest = {
          projectId: projectIdSchema.parse(payload.projectId),
          workspacePath: payload.workspacePath,
          actor: payload.actor,
        };
        const resumeRequest: ResumeProjectRequest = {
          ...controlRequest,
          ...("acknowledgeIntervention" in payload && payload.acknowledgeIntervention !== undefined
            ? { acknowledgeIntervention: payload.acknowledgeIntervention }
            : {}),
        };
        const result =
          method === "projects.resume"
            ? await this.#executionControl.resume(resumeRequest)
            : method === "projects.stop"
              ? await this.#executionControl.stop(controlRequest)
              : request.method === "project.cancel"
                ? await this.#executionControl.cancelCurrentAgent(controlRequest)
                : await this.#executionControl.pause(controlRequest);
        // Keep the frozen v1 result shape; legacy CLI controls also return focused intervention context.
        const projected = {
          projectId: result.projectId,
          status: result.status,
          ...("reason" in result ? { reason: result.reason } : {}),
          ...("recontextualization" in result && result.recontextualization !== undefined
            ? { changedPaths: result.recontextualization.changedPaths }
            : {}),
        };
        return request.method.startsWith("projects.")
          ? asJson(parseCoreV1Result(method, projected))
          : asJson(result);
      }
      case "core.status":
        jsonObjectSchema.parse(request.payload);
        return this.status();
      case "core.stop":
        jsonObjectSchema.parse(request.payload);
        setImmediate(() => void this.stop().catch(() => undefined));
        return { stopping: true, instanceId: this.#instanceId };
      case "events.list":
      case "events.replay": {
        const filter = eventReplayRequestSchema.parse(request.payload);
        const limit = filter.limit ?? CORE_IPC_EVENT_REPLAY_DEFAULT;
        const replayFilter = {
          ...(filter.projectId === undefined ? {} : { projectId: filter.projectId }),
          ...(filter.afterSequence === undefined ? {} : { afterSequence: filter.afterSequence }),
          limit: Math.min(limit + 1, CORE_IPC_EVENT_REPLAY_LIMIT + 1),
        };
        const replay = this.#database.eventJournal.replay(replayFilter);
        const events = replay.slice(0, limit);
        const latestSequence =
          filter.projectId === undefined
            ? events.reduce((latest, event) => Math.max(latest, event.sequenceNumber), 0)
            : (this.#database.repositories.events.latest(filter.projectId)?.sequenceNumber ?? 0);
        return asJson({ events, latestSequence, hasMore: replay.length > limit });
      }
      case "events.subscribe": {
        const filter = eventSubscriptionRequestSchema.parse(request.payload);
        const limit = filter.limit ?? CORE_IPC_EVENT_REPLAY_DEFAULT;
        const replayFilter = {
          projectId: filter.projectId,
          ...(filter.afterSequence === undefined ? {} : { afterSequence: filter.afterSequence }),
          limit: Math.min(limit + 1, CORE_IPC_EVENT_REPLAY_LIMIT + 1),
        };
        this.#subscriptions.get(socket)?.();
        const replay = this.#database.eventJournal.replay(replayFilter);
        const events = replay.slice(0, limit);
        const subscriptionFilter = {
          projectId: filter.projectId,
          ...(filter.afterSequence === undefined ? {} : { afterSequence: filter.afterSequence }),
        };
        const unsubscribe = this.#database.eventJournal.subscribe(subscriptionFilter, (event) => {
          const notification: NotificationEnvelope = {
            protocolVersion: PROTOCOL_VERSION,
            kind: "notification",
            event: CORE_EVENT_NOTIFICATION,
            payload: asJson(event),
          };
          writeFrame(socket, asJson(notification));
        });
        this.#subscriptions.set(socket, unsubscribe);
        return asJson({
          events,
          latestSequence:
            this.#database.repositories.events.latest(filter.projectId)?.sequenceNumber ?? 0,
          hasMore: replay.length > limit,
          subscribed: true,
        });
      }
      case "project.status":
        return { state: "no_project_selected" };
      default:
        throw new CoreIpcError({
          code: "USER_CONFIGURATION_ERROR",
          message: `Unsupported Core method: ${request.method}`,
          details: { method: request.method },
        });
    }
  }
}

interface PendingRequest {
  readonly resolve: (value: JsonValue) => void;
  readonly reject: (error: Error) => void;
}

/** Reconnectable authenticated client for CLI, IDE, Dashboard, and tests. */
export class CoreIpcClient {
  readonly #paths: CoreRuntimePaths;
  readonly #listeners = new Set<CoreNotificationListener>();
  readonly #pending = new Map<string, PendingRequest>();
  #socket: Socket | undefined;
  #token: string | undefined;
  #buffer = "";

  constructor(options: CoreDaemonOptions = {}) {
    this.#paths = coreRuntimePaths(options);
  }

  get connected(): boolean {
    return this.#socket !== undefined && !this.#socket.destroyed;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await assertPrivateRuntimeDirectory(this.#paths.directory);
    this.#token = (await readPrivateFile(this.#paths.token)).trim();
    const socket = createConnection(this.#paths.socket);
    await new Promise<void>((resolvePromise, reject) => {
      socket.once("connect", resolvePromise);
      socket.once("error", reject);
    });
    socket.removeAllListeners("error");
    socket.on("data", (chunk) => this.#receive(chunk));
    socket.on("error", (error) => this.#disconnect(error));
    socket.on("close", () => this.#disconnect(new Error("Densa ADE Core disconnected")));
    this.#socket = socket;
  }

  async reconnect(): Promise<void> {
    this.disconnect();
    await this.connect();
  }

  disconnect(): void {
    this.#socket?.destroy();
    this.#disconnect(new Error("Densa ADE Core client disconnected"));
  }

  onNotification(listener: CoreNotificationListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async request(request: RequestEnvelope): Promise<JsonValue> {
    await this.connect();
    const envelope = requestEnvelopeSchema.parse(request);
    const token = this.#token;
    const socket = this.#socket;
    if (token === undefined || socket === undefined)
      throw new Error("Densa ADE Core is disconnected");
    return await new Promise<JsonValue>((resolvePromise, reject) => {
      this.#pending.set(envelope.requestId, { resolve: resolvePromise, reject });
      socket.write(`${JSON.stringify({ authToken: token, envelope })}\n`, (error) => {
        if (error !== null && error !== undefined) {
          this.#pending.delete(envelope.requestId);
          reject(error);
        }
      });
    });
  }

  #receive(chunk: string | Buffer): void {
    this.#buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (Buffer.byteLength(this.#buffer, "utf8") > MAX_FRAME_BYTES) {
      this.#socket?.destroy(new Error("Densa ADE Core response exceeded the frame limit"));
      return;
    }
    let boundary = this.#buffer.indexOf("\n");
    while (boundary >= 0) {
      const serialized = this.#buffer.slice(0, boundary);
      this.#buffer = this.#buffer.slice(boundary + 1);
      if (serialized.length > 0) {
        try {
          const envelope = parseProtocolEnvelope(JSON.parse(serialized) as unknown);
          if (envelope.kind === "notification") {
            for (const listener of this.#listeners) listener(envelope);
          } else if (envelope.kind === "response") {
            const pending = this.#pending.get(envelope.requestId);
            if (pending !== undefined) {
              this.#pending.delete(envelope.requestId);
              if (envelope.ok) pending.resolve(envelope.result);
              else pending.reject(new CoreIpcError(envelope.error));
            }
          }
        } catch (error) {
          this.#disconnect(error instanceof Error ? error : new Error("Malformed Core response"));
        }
      }
      boundary = this.#buffer.indexOf("\n");
    }
  }

  #disconnect(error: Error): void {
    this.#socket = undefined;
    this.#token = undefined;
    this.#buffer = "";
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export class CoreDaemonManager {
  readonly #options: CoreDaemonManagerOptions;
  readonly #paths: CoreRuntimePaths;

  constructor(options: CoreDaemonManagerOptions = {}) {
    this.#options = options;
    this.#paths = coreRuntimePaths(options);
  }

  async start(): Promise<CoreDaemonStatus> {
    const current = await this.status();
    if (current.state === "running") return current;
    await ensureRuntimeDirectory(this.#paths.directory);
    const daemonEntryPath =
      this.#options.daemonEntryPath ?? fileURLToPath(new URL("./daemon-bin.js", import.meta.url));
    const child = spawn(process.execPath, [daemonEntryPath], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        DENSA_CORE_RUNTIME_DIR: this.#paths.directory,
        DENSA_CORE_DATABASE_PATH: this.#paths.database,
      },
    });
    child.unref();
    const deadline = Date.now() + (this.#options.startTimeoutMs ?? START_TIMEOUT_MS);
    let wait = 20;
    while (Date.now() < deadline) {
      try {
        const status = await this.status();
        if (status.state === "running") return status;
      } catch (error) {
        const startingState = await readProcessState(this.#paths);
        if (child.pid === undefined || startingState?.pid !== child.pid) throw error;
        // This exact child may persist its PID just before its authenticated socket starts listening.
      }
      await delay(wait);
      wait = Math.min(wait * 2, 250);
    }
    throw new Error("Timed out waiting for Densa ADE Core to start");
  }

  async status(): Promise<CoreDaemonLifecycleStatus> {
    try {
      const client = new CoreIpcClient(this.#options);
      const result = await client.request({
        protocolVersion: PROTOCOL_VERSION,
        kind: "request",
        requestId: requestIdSchema.parse(randomUUID()),
        method: "core.status",
        payload: {},
      });
      client.disconnect();
      return coreDaemonStatusSchema.parse(result);
    } catch (error) {
      const state = await readProcessState(this.#paths);
      if (state !== undefined && processExists(state.pid)) {
        throw new Error(
          `Densa ADE Core owner process ${String(state.pid)} is live but its authenticated endpoint is unavailable`,
          { cause: error },
        );
      }
      return { state: "stopped" };
    }
  }

  async stop(): Promise<CoreDaemonLifecycleStatus> {
    const current = await this.status();
    if (current.state === "stopped") return current;
    const client = new CoreIpcClient(this.#options);
    await client.request({
      protocolVersion: PROTOCOL_VERSION,
      kind: "request",
      requestId: requestIdSchema.parse(randomUUID()),
      method: "core.stop",
      payload: {},
    });
    client.disconnect();
    const deadline = Date.now() + (this.#options.stopTimeoutMs ?? STOP_TIMEOUT_MS);
    let wait = 20;
    while (Date.now() < deadline) {
      try {
        const status = await this.status();
        if (status.state === "stopped") return status;
      } catch (error) {
        const state = await readProcessState(this.#paths);
        if (state !== undefined && state.instanceId !== current.instanceId) throw error;
        // The authenticated owner may close its socket just before removing matching PID state.
      }
      await delay(wait);
      wait = Math.min(wait * 2, 250);
    }
    throw new Error("Timed out waiting for Densa ADE Core to stop");
  }
}

export async function startCoreDaemonProcess(options: CoreDaemonOptions = {}): Promise<void> {
  const runtimeDirectory = options.runtimeDirectory ?? process.env["DENSA_CORE_RUNTIME_DIR"];
  const databasePath = options.databasePath ?? process.env["DENSA_CORE_DATABASE_PATH"];
  const daemon = await CoreDaemon.start({
    ...(runtimeDirectory === undefined ? {} : { runtimeDirectory }),
    ...(databasePath === undefined ? {} : { databasePath }),
  });
  const stop = (): void => {
    void daemon.stop().finally(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
