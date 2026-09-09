import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as c from '../dist/contracts/src/index.js';

const uuid = '12345678-1234-4234-8234-123456789abc';
const ident = kind => `${kind}_${uuid}`;
const projectId = ident('project');
const reference = kind => ({ projectId, id: ident(kind) });
const hash = `sha256:${'a'.repeat(64)}`;
const expected = [{ target: reference('execution'), revision: 3 }, { target: reference('project'), revision: 3 }];
function request(action = 'project.pause', payload = { execution: reference('execution') }) {
  const entry = c.catalog[action];
  return { protocolVersion: 1, partition: 'H', schemaVersion: 1, capabilityVersion: 1, kind: entry.kind === 'query' ? 'query' : 'command', action, clientId: ident('client'), principalId: ident('principal'), correlationId: 'delivery-1', ...(entry.scope === 'project' ? { projectId } : {}), ...(entry.kind === 'query' ? {} : { commandId: ident('command'), payloadDigest: hash, expectedRevisions: entry.scope === 'project' ? expected : [{ target: ident('principal'), revision: 0 }] }), payload };
}
async function signed(action, payload) { const r = request(action, payload); r.payloadDigest = await c.commandDigest(r); return r; }
function rejects(fn, code = 'MALFORMED_MESSAGE') { assert.throws(fn, error => error instanceof c.ContractError && error.code === code); }
test('all identity kinds round trip and reject kind confusion, paths, nil and malformed IDs', () => {
  for (const kind of c.idKinds) {
    assert.equal(c.id(kind).parse(ident(kind)), ident(kind));
    for (const value of ['/tmp/project', uuid, `${kind}_${uuid.toUpperCase()}`, `${kind}_00000000-0000-0000-0000-000000000000`, `${ident(kind)}\n`, 7]) rejects(() => c.id(kind).parse(value));
    for (const other of c.idKinds.filter(x => x !== kind)) rejects(() => c.id(kind).parse(ident(other)));
  }
  rejects(() => c.ref('project').parse({ projectId, id: `project_${uuid.replace('1234', 'abcd')}` }), 'CROSS_PROJECT_REFERENCE');
});
test('JSON rejects lossy values, getters, cycles, sparse arrays, prototype keys and non-JSON objects', () => {
  const cycle = {}; cycle.self = cycle;
  let getterRan = false;
  const accessor = Object.defineProperty({}, 'x', { enumerable: true, get() { getterRan = true; return 1; } });
  for (const value of [undefined, NaN, Infinity, -0, 1.1, 2 ** 53, 1n, new Date(), new Map(), cycle, accessor, [,,], { x: undefined }, JSON.parse('{"__proto__":1}'), '\ud800', { ['\ud800']: 1 }]) rejects(() => c.json(value));
  assert.equal(getterRan, false);
  assert.equal(c.canonicalJson([null, true, '😀', 42]), '[null,true,"😀",42]');
});
test('depth, node, string, wire byte and page limits fail before dispatch', () => {
  let deep = null; for (let i = 0; i < 34; i++) deep = [deep];
  for (const value of [deep, Array(4097).fill(null), 'x'.repeat(c.limits.string + 1), Array(5).fill('界'.repeat(80000))]) rejects(() => c.json(value), 'PAYLOAD_TOO_LARGE');
  rejects(() => c.decodeMessage(' '.repeat(c.limits.bytes + 1)), 'PAYLOAD_TOO_LARGE');
  for (const limit of [0, 101, -1, 1.5]) rejects(() => c.parseRequest(request('events.query', { after: 0, limit })));
  rejects(() => c.parseRequest(request('portable.conflicts', { limit: 101 })));
});
test('canonical wire round trips and refuses duplicate keys, noncanonical numbers and trailing junk', () => {
  const r = request();
  assert.equal(c.canonicalJson(c.decodeMessage(c.canonicalJson(r))), c.canonicalJson(r));
  for (const wire of ['{"a":1,"a":2}', '{"a":1e0}', '{"b":2,"a":1}', 'null garbage', '{"a":-0}', '{"a":1, "b":2}']) rejects(() => c.decodeMessage(wire));
});
test('serialized timestamps and revisions are exact and bounded', () => {
  assert.equal(c.timestamp.parse('2026-09-09T00:00:00.000Z'), '2026-09-09T00:00:00.000Z');
  for (const value of ['2026-02-30T00:00:00.000Z', '2026-09-09', '2026-09-09T00:00:00+00:00', new Date()]) rejects(() => c.timestamp.parse(value));
  for (const value of [-1, 0.5, '1', 2 ** 53]) rejects(() => c.revision.parse(value));
});
test('request version/partition matrix is fail closed and no declared action is implemented', () => {
  for (const key of ['protocolVersion', 'schemaVersion', 'capabilityVersion']) for (const version of [0, 2, 999]) rejects(() => c.parseRequest({ ...request(), [key]: version }), 'INCOMPATIBLE_VERSION');
  for (const partition of ['I', 'U', 'L']) rejects(() => c.parseRequest({ ...request(), partition }), 'FEATURE_UNAVAILABLE');
  rejects(() => c.parseRequest({ ...request(), action: 'update.install' }), 'FEATURE_UNAVAILABLE');
  rejects(() => c.requireImplemented(c.parseRequest(request())), 'FEATURE_UNAVAILABLE');
  rejects(() => c.parseRequest(request('renewal.drain')), 'UNAUTHORIZED');
  for (const entry of Object.values(c.partitions)) assert.deepEqual(entry.implementedOperations, []);
  assert.equal(c.partitions.U.schemaVersion, null);
  assert.equal(c.partitions.L.authority, 'maintainer-only');
});
test('project references and authenticated scope cannot be crossed, including revision targets', () => {
  const other = `project_${uuid.replace('1234', 'abcd')}`;
  rejects(() => c.parseRequest(request(), c.id('project').parse(other)), 'CROSS_PROJECT_REFERENCE');
  rejects(() => c.parseRequest(request('project.pause', { execution: { ...reference('execution'), projectId: other } })), 'CROSS_PROJECT_REFERENCE');
  rejects(() => c.parseRequest({ ...request(), expectedRevisions: [{ target: { ...reference('task'), projectId: other }, revision: 0 }] }), 'CROSS_PROJECT_REFERENCE');
  rejects(() => c.parseRequest({ ...request(), expectedRevisions: [] }));
  rejects(() => c.parseRequest({ ...request(), expectedRevisions: [...expected, ...expected] }));
  rejects(() => c.parseRequest({ ...request(), payload: { execution: reference('execution'), state: 'COMPLETED' } }));
  rejects(() => c.parseRequest(request('client.quit', { principal: `principal_${uuid.replace('1234', 'abcd')}`, observed: [] })), 'UNAUTHORIZED');
});
test('digest matches independent SHA-256 material and ignores only transport correlation/command ID', async () => {
  const r = await signed();
  const material = { digestVersion: 1, protocolVersion: 1, partition: 'H', schemaVersion: 1, capabilityVersion: 1, action: r.action, clientId: r.clientId, principalId: r.principalId, projectId, expectedRevisions: expected, payload: r.payload };
  function canonical(v) { return v && typeof v === 'object' ? Array.isArray(v) ? `[${v.map(canonical)}]` : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v); }
  assert.equal(r.payloadDigest, `sha256:${createHash('sha256').update(canonical(material)).digest('hex')}`);
  assert.equal(await c.commandDigest({ ...r, correlationId: 'delivery-2', commandId: `command_${uuid.replace('1234', 'abcd')}` }), r.payloadDigest);
  assert.notEqual(await c.commandDigest({ ...r, expectedRevisions: expected.map(row => ({ ...row, revision: 4 })) }), r.payloadDigest);
  assert.notEqual(await c.commandDigest({ ...r, clientId: `client_${uuid.replace('1234', 'abcd')}` }), r.payloadDigest);
  await assert.rejects(c.verifyCommandDigest({ ...r, payloadDigest: hash }), { code: 'DIGEST_MISMATCH' });
});
test('same-ID replay preserves committed warning/in-progress/unknown outcome before stale check', async () => {
  const r = await signed();
  const outcomes = [
    { status: 'in-progress', operationId: ident('operation') },
    { status: 'outcome-unknown', operationId: ident('operation'), recoveryRequired: true },
    { status: 'committed', value: { projectId }, warnings: [{ code: 'PROJECTION_FAILED', repairOperationId: ident('operation') }] },
  ];
  for (const result of outcomes) {
    const outcome = { ...result, commandId: r.commandId, currentRevisions: expected };
    const recorded = { commandId: r.commandId, payloadDigest: r.payloadDigest, outcome };
    const replay = await c.classifyCommand(r, recorded, []);
    assert.equal(replay.kind, 'replay');
    assert.equal(c.canonicalJson(replay.outcome), c.canonicalJson(outcome));
    const changed = { ...r, expectedRevisions: expected.map(row => ({ ...row, revision: 99 })) };
    changed.payloadDigest = await c.commandDigest(changed);
    await assert.rejects(c.classifyCommand(changed, recorded, []), { code: 'COMMAND_ID_CONFLICT' });
  }
  assert.deepEqual(await c.classifyCommand(r, null, expected), { kind: 'new' });
  await assert.rejects(c.classifyCommand(r, null, []), { code: 'STALE_REVISION' });
});
test('operation journal exposes ambiguity and requires verification to assert an external outcome', () => {
  const base = { version: 1, operationId: ident('operation'), commandId: ident('command'), projectId, revision: 1, updatedAt: '2026-09-09T00:00:00.000Z', intentDigest: hash };
  for (const detail of [{ phase: 'intended' }, { phase: 'dispatched-outcome-unknown', recoveryRequired: true }, { phase: 'verified-completed', verificationDigest: hash }, { phase: 'verified-not-applied', verificationDigest: hash }]) assert.equal(c.operationEnvelope.parse({ ...base, ...detail }).phase, detail.phase);
  for (const detail of [{ phase: 'failed' }, { phase: 'verified-completed' }, { phase: 'dispatched-outcome-unknown', recoveryRequired: false }, { phase: 'intended', verificationDigest: hash }]) rejects(() => c.operationEnvelope.parse({ ...base, ...detail }));
});
test('snapshot/event replay has explicit archive response, contiguous bounded pages and project checks', () => {
  const event = { version: 1, eventId: ident('event'), projectId, sequence: 5, occurredAt: '2026-09-09T00:00:00.000Z', commandId: ident('command'), revision: 3, type: 'command.committed', payloadVersion: 1, payload: {} };
  const page = { status: 'page', projectId, after: 4, watermark: 6, events: [event], next: 5, hasMore: true };
  assert.equal(c.parseEventPage(page).next, 5);
  assert.equal(c.parseEventPage({ status: 'resnapshot-required', projectId, earliestAvailable: 10 }).status, 'resnapshot-required');
  for (const patch of [{ next: 6 }, { after: 3 }, { watermark: 4 }, { hasMore: false }, { events: [event, event] }]) rejects(() => c.parseEventPage({ ...page, ...patch }));
  rejects(() => c.parseEventPage({ ...page, events: [{ ...event, projectId: `project_${uuid.replace('1234', 'abcd')}` }] }));
  rejects(() => c.eventEnvelope.parse({ ...event, version: 2 }));
});
test('contracts compile independently and catalog has roadmap owners and explicit client boundaries', () => {
  const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'packages/contracts/tsconfig.json', '--noEmit'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const roadmap = fs.readFileSync('MASTER_ROADMAP.md', 'utf8');
  for (const [action, entry] of Object.entries(c.catalog)) {
    assert.ok(roadmap.includes(`## ${entry.owner} —`), action);
    assert.ok(roadmap.includes(`## ${entry.payloadProducer} —`), action);
    assert.equal(entry.implemented, false);
    assert.equal(entry.partition, 'H');
    assert.equal(typeof entry.payload.parse, 'function');
    rejects(() => entry.payload.parse({ injectedState: 'COMPLETED' }));
  }
  for (const binding of c.clientBindings) for (const action of binding.invokes) assert.ok(c.catalog[action]);
  for (const required of ['settings.correctHeldRole', 'project.reopen', 'client.quit', 'renewal.drain', 'renewal.execute', 'repair.admit', 'lifecycle.transfer', 'portable.replaceInspected']) assert.ok(c.catalog[required]);
});

