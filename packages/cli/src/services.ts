import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";

import type { JsonValue, RequestEnvelope } from "@densa/protocol";

import { CliCommandError, EXIT_UNAVAILABLE } from "./contracts.js";

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

export interface CliServices {
  coreClient: CoreClient;
  doctorService: DoctorService;
  createRequestId(): string;
}

export class PlaceholderCoreClient implements CoreClient {
  async request(request: RequestEnvelope): Promise<JsonValue> {
    throw new CliCommandError(
      "PROCESS_FAILURE",
      `Densa Core is not available for ${request.method}; this command is a Phase 0 placeholder.`,
      EXIT_UNAVAILABLE,
      { method: request.method },
    );
  }
}

export class LocalDoctorService implements DoctorService {
  async inspect(): Promise<readonly DoctorCheck[]> {
    const git = await inspectGit();

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
      {
        name: "core",
        status: "placeholder",
        detail: "local Core connectivity begins in Phase 2",
      },
    ];
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
