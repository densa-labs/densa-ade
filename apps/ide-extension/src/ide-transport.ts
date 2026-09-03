// Copyright 2026 Densa Labs
// SPDX-License-Identifier: Apache-2.0

/**
 * Protocol-only authenticated IPC transport for the IDE client.
 *
 * Speaks the same newline-delimited JSON framing as Densa ADE Core
 * (`{ authToken, envelope }` per line, 1 MiB frame bound) using only
 * `@densa-ade/protocol` schemas and Node builtins. It never imports
 * `@densa-ade/core`, SQLite, or workbench APIs.
 *
 * Connection loss is always local: disconnecting the IDE never stops Core and
 * never mutates project truth. Mutations only happen through versioned
 * protocol requests.
 */

import { lstat, readFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";

import {
  PROTOCOL_VERSION,
  parseProtocolEnvelope,
  requestEnvelopeSchema,
  type JsonValue,
  type NotificationEnvelope,
  type ProtocolError,
  type RequestEnvelope,
} from "@densa-ade/protocol";

import { ideCoreRuntimePaths } from "./runtime-paths.js";

export const IDE_IPC_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export type IdeNotificationListener = (notification: NotificationEnvelope) => void;

export class IdeCoreIpcError extends Error {
  constructor(readonly protocolError: ProtocolError) {
    super(protocolError.message);
    this.name = "IdeCoreIpcError";
  }
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

async function assertPrivateRuntimeDirectory(directory: string): Promise<void> {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Densa ADE Core runtime directory is unsafe: ${directory}`);
  }
  const uid = currentUid();
  if (uid !== undefined && metadata.uid !== uid) {
    throw new Error(
      `Densa ADE Core runtime directory is not owned by the current user: ${directory}`,
    );
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`Densa ADE Core runtime directory is accessible by another user: ${directory}`);
  }
}

async function readPrivateToken(tokenPath: string): Promise<string> {
  const metadata = await lstat(tokenPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Densa ADE Core token path is unsafe: ${tokenPath}`);
  }
  const uid = currentUid();
  if (uid !== undefined && metadata.uid !== uid) {
    throw new Error("Densa ADE Core credential file is not owned by the current user");
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error("Densa ADE Core credential file is accessible by another user");
  }
  return (await readFile(tokenPath, "utf8")).trim();
}

interface PendingIdeRequest {
  readonly resolve: (value: JsonValue) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

export interface IdeIpcTransportOptions {
  readonly runtimeDirectory?: string;
  readonly connectTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
}

function assertBoundedTimeout(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new Error(`${label} must be a positive bounded integer of milliseconds`);
  }
}

/**
 * Reconnectable authenticated transport. Shares one socket among concurrent
 * first requests, rejects duplicate in-flight request IDs, and fails
 * time-outs as unknown-outcome without retrying the mutation.
 */
export class IdeCoreIpcTransport {
  readonly #runtimeDirectory: string;
  readonly #connectTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  readonly #listeners = new Set<IdeNotificationListener>();
  readonly #pending = new Map<string, PendingIdeRequest>();
  #socket: Socket | undefined;
  #connecting: Promise<void> | undefined;
  #connectingSocket: Socket | undefined;
  #connectionGeneration = 0;
  #token: string | undefined;
  #buffer = "";

  constructor(options: IdeIpcTransportOptions = {}) {
    this.#runtimeDirectory =
      options.runtimeDirectory ?? process.env["DENSA_CORE_RUNTIME_DIR"] ?? "";
    this.#connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    assertBoundedTimeout(this.#connectTimeoutMs, "connectTimeoutMs");
    assertBoundedTimeout(this.#requestTimeoutMs, "requestTimeoutMs");
  }

  get connected(): boolean {
    return this.#socket !== undefined && !this.#socket.destroyed;
  }

  get runtimeDirectory(): string | undefined {
    return this.#runtimeDirectory.length > 0 ? this.#runtimeDirectory : undefined;
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }
    if (this.#connecting !== undefined) {
      await this.#connecting;
      return;
    }
    const connecting = this.#openConnection(this.#connectionGeneration);
    this.#connecting = connecting;
    try {
      await connecting;
    } finally {
      if (this.#connecting === connecting) {
        this.#connecting = undefined;
      }
    }
  }

  async reconnect(): Promise<void> {
    this.disconnect();
    await this.connect();
  }

  /**
   * Close the IDE socket only. Core keeps running; project truth is unchanged.
   * Pending requests fail locally so callers refresh authoritative state
   * before deciding whether a mutation can be retried.
   */
  disconnect(): void {
    this.#connectionGeneration += 1;
    this.#connectingSocket?.destroy(new Error("Densa ADE IDE client disconnected"));
    this.#connecting = undefined;
    this.#disconnect(new Error("Densa ADE IDE client disconnected"));
  }