test('handshake advertises independent supported versions and rejects reserved or forged operations', () => {
  const handshake = { protocolVersion: 1, partitions: Object.fromEntries(Object.entries(c.partitions).map(([key, value]) => [key, { schemaVersion: value.schemaVersion, capabilityVersion: value.capabilityVersion, implementedOperations: [] }])) };
  assert.equal(c.parseHandshake(handshake).partitions.U.schemaVersion, null);
  for (const key of ['H', 'I', 'U', 'L']) {
    const bad = structuredClone(handshake); bad.partitions[key].schemaVersion = 99;
    rejects(() => c.parseHandshake(bad), 'INCOMPATIBLE_VERSION');
  }
  for (const [key, action] of [['U', 'update.install'], ['L', 'release.sign'], ['H', 'renewal.drain'], ['H', 'not.present']]) {
    const bad = structuredClone(handshake); bad.partitions[key].implementedOperations = [action];
    rejects(() => c.parseHandshake(bad), 'FEATURE_UNAVAILABLE');
  }
});
test('response binding rejects mismatched action, correlation, command identity and query/command outcome', () => {
  const r = request();
  const response = { protocolVersion: 1, partition: 'H', schemaVersion: 1, correlationId: r.correlationId, action: r.action, result: { status: 'committed', commandId: r.commandId, currentRevisions: expected, value: null, warnings: [] } };
  assert.equal(c.parseResponse(response, r).result.status, 'committed');
  for (const patch of [{ action: 'project.resume' }, { correlationId: 'different' }, { result: { status: 'query', watermark: 0, value: null } }]) rejects(() => c.parseResponse({ ...response, ...patch }, r));
});

