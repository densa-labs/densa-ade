import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { masterRoadmapSchema, projectSpecificationSchema } from "@densa-ade/protocol";
import type {
  Decision,
  JsonObject,
  JsonValue,
  MasterRoadmapRecord,
  Phase,
  Project,
  ProjectId,
  ProjectSpecification,
  RoadmapRevision,
  Task,
} from "@densa-ade/protocol";

import { renderProjectSpecificationMarkdown } from "../project-specification.js";
import { renderMasterRoadmapMarkdown } from "../master-roadmap.js";
import type { DensaAdeRepositories, ProjectSettingsRecord } from "./repositories.js";

const PORTABLE_FORMAT_VERSION = 1;
const SYNC_MANIFEST_NAME = ".sync-state.json";
const MANAGED_FILE_NAMES = [
  "project.json",
  "SPEC.md",
  "ROADMAP.md",
  "DECISIONS.md",
  "config.json",
] as const;

type ManagedFileName = (typeof MANAGED_FILE_NAMES)[number];

const SECRET_KEY_PATTERN =
  /(?:^|[_.-])(?:api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|authorization|bearer|client[_-]?secret|cookie|credential|password|passwd|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token)(?:$|[_.-])/iu;
const PRIVATE_KEY_PATTERN =
  /-----BEGIN (?:EC |OPENSSH |PGP |RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:EC |OPENSSH |PGP |RSA )?PRIVATE KEY-----/gu;
