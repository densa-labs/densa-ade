import { spawn } from "node:child_process";
import process from "node:process";

const FORCE_STOP_AFTER_MS = 500;

function parsedArgv(value: string | undefined): readonly string[] {
  if (value === undefined) throw new Error("Owned browser process command is missing");
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((part) => typeof part !== "string" || part.length === 0 || part.includes("\0"))
  ) {
    throw new Error("Owned browser process command is invalid");
  }
  return parsed;
}

const argv = parsedArgv(process.argv[2]);
const child = spawn(argv[0]!, argv.slice(1), {
  cwd: process.cwd(),
  env: process.env,
  shell: false,
  detached: false,
  stdio: ["ignore", "inherit", "inherit"],
});

let stopping = false;
let childExitCode: number | null = null;

function signalOwnedGroup(signal: NodeJS.Signals): void {
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-process.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function stopOwnedGroup(): void {
  if (stopping) return;
  stopping = true;
  signalOwnedGroup("SIGTERM");
  setTimeout(() => signalOwnedGroup("SIGKILL"), FORCE_STOP_AFTER_MS);
}

process.stdin.resume();
process.stdin.once("end", stopOwnedGroup);
process.stdin.once("close", stopOwnedGroup);
process.once("SIGTERM", stopOwnedGroup);
process.once("SIGINT", stopOwnedGroup);
process.once("SIGHUP", stopOwnedGroup);

child.once("error", () => {
  childExitCode = 125;
  stopOwnedGroup();
});
child.once("exit", (code) => {
  childExitCode = code;
  stopOwnedGroup();
});

process.once("exit", () => {
  process.exitCode = childExitCode ?? 1;
});
