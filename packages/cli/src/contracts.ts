import type { JsonObject, JsonValue, ProtocolError } from "@densa/protocol";

export const CLI_OUTPUT_SCHEMA_VERSION = 1 as const;
export const CLI_VERSION = "0.0.0" as const;

export const EXIT_SUCCESS = 0 as const;
export const EXIT_FAILURE = 1 as const;
export const EXIT_USAGE = 2 as const;
export const EXIT_UNAVAILABLE = 3 as const;

export type CliExitCode =
  typeof EXIT_SUCCESS | typeof EXIT_FAILURE | typeof EXIT_USAGE | typeof EXIT_UNAVAILABLE;

export type CliCommandName =
  | "help"
  | "core start"
  | "core status"
  | "core stop"
  | "doctor"
  | "project init"
  | "project status"
  | "project start"
  | "project pause"
  | "project cancel"
  | "project resume"
  | "project stop"
  | "events"
  | "version";

export interface CliSuccessOutput {
  schemaVersion: typeof CLI_OUTPUT_SCHEMA_VERSION;
  command: CliCommandName;
  ok: true;
  data: JsonValue;
}

export interface CliFailureOutput {
  schemaVersion: typeof CLI_OUTPUT_SCHEMA_VERSION;
  command: CliCommandName;
  ok: false;
  error: ProtocolError;
}

export type CliOutput = CliFailureOutput | CliSuccessOutput;

export interface CliIo {
  stdout(value: string): void;
  stderr(value: string): void;
}

export class CliCommandError extends Error {
  readonly details: JsonObject | undefined;

  constructor(
    readonly code: ProtocolError["code"],
    message: string,
    readonly exitCode: CliExitCode = EXIT_FAILURE,
    details?: JsonObject,
  ) {
    super(message);
    this.name = "CliCommandError";
    this.details = details;
  }
}
