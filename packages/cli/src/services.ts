import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";

import { CodexAdapter } from "@densa-ade/agent-sdk";
import {
  CoreDaemonManager,
  CoreIpcClient,
  CoreIpcError,
  runHeadlessOnePhaseProof,
} from "@densa-ade/core";
import {
  jsonValueSchema,
  type CoreDaemonLifecycleStatus,
  type JsonValue,
  type RequestEnvelope,
} from "@densa-ade/protocol";

import { CliCommandError, EXIT_FAILURE, EXIT_UNAVAILABLE } from "./contracts.js";

export type DoctorCheckName = "node" | "git" | "platform" | "agent" | "core";
export type DoctorCheckStatus = "available" | "unavailable" | "placeholder";

export interface DoctorCheck {
  name: DoctorCheckName;
  status: DoctorCheckStatus;
  detail: string;
}

export interface DoctorService {
  inspect(): Promise<readonly DoctorCheck[]>;
}

export interface CoreClient {
  request(request: RequestEnvelope): Promise<JsonValue>;
}

export interface CoreLifecycleService {
  start(): Promise<CoreDaemonLifecycleStatus>;
  status(): Promise<CoreDaemonLifecycleStatus>;
  stop(): Promise<CoreDaemonLifecycleStatus>;
}

export interface CliServices {
  coreClient: CoreClient;
  coreLifecycle: CoreLifecycleService;
  doctorService: DoctorService;
  phaseOneProofService: PhaseOneProofService;
  createRequestId(): string;
}

export interface PhaseOneProofService {
  run(): Promise<JsonValue>;
}

export class LocalPhaseOneProofService implements PhaseOneProofService {
  async run(): Promise<JsonValue> {
    const result = await runHeadlessOnePhaseProof({
      adapter: new CodexAdapter(),
      retainArtifacts: true,
    });
    if (result.verdict === "FAIL") {
      throw new CliCommandError("PROCESS_FAILURE", result.failureReasons.join(" "), EXIT_FAILURE, {
        diagnosticsPath: result.diagnosticsPath,
        workspacePath: result.workspacePath,
        databasePath: result.databasePath,
      });
    }
    return jsonValueSchema.parse(result);
  }
}

export class LocalCoreClient implements CoreClient {
  readonly #client = new CoreIpcClient();

  async request(request: RequestEnvelope): Promise<JsonValue> {
    try {
      return await this.#client.request(request);
    } catch (error) {
      if (error instanceof CoreIpcError) {
        throw new CliCommandError(
          error.protocolError.code,
          error.protocolError.message,
          EXIT_UNAVAILABLE,
          error.protocolError.details,
        );
      }
      throw new CliCommandError(
        "PROCESS_FAILURE",
        error instanceof Error ? error.message : "Densa ADE Core is unavailable",
        EXIT_UNAVAILABLE,
      );
    } finally {
      this.#client.disconnect();
    }
  }
}

export class LocalCoreLifecycleService implements CoreLifecycleService {
  readonly #manager = new CoreDaemonManager();

  async start(): Promise<CoreDaemonLifecycleStatus> {
    return await this.#manager.start();
  }

  async status(): Promise<CoreDaemonLifecycleStatus> {
    return await this.#manager.status();
  }

  async stop(): Promise<CoreDaemonLifecycleStatus> {
    return await this.#manager.stop();
  }
}

export class PlaceholderCoreClient implements CoreClient {
  async request(request: RequestEnvelope): Promise<JsonValue> {
    throw new CliCommandError(
      "PROCESS_FAILURE",
      `Densa ADE Core is not available for ${request.method}; this command is a Phase 0 placeholder.`,
      EXIT_UNAVAILABLE,
      { method: request.method },
    );
  }
}

export class LocalDoctorService implements DoctorService {
  constructor(private readonly coreLifecycle?: CoreLifecycleService) {}

  async inspect(): Promise<readonly DoctorCheck[]> {
    const git = await inspectGit();
    const core = await this.#inspectCore();

    return [
      {
        name: "node",
        status: "available",
        detail: process.version,
      },
      git,
      {
        name: "platform",
        status: "available",
        detail: `${process.platform} (${process.arch})`,
      },
      {
        name: "agent",
        status: "placeholder",
        detail: "agent detection begins in Phase 1",
      },
      core,
    ];
  }

  async #inspectCore(): Promise<DoctorCheck> {
    if (this.coreLifecycle === undefined) {
      return { name: "core", status: "placeholder", detail: "Core lifecycle not configured" };
    }
    const status = await this.coreLifecycle.status();
    return {
      name: "core",
      status: "available",
      detail:
        status.state === "running"
          ? `running (pid ${String(status.pid)})`
          : "installed (not running)",
    };
  }
}

async function inspectGit(): Promise<DoctorCheck> {
  try {
    const execute = promisify(execFile);
    const { stdout } = await execute("git", ["--version"], { encoding: "utf8" });

    return {
      name: "git",
      status: "available",
      detail: stdout.trim(),
    };
  } catch (error) {
    return {
      name: "git",
      status: "unavailable",
      detail: error instanceof Error ? error.message : "Git could not be executed",
    };
  }
}
