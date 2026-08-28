import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import process from "node:process";
import type { Readable } from "node:stream";
import { tmpdir } from "node:os";

import type { JsonObject, ValidationDiagnostic, ValidatorOutcome } from "@densa/protocol";
import { chromium, type Browser, type Page } from "playwright";

import type { Validator, ValidatorContext } from "./validation-pipeline.js";

const MAX_METADATA_BYTES = 1_024 * 1_024;
const MAX_COMMAND_PART_BYTES = 4_096;
const MAX_COMMAND_ARGUMENTS = 128;
const MAX_RETAINED_LOG_BYTES = 64 * 1_024;
const MAX_RETAINED_LOG_ENTRIES = 128;
const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_RUN_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_GRACE_MS = 2_000;
const READY_POLL_INTERVAL_MS = 50;

export type BrowserValidationDetectionStatus =
  "configured" | "detected" | "manual_configuration_required" | "not_applicable";

export interface BrowserStartCommand {
  /** Executable followed by arguments. This is always spawned with shell=false. */
  readonly argv: readonly string[];
  readonly cwd: string;
}

export interface BrowserValidationTarget {
  readonly url: string;
  readonly startCommand: BrowserStartCommand;
  readonly source: "detected" | "user-configured";
}

export interface BrowserValidationDetection {
  readonly version: 1;
  readonly status: BrowserValidationDetectionStatus;
  readonly target?: BrowserValidationTarget;
  readonly issues: readonly BrowserValidationIssue[];
}

export interface BrowserValidationIssue {
  readonly code:
    | "AMBIGUOUS_PACKAGE_MANAGER"
    | "APP_URL_REQUIRED"
    | "NO_SAFE_START_COMMAND"
    | "UNSAFE_PROJECT_METADATA"
    | "UNSUPPORTED_PACKAGE_MANAGER";
  readonly message: string;
}

export interface DetectBrowserValidationRequest {
  readonly workspacePath: string;
  /** The roadmap/policy layer must make this decision; file heuristics do not opt a task in. */
  readonly browserRelevant: boolean;
  readonly appUrl?: string;
  readonly configuredStartCommand?: {
    readonly argv: readonly string[];
    readonly cwd?: string;
  };
}

export type BrowserCheck =
  | {
      readonly kind: "page_load";
      readonly path: string;
      readonly expectedStatus?: number;
    }
  | {
      readonly kind: "visible_text";
      readonly path: string;
      readonly text: string;
      readonly exact?: boolean;
    }
  | {
      readonly kind: "visible_selector";
      readonly path: string;
      readonly selector: string;
    };

export interface BrowserArtifact {
  readonly kind: "screenshot" | "trace";
  readonly path: string;
}

export interface BrowserLog {
  readonly level: "debug" | "info" | "warning" | "error";
  readonly message: string;
}