  onNotification(listener: IdeNotificationListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async request(envelope: RequestEnvelope): Promise<JsonValue> {
    await this.connect();
    const rawVersion =
      typeof envelope === "object" && envelope !== null && "protocolVersion" in envelope
        ? (envelope as { protocolVersion?: unknown }).protocolVersion
        : undefined;
    if (rawVersion !== PROTOCOL_VERSION) {
      throw new IdeCoreIpcError({
        code: "PROTOCOL_VERSION_MISMATCH",
        message: `Densa ADE IDE client protocol mismatch: expected ${PROTOCOL_VERSION}.`,
      });
    }
    const parsed = requestEnvelopeSchema.parse(envelope);
    const token = this.#token;
    const socket = this.#socket;
    if (token === undefined || socket === undefined) {
      throw new Error("Densa ADE Core is disconnected");
    }
    return await new Promise<JsonValue>((resolvePromise, reject) => {
      if (this.#pending.has(parsed.requestId)) {
        reject(new Error("Core request ID is already pending"));
        return;
      }
      const pending: PendingIdeRequest = {
        resolve: resolvePromise,
        reject,
        timeout: setTimeout(() => {
          if (this.#pending.get(parsed.requestId) !== pending) {
            return;
          }
          this.#disconnect(
            new IdeCoreIpcError({
              code: "PROCESS_FAILURE",
              message:
                "Core request timed out; the operation outcome is unknown. Refresh authoritative state before retrying.",
            }),
            socket,
          );
        }, this.#requestTimeoutMs),
      };
      this.#pending.set(parsed.requestId, pending);
      socket.write(`${JSON.stringify({ authToken: token, envelope: parsed })}\n`, (error) => {
        if (
          error !== null &&
          error !== undefined &&
          this.#pending.get(parsed.requestId) === pending
        ) {
          clearTimeout(pending.timeout);
          this.#pending.delete(parsed.requestId);
          reject(error);
        }
      });
    });
  }

  async #openConnection(generation: number): Promise<void> {
    const paths = ideCoreRuntimePaths(
      this.#runtimeDirectory.length > 0 ? { runtimeDirectory: this.#runtimeDirectory } : {},
    );
    await assertPrivateRuntimeDirectory(paths.directory);
    const token = await readPrivateToken(paths.token);
    if (generation !== this.#connectionGeneration) {
      throw new Error("Core connection was cancelled");
    }
    const socket = createConnection(paths.socket);
    this.#connectingSocket = socket;
    const timeout = setTimeout(() => {
      socket.destroy(new Error("Core connection timed out"));
    }, this.#connectTimeoutMs);
    try {
      await new Promise<void>((resolvePromise, reject) => {
        socket.once("connect", resolvePromise);
        socket.once("error", reject);
      });
    } catch (error) {
      socket.destroy();
      throw error;
    } finally {
      clearTimeout(timeout);
      if (this.#connectingSocket === socket) {
        this.#connectingSocket = undefined;
      }
    }
    if (generation !== this.#connectionGeneration) {
      socket.destroy();
      throw new Error("Core connection was cancelled");
    }
    socket.removeAllListeners("error");
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.#receive(chunk, socket));
    socket.on("error", (error) => this.#disconnect(error, socket));
    socket.on("close", () => this.#disconnect(new Error("Densa ADE Core disconnected"), socket));
    this.#token = token;
    this.#socket = socket;
  }

  #receive(chunk: string | Buffer, socket: Socket): void {
    if (socket !== this.#socket) {
      return;
    }
    this.#buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let boundary = this.#buffer.indexOf("\n");
    while (boundary >= 0) {
      const serialized = this.#buffer.slice(0, boundary);
      this.#buffer = this.#buffer.slice(boundary + 1);
      if (Buffer.byteLength(serialized, "utf8") + 1 > IDE_IPC_MAX_FRAME_BYTES) {
        this.#disconnect(new Error("Densa ADE Core response exceeded the frame limit"), socket);
        return;
      }
      if (serialized.length > 0) {
        try {
          const envelope = parseProtocolEnvelope(JSON.parse(serialized) as unknown);
          if (envelope.kind === "notification") {
            for (const listener of this.#listeners) {
              listener(envelope);
            }
          } else if (envelope.kind === "response") {
            const pending = this.#pending.get(envelope.requestId);
            if (pending !== undefined) {
              clearTimeout(pending.timeout);
              this.#pending.delete(envelope.requestId);
              if (envelope.ok) {
                pending.resolve(envelope.result);
              } else {
                pending.reject(new IdeCoreIpcError(envelope.error));
              }
            }
          }
        } catch (error) {
          this.#disconnect(
            error instanceof Error ? error : new Error("Malformed Core response"),
            socket,
          );
          return;
        }
      }
      boundary = this.#buffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.#buffer, "utf8") > IDE_IPC_MAX_FRAME_BYTES) {
      this.#disconnect(new Error("Densa ADE Core response exceeded the frame limit"), socket);
    }
  }

  #disconnect(error: Error, source?: Socket): void {
    if (source !== undefined && source !== this.#socket) {
      return;
    }
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.destroy();
    this.#token = undefined;
    this.#buffer = "";
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
