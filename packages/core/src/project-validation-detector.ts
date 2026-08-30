import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { isoTimestampSchema, type ValidationPolicy } from "@densa-ade/protocol";

const MAX_PROJECT_METADATA_BYTES = 1_024 * 1_024;
const MAX_COMMAND_ARGUMENTS = 128;
const MAX_COMMAND_PART_BYTES = 4_096;

export type ValidationCommandCategory = "build" | "typecheck" | "lint" | "test" | "custom";
export type ValidationCommandSource = "detected" | "user-configured";
export type ValidationDetectionStatus = "detected" | "manual_configuration_required" | "unknown";
export type DetectedProjectEcosystem = "node" | "node-typescript" | "typescript" | "unknown";

export interface StructuredValidationCommand {
  readonly id: string;
  readonly category: ValidationCommandCategory;
  /** Executable followed by arguments. Consumers must spawn this with shell=false. */
  readonly argv: readonly string[];
  /** Workspace-relative working directory. */
  readonly cwd: string;
  readonly policy: ValidationPolicy;
  readonly source: ValidationCommandSource;
}

export interface UserConfiguredValidationCommand {
  readonly id: string;
  readonly category: ValidationCommandCategory;
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly policy?: ValidationPolicy;
}

export interface ValidationCommandOverrideAuditContext {
  readonly actor: string;
  readonly reason: string;
}

export interface ValidationCommandOverrideAuditFact {
  readonly type: "VALIDATION_COMMANDS_OVERRIDDEN";
  readonly eventVersion: 1;
  readonly occurredAt: string;
  readonly actor: string;
  readonly reason: string;
  readonly replacedCommandIds: readonly string[];
  readonly configuredCommands: readonly AuditedValidationCommand[];
}

export interface AuditedValidationCommand {
  readonly id: string;
  readonly category: ValidationCommandCategory;
  readonly policy: ValidationPolicy;
  readonly cwd: string;
  readonly argumentCount: number;
  /** Verifies the configured argv without persisting potentially secret argument values. */
  readonly argvSha256: string;
}

export interface ValidationDetectionIssue {
  readonly code:
    | "AMBIGUOUS_PACKAGE_MANAGER"
    | "INVALID_PACKAGE_JSON"
    | "LOCAL_TYPESCRIPT_UNAVAILABLE"
    | "NO_SAFE_VALIDATION_COMMANDS"
    | "UNSAFE_PROJECT_METADATA"
    | "UNSUPPORTED_PACKAGE_MANAGER";
  readonly message: string;
}

export interface DetectedValidationCommandPlan {
  readonly version: 1;
  readonly status: ValidationDetectionStatus;
  readonly ecosystem: DetectedProjectEcosystem;
  readonly commands: readonly StructuredValidationCommand[];
  readonly issues: readonly ValidationDetectionIssue[];
  /** Facts recorded by the required audit sink before a configured plan is returned. */
  readonly auditFacts: readonly ValidationCommandOverrideAuditFact[];
}

export interface DetectProjectValidationRequest {
  readonly workspacePath: string;
  /** Presence, including an empty array, explicitly replaces detected commands. */
  readonly userConfiguredCommands?: readonly UserConfiguredValidationCommand[];
  readonly overrideAudit?: ValidationCommandOverrideAuditContext;
}

export interface ProjectValidationDetectorOptions {
  readonly now?: () => string;
  readonly auditSink?: ValidationCommandAuditSink;
}

export interface ValidationCommandAuditSink {
  record(fact: ValidationCommandOverrideAuditFact): Promise<void> | void;
}

interface FileInspection {
  readonly status: "missing" | "regular" | "unsafe";
  readonly content?: string;
}

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

interface LockfileInspection {
  readonly manager?: PackageManager;
  readonly blocked: boolean;
}

interface PackageInspection {
  readonly present: boolean;
  readonly scriptNames: readonly string[];
  readonly packageManager?: PackageManager;
  readonly packageManagerBlocked: boolean;
}

