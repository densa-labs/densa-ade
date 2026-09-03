// Copyright 2026 Densa Labs
// SPDX-License-Identifier: Apache-2.0

/**
 * Protocol-only Core runtime path discovery for the IDE client.
 *
 * Mirrors the authoritative layout owned by Densa ADE Core
 * (`~/.densa-ade/runtime` with `core.sock`, `core.pid`, `core.token`) without
 * importing `@densa-ade/core`, SQLite, or workbench APIs. The IDE never touches
 * the Core database file; it only needs the socket + token to speak the
 * versioned local protocol.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface IdeCoreRuntimePaths {
  readonly directory: string;
  readonly socket: string;
  readonly pid: string;
  readonly token: string;
}

export function defaultIdeCoreRuntimeDirectory(): string {
  const configured = process.env["DENSA_CORE_RUNTIME_DIR"];
  if (configured !== undefined && configured.length > 0) {
    return resolve(configured);
  }
  return join(homedir(), ".densa-ade", "runtime");
}

export function ideCoreRuntimePaths(
  options: { readonly runtimeDirectory?: string } = {},
): IdeCoreRuntimePaths {
  const directory = resolve(options.runtimeDirectory ?? defaultIdeCoreRuntimeDirectory());
  return Object.freeze({
    directory,
    socket: join(directory, "core.sock"),
    pid: join(directory, "core.pid"),
    token: join(directory, "core.token"),
  });
}

export interface IdeCoreProcessState {
  readonly instanceId: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly socketPath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Parse `core.pid` metadata without trusting its shape. Returns undefined
 * semantics to the caller (missing file), throws on malformed content.
 */
export function parseIdeCoreProcessState(value: string): IdeCoreProcessState {
  const parsed: unknown = JSON.parse(value);
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).length !== 4 ||
    typeof parsed["instanceId"] !== "string" ||
    parsed["instanceId"].length === 0 ||
    typeof parsed["pid"] !== "number" ||
    !Number.isSafeInteger(parsed["pid"]) ||
    (parsed["pid"] as number) <= 0 ||
    typeof parsed["startedAt"] !== "string" ||
    (parsed["startedAt"] as string).length === 0 ||
    typeof parsed["socketPath"] !== "string" ||
    (parsed["socketPath"] as string).length === 0
  ) {
    throw new Error("Densa ADE Core PID metadata is malformed");
  }
  return {
    instanceId: parsed["instanceId"] as string,
    pid: parsed["pid"] as number,
    startedAt: parsed["startedAt"] as string,
    socketPath: parsed["socketPath"] as string,
  };
}

/** True when the PID still refers to a live process (EPERM counts as live). */
export function ideCoreProcessExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
