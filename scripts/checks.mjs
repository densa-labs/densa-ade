import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createHash } from 'node:crypto';

export const layers = { contracts: [], core: ['contracts'], adapters: ['contracts'], clients: ['contracts'] };
export function filesUnder(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unsupported symlink in checked tree: ${target}`);
    return entry.isDirectory() ? filesUnder(target) : [target];
  }).sort();
}
export function checkArchitecture(root) {
  const errors = [];
  const packages = path.join(root, 'packages');
  for (const entry of fs.readdirSync(packages, { withFileTypes: true })) {
    const layer = entry.name;
    if (!entry.isDirectory() || !Object.hasOwn(layers, layer)) {
      errors.push(`Unclassified package: ${layer}`); continue;
    }
    const directory = path.join(packages, layer);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    const dependencies = { ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies, ...manifest.devDependencies };
    function checkDependency(specifier, location) {
      if (/vscode|code-oss|electron/i.test(specifier)) errors.push(`${location}: editor dependency forbidden: ${specifier}`);
      if (specifier.startsWith('@densa/') && !layers[layer].includes(specifier.slice(7))) errors.push(`${location}: forbidden layer dependency ${specifier}`);
    }
    if (manifest.name !== `@densa/${layer}`) errors.push(`${layer}: package identity mismatch`);
    for (const name of Object.keys(dependencies)) checkDependency(name, layer);
    for (const file of filesUnder(path.join(directory, 'src'))) {
      if (!/\.(?:[cm]?[jt]s|[jt]sx)$/.test(file)) { errors.push(`Unclassified source: ${file}`); continue; }
      const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      function specifier(node) {
        const location = path.relative(root, file);
        if (!node || !(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
          errors.push(`${location}: computed module loading is not statically checkable`); return;
        }
        const name = node.text;
        checkDependency(name, location);
        if (name.startsWith('.')) {
          const resolved = path.resolve(path.dirname(file), name);
          if (!resolved.startsWith(path.join(directory, 'src') + path.sep)) errors.push(`${location}: relative import leaves its source boundary: ${name}`);
        } else if (name.startsWith('node:')) {
          if (layer === 'contracts') errors.push(`${location}: contracts cannot import Node runtime modules`);
          if (name === 'node:module') errors.push(`${location}: alternate module loaders require an explicit architecture review`);
        } else if (!Object.hasOwn(dependencies, name)) {
          errors.push(`${location}: undeclared or non-public import: ${name}`);
        }
      }
      function visit(node) {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) specifier(node.moduleSpecifier);
        if (ts.isImportTypeNode(node)) specifier(node.argument.literal);
        if (ts.isExternalModuleReference(node)) specifier(node.expression);
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) specifier(node.arguments[0]);
        if (ts.isIdentifier(node) && ['eval', 'createRequire'].includes(node.text)) errors.push(`${path.relative(root, file)}: alternate code/module loading requires architecture review`);
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  for (const layer of Object.keys(layers)) if (!fs.existsSync(path.join(packages, layer, 'src/index.ts'))) errors.push(`Missing layer entry: ${layer}`);
  return errors;
}
function slug(text) { return text.toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/\s/g, '-'); }
export function checkLinks(root, documents) {
  const errors = [];
  for (const file of documents) {
    const body = fs.readFileSync(file, 'utf8').replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
    const targets = [...body.matchAll(/!?\[[^\]\n]*\]\((<[^>]+>|[^)]+)\)/g)].map(match => match[1]);
    const definitions = new Map([...body.matchAll(/^\[([^\]]+)\]:\s*(\S+)/gm)].map(match => [match[1].toLowerCase(), match[2]]));
    targets.push(...definitions.values());
    for (const match of body.matchAll(/!?\[([^\]\n]+)\]\[([^\]\n]*)\]/g)) {
      if (!definitions.has((match[2] || match[1]).toLowerCase())) errors.push(`${file}: undefined reference ${match[2] || match[1]}`);
    }
    for (let target of targets) {
      target = target.trim().replace(/^<([^>]+)>.*$/, '$1').replace(/\s+"[^"]*"$/, '');
      if (/^(?:https?:|mailto:)/.test(target)) continue;
      try {
        const [relative, fragment] = target.split('#');
        const destination = relative ? path.resolve(path.dirname(file), decodeURIComponent(relative)) : file;
        if (!destination.startsWith(path.resolve(root) + path.sep)) throw new Error('link leaves repository');
        if (!fs.existsSync(destination)) throw new Error('missing local target');
        if (fragment && destination.endsWith('.md')) {
          const headings = [...fs.readFileSync(destination, 'utf8').matchAll(/^#{1,6}\s+(.+)$/gm)].map(match => slug(match[1]));
          if (!headings.includes(decodeURIComponent(fragment))) throw new Error('missing heading');
        }
      } catch (error) { errors.push(`${path.relative(root, file)}: ${target}: ${error.message}`); }
    }
  }
  return errors;
}
export function roadmapCatalog(text) {
  const contracts = [...text.matchAll(/^### (R\d[a-z]?) — (.+)$/gm)].map(match => ({ id: match[1], title: match[2] }));
  const milestones = [...text.matchAll(/^## (P\d+M\d+) — ([^\n]+)\n([\s\S]*?)(?=^## |^# |$(?![\s\S]))/gm)].map(match => ({
    id: match[1], title: match[2], prerequisites: [...new Set((match[3].match(/^- \*\*Prerequisites:\*\* (.+)$/m)?.[1] ?? '').match(/P\d+M\d+/g) ?? [])],
  }));
  function table(section) {
    const body = text.split(section)[1]?.split(/\n#{1,3} /)[0] ?? '';
    return body.split('\n').filter(line => line.startsWith('| ') && !line.startsWith('| ---')).slice(1).map(line => line.split('|').slice(1, -1).map(value => value.trim()));
  }
  return { contracts, milestones, ownership: table('# Requirement ownership and diagnostic resolution'), staged: table('### R9 — Staging and audit gates') };
}
export function checkLedger(root) {
  const ledger = JSON.parse(fs.readFileSync(path.join(root, 'docs/evidence/ledger.json'), 'utf8'));
  const catalog = roadmapCatalog(fs.readFileSync(path.join(root, 'MASTER_ROADMAP.md'), 'utf8'));
  const errors = [];
  const roadmapHash = createHash('sha256').update(fs.readFileSync(path.join(root, 'MASTER_ROADMAP.md'))).digest('hex');
  if (ledger.roadmapSha256 !== roadmapHash) errors.push('Ledger roadmap hash is stale');
  for (const key of ['milestones', 'ownership', 'staged']) if (JSON.stringify(ledger[key]) !== JSON.stringify(catalog[key])) errors.push(`Ledger ${key} differs from authoritative roadmap`);
  if (JSON.stringify(ledger.contracts.map(({ id, title }) => ({ id, title }))) !== JSON.stringify(catalog.contracts)) errors.push('Ledger must cover every R contract and subcontract');
  for (const row of ledger.contracts) if (!row.implementationOwners?.length || !row.verificationOwners?.length || row.status !== 'PENDING' || !row.currentClaim) errors.push(`Incomplete or premature contract claim: ${row.id}`);
  const earlier = new Set();
  for (const row of ledger.milestones) {
    for (const prerequisite of row.prerequisites) if (!earlier.has(prerequisite)) errors.push(`${row.id}: missing or later prerequisite ${prerequisite}`);
    earlier.add(row.id);
  }
  if (!ledger.impactAssessments?.length) errors.push('Missing R7a assessment');
  for (const assessment of ledger.impactAssessments ?? []) {
    for (const field of ['id', 'milestone', 'stage', 'changes', 'dependencyEdges', 'behaviorEdges', 'noImpact', 'staleEvidence', 'replacementEvidence', 'pendingGates', 'transitiveAffectedMilestones']) {
      if (assessment[field] === undefined) errors.push(`Impact assessment missing ${field}`);
    }
  }
  for (const assessment of ledger.impactAssessments ?? []) {
    if (!assessment.changes?.length || !assessment.dependencyEdges?.length || !assessment.behaviorEdges?.length || !assessment.noImpact?.length || !assessment.pendingGates?.length) errors.push('Empty R7a impact assessment');
  }
  return errors;
}
export function documentationFiles(root) {
  return ['README.md', 'LICENSE.md', 'AGENTS.md', 'MASTER_ROADMAP.md', 'MODEL_POLICY.md'].map(file => path.join(root, file)).concat(filesUnder(path.join(root, 'docs')).filter(file => file.endsWith('.md')));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const checks = { architecture: () => checkArchitecture(root), links: () => checkLinks(root, documentationFiles(root)), ledger: () => checkLedger(root) };
  const names = process.argv[2] ? [process.argv[2]] : Object.keys(checks);
  for (const name of names) {
    if (!checks[name]) throw new Error(`Unknown check: ${name}`);
    const errors = checks[name]();
    for (const error of errors) console.error(error);
    console.log(`${name}: ${errors.length ? 'FAIL' : 'PASS'}`);
    if (errors.length) process.exitCode = 1;
  }
}