export interface PlaywrightRunRequest {
  readonly baseUrl: string;
  readonly checks: readonly BrowserCheck[];
  readonly artifactDirectory: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

export interface PlaywrightRunResult {
  readonly status: "passed" | "failed" | "error";
  readonly logs: readonly BrowserLog[];
  readonly logsTruncated: boolean;
  readonly artifacts: readonly BrowserArtifact[];
  readonly message?: string;
}

/** Browser-provider boundary used by Core browser validation and deterministic tests. */
export interface PlaywrightRunner {
  run(request: PlaywrightRunRequest): Promise<PlaywrightRunResult>;
}

export interface BrowserValidatorOptions {
  readonly runner?: PlaywrightRunner;
  readonly readyTimeoutMs?: number;
  readonly runTimeoutMs?: number;
  readonly stopGraceMs?: number;
  readonly artifactRoot?: string;
  readonly artifactId?: () => string;
}

interface CapturedLogs {
  readonly entries: readonly BrowserLog[];
  readonly truncated: boolean;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${label} must be positive`);
  return value;
}

function isInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))
  );
}

function redact(value: string): string {
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/giu, "$1[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED]")
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password)["']?\s*[:=]\s*["']?)[^"',\s}]+/giu,
      "$1[REDACTED]",
    );
}

function safeUrlForLog(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[invalid URL]";
  }
}

function boundedText(value: string, limit = 4_096): string {
  const safe = redact(value);
  const bytes = Buffer.from(safe);
  if (bytes.byteLength <= limit)
    return safe.length === 0 ? "No diagnostic text was emitted." : safe;
  return `${bytes.subarray(0, Math.max(0, limit - 14)).toString("utf8")}...[truncated]`;
}

class LogCapture {
  readonly #entries: BrowserLog[] = [];
  #bytes = 0;
  #truncated = false;

  append(level: BrowserLog["level"], rawMessage: string): void {
    if (this.#entries.length >= MAX_RETAINED_LOG_ENTRIES) {
      this.#truncated = true;
      return;
    }
    const message = boundedText(rawMessage, 4_096);
    if (byteLength(redact(rawMessage)) > byteLength(message)) this.#truncated = true;
    const bytes = byteLength(message);
    if (this.#bytes + bytes > MAX_RETAINED_LOG_BYTES) {
      this.#truncated = true;
      return;
    }
    this.#bytes += bytes;
    this.#entries.push(Object.freeze({ level, message }));
  }

  snapshot(): CapturedLogs {
    return Object.freeze({
      entries: Object.freeze([...this.#entries]),
      truncated: this.#truncated,
    });
  }
}

function validCommandPart(value: string): boolean {
  return value.length > 0 && !value.includes("\0") && byteLength(value) <= MAX_COMMAND_PART_BYTES;
}

function rejectsShellEvaluation(argv: readonly string[]): boolean {
  const executable = argv[0]?.split(/[\\/]/u).at(-1)?.toLowerCase();
  if (executable === undefined) return false;
  const shellFlags = new Set(["-c", "/c", "-command", "-encodedcommand"]);
  return (
    new Set(["sh", "bash", "zsh", "dash", "fish", "cmd", "cmd.exe", "powershell", "pwsh"]).has(
      executable,
    ) && argv.slice(1).some((argument) => shellFlags.has(argument.toLowerCase()))
  );
}

function normalizeRelativeDirectory(workspaceRoot: string, value: string | undefined): string {
  const cwd = value ?? ".";
  if (!validCommandPart(cwd) || isAbsolute(cwd)) {
    throw new Error("Browser start cwd must be a bounded workspace-relative path");
  }
  const absolute = resolve(workspaceRoot, cwd);
  if (!isInside(workspaceRoot, absolute))
    throw new Error("Browser start cwd cannot escape workspace");
  const normalized = relative(workspaceRoot, absolute);
  return normalized.length === 0 ? "." : normalized;
}

function normalizeStartCommand(
  workspaceRoot: string,
  input: DetectBrowserValidationRequest["configuredStartCommand"],
): BrowserStartCommand {
  if (
    input === undefined ||
    input.argv.length === 0 ||
    input.argv.length > MAX_COMMAND_ARGUMENTS ||
    input.argv.some((part) => !validCommandPart(part)) ||
    rejectsShellEvaluation(input.argv)
  ) {
    throw new Error("Browser start commands require bounded argv and no shell evaluation");
  }
  return Object.freeze({
    argv: Object.freeze([...input.argv]),
    cwd: normalizeRelativeDirectory(workspaceRoot, input.cwd),
  });
}

function normalizeAppUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Browser validation requires a valid absolute app URL");
  }
  if (
    parsed.protocol !== "http:" ||
    (parsed.hostname !== "127.0.0.1" &&
      parsed.hostname !== "localhost" &&
      parsed.hostname !== "[::1]") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error("Browser validation app URLs must be credential-free loopback HTTP URLs");
  }
  parsed.pathname = parsed.pathname.endsWith("/") ? parsed.pathname : `${parsed.pathname}/`;
  return parsed.toString();
}

function issue(code: BrowserValidationIssue["code"], message: string): BrowserValidationIssue {
  return Object.freeze({ code, message });
}

async function inspectPackageStartCommand(
  workspaceRoot: string,
): Promise<{ command?: BrowserStartCommand; issues: readonly BrowserValidationIssue[] }> {
  const packagePath = resolve(workspaceRoot, "package.json");
  try {
    const metadata = await lstat(packagePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_METADATA_BYTES) {
      return {
        issues: [
          issue(
            "UNSAFE_PROJECT_METADATA",
            "package.json is not a bounded regular file and was not inspected for an app start script.",
          ),
        ],
      };
    }
    const content = await readFile(packagePath, "utf8");
    if (byteLength(content) > MAX_METADATA_BYTES) throw new Error("oversized");
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    const object = parsed as Record<string, unknown>;
    const scripts =
      typeof object["scripts"] === "object" &&
      object["scripts"] !== null &&
      !Array.isArray(object["scripts"])
        ? (object["scripts"] as Record<string, unknown>)
        : {};
    const script = ["dev", "start", "serve", "preview"].find(
      (name) => typeof scripts[name] === "string" && scripts[name].trim().length > 0,
    );
    if (script === undefined) return { issues: [] };
    const packageManager = object["packageManager"];
    let manager =
      typeof packageManager === "string" && packageManager.length > 0
        ? packageManager.split("@", 1)[0]
        : undefined;
    const supportedManagers = new Set(["npm", "pnpm", "yarn", "bun"]);
    if (manager !== undefined && !supportedManagers.has(manager)) {
      return {
        issues: [
          issue(
            "UNSUPPORTED_PACKAGE_MANAGER",
            "package.json declares an unsupported package manager for browser startup.",
          ),
        ],
      };
    }
    if (manager === undefined) {
      const discovered = new Set<string>();
      for (const candidate of [
        { path: "package-lock.json", manager: "npm" },
        { path: "npm-shrinkwrap.json", manager: "npm" },
        { path: "pnpm-lock.yaml", manager: "pnpm" },
        { path: "yarn.lock", manager: "yarn" },
        { path: "bun.lock", manager: "bun" },
        { path: "bun.lockb", manager: "bun" },
      ]) {
        try {
          const lockfile = await lstat(resolve(workspaceRoot, candidate.path));
          if (!lockfile.isFile() || lockfile.isSymbolicLink()) {
            return {
              issues: [
                issue(
                  "UNSAFE_PROJECT_METADATA",
                  `${candidate.path} is not a regular lockfile and was not used for browser startup.`,
                ),
              ],
            };
          }
          discovered.add(candidate.manager);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            return {
              issues: [
                issue(
                  "UNSAFE_PROJECT_METADATA",
                  `${candidate.path} could not be safely inspected for browser startup.`,
                ),
              ],
            };
          }
        }
      }
      if (discovered.size > 1) {
        return {
          issues: [
            issue(
              "AMBIGUOUS_PACKAGE_MANAGER",
              "Multiple package-manager lockfile families were found; configure browser startup explicitly.",
            ),
          ],
        };
      }
      manager = [...discovered][0] ?? "npm";
    }
    return {
      command: Object.freeze({
        argv: Object.freeze([manager, "run", script]),
        cwd: ".",
      }),
      issues: [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { issues: [] };
    return {
      issues: [
        issue(
          "UNSAFE_PROJECT_METADATA",
          "package.json could not be safely parsed for an app start script.",
        ),
      ],
    };
  }
}

/** Read-only target planning. A relevant task still fails closed until its URL is explicit. */
export class BrowserValidationDetector {
  async detect(request: DetectBrowserValidationRequest): Promise<BrowserValidationDetection> {
    if (!isAbsolute(request.workspacePath)) {
      throw new Error("Browser validation detection requires an absolute workspace path");
    }
    const workspaceRoot = await realpath(request.workspacePath);
    if (!(await lstat(workspaceRoot)).isDirectory()) {
      throw new Error("Browser validation workspace must be a directory");
    }
    if (!request.browserRelevant) {
      return Object.freeze({
        version: 1 as const,
        status: "not_applicable" as const,
        issues: Object.freeze([]),
      });
    }

    const url = normalizeAppUrl(request.appUrl);
    const issues: BrowserValidationIssue[] = [];
    if (url === undefined) {
      issues.push(
        issue("APP_URL_REQUIRED", "A browser-relevant task requires an explicit app URL."),
      );
    }
    const configured =
      request.configuredStartCommand === undefined
        ? undefined
        : normalizeStartCommand(workspaceRoot, request.configuredStartCommand);
    const detected =
      configured === undefined
        ? await inspectPackageStartCommand(workspaceRoot)
        : { issues: Object.freeze([]) };
    issues.push(...detected.issues);
    const startCommand = configured ?? detected.command;
    if (startCommand === undefined) {
      issues.push(
        issue(
          "NO_SAFE_START_COMMAND",
          "No allowlisted app start script was detected; configure structured argv explicitly.",
        ),
      );
    }
    if (url === undefined || startCommand === undefined) {
      return Object.freeze({
        version: 1 as const,
        status: "manual_configuration_required" as const,
        issues: Object.freeze(issues),
      });
    }
    const source = configured === undefined ? "detected" : "user-configured";
    return Object.freeze({
      version: 1 as const,
      status: source === "detected" ? ("detected" as const) : ("configured" as const),
      target: Object.freeze({ url, startCommand, source }),
      issues: Object.freeze(issues),
    });
  }
}

function normalizeCheck(check: BrowserCheck): BrowserCheck {
  if (
    !check.path.startsWith("/") ||
    check.path.startsWith("//") ||
    check.path.includes("\0") ||
    check.path.includes("?") ||
    check.path.includes("#") ||
    byteLength(check.path) > 2_048
  ) {
    throw new Error("Browser check paths must be bounded absolute URL paths");
  }
  if (
    check.kind === "page_load" &&
    check.expectedStatus !== undefined &&
    (!Number.isInteger(check.expectedStatus) ||
      check.expectedStatus < 100 ||
      check.expectedStatus > 599)
  ) {
    throw new Error("Browser page-load status must be a valid HTTP status");
  }
  if (
    (check.kind === "visible_text" &&
      (!validCommandPart(check.text) || check.text.length > 2_048)) ||
    (check.kind === "visible_selector" &&
      (!validCommandPart(check.selector) || check.selector.length > 2_048))
  ) {
    throw new Error("Browser check values must be non-empty and bounded");
  }
  return Object.freeze({ ...check });
}

function sameOriginUrl(baseUrl: string, path: string): string {
  const base = new URL(baseUrl);
  const target = new URL(path, base);
  if (target.origin !== base.origin)
    throw new Error("Browser checks cannot navigate off the app origin");
  return target.toString();
}

async function runCheck(
  page: Page,
  baseUrl: string,
  check: BrowserCheck,
  timeoutMs: number,
): Promise<void> {
  const response = await page.goto(sameOriginUrl(baseUrl, check.path), {
    waitUntil: "load",
    timeout: timeoutMs,
  });
  if (response === null) throw new Error(`Navigation to ${check.path} returned no HTTP response`);
  if (new URL(page.url()).origin !== new URL(baseUrl).origin) {
    throw new Error(`Navigation to ${check.path} left the configured app origin`);
  }
  if (check.kind === "page_load") {
    const status = response.status();
    const expected = check.expectedStatus;
    if (expected === undefined ? status < 200 || status >= 400 : status !== expected) {
      throw new Error(
        `Navigation to ${check.path} returned HTTP ${String(status)}${expected === undefined ? "" : `; expected ${String(expected)}`}`,
      );
    }
    return;
  }
  if (check.kind === "visible_text") {
    await page
      .getByText(check.text, { exact: check.exact ?? true })
      .first()
      .waitFor({
        state: "visible",
        timeout: timeoutMs,
      });
    return;
  }
  await page.locator(check.selector).first().waitFor({ state: "visible", timeout: timeoutMs });
}

/** Real Playwright implementation. Core owns navigation, assertions, logs, and artifacts. */
export class ChromiumPlaywrightRunner implements PlaywrightRunner {
  async run(request: PlaywrightRunRequest): Promise<PlaywrightRunResult> {
    const logs = new LogCapture();
    const artifacts: BrowserArtifact[] = [];
    let browser: Browser | undefined;
    let tracing = false;
    let activeCheck: BrowserCheck | undefined;
    const onAbort = (): void => {
      void browser?.close().catch(() => undefined);
    };
    request.signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (request.signal.aborted) throw request.signal.reason;
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext();
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
      tracing = true;
      const page = await context.newPage();
      page.on("console", (message) => {
        const level = message.type();
        logs.append(
          level === "error"
            ? "error"
            : level === "warning"
              ? "warning"
              : level === "debug"
                ? "debug"
                : "info",
          `console.${level}: ${message.text()}`,
        );
      });
      page.on("pageerror", (error) => logs.append("error", `pageerror: ${error.message}`));
      page.on("requestfailed", (requestFailure) =>
        logs.append(
          "warning",
          `requestfailed: ${requestFailure.method()} ${safeUrlForLog(requestFailure.url())} ${requestFailure.failure()?.errorText ?? "unknown"}`,
        ),
      );
      for (const check of request.checks) {
        if (request.signal.aborted) throw request.signal.reason;
        activeCheck = check;
        await runCheck(page, request.baseUrl, check, request.timeoutMs);
      }
      activeCheck = undefined;
      await context.tracing.stop();
      tracing = false;
      const captured = logs.snapshot();
      return Object.freeze({
        status: "passed" as const,
        logs: captured.entries,
        logsTruncated: captured.truncated,
        artifacts: Object.freeze([]),
      });
    } catch (error) {
      const aborted = request.signal.aborted;
      const screenshotPath = resolve(request.artifactDirectory, "failure.png");
      const tracePath = resolve(request.artifactDirectory, "trace.zip");
      const contexts = browser?.contexts() ?? [];
      const page = contexts[0]?.pages()[0];
      if (page !== undefined && !page.isClosed()) {
        try {
          await page.screenshot({ path: screenshotPath, fullPage: true });
          artifacts.push(Object.freeze({ kind: "screenshot", path: screenshotPath }));
        } catch (artifactError) {
          logs.append("warning", `Screenshot capture failed: ${String(artifactError)}`);
        }
      }
      if (tracing && contexts[0] !== undefined) {
        try {
          await contexts[0].tracing.stop({ path: tracePath });
          artifacts.push(Object.freeze({ kind: "trace", path: tracePath }));
          tracing = false;
        } catch (artifactError) {
          logs.append("warning", `Trace capture failed: ${String(artifactError)}`);
        }
      }
      const captured = logs.snapshot();
      return Object.freeze({
        status: aborted ? ("error" as const) : ("failed" as const),
        logs: captured.entries,
        logsTruncated: captured.truncated,
        artifacts: Object.freeze(artifacts),
        message: aborted
          ? "Browser validation was cancelled or timed out."
          : boundedText(
              `Browser ${activeCheck?.kind ?? "startup"} check${activeCheck === undefined ? "" : ` at ${activeCheck.path}`} failed: ${
                error instanceof Error
                  ? (error.message.split(/\r?\n/u, 1)[0] ?? error.name)
                  : String(error)
              }`,
            ),
      });
    } finally {
      request.signal.removeEventListener("abort", onAbort);
      await browser?.close().catch(() => undefined);
    }
  }
}

class ManagedDevServer {
  readonly #child: ChildProcessByStdio<null, Readable, Readable>;
  readonly #logs = new LogCapture();
  readonly completion: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  #completed = false;
  #exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;

  private constructor(child: ChildProcessByStdio<null, Readable, Readable>) {
    this.#child = child;
    child.stdout.on("data", (chunk: Buffer) =>
      this.#logs.append("info", `server stdout: ${chunk.toString("utf8")}`),
    );
    child.stderr.on("data", (chunk: Buffer) =>
      this.#logs.append("warning", `server stderr: ${chunk.toString("utf8")}`),
    );
    this.completion = new Promise((resolveCompletion) => {
      child.once("exit", (code, signal) => {
        this.#completed = true;
        this.#exit = { code, signal };
        resolveCompletion(this.#exit);
      });
    });
  }

  static async start(
    command: BrowserStartCommand,
    workspaceRoot: string,
  ): Promise<ManagedDevServer> {
    const cwd = resolve(workspaceRoot, command.cwd);
    if (!isInside(workspaceRoot, cwd)) throw new Error("Browser start cwd escaped workspace");
    const child = spawn(command.argv[0]!, command.argv.slice(1), {
      cwd,
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        HOME: tmpdir(),
        TMPDIR: process.env["TMPDIR"] ?? tmpdir(),
        LANG: process.env["LANG"] ?? "C.UTF-8",
        LC_ALL: "C.UTF-8",
        NO_COLOR: "1",
      },
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((resolveStart, rejectStart) => {
      child.once("spawn", resolveStart);
      child.once("error", rejectStart);
    });
    return new ManagedDevServer(child);
  }

  logs(): CapturedLogs {
    return this.#logs.snapshot();
  }

  exitResult(): { code: number | null; signal: NodeJS.Signals | null } | undefined {
    return this.#exit;
  }

  async stop(graceMs: number): Promise<void> {
    this.#signal("SIGTERM");
    const stopped = await this.#waitUntilProcessTreeStops(graceMs);
    if (!stopped) {
      this.#signal("SIGKILL");
      if (!(await this.#waitUntilProcessTreeStops(graceMs))) {
        throw new Error("Owned dev-server process group survived SIGKILL");
      }
    }
    if (!this.#completed) await this.completion;
  }

  async #waitUntilProcessTreeStops(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.#processTreeAlive()) {
      if (Date.now() >= deadline) return false;
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
    }
    return true;
  }

  #processTreeAlive(): boolean {
    const pid = this.#child.pid;
    if (pid === undefined) return false;
    if (process.platform === "win32") return !this.#completed;
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  }

  #signal(signal: NodeJS.Signals): void {
    const pid = this.#child.pid;
    if (pid === undefined) return;
    try {
      if (process.platform === "win32") this.#child.kill(signal);
      else process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, rejectDelay) => {
    if (signal.aborted) {
      rejectDelay(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      rejectDelay(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveDelay();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitUntilReady(
  url: string,
  server: ManagedDevServer,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal.aborted) throw signal.reason;
    const earlyExit = server.exitResult();
    if (earlyExit !== undefined) {
      throw new Error(
        `App dev server exited before readiness (code ${String(earlyExit.code)}, signal ${String(earlyExit.signal)}).`,
      );
    }
    try {
      const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(1_000)]);
      const response = await fetch(url, { signal: probeSignal, redirect: "manual" });
      await response.body?.cancel();
      return;
    } catch {
      if (signal.aborted) throw signal.reason;
    }
    await delay(READY_POLL_INTERVAL_MS, signal);
  }
  throw new Error(`App dev server did not become ready within ${String(timeoutMs)}ms.`);
}

function diagnostic(
  severity: ValidationDiagnostic["severity"],
  code: string,
  message: string,
): ValidationDiagnostic {
  return Object.freeze({ severity, code, message: boundedText(message) });
}

async function validateArtifacts(
  artifactDirectory: string,
  artifacts: readonly BrowserArtifact[],
): Promise<readonly BrowserArtifact[]> {
  const accepted: BrowserArtifact[] = [];
  for (const artifact of artifacts) {
    const absolute = resolve(artifact.path);
    if (!isInside(artifactDirectory, absolute)) {
      throw new Error("Playwright runner returned an artifact outside its owned directory");
    }
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("Playwright runner returned a non-regular artifact");
    }
    const realArtifact = await realpath(absolute);
    const realArtifactDirectory = await realpath(artifactDirectory);
    if (!isInside(realArtifactDirectory, realArtifact)) {
      throw new Error("Playwright runner returned an artifact through an escaping symlink");
    }
    accepted.push(
      Object.freeze({
        kind: artifact.kind,
        path: absolute,
      }),
    );
  }
  return Object.freeze(accepted);
}

function logDiagnostics(
  captured: CapturedLogs,
  source: "server" | "browser",
): ValidationDiagnostic[] {
  const retained = captured.entries
    .slice(0, 12)
    .map((entry) =>
      diagnostic(
        entry.level === "error" ? "error" : entry.level === "warning" ? "warning" : "info",
        source === "server" ? "DEV_SERVER_LOG" : "BROWSER_LOG",
        entry.message,
      ),
    );
  if (captured.truncated || captured.entries.length > retained.length) {
    retained.push(
      diagnostic(
        "warning",
        source === "server" ? "DEV_SERVER_LOGS_TRUNCATED" : "BROWSER_LOGS_TRUNCATED",
        `Additional ${source} logs were omitted at the bounded capture limit.`,
      ),
    );
  }
  return retained;
}

/** Validator plugin that owns one dev server and one Playwright run. */
export class BrowserValidationValidator implements Validator {
  readonly id = "browser/playwright";
  readonly version = "1.0.0";
  readonly #checks: readonly BrowserCheck[];
  readonly #runner: PlaywrightRunner;
  readonly #readyTimeoutMs: number;
  readonly #runTimeoutMs: number;
  readonly #stopGraceMs: number;
  readonly #artifactRoot: string;
  readonly #artifactId: () => string;

  constructor(
    private readonly target: BrowserValidationTarget,
    checks: readonly BrowserCheck[],
    options: BrowserValidatorOptions = {},
  ) {
    if (checks.length === 0) throw new Error("Browser validation requires at least one check");
    this.#checks = Object.freeze(checks.map(normalizeCheck));
    this.#runner = options.runner ?? new ChromiumPlaywrightRunner();
    this.#readyTimeoutMs = positiveInteger(
      options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      "readyTimeoutMs",
    );
    this.#runTimeoutMs = positiveInteger(
      options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
      "runTimeoutMs",
    );
    this.#stopGraceMs = positiveInteger(
      options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS,
      "stopGraceMs",
    );
    this.#artifactRoot = options.artifactRoot ?? resolve(tmpdir(), "densa-browser-artifacts");
    this.#artifactId = options.artifactId ?? randomUUID;
  }

  async validate(context: ValidatorContext): Promise<ValidatorOutcome> {
    const workspaceRoot = await realpath(context.workspacePath);
    const targetUrl = normalizeAppUrl(this.target.url);
    if (targetUrl === undefined) throw new Error("Browser validation target URL is missing");
    const command = normalizeStartCommand(workspaceRoot, this.target.startCommand);
    const artifactRoot = isAbsolute(this.#artifactRoot)
      ? resolve(this.#artifactRoot)
      : resolve(workspaceRoot, this.#artifactRoot);
    if (!isAbsolute(this.#artifactRoot) && !isInside(workspaceRoot, artifactRoot)) {
      throw new Error("A relative browser artifact root cannot escape workspace");
    }
    const artifactId = this.#artifactId();
    if (!/^[A-Za-z0-9._-]{1,128}$/u.test(artifactId))
      throw new Error("Browser artifact ID is unsafe");
    const artifactDirectory = resolve(artifactRoot, artifactId);
    await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
    const rootMetadata = await lstat(artifactRoot);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      throw new Error("Browser artifact root must be a real directory");
    }
    await mkdir(artifactDirectory, { mode: 0o700 });

    const timeoutController = new AbortController();
    const timeout = setTimeout(
      () => timeoutController.abort(new Error("Browser validation timed out")),
      this.#readyTimeoutMs + this.#runTimeoutMs,
    );
    const signal =
      context.signal === undefined
        ? timeoutController.signal
        : AbortSignal.any([context.signal, timeoutController.signal]);
    let server: ManagedDevServer | undefined;
    let runResult: PlaywrightRunResult | undefined;
    let failure: unknown;
    try {
      if (signal.aborted) throw signal.reason;
      server = await ManagedDevServer.start(command, workspaceRoot);
      await waitUntilReady(targetUrl, server, this.#readyTimeoutMs, signal);
      runResult = await this.#runner.run({
        baseUrl: targetUrl,
        checks: this.#checks,
        artifactDirectory,
        timeoutMs: this.#runTimeoutMs,
        signal,
      });
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(timeout);
      await server?.stop(this.#stopGraceMs);
    }

    const serverLogs =
      server?.logs() ?? Object.freeze({ entries: Object.freeze([]), truncated: false });
    const browserLogs =
      runResult === undefined
        ? Object.freeze({ entries: Object.freeze([]), truncated: false })
        : Object.freeze({ entries: runResult.logs, truncated: runResult.logsTruncated });
    const diagnostics = [
      ...(failure === undefined
        ? []
        : [
            diagnostic(
              "error",
              signal.aborted ? "BROWSER_VALIDATION_CANCELLED" : "BROWSER_VALIDATION_FAILED",
              failure instanceof Error ? failure.message : String(failure),
            ),
          ]),
      ...(runResult?.message === undefined
        ? []
        : [
            diagnostic(
              runResult.status === "error" ? "error" : "warning",
              runResult.status === "error"
                ? "BROWSER_VALIDATION_CANCELLED"
                : "BROWSER_CHECK_FAILED",
              runResult.message,
            ),
          ]),
      ...logDiagnostics(serverLogs, "server"),
      ...logDiagnostics(browserLogs, "browser"),
    ].slice(0, 32);
    const artifacts =
      runResult === undefined
        ? Object.freeze([])
        : await validateArtifacts(artifactDirectory, runResult.artifacts);
    const config = Object.freeze({
      baseUrl: targetUrl,
      checkCount: this.#checks.length,
      artifacts: artifacts.map((artifact) => Object.freeze({ ...artifact })),
      serverLogsTruncated: serverLogs.truncated,
      browserLogsTruncated: browserLogs.truncated,
    }) as JsonObject;
    const status = failure === undefined ? (runResult?.status ?? "error") : "error";
    return Object.freeze({
      status,
      command: [...command.argv],
      config,
      diagnostics,
      retryRelevant: status !== "passed",
    });
  }
}
