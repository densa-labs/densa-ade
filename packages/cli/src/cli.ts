import { randomUUID } from "node:crypto";

import {
  PROTOCOL_VERSION,
  jsonValueSchema,
  requestEnvelopeSchema,
  type JsonValue,
  type ProtocolError,
} from "@densa/protocol";

import {
  CLI_OUTPUT_SCHEMA_VERSION,
  CLI_VERSION,
  CliCommandError,
  EXIT_FAILURE,
  EXIT_SUCCESS,
  EXIT_USAGE,
  type CliCommandName,
  type CliExitCode,
  type CliFailureOutput,
  type CliIo,
  type CliOutput,
  type CliSuccessOutput,
} from "./contracts.js";
import {
  LocalDoctorService,
  LocalCoreClient,
  LocalCoreLifecycleService,
  LocalPhaseOneProofService,
  type CliServices,
  type DoctorCheck,
} from "./services.js";

const HELP_TEXT = `Usage: densa [--json] <command>

Headless client shell for Densa Core.

Commands:
  core start             Start the user-local Densa Core daemon
  core status            Show daemon connectivity and process status
  core stop              Stop the Densa Core daemon cleanly
  doctor                 Check Node, Git, platform, agent, and Core readiness
  proof phase-one        Run the P9M0 disposable real-agent headless proof
  project init           Initialize a Densa project through Core
  project status         Show the current project status
  project start          Start the current project
  project pause          Pause the current project
  project cancel         Immediately interrupt the current worker and pause
  project resume         Resume the current project
  project stop           Stop scheduling without deleting work
  events                 List project events
  version                Show CLI and protocol versions

Options:
  --json                  Emit one stable JSON object instead of human text
  -h, --help              Show help
  -v, --version           Show version`;

interface ParsedInvocation {
  command: CliCommandName;
  json: boolean;
}

interface CommandResult {
  data: JsonValue;
  human: string;
}

export interface RunCliOptions {
  io?: CliIo;
  services?: CliServices;
}

export async function runCli(
  arguments_: readonly string[],
  options: RunCliOptions = {},
): Promise<CliExitCode> {
  const io = options.io ?? processIo();
  const services = options.services ?? createDefaultServices();
  let invocation: ParsedInvocation = { command: "help", json: arguments_.includes("--json") };

  try {
    invocation = parseInvocation(arguments_);
    const result = await executeCommand(invocation.command, services);
    const output: CliSuccessOutput = {
      schemaVersion: CLI_OUTPUT_SCHEMA_VERSION,
      command: invocation.command,
      ok: true,
      data: result.data,
    };

    writeSuccess(io, invocation.json, output, result.human);
    return EXIT_SUCCESS;
  } catch (error) {
    const failure = normalizeFailure(error);
    const protocolError: ProtocolError = {
      code: failure.code,
      message: failure.message,
      ...(failure.details === undefined ? {} : { details: failure.details }),
    };
    const output: CliFailureOutput = {
      schemaVersion: CLI_OUTPUT_SCHEMA_VERSION,
      command: invocation.command,
      ok: false,
      error: protocolError,
    };

    writeFailure(io, invocation.json, output);
    return failure.exitCode;
  }
}

function parseInvocation(arguments_: readonly string[]): ParsedInvocation {
  const json = arguments_.includes("--json");
  const tokens = arguments_.filter((argument) => argument !== "--json");

  if (tokens.length === 0 || tokens[0] === "help" || tokens[0] === "--help" || tokens[0] === "-h") {
    assertNoExtraArguments(tokens, tokens.length === 0 ? 0 : 1);
    return { command: "help", json };
  }

  if (tokens[0] === "version" || tokens[0] === "--version" || tokens[0] === "-v") {
    assertNoExtraArguments(tokens, 1);
    return { command: "version", json };
  }

  if (tokens[0] === "doctor" || tokens[0] === "events") {
    assertNoExtraArguments(tokens, 1);
    return { command: tokens[0], json };
  }

  if (tokens[0] === "core") {
    const subcommand = tokens[1];
    if (subcommand === "start" || subcommand === "status" || subcommand === "stop") {
      assertNoExtraArguments(tokens, 2);
      return { command: `core ${subcommand}`, json };
    }
    throw usageError(`Unknown core command: ${subcommand ?? ""}`);
  }

  if (tokens[0] === "proof") {
    if (tokens[1] === "phase-one") {
      assertNoExtraArguments(tokens, 2);
      return { command: "proof phase-one", json };
    }
    throw usageError(`Unknown proof command: ${tokens[1] ?? ""}`);
  }

  if (tokens[0] === "project") {
    if (tokens.length === 1 || tokens[1] === "--help" || tokens[1] === "-h") {
      assertNoExtraArguments(tokens, tokens.length === 1 ? 1 : 2);
      return { command: "help", json };
    }

    const subcommand = tokens[1];
    if (
      subcommand === "init" ||
      subcommand === "status" ||
      subcommand === "start" ||
      subcommand === "pause" ||
      subcommand === "cancel" ||
      subcommand === "resume" ||
      subcommand === "stop"
    ) {
      assertNoExtraArguments(tokens, 2);
      return { command: `project ${subcommand}`, json };
    }

    throw usageError(`Unknown project command: ${subcommand ?? ""}`);
  }

  throw usageError(`Unknown command: ${tokens[0]}`);
}

