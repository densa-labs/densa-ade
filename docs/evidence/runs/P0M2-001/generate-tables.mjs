import fs from 'node:fs';
import { transitionPairs, transitionRules, roleResultTable } from '../../../../dist/contracts/src/index.js';

const root = new URL('./', import.meta.url);
const pairwise = Object.fromEntries(['project', 'phase', 'task'].map(entity => [entity, transitionPairs(entity)]));
for (const [name, value] of Object.entries({ pairwise, 'transition-rules': transitionRules, 'role-results': roleResultTable })) {
  fs.writeFileSync(new URL(`${name}.json`, root), JSON.stringify(value, null, 2) + '\n');
}
console.log(JSON.stringify({ pairs: Object.values(pairwise).reduce((n, pairs) => n + pairs.length, 0), rules: transitionRules.length, roleResultCells: Object.values(roleResultTable).reduce((n, row) => n + Object.keys(row).length, 0) }));
