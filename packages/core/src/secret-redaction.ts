import type { Event, JsonObject, JsonValue } from "@densa-ade/protocol";

const SENSITIVE_KEY_PATTERN =
  /(?:^|[_.-])(?:api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|authorization|bearer|client[_-]?secret|cookie|credential|password|passwd|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token)(?:$|[_.-])/iu;
const PRIVATE_KEY_PATTERN =
  /-----BEGIN (?:EC |OPENSSH |PGP |RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:EC |OPENSSH |PGP |RSA )?PRIVATE KEY-----/gu;
const INCOMPLETE_PRIVATE_KEY_PATTERN =
  /-----BEGIN (?:EC |OPENSSH |PGP |RSA )?PRIVATE KEY-----[\s\S]*$/gu;
const KNOWN_TOKEN_PATTERN =
  /\b(?:AKIA[0-9A-Z]{12,}|github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|glpat-[A-Za-z0-9_-]{12,}|npm_[A-Za-z0-9]{12,}|sk-(?:proj-)?[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/gu;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;
const BEARER_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/giu;
const SECRET_ASSIGNMENT_PATTERN =
  /(["']?\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|authorization|client[_-]?secret|cookie|credential|password|passwd|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token)["']?\s*[:=]\s*)(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|[^\s,;}]+)/giu;
const EXPLICIT_SECRET_PATTERN = /<secret>[\s\S]*?(?:<\/secret>|$)|\[secret:[^\]]*(?:\]|$)/giu;

function replaceLiteral(input: string, value: string): string {
  return value.length === 0 ? input : input.split(value).join("[REDACTED]");
}

/** Redacts known credential shapes plus the exact transient values resolved for one operation. */
export class SecretRedactor {
  readonly #secretValues: readonly string[];

  constructor(secretValues: Iterable<string> = []) {
    this.#secretValues = Object.freeze(
      [...new Set(secretValues)]
        .filter((value) => value.length > 0)
        .toSorted((left, right) => right.length - left.length),
    );
  }

  text(input: string): string {
    let output = input;
    for (const value of this.#secretValues) output = replaceLiteral(output, value);
    return output
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

  prompt(input: string): string {
    return this.text(input);
  }

  log(input: string): string {
    return this.text(input);
  }

  json(value: JsonValue, key?: string): JsonValue {
    if (key !== undefined && SENSITIVE_KEY_PATTERN.test(key)) return "[REDACTED]";
    if (typeof value === "string") return this.text(value);
    if (Array.isArray(value)) return value.map((entry) => this.json(entry));
    if (value !== null && typeof value === "object") {
      const result: JsonObject = {};
      for (const [childKey, childValue] of Object.entries(value)) {
        result[childKey] = this.json(childValue, childKey);
      }
      return result;
    }
    return value;
  }

  event(event: Event): Event {
    return Object.freeze({
      ...event,
      actor: this.text(event.actor),
      payload: this.json(event.payload) as JsonObject,
    });
  }
}

export function redactSensitiveText(input: string): string {
  return new SecretRedactor().text(input);
}

export function redactPrompt(input: string, secretValues: Iterable<string> = []): string {
  return new SecretRedactor(secretValues).prompt(input);
}

export function redactLog(input: string, secretValues: Iterable<string> = []): string {
  return new SecretRedactor(secretValues).log(input);
}

export function redactEvent(event: Event, secretValues: Iterable<string> = []): Event {
  return new SecretRedactor(secretValues).event(event);
}