function assertNoExtraArguments(tokens: readonly string[], expectedLength: number): void {
  if (tokens.length > expectedLength) {
    throw usageError(`Unexpected argument: ${tokens[expectedLength]}`);
  }
}

function usageError(message: string): CliCommandError {
  return new CliCommandError("USER_CONFIGURATION_ERROR", message, EXIT_USAGE);
}

async function executeCommand(
  command: CliCommandName,
  services: CliServices,
): Promise<CommandResult> {
  switch (command) {
    case "help":
      return { data: { text: HELP_TEXT }, human: HELP_TEXT };
    case "version":
      return {
        data: { cliVersion: CLI_VERSION, protocolVersion: PROTOCOL_VERSION },
        human: `densa ${CLI_VERSION}\nprotocol ${PROTOCOL_VERSION}`,
      };
    case "doctor":
      return runDoctor(services);
    case "proof phase-one": {
      const data = jsonValueSchema.parse(await services.phaseOneProofService.run());
      return { data, human: `proof phase-one: ${formatHumanValue(data)}` };
    }
    case "core start":
      return runCoreLifecycle(command, await services.coreLifecycle.start());
    case "core status":
      return runCoreLifecycle(command, await services.coreLifecycle.status());
    case "core stop":
      return runCoreLifecycle(command, await services.coreLifecycle.stop());
    case "events":
      return requestCore(command, "events.list", services);
    case "project init":
      return requestCore(command, "project.init", services);
    case "project status":
      return requestCore(command, "project.status", services);
    case "project start":
      return requestCore(command, "project.start", services);
    case "project pause":
      return requestCore(command, "project.pause", services);
    case "project cancel":
      return requestCore(command, "project.cancel", services);
    case "project resume":
      return requestCore(command, "project.resume", services);
    case "project stop":
      return requestCore(command, "project.stop", services);
  }
}

function runCoreLifecycle(
  command: "core start" | "core status" | "core stop",
  status: Awaited<ReturnType<CliServices["coreLifecycle"]["status"]>>,
): CommandResult {
  const data = jsonValueSchema.parse(status);
  return { data, human: `${command}: ${formatHumanValue(data)}` };
}

async function runDoctor(services: CliServices): Promise<CommandResult> {
  const checks = await services.doctorService.inspect();
  const dataChecks = checks.map((check) => ({
    name: check.name,
    status: check.status,
    detail: check.detail,
  }));
  const unavailableChecks = checks.filter((check) => check.status === "unavailable");

  if (unavailableChecks.length > 0) {
    throw new CliCommandError(
      "PROCESS_FAILURE",
      `Doctor found ${String(unavailableChecks.length)} unavailable requirement(s).`,
      EXIT_FAILURE,
      { checks: dataChecks },
    );
  }

  return {
    data: { checks: dataChecks },
    human: checks.map(formatDoctorCheck).join("\n"),
  };
}

function formatDoctorCheck(check: DoctorCheck): string {
  const marker = check.status === "available" ? "ok" : check.status;
  return `${check.name.padEnd(8)} ${marker.padEnd(11)} ${check.detail}`;
}

async function requestCore(
  command: CliCommandName,
  method: string,
  services: CliServices,
): Promise<CommandResult> {
  const request = requestEnvelopeSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    kind: "request",
    requestId: services.createRequestId(),
    method,
    payload: {},
  });
  const result = await services.coreClient.request(request);

  return {
    data: result,
    human: `${command}: ${formatHumanValue(result)}`,
  };
}

function formatHumanValue(value: JsonValue): string {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value, null, 2);
}

function normalizeFailure(error: unknown): CliCommandError {
  if (error instanceof CliCommandError) {
    return error;
  }

  return new CliCommandError(
    "INTERNAL_INVARIANT_VIOLATION",
    error instanceof Error ? error.message : "Unknown CLI failure",
    EXIT_FAILURE,
  );
}

function writeSuccess(io: CliIo, json: boolean, output: CliSuccessOutput, human: string): void {
  io.stdout(`${json ? serializeOutput(output) : human}\n`);
}

function writeFailure(io: CliIo, json: boolean, output: CliFailureOutput): void {
  if (json) {
    io.stdout(`${serializeOutput(output)}\n`);
    return;
  }

  io.stderr(`Error [${output.error.code}]: ${output.error.message}\n`);
}

function serializeOutput(output: CliOutput): string {
  return JSON.stringify(jsonValueSchema.parse(output));
}

function processIo(): CliIo {
  return {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
  };
}

function createDefaultServices(): CliServices {
  const coreLifecycle = new LocalCoreLifecycleService();
  return {
    coreClient: new LocalCoreClient(),
    coreLifecycle,
    doctorService: new LocalDoctorService(coreLifecycle),
    phaseOneProofService: new LocalPhaseOneProofService(),
    createRequestId: () => randomUUID(),
  };
}

export const cliHelpText = HELP_TEXT;
