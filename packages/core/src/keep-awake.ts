import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import {
  eventIdSchema,
  isoTimestampSchema,
  keepAwakeBatteryPolicySchema,
  keepAwakeBatteryStateSchema,
  keepAwakeReasonIdSchema,
  keepAwakeReasonSchema,
  keepAwakeStatusSchema,
  projectIdSchema,
  type JsonObject,
  type KeepAwakeBatteryPolicy,
  type KeepAwakeBatteryState,
  type KeepAwakeReason,
  type KeepAwakeReasonId,
  type KeepAwakeStatus,
  type ProjectId,
} from "@densa/protocol";

import type { DensaDatabase } from "./persistence/database.js";

const execFileAsync = promisify(execFile);
const DEFAULT_MINIMUM_BATTERY_PERCENT = 20;
const DEFAULT_MONITOR_INTERVAL_MS = 60_000;
const PROCESS_EXIT_TIMEOUT_MS = 2_000;

export interface KeepAwakePlatformHandle {
  readonly id: string;
  readonly platform: "macos_caffeinate" | "fake";
  readonly pid?: number;
  readonly ownerPid?: number;
}

export interface KeepAwakePlatform {
  isSupported(): boolean;
  isActive(handle: KeepAwakePlatformHandle): boolean;
  acquire(projectId: ProjectId): Promise<KeepAwakePlatformHandle>;
  release(handle: KeepAwakePlatformHandle): Promise<void>;
  readBatteryState(observedAt: string): Promise<KeepAwakeBatteryState>;
}

interface CaffeinateProcess {
  readonly pid: number;
  isActive(): boolean;
  terminate(): Promise<void>;
}

export type CaffeinateProcessFactory = (
  command: string,
  arguments_: readonly string[],
) => Promise<CaffeinateProcess>;

export type BatteryStateReader = (observedAt: string) => Promise<KeepAwakeBatteryState>;
export type StaleAssertionReleaser = (handle: KeepAwakePlatformHandle) => Promise<void>;

function waitForChildExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("caffeinate did not exit after SIGTERM")),
      PROCESS_EXIT_TIMEOUT_MS,
    );
    timeout.unref();
    child.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function spawnCaffeinate(
  command: string,
  arguments_: readonly string[],
): Promise<CaffeinateProcess> {
  const child = spawn(command, [...arguments_], {
    shell: false,
    stdio: "ignore",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  if (child.pid === undefined) throw new Error("caffeinate started without a process id");
  return Object.freeze({
    pid: child.pid,
    isActive: () => child.exitCode === null && child.signalCode === null,
    terminate: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      await waitForChildExit(child);
    },
  });
}

function parsePmsetBatteryState(output: string, observedAt: string): KeepAwakeBatteryState {
  const source = /Now drawing from '([^']+)'/u.exec(output)?.[1]?.toLowerCase();
  const levelText = /\b(\d{1,3})%;/u.exec(output)?.[1];
  const level = levelText === undefined ? undefined : Number.parseInt(levelText, 10);
  const powerSource =
    source?.includes("ac power") === true
      ? ("external_power" as const)
      : source?.includes("battery power") === true
        ? ("battery" as const)
        : ("unknown" as const);
  return keepAwakeBatteryStateSchema.parse({
    powerSource,
    ...(level === undefined || level < 0 || level > 100 ? {} : { levelPercent: level }),
    observedAt,
  });
}

async function readMacOsBatteryState(observedAt: string): Promise<KeepAwakeBatteryState> {
  const result = await execFileAsync("/usr/bin/pmset", ["-g", "batt"], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 64 * 1_024,
  });
  return parsePmsetBatteryState(result.stdout, observedAt);
}

function processIsMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === 1 || error.code === "ESRCH")
  );
}

