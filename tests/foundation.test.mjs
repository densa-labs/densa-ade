import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { checkArchitecture, checkLinks, checkLedger, documentationFiles, layers } from '../scripts/checks.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'densa-p0m0-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of Object.keys(layers)) {
    fs.mkdirSync(path.join(root, 'packages', name, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'packages', name, 'package.json'), JSON.stringify({ name: `@densa/${name}`, dependencies: name === 'contracts' ? {} : { '@densa/contracts': '0.0.0' } }));
    fs.writeFileSync(path.join(root, 'packages', name, 'src/index.ts'), 'export {};\n');
  }
  return root;
}
function source(root, layer, text) { fs.writeFileSync(path.join(root, 'packages', layer, 'src/index.ts'), text); }
test('current repository boundaries, documents and authoritative ledger agree', () => {
  const root = process.cwd();
  assert.deepEqual(checkArchitecture(root), []);
  assert.deepEqual(checkLinks(root, documentationFiles(root)), []);
  assert.deepEqual(checkLedger(root), []);
});
test('neutral contract imports work while inward and editor imports fail', t => {
  const root = fixture(t);
  source(root, 'core', 'import type { A } from "@densa/contracts";');
  assert.deepEqual(checkArchitecture(root), []);
  for (const text of ['import "vscode";', 'export * from "@densa/clients";', 'type T = import("@densa/adapters").T;', 'import "../../../clients/src/index.js";', 'import "@densa/contracts/private";', 'const x = require("electron");', 'import("code-oss");', 'import(someModule);', 'import fs = require("vscode");']) {
    source(root, 'core', text);
    assert.notEqual(checkArchitecture(root).length, 0, text);
  }
});
test('contracts reject platform modules and dependency declarations cannot hide forbidden edges', t => {
  const root = fixture(t);
  source(root, 'contracts', 'import "node:fs";');
  assert.match(checkArchitecture(root).join('\n'), /contracts cannot import Node/);
  source(root, 'contracts', 'export {};');
  fs.writeFileSync(path.join(root, 'packages/core/package.json'), JSON.stringify({ name: '@densa/core', dependencies: { '@densa/clients': '0.0.0' } }));
  assert.match(checkArchitecture(root).join('\n'), /forbidden layer/);
});
test('unknown packages and source symlinks are not silently skipped', t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'packages/mystery'));
  assert.match(checkArchitecture(root).join('\n'), /Unclassified package/);
  fs.symlinkSync(os.tmpdir(), path.join(root, 'packages/core/src/escape'));
  assert.throws(() => checkArchitecture(root), /Unsupported symlink/);
});
test('local links resolve relative to docs and reject missing paths, headings and references', t => {
  const root = fixture(t);
  const doc = path.join(root, 'README.md');
  fs.writeFileSync(path.join(root, 'detail.md'), '# Existing heading\n');
  fs.writeFileSync(doc, '[ok](detail.md#existing-heading)\n[reference][valid]\n[valid]: detail.md\n');
  assert.deepEqual(checkLinks(root, [doc]), []);
  for (const text of ['[missing](absent.md)', '[heading](detail.md#absent)', '[broken][unknown]', '[escape](../outside.md)']) {
    fs.writeFileSync(doc, text);
    assert.notEqual(checkLinks(root, [doc]).length, 0, text);
  }
});
test('ledger rejects lost contracts, stale ownership, absent impact and later prerequisites', t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'docs/evidence'), { recursive: true });
  fs.copyFileSync('MASTER_ROADMAP.md', path.join(root, 'MASTER_ROADMAP.md'));
  const original = JSON.parse(fs.readFileSync('docs/evidence/ledger.json'));
  for (const mutate of [value => value.roadmapSha256 = 'stale', value => value.contracts.pop(), value => value.ownership.pop(), value => value.impactAssessments = [], value => value.milestones[0].prerequisites.push('P16M5')]) {
    const value = structuredClone(original); mutate(value);
    fs.writeFileSync(path.join(root, 'docs/evidence/ledger.json'), JSON.stringify(value));
    assert.notEqual(checkLedger(root).length, 0);
  }
});
test('wrong npm configuration stops with actionable setup diagnostic (injected environment)', () => {
  const result = spawnSync(process.execPath, ['scripts/toolchain.mjs'], { encoding: 'utf8', env: { ...process.env, npm_config_user_agent: 'npm/0.0.0 node/v24.14.0' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SETUP_REQUIRED.*npm 11.9.0/);
});
test('normal architecture CLI returns failure for forbidden imports', t => {
  const root = fixture(t);
  source(root, 'core', 'import "vscode";');
  const result = spawnSync(process.execPath, [path.resolve('scripts/checks.mjs'), 'architecture'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /editor dependency forbidden/);
});
test('strict TypeScript build rejects an invalid assignment in a disposable workspace', t => {
  const root = fixture(t);
  fs.copyFileSync('tsconfig.json', path.join(root, 'tsconfig.json'));
  source(root, 'core', 'export const invalid: string = 7;');
  const result = spawnSync(process.execPath, [path.resolve('node_modules/typescript/bin/tsc'), '-p', path.join(root, 'tsconfig.json'), '--noEmit'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /not assignable to type 'string'/);
});
