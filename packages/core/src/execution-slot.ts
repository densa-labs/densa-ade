import type { DensaAdeDatabase } from "./persistence/database.js";

const slots = new Map<string | object, Set<string>>();

/** Reserve before the first await, including across separate connections in the owning Core. */
export function claimExecutionSlot(
  database: DensaAdeDatabase,
  kind: "task" | "phase" | "project",
): (() => void) | undefined {
  const identity = database.executionIdentity;
  const active = slots.get(identity) ?? new Set<string>();
  if (active.has(kind)) return undefined;
  active.add(kind);
  slots.set(identity, active);
  return () => {
    active.delete(kind);
    if (active.size === 0) slots.delete(identity);
  };
}
