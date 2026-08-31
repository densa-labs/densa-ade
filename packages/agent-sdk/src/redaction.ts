const SENSITIVE_KEY_PATTERN =
  /(?:^|[_.-])(?:api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|authorization|bearer|client[_-]?secret|cookie|credential|password|passwd|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token)(?:$|[_.-])/iu;
const NORMALIZED_SENSITIVE_KEYS = new Set([
  "apikey",
  "accesskey",
  "accesstoken",
  "authtoken",
  "authorization",
  "bearer",
  "clientsecret",
  "cookie",
  "credential",
  "password",
  "passwd",
  "privatekey",
  "refreshtoken",
  "secret",
  "sessiontoken",
  "token",
]);
const PRIVATE_KEY_PATTERN =
  /-----BEGIN (?:EC |OPENSSH |PGP |RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:EC |OPENSSH |PGP |RSA )?PRIVATE KEY-----/gu;
const INCOMPLETE_PRIVATE_KEY_PATTERN =
  /-----BEGIN (?:EC |OPENSSH |PGP |RSA )?PRIVATE KEY-----[\s\S]*$/gu;
const KNOWN_TOKEN_PATTERN =
  /\b(?:AKIA[0-9A-Z]{12,}|github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|glpat-[A-Za-z0-9_-]{12,}|npm_[A-Za-z0-9]{12,}|sk-(?:proj-)?[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/gu;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;
const BEARER_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/giu;
const SECRET_ASSIGNMENT_PATTERN =
  /(["']?\b(?:api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|authorization|client[_-]?secret|cookie|credential|password|passwd|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token)["']?\s*[:=]\s*)(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|[^\s,;}]+)/giu;
const EXPLICIT_SECRET_PATTERN = /<secret>[\s\S]*?(?:<\/secret>|$)|\[secret:[^\]]*(?:\]|$)/giu;

/** Redacts known credential shapes from provider output before it crosses the adapter boundary. */
export function redactAgentText(value: string): string {
  return value
    .replace(EXPLICIT_SECRET_PATTERN, "[REDACTED]")
    .replace(PRIVATE_KEY_PATTERN, "[REDACTED PRIVATE KEY]")
    .replace(INCOMPLETE_PRIVATE_KEY_PATTERN, "[REDACTED PRIVATE KEY]")
    .replace(KNOWN_TOKEN_PATTERN, "[REDACTED]")
    .replace(JWT_PATTERN, "[REDACTED]")
    .replace(BEARER_PATTERN, "$1[REDACTED]")
    .replace(
      SECRET_ASSIGNMENT_PATTERN,
      (
        _match: string,
        prefix: string,
        doubleQuoted: string | undefined,
        singleQuoted: string | undefined,
      ) =>
        `${prefix}${doubleQuoted !== undefined ? '"[REDACTED]"' : singleQuoted !== undefined ? "'[REDACTED]'" : "[REDACTED]"}`,
    );
}

/** Redaction is line-framed, never chunk-framed, so split credentials cannot cross the boundary. */
export class RedactedAgentTextStream {
  private pending = "";
  private oversized = false;
  private redactedBlock: "private" | "angle" | "bracket" | undefined;

  constructor(
    private readonly limitBytes: number,
    private readonly emit: (text: string, truncated: boolean) => void,
  ) {}

  append(chunk: string): void {
    if (this.oversized) return;
    this.pending += chunk;
    let newline = this.pending.indexOf("\n");
    while (newline >= 0) {
      const line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      this.line(line);
      newline = this.pending.indexOf("\n");
    }
    if (Buffer.byteLength(this.pending) > this.limitBytes) {
      this.pending = "";
      // Do not resume mid-secret after dropping a partial line or block delimiter.
      this.oversized = true;
      this.emit("[Oversized diagnostic stream omitted]\n", true);
    }
  }

  finish(): void {
    if (this.pending.length > 0) this.line(this.pending);
    this.pending = "";
  }

  private line(line: string): void {
    if (this.oversized) return;
    if (Buffer.byteLength(line) > this.limitBytes) {
      this.oversized = true;
      this.emit("[Oversized diagnostic stream omitted]\n", true);
      return;
    }
    let containsSecret = this.redactedBlock !== undefined;
    // Consume delimiters in order: a line can close one block and open another.
    const markers = line.matchAll(
      /-----BEGIN (?:EC |OPENSSH |PGP |RSA )?PRIVATE KEY-----|-----END (?:EC |OPENSSH |PGP |RSA )?PRIVATE KEY-----|<secret>|<\/secret>|\[secret:|\]/giu,
    );
    for (const match of markers) {
      const marker = match[0].toLowerCase();
      if (this.redactedBlock !== undefined) {
        if (
          (this.redactedBlock === "private" && marker.startsWith("-----end ")) ||
          (this.redactedBlock === "angle" && marker === "</secret>") ||
          (this.redactedBlock === "bracket" && marker === "]")
        )
          this.redactedBlock = undefined;
      } else if (marker.startsWith("-----begin ")) {
        this.redactedBlock = "private";
        containsSecret = true;
      } else if (marker === "<secret>" || marker === "[secret:") {
        this.redactedBlock = marker === "<secret>" ? "angle" : "bracket";
        containsSecret = true;
      }
    }
    if (containsSecret) {
      this.emit("[REDACTED]\n", false);
      return;
    }
    this.emit(`${redactAgentText(line)}\n`, false);
  }
}

/** Redacts strings recursively and fails closed for values stored under secret-bearing keys. */
export function redactAgentValue(value: unknown, key?: string): unknown {
  if (
    key !== undefined &&
    (SENSITIVE_KEY_PATTERN.test(key) ||
      NORMALIZED_SENSITIVE_KEYS.has(key.replace(/[^A-Za-z0-9]/gu, "").toLowerCase()))
  ) {
    return "[REDACTED]";
  }
  if (typeof value === "string") return redactAgentText(value);
  if (Array.isArray(value)) return value.map((entry) => redactAgentValue(entry));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([childKey, entry]) => [childKey, redactAgentValue(entry, childKey)]),
  );
}