const scriptGroups = Object.freeze([
  Object.freeze({ category: "build" as const, names: Object.freeze(["build"]) }),
  Object.freeze({
    category: "typecheck" as const,
    names: Object.freeze(["typecheck", "type-check"]),
  }),
  Object.freeze({ category: "lint" as const, names: Object.freeze(["lint"]) }),
  Object.freeze({ category: "test" as const, names: Object.freeze(["test"]) }),
]);

const fallbackTestScripts = Object.freeze(["test:unit", "test:integration"]);
const knownScriptNames = Object.freeze([
  ...scriptGroups.flatMap((group) => group.names),
  ...fallbackTestScripts,
]);
const lockfileManagers = Object.freeze([
  Object.freeze({ path: "package-lock.json", manager: "npm" as const }),
  Object.freeze({ path: "npm-shrinkwrap.json", manager: "npm" as const }),
  Object.freeze({ path: "pnpm-lock.yaml", manager: "pnpm" as const }),
  Object.freeze({ path: "yarn.lock", manager: "yarn" as const }),
  Object.freeze({ path: "bun.lock", manager: "bun" as const }),
  Object.freeze({ path: "bun.lockb", manager: "bun" as const }),
]);

function frozenIssue(
  code: ValidationDetectionIssue["code"],
  message: string,
): ValidationDetectionIssue {
  return Object.freeze({ code, message });
}

function isInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))
  );
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

async function inspectRegularFile(
  workspaceRoot: string,
  relativePath: string,
): Promise<FileInspection> {
  const absolutePath = resolve(workspaceRoot, relativePath);
  if (!isInside(workspaceRoot, absolutePath)) return Object.freeze({ status: "unsafe" });
  try {
    const metadata = await lstat(absolutePath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > MAX_PROJECT_METADATA_BYTES
    ) {
      return Object.freeze({ status: "unsafe" });
    }
    const content = await readFile(absolutePath, "utf8");
    if (byteLength(content) > MAX_PROJECT_METADATA_BYTES) {
      return Object.freeze({ status: "unsafe" });
    }
    return Object.freeze({ status: "regular", content });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return Object.freeze({ status: "missing" });
    return Object.freeze({ status: "unsafe" });
  }
}

async function inspectRegularPath(
  workspaceRoot: string,
  relativePath: string,
): Promise<FileInspection> {
  const absolutePath = resolve(workspaceRoot, relativePath);
  if (!isInside(workspaceRoot, absolutePath)) return Object.freeze({ status: "unsafe" });
  try {
    const metadata = await lstat(absolutePath);
    return Object.freeze({
      status: metadata.isFile() && !metadata.isSymbolicLink() ? "regular" : "unsafe",
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return Object.freeze({ status: "missing" });
    return Object.freeze({ status: "unsafe" });
  }
}

function supportedPackageManager(value: unknown): PackageManager | "unsupported" | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const separator = value.indexOf("@");
  const name = separator === -1 ? value : value.slice(0, separator);
  return name === "npm" || name === "pnpm" || name === "yarn" || name === "bun"
    ? name
    : "unsupported";
}

function packageScriptNames(value: unknown): readonly string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return Object.freeze([]);
  const scripts = value as Record<string, unknown>;
  return Object.freeze(
    knownScriptNames.filter(
      (name) => typeof scripts[name] === "string" && scripts[name].trim().length > 0,
    ),
  );
}