async function releaseStaleCaffeinate(handle: KeepAwakePlatformHandle): Promise<void> {
  if (handle.pid === undefined || handle.ownerPid === undefined) {
    throw new Error("Persisted caffeinate assertion is missing process identity");
  }
  let command: string;
  try {
    const result = await execFileAsync("/bin/ps", [
      "-ww",
      "-p",
      String(handle.pid),
      "-o",
      "command=",
    ]);
    command = result.stdout.trim();
  } catch (error) {
    if (processIsMissing(error)) return;
    throw error;
  }
  const expected = `/usr/bin/caffeinate -i -w ${String(handle.ownerPid)}`;
  if (command !== expected) {
    throw new Error("Persisted PID no longer identifies Densa's caffeinate assertion");
  }
  try {
    process.kill(handle.pid, "SIGTERM");
  } catch (error) {
    if (!processIsMissing(error)) throw error;
    return;
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    try {
      process.kill(handle.pid, 0);
    } catch (error) {
      if (processIsMissing(error)) return;
      throw error;
    }
  }
  throw new Error("Stale caffeinate assertion did not exit after SIGTERM");
}

export interface MacOsKeepAwakePlatformOptions {
  readonly platform?: NodeJS.Platform;
  readonly ownerPid?: number;
  readonly processFactory?: CaffeinateProcessFactory;
  readonly batteryStateReader?: BatteryStateReader;
  readonly staleAssertionReleaser?: StaleAssertionReleaser;
}

/** macOS implementation. `-i` blocks idle system sleep; no display assertion is requested. */
export class MacOsKeepAwakePlatform implements KeepAwakePlatform {
  readonly #platform: NodeJS.Platform;
  readonly #ownerPid: number;
  readonly #processFactory: CaffeinateProcessFactory;
  readonly #batteryStateReader: BatteryStateReader;
  readonly #staleAssertionReleaser: StaleAssertionReleaser;
  readonly #children = new Map<string, CaffeinateProcess>();

  constructor(options: MacOsKeepAwakePlatformOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#ownerPid = options.ownerPid ?? process.pid;
    this.#processFactory = options.processFactory ?? spawnCaffeinate;
    this.#batteryStateReader = options.batteryStateReader ?? readMacOsBatteryState;
    this.#staleAssertionReleaser = options.staleAssertionReleaser ?? releaseStaleCaffeinate;
  }

  isSupported(): boolean {
    return this.#platform === "darwin";
  }

  isActive(handle: KeepAwakePlatformHandle): boolean {
    return this.#children.get(handle.id)?.isActive() === true;
  }

  async acquire(): Promise<KeepAwakePlatformHandle> {
    if (!this.isSupported()) throw new Error("macOS keep-awake is unavailable on this platform");
    const child = await this.#processFactory("/usr/bin/caffeinate", [
      "-i",
      "-w",
      String(this.#ownerPid),
    ]);
    const handle: KeepAwakePlatformHandle = Object.freeze({
      id: `caffeinate:${String(child.pid)}:${String(this.#ownerPid)}`,
      platform: "macos_caffeinate",
      pid: child.pid,
      ownerPid: this.#ownerPid,
    });
    this.#children.set(handle.id, child);
    return handle;
  }

  async release(handle: KeepAwakePlatformHandle): Promise<void> {
    const local = this.#children.get(handle.id);
    if (local !== undefined) {
      try {
        await local.terminate();
      } finally {
        this.#children.delete(handle.id);
      }
      return;
    }
    if (handle.platform !== "macos_caffeinate") {
      throw new Error("Cannot recover an assertion owned by another platform implementation");
    }
    await this.#staleAssertionReleaser(handle);
  }

  async readBatteryState(observedAt: string): Promise<KeepAwakeBatteryState> {
    if (!this.isSupported()) {
      return keepAwakeBatteryStateSchema.parse({ powerSource: "unknown", observedAt });
    }
    return await this.#batteryStateReader(isoTimestampSchema.parse(observedAt));
  }
}

