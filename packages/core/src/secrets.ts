import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";

import {
  eventIdSchema,
  isoTimestampSchema,
  projectIdSchema,
  secretRefSchema,
  type DecisionId,
  type PermissionDecision,
  type ProjectId,
  type SecretRef,
} from "@densa/protocol";

import {
  PermissionPolicyService,
  assertAuthorizedOperation,
  type AuthorizedOperationContext,
} from "./permission-policy.js";
import type { DensaDatabase } from "./persistence/database.js";
import { SecretRedactor, redactSensitiveText } from "./secret-redaction.js";

const KEYCHAIN_NOT_FOUND_EXIT_CODE = 44;
const MAX_SECRET_BYTES = 64 * 1024;
const MAX_CAPTURE_BYTES = 128 * 1024;
const MAX_RAW_CAPTURE_BYTES = MAX_CAPTURE_BYTES + MAX_SECRET_BYTES;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export class SecretStoreError extends Error {
  readonly code = "PROCESS_FAILURE" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SecretStoreError";
  }
}

/** Low-level stores require the unforgeable P7M2 context on every credential operation. */
export interface SecretStore {
  put(
    reference: SecretRef,
    value: string,
    authorization: AuthorizedOperationContext,
  ): Promise<void>;
  get(reference: SecretRef, authorization: AuthorizedOperationContext): Promise<string | undefined>;
  delete(reference: SecretRef, authorization: AuthorizedOperationContext): Promise<boolean>;
}

export interface KeychainCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type KeychainCommandRunner = (
  arguments_: readonly string[],
  standardInput?: string,
) => Promise<KeychainCommandResult>;

function boundedAppend(chunks: Buffer[], chunk: Buffer, limit = MAX_CAPTURE_BYTES): void {
  const used = chunks.reduce((total, entry) => total + entry.length, 0);
  if (used >= limit) return;
  chunks.push(chunk.subarray(0, limit - used));
}

function validateSecretValue(value: string): void {
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) {
    throw new SecretStoreError("Secret values must contain between 1 byte and 64 KiB");
  }
}

async function runSecurityCommand(
  arguments_: readonly string[],
  standardInput?: string,
): Promise<KeychainCommandResult> {
  return await new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const child = spawn("/usr/bin/security", arguments_, {
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => boundedAppend(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => boundedAppend(stderr, chunk));
    child.once("error", (error) =>
      reject(new SecretStoreError("Keychain command failed to start", { cause: error })),
    );
    child.once("close", (exitCode) => {
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin.end(standardInput === undefined ? undefined : `${standardInput}\n`);
  });
}

export interface MacOsKeychainSecretStoreOptions {
  readonly platform?: NodeJS.Platform;
  readonly servicePrefix?: string;
  readonly commandRunner?: KeychainCommandRunner;
}

/** macOS v1 store. Secret values are sent through stdin and never placed in process arguments. */
export class MacOsKeychainSecretStore implements SecretStore {
  readonly #platform: NodeJS.Platform;
  readonly #servicePrefix: string;
  readonly #commandRunner: KeychainCommandRunner;

  constructor(options: MacOsKeychainSecretStoreOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#servicePrefix = options.servicePrefix ?? "dev.densa.secret";
    this.#commandRunner = options.commandRunner ?? runSecurityCommand;
  }

  async put(
    referenceInput: SecretRef,
    value: string,
    authorization: AuthorizedOperationContext,
  ): Promise<void> {
    const reference = this.#validate(referenceInput, authorization);
    this.#validateValue(value);
    const result = await this.#commandRunner(
      ["add-generic-password", "-U", "-a", reference.id, "-s", this.#service(reference), "-w"],
      value,
    );
    if (result.exitCode !== 0) throw new SecretStoreError("Keychain could not store the secret");
  }

  async get(
    referenceInput: SecretRef,
    authorization: AuthorizedOperationContext,
  ): Promise<string | undefined> {
    const reference = this.#validate(referenceInput, authorization);
    const result = await this.#commandRunner([
      "find-generic-password",
      "-a",
      reference.id,
      "-s",
      this.#service(reference),
      "-w",
    ]);
    if (result.exitCode === KEYCHAIN_NOT_FOUND_EXIT_CODE) return undefined;
    if (result.exitCode !== 0) throw new SecretStoreError("Keychain could not retrieve the secret");
    return result.stdout.replace(/\r?\n$/u, "");
  }

  async delete(
    referenceInput: SecretRef,
    authorization: AuthorizedOperationContext,
  ): Promise<boolean> {
    const reference = this.#validate(referenceInput, authorization);
    const result = await this.#commandRunner([
      "delete-generic-password",
      "-a",
      reference.id,
      "-s",
      this.#service(reference),
    ]);
    if (result.exitCode === KEYCHAIN_NOT_FOUND_EXIT_CODE) return false;
    if (result.exitCode !== 0) throw new SecretStoreError("Keychain could not revoke the secret");
    return true;
  }

  #validate(referenceInput: SecretRef, authorization: AuthorizedOperationContext): SecretRef {
    if (this.#platform !== "darwin") {
      throw new SecretStoreError("The v1 Keychain secret store is available only on macOS");
    }
    const reference = secretRefSchema.parse(referenceInput);
    assertAuthorizedOperation(authorization, reference.projectId, "secret_access");
    return reference;
  }

  #validateValue(value: string): void {
    validateSecretValue(value);
    if (/\r|\n/u.test(value)) {
      throw new SecretStoreError("The macOS Keychain command boundary does not accept newlines");
    }
  }

  #service(reference: SecretRef): string {
    return `${this.#servicePrefix}.${reference.projectId}`;
  }
}

