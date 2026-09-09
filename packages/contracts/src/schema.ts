/** Dependency-free JSON boundary validators; never execute getters or coerce input. */
export const limits = Object.freeze({ bytes: 1_048_576, depth: 32, entries: 4096, string: 262144, page: 100 });
export const errorCodes = [
  'MALFORMED_MESSAGE', 'PAYLOAD_TOO_LARGE', 'INCOMPATIBLE_VERSION', 'FEATURE_UNAVAILABLE',
  'COMMAND_ID_CONFLICT', 'DIGEST_MISMATCH', 'STALE_REVISION', 'CROSS_PROJECT_REFERENCE',
  'UNSUPPORTED_ENFORCEMENT', 'EVIDENCE_STALE', 'PROJECTION_CONFLICT', 'PROJECTION_FAILED',
  'RESNAPSHOT_REQUIRED', 'OUTCOME_UNKNOWN', 'RECOVERY_REQUIRED', 'NOT_FOUND', 'UNAUTHORIZED',
  'INVALID_CONFIGURATION', 'INVALID_TRANSITION', 'DEPENDENCY_BLOCKED', 'STORAGE_HOLD',
  'OWNERSHIP_CONFLICT', 'CANCELLED', 'TIMEOUT', 'RETRY_EXHAUSTED', 'AUTHENTICATION_REQUIRED',
  'USAGE_LIMITED', 'CONTEXT_OVERFLOW', 'PROVIDER_REFUSAL', 'UNSUPPORTED_FORMAT', 'INTERNAL_ERROR',
] as const;
export type ErrorCode = typeof errorCodes[number];
export class ContractError extends Error {
  constructor(readonly code: ErrorCode) { super(code); this.name = 'ContractError'; }
}
export function fail(code: ErrorCode = 'MALFORMED_MESSAGE'): never { throw new ContractError(code); }
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export function json(value: unknown): Json {
  let count = 0;
  const ancestors = new Set<object>();
  function visit(v: unknown, depth: number): Json {
    if (++count > limits.entries || depth > limits.depth) fail('PAYLOAD_TOO_LARGE');
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      if (v.length > limits.string) fail('PAYLOAD_TOO_LARGE');
      if (/[\uD800-\uDFFF]/u.test(v)) fail();
      return v;
    }
    if (typeof v === 'number') { if (!Number.isSafeInteger(v) || Object.is(v, -0)) fail(); return v; }
    if (typeof v !== 'object' || ancestors.has(v)) fail();
    const array = Array.isArray(v);
    if (!array && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) fail();
    ancestors.add(v);
    const keys = Reflect.ownKeys(v);
    const result: { [key: string]: Json } = Object.create(null) as { [key: string]: Json };
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) fail();
      if (/[\uD800-\uDFFF]/u.test(key)) fail();
      if (array && !/^(0|[1-9][0-9]*)$/.test(key)) fail();
      const descriptor = Object.getOwnPropertyDescriptor(v, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) fail();
      result[key] = visit(descriptor.value, depth + 1);
    }
    ancestors.delete(v);
    if (!array) return result;
    if (Object.keys(result).length !== v.length) fail();
    return Array.from({ length: v.length }, (_, i) => result[String(i)] as Json);
  }
  const result = visit(value, 0);
  if (new TextEncoder().encode(JSON.stringify(result)).length > limits.bytes) fail('PAYLOAD_TOO_LARGE');
  return result;
}
export interface Schema<T> { parse(value: unknown): T }
export type Infer<S> = S extends Schema<infer T> ? T : never;
export function schema<T>(parse: (value: unknown) => T): Schema<T> { return Object.freeze({ parse }); }
export const text = schema<string>(v => typeof v === 'string' && v.length > 0 && v.length <= limits.string && !/[\uD800-\uDFFF]/u.test(v) ? v : fail());
export const integer = schema<number>(v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && !Object.is(v, -0) ? v : fail());
export const pageSize = schema<number>(v => { const n = integer.parse(v); return n >= 1 && n <= limits.page ? n : fail(); });
export const boolean = schema<boolean>(v => typeof v === 'boolean' ? v : fail());
export function enumeration<const T extends readonly string[]>(values: T): Schema<T[number]> {
  return schema(v => typeof v === 'string' && values.includes(v) ? v as T[number] : fail());
}
export function literal<const T extends string | number | boolean | null>(value: T): Schema<T> { return schema(v => v === value ? value : fail()); }
export function optional<T>(inner: Schema<T>): Schema<T | undefined> { return schema(v => v === undefined ? undefined : inner.parse(v)); }
export function array<T>(inner: Schema<T>, max: number = limits.page): Schema<T[]> {
  return schema(v => Array.isArray(v) && v.length <= max ? v.map(x => inner.parse(x)) : fail());
}
export function object<const S extends Record<string, Schema<unknown>>>(fields: S): Schema<{ [K in keyof S]: Infer<S[K]> }> {
  return schema(value => {
    const v = json(value);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) fail();
    for (const key of Object.keys(v)) if (!Object.hasOwn(fields, key)) fail();
    const output: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(fields)) {
      const parsed = field.parse(v[key]);
      if (parsed !== undefined) output[key] = parsed;
    }
    if (Object.hasOwn(fields, 'projectId') && output.projectId !== undefined) assertProject(output, id('project').parse(output.projectId));
    return output as { [K in keyof S]: Infer<S[K]> };
  });
}
export function union<const S extends readonly Schema<unknown>[]>(...variants: S): Schema<Infer<S[number]>> {
  return schema(v => {
    for (const variant of variants) { try { return variant.parse(v) as Infer<S[number]>; } catch (error) { if (!(error instanceof ContractError)) throw error; } }
    return fail();
  });
}
export const idKinds = ['project', 'execution', 'principal', 'sponsorship', 'binding', 'specification', 'roadmap', 'phase', 'task', 'attempt', 'roleRun', 'validationRun', 'renewal', 'repair', 'operation', 'approval', 'command', 'event', 'candidate', 'client', 'requirement', 'criterion', 'decision', 'snapshot', 'proposal', 'grant', 'deferred', 'projection'] as const;
export type IdKind = typeof idKinds[number];
declare const identity: unique symbol;
export type Id<K extends IdKind> = string & { readonly [identity]: K };
export function id<K extends IdKind>(kind: K): Schema<Id<K>> {
  const pattern = new RegExp(`^${kind}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`);
  return schema(v => typeof v === 'string' && pattern.test(v) && !v.endsWith('00000000-0000-0000-0000-000000000000') ? v as Id<K> : fail());
}
export const revision = integer;
export const digest = schema<string>(v => typeof v === 'string' && /^sha256:[0-9a-f]{64}$/.test(v) ? v : fail());
export const timestamp = schema<string>(v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v ? v : fail());
export function ref<K extends IdKind>(kind: K) {
  const shape = object({ projectId: id('project'), id: id(kind) });
  return schema(value => {
    const result = shape.parse(value);
    if (kind === 'project' && String(result.id) !== result.projectId) fail('CROSS_PROJECT_REFERENCE');
    return result;
  });
}
/** The caller supplies authenticated scope; payload project fields cannot select it. */
export function assertProject(value: unknown, projectId: Id<'project'>): void {
  const root = json(value);
  function visit(v: Json): void {
    if (v === null || typeof v !== 'object') return;
    if (!Array.isArray(v) && Object.hasOwn(v, 'projectId') && v.projectId !== projectId) fail('CROSS_PROJECT_REFERENCE');
    for (const child of Object.values(v)) visit(child);
  }
  visit(root);
}