interface StoredKeepAwakeState {
  readonly formatVersion: 1;
  readonly projectId: ProjectId;
  readonly state: KeepAwakeStatus["state"];
  readonly reasons: readonly KeepAwakeReason[];
  readonly batteryPolicy: KeepAwakeBatteryPolicy;
  readonly batteryState?: KeepAwakeBatteryState;
  readonly assertion?: KeepAwakePlatformHandle;
  readonly updatedAt: string;
  readonly message?: string;
}

export interface AcquireKeepAwakeRequest {
  readonly projectId: ProjectId;
  readonly reasonId: KeepAwakeReasonId;
  readonly reason: string;
  readonly actor: string;
}

export interface ReleaseKeepAwakeRequest {
  readonly projectId: ProjectId;
  readonly reasonId: KeepAwakeReasonId;
  readonly actor: string;
}

export type KeepAwakeOperationResult = Readonly<{
  outcome: "acquired" | "released" | "unchanged" | "declined" | "unavailable";
  status: KeepAwakeStatus;
}>;

export interface KeepAwakeClock {
  now(): number;
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface KeepAwakeManagerOptions {
  readonly platform?: KeepAwakePlatform;
  readonly batteryPolicy?: KeepAwakeBatteryPolicy;
  readonly clock?: KeepAwakeClock;
  readonly monitorIntervalMs?: number;
  readonly eventIdFactory?: () => string;
}

function systemClock(): KeepAwakeClock {
  return {
    now: () => Date.now(),
    setInterval: (callback, intervalMs) => {
      const timer = globalThis.setInterval(callback, intervalMs);
      timer.unref();
      return timer;
    },
    clearInterval: (handle) =>
      globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHandle(value: unknown): KeepAwakePlatformHandle | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value["id"] !== "string" ||
    (value["platform"] !== "macos_caffeinate" && value["platform"] !== "fake")
  ) {
    return undefined;
  }
  const pid = value["pid"];
  const ownerPid = value["ownerPid"];
  if (pid !== undefined && (!Number.isSafeInteger(pid) || (pid as number) <= 0)) return undefined;
  if (ownerPid !== undefined && (!Number.isSafeInteger(ownerPid) || (ownerPid as number) <= 0)) {
    return undefined;
  }
  return Object.freeze({
    id: value["id"],
    platform: value["platform"],
    ...(pid === undefined ? {} : { pid: pid as number }),
    ...(ownerPid === undefined ? {} : { ownerPid: ownerPid as number }),
  });
}

function parseStoredState(value: unknown): StoredKeepAwakeState | undefined {
  if (!isRecord(value)) return undefined;
  const status = keepAwakeStatusSchema.safeParse({
    formatVersion: value["formatVersion"],
    projectId: value["projectId"],
    state: value["state"],
    systemSleepPrevented: value["state"] === "active",
    displaySleepAllowed: true,
    reasons: value["reasons"],
    batteryPolicy: value["batteryPolicy"],
    ...(value["batteryState"] === undefined ? {} : { batteryState: value["batteryState"] }),
    updatedAt: value["updatedAt"],
    ...(value["message"] === undefined ? {} : { message: value["message"] }),
  });
  if (!status.success) return undefined;
  const assertion = value["assertion"] === undefined ? undefined : parseHandle(value["assertion"]);
  if (value["assertion"] !== undefined && assertion === undefined) return undefined;
  if (status.data.state === "active" && assertion === undefined) return undefined;
  if (
    assertion !== undefined &&
    status.data.state !== "active" &&
    status.data.state !== "recovery_required"
  ) {
    return undefined;
  }
  return Object.freeze({
    formatVersion: 1 as const,
    projectId: status.data.projectId,
    state: status.data.state,
    reasons: status.data.reasons,
    batteryPolicy: status.data.batteryPolicy,
    ...(status.data.batteryState === undefined ? {} : { batteryState: status.data.batteryState }),
    ...(assertion === undefined ? {} : { assertion }),
    updatedAt: status.data.updatedAt,
    ...(status.data.message === undefined ? {} : { message: status.data.message }),
  });
}

function jsonState(state: StoredKeepAwakeState): JsonObject {
  const batteryState =
    state.batteryState === undefined
      ? undefined
      : {
          powerSource: state.batteryState.powerSource,
          observedAt: state.batteryState.observedAt,
          ...(state.batteryState.levelPercent === undefined
            ? {}
            : { levelPercent: state.batteryState.levelPercent }),
        };
  const assertion =
    state.assertion === undefined
      ? undefined
      : {
          id: state.assertion.id,
          platform: state.assertion.platform,
          ...(state.assertion.pid === undefined ? {} : { pid: state.assertion.pid }),
          ...(state.assertion.ownerPid === undefined ? {} : { ownerPid: state.assertion.ownerPid }),
        };
  return {
    formatVersion: 1,
    projectId: state.projectId,
    state: state.state,
    reasons: state.reasons.map((reason) => ({ ...reason })),
    batteryPolicy: { ...state.batteryPolicy },
    ...(batteryState === undefined ? {} : { batteryState }),
    ...(assertion === undefined ? {} : { assertion }),
    updatedAt: state.updatedAt,
    ...(state.message === undefined ? {} : { message: state.message }),
  };
}

function batteryAllowsAssertion(state: KeepAwakeBatteryState, threshold: number): boolean {
  if (state.powerSource === "external_power") return true;
  return (
    state.powerSource === "battery" &&
    state.levelPercent !== undefined &&
    state.levelPercent >= threshold
  );
}

function withoutAssertion(state: StoredKeepAwakeState): Omit<StoredKeepAwakeState, "assertion"> {
  return Object.freeze({
    formatVersion: state.formatVersion,
    projectId: state.projectId,
    state: state.state,
    reasons: state.reasons,
    batteryPolicy: state.batteryPolicy,
    ...(state.batteryState === undefined ? {} : { batteryState: state.batteryState }),
    updatedAt: state.updatedAt,
    ...(state.message === undefined ? {} : { message: state.message }),
  });
}

/** Core-owned, project-scoped keep-awake lifecycle with durable demand and stale-state recovery. */
export class KeepAwakeManager {
  readonly #platform: KeepAwakePlatform;
  readonly #batteryPolicy: KeepAwakeBatteryPolicy;
  readonly #clock: KeepAwakeClock;
  readonly #monitorIntervalMs: number;
  readonly #eventIdFactory: () => string;
  readonly #ownedHandles = new Set<string>();
  readonly #monitoredProjects = new Set<ProjectId>();
  #monitor: unknown;
  #operation: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly database: DensaDatabase,
    options: KeepAwakeManagerOptions = {},
  ) {
    this.#platform = options.platform ?? new MacOsKeepAwakePlatform();
    this.#batteryPolicy = keepAwakeBatteryPolicySchema.parse(
      options.batteryPolicy ?? { minimumLevelPercent: DEFAULT_MINIMUM_BATTERY_PERCENT },
    );
    this.#clock = options.clock ?? systemClock();
    this.#monitorIntervalMs = options.monitorIntervalMs ?? DEFAULT_MONITOR_INTERVAL_MS;
    if (!Number.isSafeInteger(this.#monitorIntervalMs) || this.#monitorIntervalMs < 1_000) {
      throw new Error("Keep-awake monitor interval must be at least one second");
    }
    this.#eventIdFactory = options.eventIdFactory ?? (() => `keep-awake-${randomUUID()}`);
  }

