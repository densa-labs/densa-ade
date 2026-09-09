import { catalog, partitions } from './catalog.js';
import type { ActionId } from './catalog.js';
import { array, assertProject, digest, enumeration, errorCodes, fail, id, integer, json, limits, literal, object, optional, ref, schema, text, timestamp, union } from './schema.js';
import type { Id, Infer, Json } from './schema.js';

export const versions = Object.freeze({ protocol: 1, event: 1, operation: 1, digest: 1 });
const partition = enumeration(['H', 'I', 'U', 'L']);
export const expectedRevision = object({ target: union(id('principal'), ref('project'), ref('execution'), ref('specification'), ref('roadmap'), ref('task'), ref('phase'), ref('operation'), ref('approval'), ref('binding'), ref('snapshot'), ref('decision'), ref('grant')), revision: integer });
const revisions = array(expectedRevision);
const payload = schema(json);
const base = {
  protocolVersion: integer, partition, schemaVersion: integer, capabilityVersion: integer,
  action: text, clientId: id('client'), principalId: id('principal'), correlationId: text,
  projectId: optional(id('project')), payload,
};
const query = object({ ...base, kind: literal('query') });
const command = object({ ...base, kind: literal('command'), commandId: id('command'), payloadDigest: digest, expectedRevisions: revisions });
export type Request = Infer<typeof query> | Infer<typeof command>;
/** Authentication/authorization belongs to P2/P3; parsing does not authorize execution. */
export function parseRequest(value: unknown, authenticatedProject?: Id<'project'>): Request {
  const raw = json(value);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail();
  const request = raw.kind === 'command' ? command.parse(raw) : query.parse(raw);
  if (request.protocolVersion !== versions.protocol) fail('INCOMPATIBLE_VERSION');
  if (request.partition !== 'H') fail('FEATURE_UNAVAILABLE');
  if (request.schemaVersion !== partitions.H.schemaVersion || request.capabilityVersion !== partitions.H.capabilityVersion) fail('INCOMPATIBLE_VERSION');
  if (!Object.hasOwn(catalog, request.action)) fail('FEATURE_UNAVAILABLE');
  const entry = catalog[request.action as ActionId];
  if (entry.kind === 'internal') fail('UNAUTHORIZED');
  if (request.kind !== entry.kind) fail();
  if (entry.scope === 'project') {
    if (!request.projectId) fail();
    if (authenticatedProject && request.projectId !== authenticatedProject) fail('CROSS_PROJECT_REFERENCE');
    assertProject(request, request.projectId);
  } else if (request.projectId !== undefined) fail();
  entry.payload.parse(request.payload);
  if (request.action === 'client.quit' && request.payload && typeof request.payload === 'object' && !Array.isArray(request.payload) && request.payload.principal !== request.principalId) fail('UNAUTHORIZED');
  if (request.kind === 'command') {
    if (request.expectedRevisions.length === 0) fail();
    const targets = request.expectedRevisions.map(row => canonicalJson(row.target));
    if (new Set(targets).size !== targets.length) fail();
    const aggregate = request.projectId ? { projectId: request.projectId, id: request.projectId } : request.principalId;
    if (!targets.includes(canonicalJson(aggregate))) fail();
  }
  return request;
}
/** Pure readiness check; never calls handlers. Implemented IDs must come from trusted composition. */
export function requireImplemented(request: Request, implemented: readonly ActionId[] = []): void {
  if (!implemented.includes(request.action as ActionId)) fail('FEATURE_UNAVAILABLE');
}
export function canonicalJson(value: unknown): string {
  function encode(v: Json): string {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(encode).join(',')}]`;
    return `{${Object.keys(v).sort().map(key => `${JSON.stringify(key)}:${encode(v[key] as Json)}`).join(',')}}`;
  }
  return encode(json(value));
}
/** Versioned canonical request digest excludes only delivery correlation, command ID and digest itself. */
export async function commandDigest(value: unknown): Promise<string> {
  const request = parseRequest(value);
  if (request.kind !== 'command') fail();
  const material = {
    digestVersion: versions.digest, protocolVersion: request.protocolVersion, partition: request.partition,
    schemaVersion: request.schemaVersion, capabilityVersion: request.capabilityVersion, action: request.action,
    clientId: request.clientId, principalId: request.principalId, projectId: request.projectId ?? null,
    expectedRevisions: [...request.expectedRevisions].sort((a, b) => canonicalJson(a.target) < canonicalJson(b.target) ? -1 : 1),
    payload: request.payload,
  };
  const bytes = new TextEncoder().encode(canonicalJson(material));
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('')}`;
}
export async function verifyCommandDigest(value: unknown): Promise<Request> {
  const request = parseRequest(value);
  if (request.kind !== 'command' || await commandDigest(request) !== request.payloadDigest) fail('DIGEST_MISMATCH');
  return request;
}
export const errorEnvelope = object({ code: enumeration(errorCodes), message: text, currentRevisions: revisions });
const commonResult = { commandId: id('command'), currentRevisions: revisions };
export const commandResult = union(
  object({ ...commonResult, status: literal('rejected'), error: errorEnvelope }),
  object({ ...commonResult, status: literal('in-progress'), operationId: id('operation') }),
  object({ ...commonResult, status: literal('outcome-unknown'), operationId: id('operation'), recoveryRequired: literal(true) }),
  object({ ...commonResult, status: literal('committed'), value: payload, warnings: array(object({ code: enumeration(['PROJECTION_FAILED', 'PROJECTION_CONFLICT']), repairOperationId: id('operation') })) }),
);
export type CommandResult = Infer<typeof commandResult>;
export const recordedCommand = object({ commandId: id('command'), payloadDigest: digest, outcome: commandResult });
/** Decision only. P1M1 must execute lookup, revision check and write in one transaction. */
export async function classifyCommand(value: unknown, recorded: unknown, current: unknown): Promise<{ kind: 'replay'; outcome: CommandResult } | { kind: 'new' }> {
  const request = await verifyCommandDigest(value);
  if (request.kind !== 'command') fail();
  if (recorded !== null) {
    const previous = recordedCommand.parse(recorded);
    if (previous.commandId !== request.commandId || previous.outcome.commandId !== previous.commandId) fail();
    if (previous.payloadDigest !== request.payloadDigest) fail('COMMAND_ID_CONFLICT');
    return { kind: 'replay', outcome: previous.outcome };
  }
  const actual = revisions.parse(current);
  for (const expected of request.expectedRevisions) {
    const matches = actual.filter(row => canonicalJson(row.target) === canonicalJson(expected.target));
    if (matches.length !== 1 || matches[0]?.revision !== expected.revision) fail('STALE_REVISION');
  }
  return { kind: 'new' };
}
const operationBase = { version: literal(1), operationId: id('operation'), commandId: id('command'), projectId: optional(id('project')), revision: integer, updatedAt: timestamp, intentDigest: digest };
export const operationEnvelope = union(
  object({ ...operationBase, phase: literal('intended') }),
  object({ ...operationBase, phase: literal('dispatched-outcome-unknown'), recoveryRequired: literal(true) }),
  object({ ...operationBase, phase: literal('verified-completed'), verificationDigest: digest }),
  object({ ...operationBase, phase: literal('verified-not-applied'), verificationDigest: digest }),
);
export const callbackFence = object({ projectId: id('project'), execution: ref('execution'), attempt: union(ref('attempt'), literal(null)), run: union(ref('roleRun'), ref('validationRun')), leaseGeneration: integer, expectedRevisions: revisions });
export const eventEnvelope = object({ version: literal(1), eventId: id('event'), projectId: id('project'), sequence: integer, occurredAt: timestamp, commandId: id('command'), revision: integer, type: text, payloadVersion: integer, payload });
export const snapshotEnvelope = object({ version: literal(1), projectId: id('project'), watermark: integer, revision: integer, value: payload });
export const eventPage = union(
  object({ status: literal('resnapshot-required'), projectId: id('project'), earliestAvailable: integer }),
  object({ status: literal('page'), projectId: id('project'), after: integer, watermark: integer, events: array(eventEnvelope), next: integer, hasMore: literal(false) }),
  object({ status: literal('page'), projectId: id('project'), after: integer, watermark: integer, events: array(eventEnvelope), next: integer, hasMore: literal(true) }),
);
export function parseEventPage(value: unknown): Infer<typeof eventPage> {
  const result = eventPage.parse(value);
  assertProject(result, result.projectId);
  if (result.status === 'page') {
    let cursor = result.after;
    if (new Set(result.events.map(event => event.eventId)).size !== result.events.length || (result.hasMore && result.events.length === 0)) fail();
    for (const event of result.events) { if (event.sequence !== cursor + 1 || event.sequence > result.watermark) fail(); cursor = event.sequence; }
    if (result.next !== cursor || result.next > result.watermark || result.hasMore !== (result.next < result.watermark)) fail();
  }
  return result;
}
export const responseEnvelope = object({ protocolVersion: literal(1), partition: literal('H'), schemaVersion: literal(1), correlationId: text, action: enumeration(Object.keys(catalog) as ActionId[]), result: union(commandResult, object({ status: literal('query'), watermark: integer, value: payload }), object({ status: literal('error'), error: errorEnvelope })) });
/** Keep app/Core/storage/runtime/build axes distinct; concrete compatibility is a later producer obligation. */
export const compatibilityIdentity = object({ app: text, core: text, protocol: integer, storageSchema: integer, runtime: text, build: text });
const advertisedPartition = object({ schemaVersion: union(integer, literal(null)), capabilityVersion: union(integer, literal(null)), implementedOperations: array(text, limits.entries) });
export const handshakeEnvelope = object({ protocolVersion: literal(1), partitions: object({ H: advertisedPartition, I: advertisedPartition, U: advertisedPartition, L: advertisedPartition }) });
export function parseHandshake(value: unknown): Infer<typeof handshakeEnvelope> {
  const result = handshakeEnvelope.parse(value);
  for (const key of ['H', 'I', 'U', 'L'] as const) {
    const advertised = result.partitions[key];
    const supported = partitions[key];
    if (advertised.schemaVersion !== supported.schemaVersion || advertised.capabilityVersion !== supported.capabilityVersion) fail('INCOMPATIBLE_VERSION');
    if (new Set(advertised.implementedOperations).size !== advertised.implementedOperations.length) fail();
    for (const action of advertised.implementedOperations) {
      if (key !== 'H' || !Object.hasOwn(catalog, action) || catalog[action as ActionId].kind === 'internal') fail('FEATURE_UNAVAILABLE');
    }
  }
  return result;
}
export function parseResponse(value: unknown, requestValue: unknown): Infer<typeof responseEnvelope> {
  const request = parseRequest(requestValue);
  const response = responseEnvelope.parse(value);
  if (response.action !== request.action || response.correlationId !== request.correlationId) fail();
  if (request.projectId) assertProject(response, request.projectId);
  if (response.result.status !== 'error') {
    if (request.kind === 'query') { if (response.result.status !== 'query') fail(); }
    else if (response.result.status === 'query' || response.result.commandId !== request.commandId) fail();
  }
  return response;
}
/** Serialized input boundary; a canonical wire encoding also rejects duplicate keys and ambiguous numbers. */
export function decodeMessage(wire: string): Json {
  if (new TextEncoder().encode(wire).length > limits.bytes) fail('PAYLOAD_TOO_LARGE');
  let value: unknown;
  try { value = JSON.parse(wire); } catch { return fail(); }
  const result = json(value);
  if (canonicalJson(result) !== wire) fail();
  return result;
}