async function inspectPackage(
  workspaceRoot: string,
  issues: ValidationDetectionIssue[],
): Promise<PackageInspection> {
  const manifest = await inspectRegularFile(workspaceRoot, "package.json");
  if (manifest.status === "missing") {
    return Object.freeze({
      present: false,
      scriptNames: Object.freeze([]),
      packageManagerBlocked: false,
    });
  }
  if (manifest.status === "unsafe") {
    issues.push(
      frozenIssue(
        "UNSAFE_PROJECT_METADATA",
        "package.json is not a bounded regular file and was not inspected.",
      ),
    );
    return Object.freeze({
      present: true,
      scriptNames: Object.freeze([]),
      packageManagerBlocked: true,
    });
  }
  try {
    const parsed: unknown = JSON.parse(manifest.content ?? "");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    const object = parsed as Record<string, unknown>;
    const manager = supportedPackageManager(object["packageManager"]);
    if (manager === "unsupported") {
      issues.push(
        frozenIssue(
          "UNSUPPORTED_PACKAGE_MANAGER",
          "package.json declares an unsupported package manager; configure validation commands manually.",
        ),
      );
      return Object.freeze({
        present: true,
        scriptNames: packageScriptNames(object["scripts"]),
        packageManagerBlocked: true,
      });
    }
    return Object.freeze({
      present: true,
      scriptNames: packageScriptNames(object["scripts"]),
      ...(manager === undefined ? {} : { packageManager: manager }),
      packageManagerBlocked: false,
    });
  } catch {
    issues.push(
      frozenIssue(
        "INVALID_PACKAGE_JSON",
        "package.json is malformed and no script commands were inferred from it.",
      ),
    );
    return Object.freeze({
      present: true,
      scriptNames: Object.freeze([]),
      packageManagerBlocked: true,
    });
  }
}

async function detectLockfileManager(
  workspaceRoot: string,
  issues: ValidationDetectionIssue[],
): Promise<LockfileInspection> {
  const discovered = new Set<PackageManager>();
  let unsafe = false;
  for (const lockfile of lockfileManagers) {
    const inspected = await inspectRegularPath(workspaceRoot, lockfile.path);
    if (inspected.status === "regular") discovered.add(lockfile.manager);
    if (inspected.status === "unsafe") {
      unsafe = true;
      issues.push(
        frozenIssue(
          "UNSAFE_PROJECT_METADATA",
          `${lockfile.path} is not a bounded regular file and was ignored.`,
        ),
      );
    }
  }
  if (discovered.size > 1) {
    issues.push(
      frozenIssue(
        "AMBIGUOUS_PACKAGE_MANAGER",
        "Multiple package-manager lockfile families were found; configure validation commands manually.",
      ),
    );
    return Object.freeze({ blocked: true });
  }
  const manager = [...discovered][0];
  return Object.freeze({
    ...(manager === undefined ? {} : { manager }),
    blocked: unsafe,
  });
}

function scriptCommand(
  manager: PackageManager,
  name: string,
  category: Exclude<ValidationCommandCategory, "custom">,
): StructuredValidationCommand {
  return Object.freeze({
    id: `node-script:${name}`,
    category,
    argv: Object.freeze([manager, "run", name]),
    cwd: ".",
    policy: "required",
    source: "detected",
  });
}

async function localTypescriptCommand(
  workspaceRoot: string,
  configPath: string,
): Promise<StructuredValidationCommand | undefined> {
  const executable = resolve(workspaceRoot, "node_modules/.bin/tsc");
  try {
    const metadata = await lstat(executable);
    const target = metadata.isSymbolicLink() ? await realpath(executable) : executable;
    if (!isInside(workspaceRoot, target) || !(await lstat(target)).isFile()) return undefined;
    return Object.freeze({
      id: "typescript:tsc-no-emit",
      category: "typecheck",
      argv: Object.freeze(["./node_modules/.bin/tsc", "--project", configPath, "--noEmit"]),
      cwd: ".",
      policy: "required",
      source: "detected",
    });
  } catch {
    return undefined;
  }
}

function validCommandPart(value: string): boolean {
  return value.length > 0 && !value.includes("\0") && byteLength(value) <= MAX_COMMAND_PART_BYTES;
}