const KNOWN_TOKEN_PATTERN =
  /\b(?:AKIA[0-9A-Z]{12,}|github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|glpat-[A-Za-z0-9_-]{12,}|npm_[A-Za-z0-9]{12,}|sk-(?:proj-)?[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/gu;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu;
const SECRET_ASSIGNMENT_PATTERN =
  /\b(api[_-]?key|access[_-]?token|auth[_-]?token|authorization|client[_-]?secret|password|passwd|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token)\s*([:=])\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const SECRET_LIKE_VALUE_PATTERN = /\b(?:my|super|test)?[-_]?secret[-_][A-Za-z0-9_-]{4,}\b/giu;
const EXPLICIT_SECRET_PATTERN = /<secret>[\s\S]*?(?:<\/secret>|$)|\[secret:[\s\S]*?(?:\]|$)/giu;

export interface PortableProjectSnapshot {
  readonly project: Project;
  readonly specification?: ProjectSpecification;
  readonly masterRoadmap?: MasterRoadmapRecord;
  readonly phases: readonly Phase[];
  readonly tasks: readonly Task[];
  readonly decisions: readonly Decision[];
  readonly roadmapRevisions: readonly RoadmapRevision[];
  readonly settings?: ProjectSettingsRecord;
}

export interface PortableSyncConflict {
  readonly path: ManagedFileName;
  readonly reason: "human-edit";
}

export interface PortableSyncResult {
  readonly status: "synchronized" | "conflict";
  readonly directory: string;
  readonly written: readonly string[];
  readonly unchanged: readonly string[];
  readonly conflicts: readonly PortableSyncConflict[];
  readonly redactedValueCount: number;
}

export interface AtomicReplaceOptions {
  /** Test/fault-injection hook executed after the temp file is durable and before rename. */
  readonly beforeRename?: (temporaryPath: string) => void | Promise<void>;
}

interface SyncManifest {
  readonly formatVersion: 1;
  readonly projectId: string;
  readonly files: Readonly<Record<ManagedFileName, string>>;
}

interface RenderedPortableProject {
  readonly files: Readonly<Record<ManagedFileName, string>>;
  readonly redactedValueCount: number;
}

export class PortableProjectSyncError extends Error {
  readonly code: "PERSISTENCE_FAILURE" | "WORKSPACE_CONFLICT";

  constructor(
    code: "PERSISTENCE_FAILURE" | "WORKSPACE_CONFLICT",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PortableProjectSyncError";
    this.code = code;
  }
}

class SecretRedactor {
  count = 0;

  text(input: string): string {
    let output = input;
    output = this.replace(output, EXPLICIT_SECRET_PATTERN, "[REDACTED]");
    output = this.replace(output, PRIVATE_KEY_PATTERN, "[REDACTED PRIVATE KEY]");
    output = this.replace(output, KNOWN_TOKEN_PATTERN, "[REDACTED]");
    output = this.replace(output, JWT_PATTERN, "[REDACTED]");
    output = this.replace(output, BEARER_PATTERN, "Bearer [REDACTED]");
    output = output.replace(SECRET_ASSIGNMENT_PATTERN, (_match, key: string, separator: string) => {
      this.count += 1;
      return `${key}${separator}[REDACTED]`;
    });
    output = this.replace(output, SECRET_LIKE_VALUE_PATTERN, "[REDACTED]");
    return output;
  }

  json(value: JsonValue, key?: string): JsonValue {
    if (key !== undefined && SECRET_KEY_PATTERN.test(key)) {
      this.count += 1;
      return "[REDACTED]";
    }
    if (typeof value === "string") {
      return this.text(value);
    }
    if (Array.isArray(value)) {
      return value.map((entry) => this.json(entry));
    }
    if (value !== null && typeof value === "object") {
      const result: JsonObject = {};
      for (const childKey of Object.keys(value).sort()) {
        const child = value[childKey];
        if (child !== undefined) {
          result[childKey] = this.json(child, childKey);
        }
      }
      return result;
    }
    return value;
  }

  private replace(input: string, pattern: RegExp, replacement: string): string {
    return input.replace(pattern, () => {
      this.count += 1;
      return replacement;
    });
  }
}

/** Redacts secret-shaped values before descriptive text is persisted into portable artifacts. */
export function redactPortableText(input: string): string {
  return new SecretRedactor().text(input);
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function jsonDocument(value: unknown): string {
  return `${JSON.stringify(value, undefined, 2)}\n`;
}

function normalizeMarkdown(content: string): string {
  return `${content.replace(/\r\n?/gu, "\n").trimEnd()}\n`;
}

function inlineText(content: string): string {
  return content.replace(/\s+/gu, " ").trim();
}

function renderSpecification(snapshot: PortableProjectSnapshot, redactor: SecretRedactor): string {
  if (snapshot.specification === undefined) {
    return "# Specification\n\nNo specification has been recorded in Densa ADE Core.\n";
  }
  const sanitized = projectSpecificationSchema.parse(
    redactor.json(snapshot.specification as unknown as JsonValue),
  );
  return normalizeMarkdown(renderProjectSpecificationMarkdown(sanitized));
}

function renderRoadmap(snapshot: PortableProjectSnapshot, redactor: SecretRedactor): string {
  if (snapshot.masterRoadmap !== undefined) {
    const roadmap = masterRoadmapSchema.parse(
      redactor.json(snapshot.masterRoadmap.roadmap as unknown as JsonValue),
    );
    return `${renderMasterRoadmapMarkdown(roadmap).trimEnd()}\n\n${renderRoadmapRevisionHistory(
      snapshot.roadmapRevisions,
      redactor,
    ).trimEnd()}\n`;
  }
  const lines = [
    `# Roadmap — ${inlineText(redactor.text(snapshot.project.name))}`,
    "",
    "> Portable view generated from authoritative Densa ADE Core state.",
    "",
  ];

  if (snapshot.phases.length === 0) {
    lines.push("No phases have been recorded.", "");
  }

  for (const phase of snapshot.phases) {
    lines.push(
      `## Phase ${phase.position + 1}: ${inlineText(redactor.text(phase.title))}`,
      "",
      `- ID: \`${redactor.text(phase.id)}\``,
      `- State: \`${phase.state}\``,
      "",
    );
    const tasks = snapshot.tasks
      .filter((task) => task.phaseId === phase.id)
      .toSorted((left, right) => left.position - right.position || left.id.localeCompare(right.id));
    if (tasks.length === 0) {
      lines.push("No tasks have been recorded for this phase.", "");
      continue;
    }
    for (const task of tasks) {
      lines.push(
        `### Task ${task.position + 1}: ${inlineText(redactor.text(task.title))}`,
        "",
        `- ID: \`${redactor.text(task.id)}\``,
        `- State: \`${task.state}\``,
        `- Dependencies: ${
          task.dependencyIds.length === 0
            ? "none"
            : task.dependencyIds.map((id) => `\`${redactor.text(id)}\``).join(", ")
        }`,
        "- Acceptance criteria:",
      );
      for (const criterion of task.acceptanceCriteria) {
        lines.push(`  - ${inlineText(redactor.text(criterion))}`);
      }
      lines.push("");
    }
  }

  lines.push(...renderRoadmapRevisionHistory(snapshot.roadmapRevisions, redactor).split("\n"));
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderRoadmapRevisionHistory(
  revisions: readonly RoadmapRevision[],
  redactor: SecretRedactor,
): string {
  const lines = ["## Roadmap revision history", ""];
  if (revisions.length === 0) {
    lines.push("No roadmap revisions have been recorded.", "");
  }
  for (const revision of revisions) {
    const oldValue = redactor.json(revision.oldValue);
    const newValue = redactor.json(revision.newValue);
    lines.push(
      `### ${revision.createdAt} — ${revision.classification.toUpperCase()}`,
      "",
      `- ID: \`${redactor.text(revision.id)}\``,
      `- Actor: ${inlineText(redactor.text(revision.actor))}`,
      ...(revision.sessionId === undefined
        ? []
        : [`- Session: ${inlineText(redactor.text(revision.sessionId))}`]),
      `- Reason: ${inlineText(redactor.text(revision.reason))}`,
      ...(revision.operation === undefined ? [] : [`- Operation: \`${revision.operation.kind}\``]),
      `- Affected phases: ${
        revision.affectedPhaseIds.length === 0
          ? "none"
          : revision.affectedPhaseIds.map((id) => `\`${redactor.text(id)}\``).join(", ")
      }`,
      `- Affected tasks: ${
        revision.affectedTaskIds.length === 0
          ? "none"
          : revision.affectedTaskIds.map((id) => `\`${redactor.text(id)}\``).join(", ")
      }`,
      "- Previous value:",
      "",
      "```json",
      JSON.stringify(oldValue, undefined, 2),
      "```",
      "",
      "- New value:",
      "",
      "```json",
      JSON.stringify(newValue, undefined, 2),
      "```",
      "",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderDecisions(snapshot: PortableProjectSnapshot, redactor: SecretRedactor): string {
  const lines = [
    `# Decisions — ${inlineText(redactor.text(snapshot.project.name))}`,
    "",
    "> Portable decision record generated from authoritative Densa ADE Core state.",
    "",
  ];
  if (snapshot.decisions.length === 0) {
    lines.push("No decisions have been recorded.", "");
  }
  for (const decision of snapshot.decisions) {
    lines.push(
      `## ${inlineText(redactor.text(decision.title))}`,
      "",
      `- ID: \`${redactor.text(decision.id)}\``,
      `- Kind: ${decision.kind}`,
      `- Category: ${inlineText(redactor.text(decision.category))}`,
      `- Source: ${decision.source}`,
      `- Scope: ${decision.scope}`,
      `- Status: ${decision.status}`,
      `- Recorded: ${decision.createdAt}`,
      ...(decision.supersedesId === undefined
        ? []
        : [`- Supersedes: \`${redactor.text(decision.supersedesId)}\``]),
      ...(decision.supersededAt === undefined ? [] : [`- Superseded: ${decision.supersededAt}`]),
      `- Affected phases: ${
        decision.affectedPhaseIds.length === 0
          ? "none"
          : decision.affectedPhaseIds.map((id) => `\`${redactor.text(id)}\``).join(", ")
      }`,
      `- Affected tasks: ${
        decision.affectedTaskIds.length === 0
          ? "none"
          : decision.affectedTaskIds.map((id) => `\`${redactor.text(id)}\``).join(", ")
      }`,
      "",
      normalizeMarkdown(redactor.text(decision.statement)).trimEnd(),
      "",
      "Rationale:",
      "",
      normalizeMarkdown(redactor.text(decision.rationale)).trimEnd(),
      "",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderPortableProject(snapshot: PortableProjectSnapshot): RenderedPortableProject {
  const redactor = new SecretRedactor();
  const sanitizedSettings = redactor.json(snapshot.settings?.values ?? {});
  const files: Record<ManagedFileName, string> = {
    "project.json": jsonDocument({
      formatVersion: PORTABLE_FORMAT_VERSION,
      id: redactor.text(snapshot.project.id),
      name: redactor.text(snapshot.project.name),
      state: snapshot.project.state,
      executionMode: snapshot.project.executionMode,
      createdAt: snapshot.project.createdAt,
      updatedAt: snapshot.project.updatedAt,
    }),
    "SPEC.md": renderSpecification(snapshot, redactor),
    "ROADMAP.md": renderRoadmap(snapshot, redactor),
    "DECISIONS.md": renderDecisions(snapshot, redactor),
    "config.json": jsonDocument({
      formatVersion: PORTABLE_FORMAT_VERSION,
      projectId: redactor.text(snapshot.project.id),
      settings: sanitizedSettings,
      updatedAt: snapshot.settings?.updatedAt ?? snapshot.project.updatedAt,
    }),
  };
  return Object.freeze({ files: Object.freeze(files), redactedValueCount: redactor.count });
}

export function createPortableProjectSnapshot(
  repositories: DensaAdeRepositories,
  projectId: ProjectId,
): PortableProjectSnapshot {
  const project = repositories.projects.findById(projectId);
  if (project === undefined) {
    throw new PortableProjectSyncError(
      "PERSISTENCE_FAILURE",
      `Cannot export missing project ${projectId}`,
    );
  }
  const specification = repositories.specifications.findByProjectId(projectId)?.specification;
  const masterRoadmap = repositories.masterRoadmaps.findByProjectId(projectId);
  const settings = repositories.projectSettings.findByProjectId(projectId);
  return Object.freeze({
    project,
    phases: repositories.phases.listByProjectId(projectId),
    tasks: repositories.tasks.listByProjectId(projectId),
    decisions: repositories.decisions.listByProjectId(projectId),
    roadmapRevisions: repositories.roadmapRevisions.listByProjectId(projectId),
    ...(specification === undefined ? {} : { specification }),
    ...(masterRoadmap === undefined ? {} : { masterRoadmap }),
    ...(settings === undefined ? {} : { settings }),
  });
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new PortableProjectSyncError(
        "WORKSPACE_CONFLICT",
        `Portable project path is not a safe directory: ${path}`,
      );
    }
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
    await mkdir(path, { mode: 0o700, recursive: true });
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new PortableProjectSyncError(
        "WORKSPACE_CONFLICT",
        `Portable project path became unsafe while creating it: ${path}`,
      );
    }
  }
}

async function readRegularFile(path: string): Promise<string | undefined> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new PortableProjectSyncError(
        "WORKSPACE_CONFLICT",
        `Portable project file is not a safe regular file: ${path}`,
      );
    }
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
}

function parseManifest(content: string, projectId: ProjectId): SyncManifest {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch (error) {
    throw new PortableProjectSyncError(
      "WORKSPACE_CONFLICT",
      "The portable sync manifest is malformed; generated files were preserved",
      { cause: error },
    );
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("formatVersion" in value) ||
    value.formatVersion !== PORTABLE_FORMAT_VERSION ||
    !("projectId" in value) ||
    value.projectId !== projectId ||
    !("files" in value) ||
    typeof value.files !== "object" ||
    value.files === null
  ) {
    throw new PortableProjectSyncError(
      "WORKSPACE_CONFLICT",
      "The portable sync manifest does not match this project; generated files were preserved",
    );
  }
  const hashes = value.files as Record<string, unknown>;
  const files = {} as Record<ManagedFileName, string>;
  for (const name of MANAGED_FILE_NAMES) {
    const hash = hashes[name];
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/u.test(hash)) {
      throw new PortableProjectSyncError(
        "WORKSPACE_CONFLICT",
        "The portable sync manifest contains an invalid file hash; generated files were preserved",
      );
    }
    files[name] = hash;
  }
  return Object.freeze({ formatVersion: 1, projectId, files: Object.freeze(files) });
}

export async function atomicReplaceFile(
  path: string,
  content: string,
  options: AtomicReplaceOptions = {},
): Promise<void> {
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let temporaryExists = false;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    temporaryExists = true;
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await options.beforeRename?.(temporaryPath);
    await rename(temporaryPath, path);
    temporaryExists = false;
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    if (temporaryExists) {
      await rm(temporaryPath, { force: true });
    }
  }
}

export class PortableProjectSynchronizer {
  constructor(private readonly repositories: DensaAdeRepositories) {}

  async synchronize(workspaceRoot: string, projectId: ProjectId): Promise<PortableSyncResult> {
    const snapshot = createPortableProjectSnapshot(this.repositories, projectId);
    const rendered = renderPortableProject(snapshot);
    const densaAdeDirectory = join(workspaceRoot, ".densa-ade");
    await ensureDirectory(workspaceRoot);
    await ensureDirectory(densaAdeDirectory);
    await ensureDirectory(join(densaAdeDirectory, "reports"));
    await ensureDirectory(join(densaAdeDirectory, "logs"));

    const manifestPath = join(densaAdeDirectory, SYNC_MANIFEST_NAME);
    const manifestContent = await readRegularFile(manifestPath);
    const manifest =
      manifestContent === undefined ? undefined : parseManifest(manifestContent, projectId);
    const current = new Map<ManagedFileName, string | undefined>();
    const conflicts: PortableSyncConflict[] = [];
    const unchanged: string[] = [];

    for (const name of MANAGED_FILE_NAMES) {
      const content = await readRegularFile(join(densaAdeDirectory, name));
      current.set(name, content);
      if (content === undefined) {
        continue;
      }
      const currentHash = sha256(content);
      const desiredHash = sha256(rendered.files[name]);
      if (currentHash === desiredHash) {
        unchanged.push(name);
      } else if (manifest?.files[name] !== currentHash) {
        conflicts.push(Object.freeze({ path: name, reason: "human-edit" }));
      }
    }

    if (conflicts.length > 0) {
      return Object.freeze({
        status: "conflict",
        directory: densaAdeDirectory,
        written: Object.freeze([]),
        unchanged: Object.freeze(unchanged),
        conflicts: Object.freeze(conflicts),
        redactedValueCount: rendered.redactedValueCount,
      });
    }

    const written: string[] = [];
    for (const name of MANAGED_FILE_NAMES) {
      const content = current.get(name);
      if (content === rendered.files[name]) {
        continue;
      }
      await atomicReplaceFile(join(densaAdeDirectory, name), rendered.files[name]);
      written.push(name);
    }

    const files = {} as Record<ManagedFileName, string>;
    for (const name of MANAGED_FILE_NAMES) {
      files[name] = sha256(rendered.files[name]);
    }
    const nextManifest: SyncManifest = Object.freeze({
      formatVersion: 1,
      projectId,
      files: Object.freeze(files),
    });
    const nextManifestContent = jsonDocument(nextManifest);
    if (manifestContent !== nextManifestContent) {
      await atomicReplaceFile(manifestPath, nextManifestContent);
      written.push(SYNC_MANIFEST_NAME);
    } else {
      unchanged.push(SYNC_MANIFEST_NAME);
    }

    return Object.freeze({
      status: "synchronized",
      directory: densaAdeDirectory,
      written: Object.freeze(written),
      unchanged: Object.freeze(unchanged),
      conflicts: Object.freeze([]),
      redactedValueCount: rendered.redactedValueCount,
    });
  }
}
