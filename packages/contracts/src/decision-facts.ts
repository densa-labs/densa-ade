import { fail, json } from './schema.js';

/** Required boolean facts never treat absent, string or numeric values as evidence. */
export function requireBooleanFacts(value: unknown, names: readonly string[]): void {
  const safe = json(value);
  if (safe === null || typeof safe !== 'object' || Array.isArray(safe)) fail();
  for (const name of names) if (typeof safe[name] !== 'boolean') fail();
}