  status(projectIdInput: ProjectId): KeepAwakeStatus {
    const projectId = projectIdSchema.parse(projectIdInput);
    const raw = this.#rawState(projectId);
    const stored = this.#stored(projectId);
    if (stored === undefined) {
      if (raw === undefined) return this.#inactiveStatus(projectId);
      return keepAwakeStatusSchema.parse({
        ...this.#inactiveStatus(projectId),
        state: "recovery_required",
        message: "Persisted keep-awake state is malformed and requires recovery",
      });
    }
    if (
      stored.assertion !== undefined &&
      (!this.#ownedHandles.has(stored.assertion.id) || !this.#platform.isActive(stored.assertion))
    ) {
      return keepAwakeStatusSchema.parse({
        ...this.#publicStatus(stored),
        state: "recovery_required",
        systemSleepPrevented: false,
        message: "A persisted assertion requires recovery before its status can be trusted",
      });
    }
    return this.#publicStatus(stored);
  }

  async acquire(request: AcquireKeepAwakeRequest): Promise<KeepAwakeOperationResult> {
    return await this.#serialize(async () => {
      const projectId = projectIdSchema.parse(request.projectId);
      const reasonId = keepAwakeReasonIdSchema.parse(request.reasonId);
      if (this.database.repositories.projects.findById(projectId) === undefined) {
        throw new Error(`Project ${projectId} does not exist`);
      }
      const current = this.#stored(projectId);
      const existing = current?.reasons.find((reason) => reason.id === reasonId);
      if (existing !== undefined) {
        if (existing.reason !== request.reason.trim() || existing.actor !== request.actor.trim()) {
          throw new Error(`Keep-awake reason ${reasonId} is already associated differently`);
        }
        return Object.freeze({ outcome: "unchanged" as const, status: this.status(projectId) });
      }
      const occurredAt = this.#now();
      const reason = keepAwakeReasonSchema.parse({
        id: reasonId,
        projectId,
        reason: request.reason,
        actor: request.actor,
        acquiredAt: occurredAt,
      });
      const base = current ?? this.#inactiveState(projectId, occurredAt);
      const next = await this.#reconcile(
        Object.freeze({ ...base, reasons: Object.freeze([...base.reasons, reason]) }),
        occurredAt,
      );
      try {
        this.#persist(next, request.actor, "KEEP_AWAKE_REASON_ACQUIRED", {
          reasonId,
          disposition: next.state,
        });
      } catch (error) {
        await this.#releaseNewAssertionAfterPersistenceFailure(current, next);
        throw error;
      }
      this.#monitorProject(projectId);
      return Object.freeze({
        outcome:
          next.state === "active"
            ? ("acquired" as const)
            : next.state === "declined"
              ? ("declined" as const)
              : ("unavailable" as const),
        status: this.status(projectId),
      });
    });
  }

  async release(request: ReleaseKeepAwakeRequest): Promise<KeepAwakeOperationResult> {
    return await this.#serialize(async () => {
      const projectId = projectIdSchema.parse(request.projectId);
      const reasonId = keepAwakeReasonIdSchema.parse(request.reasonId);
      if (request.actor.trim().length === 0) throw new Error("Release actor must not be empty");
      const current = this.#stored(projectId);
      if (current === undefined || !current.reasons.some((reason) => reason.id === reasonId)) {
        return Object.freeze({ outcome: "unchanged" as const, status: this.status(projectId) });
      }
      const occurredAt = this.#now();
      const nextReasons = Object.freeze(current.reasons.filter((reason) => reason.id !== reasonId));
      const next = await this.#reconcile(
        Object.freeze({ ...current, reasons: nextReasons }),
        occurredAt,
      );
      this.#persist(next, request.actor, "KEEP_AWAKE_REASON_RELEASED", {
        reasonId,
        remainingReasonCount: nextReasons.length,
      });
      if (nextReasons.length === 0) this.#unmonitorProject(projectId);
      return Object.freeze({ outcome: "released" as const, status: this.status(projectId) });
    });
  }

  async releaseProject(
    projectIdInput: ProjectId,
    actor: string,
  ): Promise<KeepAwakeOperationResult> {
    return await this.#serialize(async () => {
      const projectId = projectIdSchema.parse(projectIdInput);
      if (actor.trim().length === 0) throw new Error("Release actor must not be empty");
      const current = this.#stored(projectId);
      if (
        current === undefined ||
        (current.reasons.length === 0 && current.assertion === undefined)
      ) {
        return Object.freeze({ outcome: "unchanged" as const, status: this.status(projectId) });
      }
      const occurredAt = this.#now();
      const next = await this.#reconcile(
        Object.freeze({ ...current, reasons: Object.freeze([]) }),
        occurredAt,
      );
      this.#persist(next, actor, "KEEP_AWAKE_PROJECT_RELEASED", {
        releasedReasonCount: current.reasons.length,
      });
      this.#unmonitorProject(projectId);
      return Object.freeze({ outcome: "released" as const, status: this.status(projectId) });
    });
  }

  async reevaluateBatteryPolicy(
    projectIdInput: ProjectId,
    actor = "core:keep-awake-battery-monitor",
  ): Promise<KeepAwakeOperationResult> {
    return await this.#serialize(async () => {
      const projectId = projectIdSchema.parse(projectIdInput);
      const current = this.#stored(projectId);
      if (current === undefined || current.reasons.length === 0) {
        return Object.freeze({ outcome: "unchanged" as const, status: this.status(projectId) });
      }
      const occurredAt = this.#now();
      const next = await this.#reconcile(current, occurredAt);
      try {
        this.#persist(next, actor, "KEEP_AWAKE_BATTERY_POLICY_EVALUATED", {
          disposition: next.state,
          minimumLevelPercent: next.batteryPolicy.minimumLevelPercent,
        });
      } catch (error) {
        await this.#releaseNewAssertionAfterPersistenceFailure(current, next);
        throw error;
      }
      return Object.freeze({
        outcome:
          next.state === "active"
            ? ("acquired" as const)
            : next.state === "declined"
              ? ("declined" as const)
              : ("unavailable" as const),
        status: this.status(projectId),
      });
    });
  }

  async recover(actor = "core:keep-awake-recovery"): Promise<readonly KeepAwakeStatus[]> {
    return await this.#serialize(async () => {
      if (actor.trim().length === 0) throw new Error("Recovery actor must not be empty");
      const recovered: KeepAwakeStatus[] = [];
      for (const settings of this.database.repositories.projectSettings.list()) {
        const raw = settings.values["keepAwake"];
        if (raw === undefined) continue;
        const current = parseStoredState(raw);
        const occurredAt = this.#now();
        if (current === undefined) {
          const projectId = projectIdSchema.parse(settings.projectId);
          const next = this.#inactiveState(projectId, occurredAt);
          this.#persist(next, actor, "KEEP_AWAKE_RECOVERY_COMPLETED", {
            cleanupConfirmed: false,
            malformedStateDiscarded: true,
          });
          recovered.push(this.status(projectId));
          continue;
        }
        let next: StoredKeepAwakeState;
        try {
          if (current.assertion !== undefined) await this.#platform.release(current.assertion);
          this.#ownedHandles.delete(current.assertion?.id ?? "");
          next = this.#inactiveState(current.projectId, occurredAt);
        } catch (error) {
          next = Object.freeze({
            ...current,
            state: "recovery_required" as const,
            updatedAt: occurredAt,
            message: `Stale assertion cleanup could not be confirmed: ${this.#errorMessage(error)}`,
          });
        }
        this.#persist(next, actor, "KEEP_AWAKE_RECOVERY_COMPLETED", {
          cleanupConfirmed: next.state === "inactive",
        });
        this.#unmonitorProject(current.projectId);
        recovered.push(this.status(current.projectId));
      }
      return Object.freeze(recovered);
    });
  }

  async dispose(actor = "core:keep-awake-shutdown"): Promise<void> {
    const projectIds = [...this.#monitoredProjects];
    for (const projectId of projectIds) await this.releaseProject(projectId, actor);
    if (this.#monitor !== undefined) {
      this.#clock.clearInterval(this.#monitor);
      this.#monitor = undefined;
    }
  }

  async #reconcile(state: StoredKeepAwakeState, occurredAt: string): Promise<StoredKeepAwakeState> {
    if (state.reasons.length === 0) {
      if (state.assertion !== undefined) {
        try {
          await this.#platform.release(state.assertion);
          this.#ownedHandles.delete(state.assertion.id);
        } catch (error) {
          return Object.freeze({
            ...state,
            state: "recovery_required" as const,
            updatedAt: occurredAt,
            message: `Keep-awake release could not be confirmed: ${this.#errorMessage(error)}`,
          });
        }
      }
      return this.#inactiveState(state.projectId, occurredAt);
    }

    let batteryState: KeepAwakeBatteryState;
    try {
      batteryState = keepAwakeBatteryStateSchema.parse(
        await this.#platform.readBatteryState(occurredAt),
      );
    } catch (error) {
      if (state.assertion !== undefined) {
        try {
          await this.#platform.release(state.assertion);
          this.#ownedHandles.delete(state.assertion.id);
        } catch {
          return Object.freeze({
            ...state,
            state: "recovery_required" as const,
            updatedAt: occurredAt,
            message: "Battery state failed and the existing assertion could not be released",
          });
        }
      }
      return Object.freeze({
        ...withoutAssertion(state),
        state: "unavailable" as const,
        updatedAt: occurredAt,
        message: `Battery state is unavailable: ${this.#errorMessage(error)}`,
      });
    }

    if (!batteryAllowsAssertion(batteryState, state.batteryPolicy.minimumLevelPercent)) {
      if (state.assertion !== undefined) {
        try {
          await this.#platform.release(state.assertion);
          this.#ownedHandles.delete(state.assertion.id);
        } catch (error) {
          return Object.freeze({
            ...state,
            state: "recovery_required" as const,
            batteryState,
            updatedAt: occurredAt,
            message: `Battery policy required release, but cleanup failed: ${this.#errorMessage(error)}`,
          });
        }
      }
      return Object.freeze({
        ...withoutAssertion(state),
        state: "declined" as const,
        batteryState,
        updatedAt: occurredAt,
        message:
          batteryState.powerSource === "battery"
            ? `Battery level is below the ${String(state.batteryPolicy.minimumLevelPercent)}% threshold`
            : "Power source could not be verified safely",
      });
    }

    if (!this.#platform.isSupported()) {
      if (state.assertion !== undefined) {
        try {
          await this.#platform.release(state.assertion);
          this.#ownedHandles.delete(state.assertion.id);
        } catch (error) {
          return Object.freeze({
            ...state,
            state: "recovery_required" as const,
            batteryState,
            updatedAt: occurredAt,
            message: `Unsupported platform could not clean up a stale assertion: ${this.#errorMessage(error)}`,
          });
        }
      }
      return Object.freeze({
        ...withoutAssertion(state),
        state: "unavailable" as const,
        batteryState,
        updatedAt: occurredAt,
        message: "Built-in keep-awake is available only on macOS",
      });
    }

    if (
      state.assertion !== undefined &&
      this.#ownedHandles.has(state.assertion.id) &&
      this.#platform.isActive(state.assertion)
    ) {
      return Object.freeze({
        ...state,
        state: "active" as const,
        batteryState,
        updatedAt: occurredAt,
        message: "Idle system sleep is prevented while display sleep remains allowed",
      });
    }
    if (state.assertion !== undefined) {
      this.#ownedHandles.delete(state.assertion.id);
      try {
        await this.#platform.release(state.assertion);
      } catch (error) {
        return Object.freeze({
          ...state,
          state: "recovery_required" as const,
          batteryState,
          updatedAt: occurredAt,
          message: `A stale assertion must be recovered before reacquiring: ${this.#errorMessage(error)}`,
        });
      }
    }
    try {
      const assertion = await this.#platform.acquire(state.projectId);
      this.#ownedHandles.add(assertion.id);
      return Object.freeze({
        ...state,
        state: "active" as const,
        batteryState,
        assertion,
        updatedAt: occurredAt,
        message: "Idle system sleep is prevented while display sleep remains allowed",
      });
    } catch (error) {
      return Object.freeze({
        ...withoutAssertion(state),
        state: "unavailable" as const,
        batteryState,
        updatedAt: occurredAt,
        message: `Keep-awake assertion could not be acquired: ${this.#errorMessage(error)}`,
      });
    }
  }

  #stored(projectId: ProjectId): StoredKeepAwakeState | undefined {
    const state = parseStoredState(this.#rawState(projectId));
    return state?.projectId === projectId ? state : undefined;
  }

  #rawState(projectId: ProjectId): unknown {
    return this.database.repositories.projectSettings.findByProjectId(projectId)?.values[
      "keepAwake"
    ];
  }

  #inactiveState(projectId: ProjectId, updatedAt: string): StoredKeepAwakeState {
    return Object.freeze({
      formatVersion: 1 as const,
      projectId,
      state: "inactive" as const,
      reasons: Object.freeze([]),
      batteryPolicy: this.#batteryPolicy,
      updatedAt,
      message: "No active keep-awake reasons",
    });
  }

  #inactiveStatus(projectId: ProjectId): KeepAwakeStatus {
    return this.#publicStatus(this.#inactiveState(projectId, this.#now()));
  }

  #publicStatus(state: StoredKeepAwakeState): KeepAwakeStatus {
    return keepAwakeStatusSchema.parse({
      formatVersion: 1,
      projectId: state.projectId,
      state: state.state,
      systemSleepPrevented: state.state === "active",
      displaySleepAllowed: true,
      reasons: state.reasons,
      batteryPolicy: state.batteryPolicy,
      ...(state.batteryState === undefined ? {} : { batteryState: state.batteryState }),
      updatedAt: state.updatedAt,
      ...(state.message === undefined ? {} : { message: state.message }),
    });
  }

  #persist(state: StoredKeepAwakeState, actor: string, type: string, payload: JsonObject): void {
    const eventId = eventIdSchema.parse(this.#eventIdFactory());
    this.database.transaction((repositories) => {
      const settings = repositories.projectSettings.findByProjectId(state.projectId);
      repositories.projectSettings.set({
        projectId: state.projectId,
        values: { ...(settings?.values ?? {}), keepAwake: jsonState(state) },
        updatedAt: state.updatedAt,
      });
      repositories.events.append({
        id: eventId,
        projectId: state.projectId,
        type,
        eventVersion: 1,
        occurredAt: state.updatedAt,
        actor,
        payload,
      });
    });
  }

  #monitorProject(projectId: ProjectId): void {
    this.#monitoredProjects.add(projectId);
    if (this.#monitor !== undefined) return;
    this.#monitor = this.#clock.setInterval(() => {
      for (const monitoredProjectId of this.#monitoredProjects) {
        void this.reevaluateBatteryPolicy(monitoredProjectId).catch(() => {
          // Reconciliation persists safe unavailable/recovery state when the boundary itself works.
        });
      }
    }, this.#monitorIntervalMs);
  }

  #unmonitorProject(projectId: ProjectId): void {
    this.#monitoredProjects.delete(projectId);
    if (this.#monitoredProjects.size === 0 && this.#monitor !== undefined) {
      this.#clock.clearInterval(this.#monitor);
      this.#monitor = undefined;
    }
  }

  #now(): string {
    return isoTimestampSchema.parse(new Date(this.#clock.now()).toISOString());
  }

  #errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async #releaseNewAssertionAfterPersistenceFailure(
    previous: StoredKeepAwakeState | undefined,
    next: StoredKeepAwakeState,
  ): Promise<void> {
    if (next.assertion === undefined || previous?.assertion?.id === next.assertion.id) {
      return;
    }
    try {
      await this.#platform.release(next.assertion);
    } finally {
      this.#ownedHandles.delete(next.assertion.id);
    }
  }

  async #serialize<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }
}