test('every H action has a valid JSON round trip fixture, with internal operations inaccessible to clients', () => {
  const fixtures = new Map();
  const group = (names, payload) => { for (const name of names.split(' ')) { assert.ok(!fixtures.has(name), name); fixtures.set(name, payload); } };
  const exec = { execution: reference('execution') };
  const op = { operation: reference('operation') };
  const proposal = { proposal: reference('proposal'), digest: hash };
  const document = { revision: 1, digest: hash, text: 'An unapproved document proposal.' };
  group('core.start core.status core.stop protocol.handshake capability.query project.status settings.query settings.defaults.query trust.query usage.query power.query diagnostics.retention lifecycle.sponsored recovery.status', {});
  group('snapshot.query approval.query decisions.query diagnostics.query portable.conflicts', { after: 0, limit: 10 });
  group('command.outcome', { commandId: ident('command') });
  group('events.query', { after: 0, limit: 10 });
  group('project.create project.adopt', { sourceRoot: '/example/source', name: 'Example' });
  group('project.gitInit', { binding: reference('binding'), branch: 'main' });
  group('project.start project.pause project.resume project.stop specification.query interview.begin interview.abandon interview.restart interview.status roadmap.query renewal.drain results.query deferred.query execution.query holds.query', exec);
  group('task.cancel worker.status task.query', { task: reference('task') });
  group('project.reopen', { parent: reference('execution'), baseline: 'accepted-result', confirmSourceDivergence: false });
  group('specification.propose roadmap.propose', { ...exec, document });
  group('interview.answer', { ...op, answer: 'Keep the source files unchanged.' });
  group('interview.cancel validation.status validation.cancel master.status master.cancel portable.repair', op);
  group('roadmap.generate', { specification: reference('specification') });
  group('mutation.preview maintenance.run', proposal);
  group('mutation.propose', { roadmap: reference('roadmap'), document, reason: 'Requirement change' });
  group('approval.approve', { approval: reference('approval'), proposalDigest: hash });
  group('approval.deny', { approval: reference('approval'), proposalDigest: hash, reason: 'Needs correction' });
  group('settings.update settings.defaults.update', { changes: [{ key: 'autoResume', value: false }] });
  group('settings.clearOverride', { keys: ['autoResume'] });
  group('settings.effective', { snapshot: reference('snapshot') });
  group('settings.correction.preview', { ...op, changes: [{ key: 'timeout', value: 60 }] });
  group('settings.correctHeldRole', { ...op, candidate: reference('candidate'), candidateDigest: hash, proposal: reference('proposal'), proposalDigest: hash, approval: reference('approval') });
  group('decision.record', { text: 'Preserve source work', source: 'user', scope: 'project' });
  group('decision.supersede', { previous: reference('decision'), text: 'New constraint', reason: 'Explicit correction' });
  group('trust.grant', { ...proposal, approval: reference('approval') });
  group('trust.revoke secretReference.revoke', { grant: reference('grant') });
  group('secretReference.authorize', { reference: 'keychain:example', ...op, approval: reference('approval') });
  group('worker.retry', { task: reference('task'), strategy: reference('proposal'), digest: hash });
  group('validation.retry', { ...op, remediation: reference('proposal'), digest: hash });
  group('renewal.status', { renewal: reference('renewal') });
  group('renewal.execute', { renewal: reference('renewal'), candidate: reference('candidate') });
  group('repair.status', { repair: reference('repair') });
  group('repair.propose', { repair: reference('repair'), document });
  group('repair.admit', { repair: reference('repair'), approval: reference('approval'), digest: hash });
  group('results.diff', { candidate: reference('candidate'), after: 0 });
  group('results.export', { ...exec, destination: '/example/new-export' });
  group('master.request', { ...exec, text: 'Explain current progress' });
  group('deferred.set', { target: reference('task'), action: 'pause' });
  group('deferred.cancel', { control: reference('deferred') });
  group('diagnostics.export', { destination: '/example/new-diagnostics' });
  group('diagnostics.deleteOptional', { inspectedSnapshot: reference('snapshot'), digest: hash });
  group('history.purge', { inspectedSnapshot: reference('snapshot'), digest: hash, approval: reference('approval') });
  group('identity.inspect', { sourceRoot: '/example/source' });
  group('identity.relink', { binding: reference('binding'), destination: '/example/moved', inspectedDigest: hash });
  group('identity.copyAsNew', { sourceRoot: '/example/copy', name: 'Copy', inspectedDigest: hash });
  group('portable.importProposal', { projection: reference('projection'), inspectedDigest: hash });
  group('portable.exportNew', { projection: reference('projection'), destination: '/example/new-projection' });
  group('portable.replaceInspected', { projection: reference('projection'), inspectedDigest: hash, approval: reference('approval') });
  group('lifecycle.transfer', { ...exec, principal: ident('principal') });
  group('lifecycle.background', { ...exec, value: 'pause' });
  group('client.quit', { principal: ident('principal'), observed: [{ execution: reference('execution'), revision: 3 }] });
  group('phase.query report.query', { phase: reference('phase') });
  group('attempt.query', { attempt: reference('attempt') });
  group('recovery.reconcile', { ...op, ...proposal });
  assert.deepEqual([...fixtures.keys()].sort(), Object.keys(c.catalog).sort());
  for (const [name, payload] of fixtures) {
    const entry = c.catalog[name];
    assert.equal(c.canonicalJson(entry.payload.parse(payload)), c.canonicalJson(payload), name);
    const value = c.decodeMessage(c.canonicalJson(request(name, payload)));
    if (entry.kind === 'internal') rejects(() => c.parseRequest(value), 'UNAUTHORIZED');
    else { assert.equal(c.parseRequest(value).action, name); rejects(() => c.requireImplemented(c.parseRequest(value)), 'FEATURE_UNAVAILABLE'); }
  }
});

test('revision set order is digest-neutral; distinct command IDs never imply a recorded replay', async () => {
  const r = request();
  r.expectedRevisions = [...expected, { target: reference('task'), revision: 1 }];
  r.payloadDigest = await c.commandDigest(r);
  assert.equal(await c.commandDigest({ ...r, expectedRevisions: [...r.expectedRevisions].reverse() }), r.payloadDigest);
  const next = { ...r, commandId: `command_${uuid.replace('1234', 'abcd')}` };
  assert.deepEqual(await c.classifyCommand(next, null, r.expectedRevisions), { kind: 'new' });
});
test('planner callback can explicitly lack a task attempt; worker-shaped callbacks retain scope', () => {
  const fence = { projectId, execution: reference('execution'), attempt: null, run: reference('roleRun'), leaseGeneration: 1, expectedRevisions: expected };
  assert.equal(c.callbackFence.parse(fence).attempt, null);
  assert.equal(c.callbackFence.parse({ ...fence, attempt: reference('attempt') }).attempt.id, ident('attempt'));
  rejects(() => c.callbackFence.parse({ ...fence, attempt: undefined }));
});