export interface SecretPermissionRequest {
  readonly projectId: ProjectId;
  readonly actor: string;
  readonly reason: string;
  readonly occurredAt: string;
  readonly approvalDecisionId?: DecisionId;
}

export interface PutSecretRequest extends SecretPermissionRequest {
  readonly reference: SecretRef;
  readonly value: string;
}

export interface RevokeSecretRequest extends SecretPermissionRequest {
  readonly reference: SecretRef;
}

export interface SecretEnvironmentBinding {
  readonly name: string;
  readonly reference: SecretRef;
}

export interface RunWithSecretsRequest extends SecretPermissionRequest {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly bindings: readonly SecretEnvironmentBinding[];
  /** Explicit non-secret base environment. Core never inherits the whole parent environment. */
  readonly baseEnvironment?: Readonly<Record<string, string>>;
}

export interface SecretPermissionDeniedResult {
  readonly status: "denied";
  readonly code: "PERMISSION_DENIED";
  readonly disposition: "deny" | "ask_user";
  readonly decision: PermissionDecision;
}

export type PutSecretResult =
  SecretPermissionDeniedResult | Readonly<{ status: "stored"; reference: SecretRef }>;

export type RevokeSecretResult =
  | SecretPermissionDeniedResult
  | Readonly<{ status: "revoked"; reference: SecretRef; existed: boolean }>;

export type RunWithSecretsResult =
  | SecretPermissionDeniedResult
  | Readonly<{
      status: "missing";
      code: "USER_CONFIGURATION_ERROR";
      missingReferenceIds: readonly string[];
    }>
  | Readonly<{
      status: "executed";
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
      truncated: boolean;
    }>;

export interface SecretServiceOptions {
  readonly permissionPolicy?: PermissionPolicyService;
  readonly eventIdFactory?: () => string;
}

interface CapturedChildResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

function defaultBaseEnvironment(): Readonly<Record<string, string>> {
  return Object.freeze({
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    TMPDIR: process.env["TMPDIR"] ?? tmpdir(),
    LANG: process.env["LANG"] ?? "C.UTF-8",
  });
}

