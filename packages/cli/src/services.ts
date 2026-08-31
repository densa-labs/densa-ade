import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";

import {
  jsonValueSchema,
  protocolErrorSchema,
  type CoreDaemonLifecycleStatus,
  type JsonValue,
  type ProtocolError,
  type RequestEnvelope,
} from "@densa-ade/protocol";

import { CliCommandError, EXIT_FAILURE, EXIT_UNAVAILABLE, EXIT_USAGE } from "./contracts.js";

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

interface DisconnectableCoreClient {
  request(request: RequestEnvelope): Promise<JsonValue>;
  disconnect(): void;
}

export class LocalPhaseOneProofService implements PhaseOneProofService {
  async run(): Promise<JsonValue> {
    const [{ CodexAdapter }, { runHeadlessOnePhaseProof }] = await Promise.all([
      import("@densa-ade/agent-sdk"),
      import("@densa-ade/core"),
    ]);
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
  #client: DisconnectableCoreClient | undefined;

  constructor(client?: DisconnectableCoreClient) {
    this.#client = client;
  }

  async request(request: RequestEnvelope): Promise<JsonValue> {
    let client: DisconnectableCoreClient | undefined;
    try {
      client = await this.#getClient();
      return await client.request(request);
    } catch (error) {
      if (isCoreIpcError(error)) {
        throw new CliCommandError(
          error.protocolError.code,
          error.protocolError.message,
          error.protocolError.code === "USER_CONFIGURATION_ERROR" ? EXIT_USAGE : EXIT_FAILURE,
          error.protocolError.details,
        );
      }
      throw new CliCommandError(
        "PROCESS_FAILURE",
        error instanceof Error ? error.message : "Densa ADE Core is unavailable",
        EXIT_UNAVAILABLE,
      );
    } finally {
      client?.disconnect();
    }
  }

  async #getClient(): Promise<DisconnectableCoreClient> {
    this.#client ??= new (await import("@densa-ade/core")).CoreIpcClient();
    return this.#client;
  }
}

export class LocalCoreLifecycleService implements CoreLifecycleService {
  #manager: CoreLifecycleService | undefined;

  async start(): Promise<CoreDaemonLifecycleStatus> {
    return await (await this.#getManager()).start();
  }

  async status(): Promise<CoreDaemonLifecycleStatus> {
    return await (await this.#getManager()).status();
  }

  async stop(): Promise<CoreDaemonLifecycleStatus> {
    return await (await this.#getManager()).stop();
  }

  async #getManager(): Promise<CoreLifecycleService> {
    this.#manager ??= new (await import("@densa-ade/core")).CoreDaemonManager();
    return this.#manager;
  }
}

function isCoreIpcError(error: unknown): error is Error & { protocolError: ProtocolError } {
  return (
    error instanceof Error &&
    error.name === "CoreIpcError" &&
    "protocolError" in error &&
    protocolErrorSchema.safeParse(error.protocolError).success
  );
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