function normalizedWorkingDirectory(workspaceRoot: string, value: string | undefined): string {
  const cwd = value ?? ".";
  if (!validCommandPart(cwd) || isAbsolute(cwd)) {
    throw new Error("User-configured validation cwd must be a bounded workspace-relative path");
  }
  const absolute = resolve(workspaceRoot, cwd);
  if (!isInside(workspaceRoot, absolute)) {
    throw new Error("User-configured validation cwd cannot escape the workspace");
  }
  const normalized = relative(workspaceRoot, absolute);
  return normalized.length === 0 ? "." : normalized;
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

function normalizeConfiguredCommands(
  workspaceRoot: string,
  configured: readonly UserConfiguredValidationCommand[],
): readonly StructuredValidationCommand[] {
  const seen = new Set<string>();
  const categories = new Set<ValidationCommandCategory>([
    "build",
    "typecheck",
    "lint",
    "test",
    "custom",
  ]);
  return Object.freeze(
    configured.map((command) => {
      if (
        !validCommandPart(command.id) ||
        seen.has(command.id) ||
        !categories.has(command.category) ||
        command.argv.length === 0 ||
        command.argv.length > MAX_COMMAND_ARGUMENTS ||
        command.argv.some((part) => !validCommandPart(part)) ||
        rejectsShellEvaluation(command.argv) ||
        (command.policy !== undefined &&
          command.policy !== "required" &&
          command.policy !== "advisory")
      ) {
        throw new Error(
          "User-configured validation commands require supported categories, unique IDs, bounded argv, and no shell evaluation",
        );
      }
      seen.add(command.id);
      return Object.freeze({
        id: command.id,
        category: command.category,
        argv: Object.freeze([...command.argv]),
        cwd: normalizedWorkingDirectory(workspaceRoot, command.cwd),
        policy: command.policy ?? "required",
        source: "user-configured" as const,
      });
    }),
  );
}

function auditCommand(command: StructuredValidationCommand): AuditedValidationCommand {
  return Object.freeze({
    id: command.id,
    category: command.category,
    policy: command.policy,
    cwd: command.cwd,
    argumentCount: command.argv.length,
    argvSha256: createHash("sha256").update(JSON.stringify(command.argv)).digest("hex"),
  });
}

function statusFor(
  commands: readonly StructuredValidationCommand[],
  recognized: boolean,
): ValidationDetectionStatus {
  if (commands.length > 0) return "detected";
  return recognized ? "manual_configuration_required" : "unknown";
}

/**
 * Read-only project inspection. It proposes argv and never evaluates a manifest script body or
 * invokes a process; the Policy/Validation layer remains responsible for execution approval.
 */
export class ProjectValidationDetector {
  readonly #now: () => string;
  readonly #auditSink: ValidationCommandAuditSink | undefined;

  constructor(options: ProjectValidationDetectorOptions = {}) {
    const clock = options.now ?? (() => new Date().toISOString());
    this.#now = () => isoTimestampSchema.parse(clock());
    this.#auditSink = options.auditSink;
  }

  async detect(request: DetectProjectValidationRequest): Promise<DetectedValidationCommandPlan> {
    if (!isAbsolute(request.workspacePath)) {
      throw new Error("Validation detection requires an absolute workspace path");
    }
    const workspaceRoot = await realpath(request.workspacePath);
    const workspaceMetadata = await lstat(workspaceRoot);
    if (!workspaceMetadata.isDirectory())
      throw new Error("Validation workspace must be a directory");

    const issues: ValidationDetectionIssue[] = [];
    const packageInspection = await inspectPackage(workspaceRoot, issues);
    const typescriptConfig = await inspectRegularFile(workspaceRoot, "tsconfig.json");
    const hasTypescript = typescriptConfig.status === "regular";
    if (typescriptConfig.status === "unsafe") {
      issues.push(
        frozenIssue(
          "UNSAFE_PROJECT_METADATA",
          "tsconfig.json is not a bounded regular file and was not used for detection.",
        ),
      );
    }
    const ecosystem: DetectedProjectEcosystem = packageInspection.present
      ? hasTypescript
        ? "node-typescript"
        : "node"
      : hasTypescript
        ? "typescript"
        : "unknown";

    const commands: StructuredValidationCommand[] = [];
    if (packageInspection.present && !packageInspection.packageManagerBlocked) {
      const lockfiles: LockfileInspection =
        packageInspection.packageManager === undefined
          ? await detectLockfileManager(workspaceRoot, issues)
          : Object.freeze({ blocked: false });
      const manager =
        packageInspection.packageManager ??
        lockfiles.manager ??
        (lockfiles.blocked ? undefined : "npm");
      if (manager !== undefined) {
        for (const group of scriptGroups) {
          const name = group.names.find((candidate) =>
            packageInspection.scriptNames.includes(candidate),
          );
          if (name !== undefined) commands.push(scriptCommand(manager, name, group.category));
        }
        if (!commands.some((command) => command.category === "test")) {
          for (const name of fallbackTestScripts) {
            if (packageInspection.scriptNames.includes(name)) {
              commands.push(scriptCommand(manager, name, "test"));
            }
          }
        }
      }
    }

    if (hasTypescript && !commands.some((command) => command.category === "typecheck")) {
      const typecheck = await localTypescriptCommand(workspaceRoot, "tsconfig.json");
      if (typecheck === undefined) {
        issues.push(
          frozenIssue(
            "LOCAL_TYPESCRIPT_UNAVAILABLE",
            "tsconfig.json was found, but no typecheck script or workspace-local tsc executable is available.",
          ),
        );
      } else {
        const buildIndex = commands.findIndex((command) => command.category !== "build");
        if (buildIndex === -1) commands.push(typecheck);
        else commands.splice(buildIndex, 0, typecheck);
      }
    }

    if (request.userConfiguredCommands !== undefined) {
      if (
        request.overrideAudit === undefined ||
        !validCommandPart(request.overrideAudit.actor.trim()) ||
        !validCommandPart(request.overrideAudit.reason.trim())
      ) {
        throw new Error("User-configured validation overrides require an audit actor and reason");
      }
      if (this.#auditSink === undefined) {
        throw new Error("User-configured validation overrides require a durable audit sink");
      }
      const configured = normalizeConfiguredCommands(workspaceRoot, request.userConfiguredCommands);
      const auditFact: ValidationCommandOverrideAuditFact = Object.freeze({
        type: "VALIDATION_COMMANDS_OVERRIDDEN",
        eventVersion: 1,
        occurredAt: this.#now(),
        actor: request.overrideAudit.actor.trim(),
        reason: request.overrideAudit.reason.trim(),
        replacedCommandIds: Object.freeze(commands.map((command) => command.id)),
        configuredCommands: Object.freeze(configured.map(auditCommand)),
      });
      await this.#auditSink.record(auditFact);
      if (configured.length === 0) {
        issues.push(
          frozenIssue(
            "NO_SAFE_VALIDATION_COMMANDS",
            "The user override explicitly configured no validation commands.",
          ),
        );
      }
      return Object.freeze({
        version: 1,
        status: statusFor(configured, true),
        ecosystem,
        commands: configured,
        issues: Object.freeze(issues),
        auditFacts: Object.freeze([auditFact]),
      });
    }

    const recognized =
      ecosystem !== "unknown" || packageInspection.present || typescriptConfig.status !== "missing";
    if (recognized && commands.length === 0) {
      issues.push(
        frozenIssue(
          "NO_SAFE_VALIDATION_COMMANDS",
          "The project was recognized, but no safe deterministic validation command could be inferred.",
        ),
      );
    }
    return Object.freeze({
      version: 1,
      status: statusFor(commands, recognized),
      ecosystem,
      commands: Object.freeze(commands),
      issues: Object.freeze(issues),
      auditFacts: Object.freeze([]),
    });
  }
}