async function spawnScopedChild(
  request: RunWithSecretsRequest,
  environment: NodeJS.ProcessEnv,
  redactor: SecretRedactor,
): Promise<CapturedChildResult> {
  return await new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    const append = (target: Buffer[], chunk: Buffer, used: number): number => {
      if (used >= MAX_RAW_CAPTURE_BYTES) {
        truncated = true;
        return used;
      }
      const retained = chunk.subarray(0, MAX_RAW_CAPTURE_BYTES - used);
      target.push(retained);
      if (retained.length !== chunk.length) truncated = true;
      return used + retained.length;
    };
    const child = spawn(request.command, request.arguments, {
      cwd: request.cwd,
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = append(stdout, chunk, stdoutBytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = append(stderr, chunk, stderrBytes);
    });
    child.once("error", (error) =>
      reject(new SecretStoreError("Scoped child failed to start", { cause: error })),
    );
    child.once("close", (exitCode, signal) => {
      const safeStdout = Buffer.from(redactor.log(Buffer.concat(stdout).toString("utf8")), "utf8");
      const safeStderr = Buffer.from(redactor.log(Buffer.concat(stderr).toString("utf8")), "utf8");
      if (safeStdout.length > MAX_CAPTURE_BYTES || safeStderr.length > MAX_CAPTURE_BYTES) {
        truncated = true;
      }
      resolve({
        exitCode,
        signal,
        stdout: safeStdout.subarray(0, MAX_CAPTURE_BYTES).toString("utf8"),
        stderr: safeStderr.subarray(0, MAX_CAPTURE_BYTES).toString("utf8"),
        truncated,
      });
    });
  });
}

/** Permission-gated Core boundary for storing, using, and revoking secret references. */
export class SecretService {
  readonly #permissionPolicy: PermissionPolicyService;
  readonly #eventIdFactory: () => string;

  constructor(
    private readonly database: DensaDatabase,
    private readonly store: SecretStore,
    options: SecretServiceOptions = {},
  ) {
    this.#permissionPolicy = options.permissionPolicy ?? new PermissionPolicyService(database);
    this.#eventIdFactory = options.eventIdFactory ?? (() => `event-${randomUUID()}`);
  }

  async put(requestInput: PutSecretRequest): Promise<PutSecretResult> {
    const reference = this.#validateReference(requestInput.reference, requestInput.projectId);
    validateSecretValue(requestInput.value);
    const redactor = new SecretRedactor([requestInput.value]);
    const safeRequest = {
      ...requestInput,
      actor: redactor.text(requestInput.actor),
      reason: redactor.text(requestInput.reason),
    };
    const permission = this.#authorize(safeRequest);
    if (permission.authorization === undefined) return permission.denied;
    await this.store.put(reference, requestInput.value, permission.authorization);
    this.#audit(safeRequest, "SECRET_STORED", { secretRefId: reference.id });
    return Object.freeze({ status: "stored", reference });
  }

  async revoke(requestInput: RevokeSecretRequest): Promise<RevokeSecretResult> {
    const reference = this.#validateReference(requestInput.reference, requestInput.projectId);
    const permission = this.#authorize(requestInput);
    if (permission.authorization === undefined) return permission.denied;
    const existed = await this.store.delete(reference, permission.authorization);
    this.#audit(requestInput, "SECRET_REVOKED", { secretRefId: reference.id, existed });
    return Object.freeze({ status: "revoked", reference, existed });
  }

