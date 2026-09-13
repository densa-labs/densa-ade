import { enumeration, fail, id, integer, type Id } from './schema.js';
import { requireBooleanFacts } from './decision-facts.js';

export const implementationAttemptLimit = 4;
export type DispatchStatus = 'reserved' | 'dispatched' | 'dispatch-unknown' | 'terminated' | 'verified-never-dispatched';
export interface AttemptSlot { readonly attemptId: Id<'attempt'>; readonly status: DispatchStatus }
export interface AttemptBudget { readonly slots: readonly AttemptSlot[] }
export type AttemptAction =
  | { type: 'reserve'; attemptId: Id<'attempt'> }
  | { type: 'dispatch' | 'dispatch-unknown'; attemptId: Id<'attempt'>; intentRecorded: boolean }
  | { type: 'verify-never-dispatched'; attemptId: Id<'attempt'>; nonDispatchProven: boolean; noLiveWriter: boolean }
  | { type: 'terminate'; attemptId: Id<'attempt'>; terminationProven: boolean };
export function inspectAttemptBudget(budget: AttemptBudget) {
  const ids = new Set<string>();
  for (const slot of budget.slots) {
    id('attempt').parse(slot.attemptId);
    if (ids.has(slot.attemptId)) fail(); ids.add(slot.attemptId);
    enumeration(['reserved', 'dispatched', 'dispatch-unknown', 'terminated', 'verified-never-dispatched']).parse(slot.status);
  }
  const used = budget.slots.filter(s => s.status !== 'verified-never-dispatched').length;
  if (used > implementationAttemptLimit || budget.slots.filter(s => ['reserved', 'dispatched', 'dispatch-unknown'].includes(s.status)).length > 1) fail();
  return { used, available: implementationAttemptLimit - used, dispatched: budget.slots.filter(s => ['dispatched', 'dispatch-unknown', 'terminated'].includes(s.status)).length, pending: budget.slots.some(s => ['reserved', 'dispatched', 'dispatch-unknown'].includes(s.status)) };
}
/** Reservation is proposed before launch. P1M1 must persist it atomically with intent. */
export function proposeAttempt(budget: AttemptBudget, action: AttemptAction): AttemptBudget {
  const info = inspectAttemptBudget(budget); id('attempt').parse(action.attemptId);
  const old = budget.slots.find(s => s.attemptId === action.attemptId);
  if (action.type === 'reserve') {
    if (old) { if (old.status === 'reserved') return budget; fail('INVALID_TRANSITION'); }
    if (!info.available) fail('RETRY_EXHAUSTED');
    if (info.pending) fail('RECOVERY_REQUIRED');
    return { slots: [...budget.slots, { attemptId: action.attemptId, status: 'reserved' }] };
  }
  if (!old) fail('NOT_FOUND');
  let status: DispatchStatus;
  switch (action.type) {
    case 'dispatch': case 'dispatch-unknown':
      requireBooleanFacts(action, ['intentRecorded']);
      if (!action.intentRecorded) fail('INVALID_TRANSITION');
      status = action.type === 'dispatch' ? 'dispatched' : 'dispatch-unknown';
      if (old.status === status) return budget;
      if (old.status !== 'reserved' && !(old.status === 'dispatch-unknown' && status === 'dispatched')) fail('INVALID_TRANSITION');
      break;
    case 'verify-never-dispatched':
      requireBooleanFacts(action, ['nonDispatchProven', 'noLiveWriter']);
      if (!action.nonDispatchProven || !action.noLiveWriter) fail('RECOVERY_REQUIRED');
      if (!['reserved', 'dispatch-unknown', 'verified-never-dispatched'].includes(old.status)) fail('INVALID_TRANSITION');
      status = 'verified-never-dispatched'; break;
    case 'terminate':
      requireBooleanFacts(action, ['terminationProven']);
      if (!action.terminationProven) fail('RECOVERY_REQUIRED');
      if (!['dispatched', 'dispatch-unknown', 'terminated'].includes(old.status)) fail('INVALID_TRANSITION');
      status = 'terminated'; break;
    default: return fail();
  }
  return { slots: budget.slots.map(s => s.attemptId === action.attemptId ? { ...s, status } : s) };
}
export function decideWorkerRetry(f: { budget: AttemptBudget; terminationProven: boolean; settlementReconciled: boolean; checkpointRestored: boolean; diagnosticsRetained: boolean; revisedStrategy: boolean; pendingIntentRecorded: boolean; holds: readonly string[] }) {
  requireBooleanFacts(f, ['terminationProven', 'settlementReconciled', 'checkpointRestored', 'diagnosticsRetained', 'revisedStrategy', 'pendingIntentRecorded']);
  const budget = inspectAttemptBudget(f.budget);
  if (!f.terminationProven || !f.settlementReconciled || budget.pending) return { action: 'reconcile' as const, consumesAttempt: false };
  if (f.holds.length) return { action: 'held' as const, consumesAttempt: false };
  if (!budget.available || !f.diagnosticsRetained || !f.revisedStrategy) return { action: 'block' as const, consumesAttempt: false };
  if (!f.pendingIntentRecorded) return { action: 'record-retry-intent' as const, consumesAttempt: false };
  return { action: f.checkpointRestored ? 'ready-for-new-reservation' as const : 'reset-original-checkpoint' as const, consumesAttempt: false };
}

export const roleCallLimit = 3;
export const roleBackoffSeconds = [30, 120] as const;
export interface RoleBudget { readonly calls: number; readonly schemaRepairs: number }
export function inspectRoleBudget(budget: RoleBudget): void {
  integer.parse(budget.calls); integer.parse(budget.schemaRepairs);
  if (budget.calls > roleCallLimit || budget.schemaRepairs > 1 || budget.schemaRepairs > budget.calls) fail();
}
export function proposeRoleCall(budget: RoleBudget, f: { repair: boolean; previousCallTerminated: boolean; authorized: boolean; backoffElapsed: boolean; holdsClear: boolean }): RoleBudget {
  requireBooleanFacts(f, ['repair', 'previousCallTerminated', 'authorized', 'backoffElapsed', 'holdsClear']);
  inspectRoleBudget(budget);
  if (!f.previousCallTerminated) fail('RECOVERY_REQUIRED');
  if (!f.authorized || !f.holdsClear || (budget.calls > 0 && !f.backoffElapsed)) fail('INVALID_TRANSITION');
  if (budget.calls >= roleCallLimit || (f.repair && budget.schemaRepairs >= 1)) fail('RETRY_EXHAUSTED');
  if (f.repair && budget.calls === 0) fail('INVALID_TRANSITION');
  return { calls: budget.calls + 1, schemaRepairs: budget.schemaRepairs + Number(f.repair) };
}
