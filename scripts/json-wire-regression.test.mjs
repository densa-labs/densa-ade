import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  PROTOCOL_VERSION,
  deserializeProtocolEnvelope,
  jsonObjectSchema,
  jsonValueSchema,
  masterAgentProposalOutputSchema,
  serializeProtocolEnvelope,
} from "../packages/protocol/dist/index.js";

test("JSON wire objects preserve reserved-looking data keys without changing prototypes", () => {
  const payload = JSON.parse(
    '{"__proto__":{"auditValue":1},"constructor":{"prototype":{"auditValue":2}},"nested":[{"__proto__":null}]}',
  );
  for (const schema of [jsonObjectSchema, jsonValueSchema]) {
    const parsed = schema.parse(payload);
    assert.deepEqual(parsed, payload);
    assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
    assert.equal(Object.getPrototypeOf(parsed.nested[0]), Object.prototype);
    assert.equal(Object.hasOwn(parsed, "__proto__"), true);
    assert.notEqual(parsed.__proto__, payload.__proto__);
    assert.notEqual(parsed.nested, payload.nested);
    parsed.__proto__.auditValue = 99;
    assert.equal(payload.__proto__.auditValue, 1);
  }
  assert.equal(Object.prototype.auditValue, undefined);

  for (const body of [
    { kind: "request", requestId: "json-request", method: "json.test", payload },
    { kind: "response", requestId: "json-response", ok: true, result: payload },
    {
      kind: "response",
      requestId: "json-error",
      ok: false,
      error: { code: "VALIDATION_FAILURE", message: "fixture", details: payload },
    },
    { kind: "notification", event: "json.test", payload },
  ]) {
    const envelope = { protocolVersion: PROTOCOL_VERSION, ...body };
    assert.deepEqual(deserializeProtocolEnvelope(serializeProtocolEnvelope(envelope)), envelope);
  }
});

test("reserved-looking keys cannot hide invalid wire values", () => {
  for (const value of [undefined, NaN, Infinity, 1n, new Date(), new (class Example {})()]) {
    const payload = Object.fromEntries([["__proto__", value]]);
    assert.equal(jsonObjectSchema.safeParse(payload).success, false);
    assert.equal(jsonValueSchema.safeParse({ nested: [payload] }).success, false);
  }
  assert.equal(jsonObjectSchema.safeParse({ [Symbol("not-json")]: 1 }).success, false);
  const nullPrototype = Object.assign(Object.create(null), { value: 1 });
  assert.deepEqual(jsonObjectSchema.parse(nullPrototype), { value: 1 });
});

test("lossless runtime parsing preserves the frozen Master provider JSON Schema", () => {
  // Fingerprint captured at audit baseline 9ce2476 before changing shared JSON validation.
  assert.equal(
    createHash("sha256").update(JSON.stringify(masterAgentProposalOutputSchema)).digest("hex"),
    "5d07207b93aa1a9c6db0ec7edbcdb069274113a53396aa64e07ccf5295d9a73e",
  );
});