  async runChild(requestInput: RunWithSecretsRequest): Promise<RunWithSecretsResult> {
    const request = this.#validateRunRequest(requestInput);
    const permission = this.#authorize(request);
    if (permission.authorization === undefined) return permission.denied;

    const values: string[] = [];
    const environment: NodeJS.ProcessEnv = {
      ...(request.baseEnvironment ?? defaultBaseEnvironment()),
    };
    const missingReferenceIds: string[] = [];
    try {
      for (const binding of request.bindings) {
        const value = await this.store.get(binding.reference, permission.authorization);
        if (value === undefined) {
          missingReferenceIds.push(binding.reference.id);
          continue;
        }
        validateSecretValue(value);
        values.push(value);
        environment[binding.name] = value;
      }
      if (missingReferenceIds.length > 0) {
        return Object.freeze({
          status: "missing",
          code: "USER_CONFIGURATION_ERROR",
          missingReferenceIds: Object.freeze(missingReferenceIds.toSorted()),
        });
      }
      const redactor = new SecretRedactor(values);
      const safeRequest = {
        ...request,
        actor: redactor.text(request.actor),
        reason: redactor.text(request.reason),
      };
      const executionMetadata = [
        request.command,
        request.cwd,
        ...request.arguments,
        ...Object.entries(request.baseEnvironment ?? {}).flat(),
      ].join("\u0000");
      if (values.some((value) => executionMetadata.includes(value))) {
        throw new SecretStoreError(
          "Resolved secret values must be injected only through scoped environment bindings",
        );
      }
      this.#audit(safeRequest, "SECRET_USE_STARTED", {
        secretRefIds: request.bindings.map((binding) => binding.reference.id),
        environmentNames: request.bindings.map((binding) => binding.name),
      });
      const result = await spawnScopedChild(request, environment, redactor);
      this.#audit(safeRequest, "SECRET_USE_FINISHED", {
        secretRefIds: request.bindings.map((binding) => binding.reference.id),
        exitCode: result.exitCode,
        signal: result.signal,
      });
      return Object.freeze({ status: "executed", ...result });
    } finally {
      for (const binding of request.bindings) delete environment[binding.name];
      values.fill("");
    }
  }

  #authorize(request: SecretPermissionRequest): Readonly<{
    authorization?: AuthorizedOperationContext;
    denied: SecretPermissionDeniedResult;
  }> {
    const decision = this.#permissionPolicy.authorize({
      projectId: projectIdSchema.parse(request.projectId),
      operation: "secret_access",
      actor: redactSensitiveText(request.actor),
      reason: redactSensitiveText(request.reason),
      occurredAt: isoTimestampSchema.parse(request.occurredAt),
      ...(request.approvalDecisionId === undefined
        ? {}
        : { approvalDecisionId: request.approvalDecisionId }),
    });
    if (decision.authorization !== undefined) {
      return Object.freeze({
        authorization: decision.authorization,
        denied: Object.freeze({
          status: "denied",
          code: "PERMISSION_DENIED",
          disposition: "deny",
          decision: decision.decision,
        }),
      });
    }
    if (decision.decision.disposition === "allow") {
      throw new SecretStoreError("Allowed secret access did not issue an authorization context");
    }
    return Object.freeze({
      denied: Object.freeze({
        status: "denied",
        code: "PERMISSION_DENIED",
        disposition: decision.decision.disposition,
        decision: decision.decision,
      }),
    });
  }

  #validateReference(referenceInput: SecretRef, projectIdInput: ProjectId): SecretRef {
    const reference = secretRefSchema.parse(referenceInput);
    const projectId = projectIdSchema.parse(projectIdInput);
    if (reference.projectId !== projectId) {
      throw new SecretStoreError("Secret references cannot cross project boundaries");
    }
    return reference;
  }

  #validateRunRequest(requestInput: RunWithSecretsRequest): RunWithSecretsRequest {
    const projectId = projectIdSchema.parse(requestInput.projectId);
    isoTimestampSchema.parse(requestInput.occurredAt);
    if (requestInput.command.length === 0 || requestInput.cwd.length === 0) {
      throw new SecretStoreError("Scoped child command and cwd must be non-empty");
    }
    const names = new Set<string>();
    const bindings = requestInput.bindings.map((binding) => {
      if (!ENVIRONMENT_NAME_PATTERN.test(binding.name) || names.has(binding.name)) {
        throw new SecretStoreError("Secret environment names must be valid and unique");
      }
      names.add(binding.name);
      return Object.freeze({
        name: binding.name,
        reference: this.#validateReference(binding.reference, projectId),
      });
    });
    return Object.freeze({ ...requestInput, projectId, bindings: Object.freeze(bindings) });
  }

  #audit(
    request: SecretPermissionRequest,
    type: string,
    payload: Readonly<Record<string, string | number | boolean | null | readonly string[]>>,
  ): void {
    this.database.repositories.events.append({
      id: eventIdSchema.parse(this.#eventIdFactory()),
      projectId: projectIdSchema.parse(request.projectId),
      type,
      eventVersion: 1,
      occurredAt: isoTimestampSchema.parse(request.occurredAt),
      actor: redactSensitiveText(request.actor),
      payload: { ...payload, reason: redactSensitiveText(request.reason) },
    });
  }
}

export function createSecretRef(projectId: ProjectId, id = `secret-${randomUUID()}`): SecretRef {
  return secretRefSchema.parse({ formatVersion: 1, id, projectId, store: "macos_keychain" });
}
