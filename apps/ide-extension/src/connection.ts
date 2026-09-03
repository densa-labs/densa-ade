// Copyright 2026 Densa Labs
// SPDX-License-Identifier: Apache-2.0

import { PROTOCOL_VERSION } from "@densa-ade/protocol";

export const IDE_PROTOCOL_VERSION: typeof PROTOCOL_VERSION = PROTOCOL_VERSION;

export interface IdeCoreConnectionOptions {
  readonly socketPath: string;
  readonly authToken: string;
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly requestTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveBoundedMs(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 120_000;
}

export function createIdeConnectionOptions(input: {
  readonly socketPath: string;
  readonly authToken: string;
  readonly requestTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
}): IdeCoreConnectionOptions {
  if (!isNonEmptyText(input.socketPath)) {
    throw new Error("Densa ADE IDE client requires a non-empty Core socketPath.");
  }
  if (!isNonEmptyText(input.authToken)) {
    throw new Error("Densa ADE IDE client requires a non-empty Core auth token.");
  }
  if (input.requestTimeoutMs !== undefined && !isPositiveBoundedMs(input.requestTimeoutMs)) {
    throw new Error("Densa ADE IDE requestTimeoutMs must be a positive integer within 120000ms.");
  }
  if (input.connectTimeoutMs !== undefined && !isPositiveBoundedMs(input.connectTimeoutMs)) {
    throw new Error("Densa ADE IDE connectTimeoutMs must be a positive integer within 120000ms.");
  }
  const options: IdeCoreConnectionOptions = {
    socketPath: input.socketPath,
    authToken: input.authToken,
    protocolVersion: PROTOCOL_VERSION,
    ...(input.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: input.requestTimeoutMs }),
    ...(input.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: input.connectTimeoutMs }),
  };
  return options;
}

export function assertCompatibleProtocol(version: string): void {
  if (version !== PROTOCOL_VERSION) {
    throw new Error(
      `Densa ADE IDE client protocol mismatch: expected ${PROTOCOL_VERSION}, received ${version}.`,
    );
  }
}
