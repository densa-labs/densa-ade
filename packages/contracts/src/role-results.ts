import { enumeration, fail } from './schema.js';
import { requireBooleanFacts } from './decision-facts.js';
import { inspectRoleBudget, roleBackoffSeconds, roleCallLimit, type RoleBudget } from './attempts.js';

export const decisionRoles = ['interview', 'planner', 'scope-planner', 'worker', 'reviewer', 'command-validator', 'browser-validator', 'Master'] as const;
export type DecisionRole = typeof decisionRoles[number];
export const roleResults = ['success', 'refusal', 'malformed', 'known-timeout', 'ambiguous-termination', 'authentication', 'usage-limit', 'transient', 'exhausted', 'unsupported', 'context-overflow', 'cancelled', 'acceptance-failed', 'unknown-failure'] as const;
export type RoleResult = typeof roleResults[number];
type Mapping = 'proposal' | 'candidate' | 'observations' | 'answer' | 'user' | 'block' | 'usage' | 'retry-input' | 'retry-candidate' | 'retry-worker' | 'repair-schema' | 'recovery' | 'cancel-task' | 'cancel-request' | 'acceptance-failure' | 'invalid-signal' | 'prepare-without-optional-history';
const planning: Record<RoleResult, Mapping> = {
  success: 'proposal', refusal: 'user', malformed: 'repair-schema', 'known-timeout': 'retry-input', 'ambiguous-termination': 'recovery', authentication: 'user', 'usage-limit': 'usage', transient: 'retry-input', exhausted: 'block', unsupported: 'user', 'context-overflow': 'user', cancelled: 'user', 'acceptance-failed': 'invalid-signal', 'unknown-failure': 'block',
};
const validator: Record<RoleResult, Mapping> = { ...planning, success: 'observations', refusal: 'invalid-signal', malformed: 'block', 'known-timeout': 'retry-candidate', transient: 'retry-candidate', 'acceptance-failed': 'acceptance-failure' };
export const roleResultTable: Readonly<Record<DecisionRole, Readonly<Record<RoleResult, Mapping>>>> = Object.freeze({
  interview: Object.freeze({ ...planning }), planner: Object.freeze({ ...planning }), 'scope-planner': Object.freeze({ ...planning }),
  worker: Object.freeze({ ...planning, success: 'candidate', malformed: 'retry-worker', 'known-timeout': 'retry-worker', transient: 'retry-worker', cancelled: 'cancel-task' }),
  reviewer: Object.freeze({ ...validator, refusal: 'user', malformed: 'repair-schema' }),
  'command-validator': Object.freeze({ ...validator }), 'browser-validator': Object.freeze({ ...validator }),
  Master: Object.freeze({ ...planning, success: 'answer', cancelled: 'cancel-request' }),
});
export interface RoleResultFacts {
  role: DecisionRole; result: RoleResult; signalSource: 'provider' | 'trusted-runner';
  scope: 'planning' | 'task' | 'phase' | 'coverage' | 'optional-request';
  budget: RoleBudget; terminationProven: boolean; dispatched: boolean;
  workerRetryEligible: boolean; usageReliable: boolean; mandatoryMaterialFits: boolean;
  responseSemanticallyValid: boolean;
}
export function decideRoleResult(f: RoleResultFacts) {
  requireBooleanFacts(f, ['terminationProven', 'dispatched', 'workerRetryEligible', 'usageReliable', 'mandatoryMaterialFits', 'responseSemanticallyValid']);
  enumeration(decisionRoles).parse(f.role); enumeration(roleResults).parse(f.result);
  enumeration(['planning', 'task', 'phase', 'coverage', 'optional-request']).parse(f.scope);
  inspectRoleBudget(f.budget);
  const deterministic = f.role === 'command-validator' || f.role === 'browser-validator';
  if (f.signalSource !== (deterministic ? 'trusted-runner' : 'provider')) fail('UNAUTHORIZED');
  if ((f.role === 'Master') !== (f.scope === 'optional-request') || (f.role === 'worker' && f.scope !== 'task') || (['interview', 'planner', 'scope-planner'].includes(f.role) && f.scope !== 'planning') || ((deterministic || f.role === 'reviewer') && !['task', 'phase', 'coverage'].includes(f.scope))) fail();
  if (f.role !== 'worker' && f.dispatched && f.budget.calls === 0) fail();
  let action: Mapping = roleResultTable[f.role][f.result];
  if (action === 'invalid-signal') fail('MALFORMED_MESSAGE');
  if (f.result === 'context-overflow' && f.mandatoryMaterialFits && !f.dispatched) action = f.role !== 'worker' && f.budget.calls >= roleCallLimit ? 'block' : 'prepare-without-optional-history';
  // No repository stdout is a trusted provider signal. The later adapter owns classification.
  if ((f.dispatched || f.result === 'known-timeout') && !f.terminationProven) action = 'recovery';
  if (f.result === 'usage-limit' && !f.usageReliable && action !== 'recovery') action = 'block';
  if (f.result === 'success' && !f.dispatched) fail('INVALID_TRANSITION');
  if (f.result === 'success' && !f.responseSemanticallyValid && action !== 'recovery') action = f.role === 'worker' ? 'retry-worker' : deterministic ? 'block' : 'repair-schema';
  let delaySeconds: number | null = null;
  if (['retry-input', 'retry-candidate', 'repair-schema'].includes(action)) {
    if (f.budget.calls === 0) fail('INVALID_TRANSITION');
    if (f.budget.calls >= roleCallLimit || (action === 'repair-schema' && f.budget.schemaRepairs >= 1)) action = 'block';
    else delaySeconds = roleBackoffSeconds[f.budget.calls - 1] ?? null;
  }
  if (action === 'retry-worker' && !f.workerRetryEligible) action = 'block';
  if (action === 'acceptance-failure') action = f.scope === 'task' && f.workerRetryEligible ? 'retry-worker' : 'acceptance-failure';
  const followUp = action === 'acceptance-failure' ? f.scope === 'coverage' ? 'deduplicated-repair-proposal' : 'explicit-tracked-repair' : f.result === 'context-overflow' ? f.mandatoryMaterialFits ? 'resubmit-with-optional-history-removed' : 'compatible-configuration-or-explicit-split' : f.result === 'refusal' ? 'explicit-legitimate-correction-or-revised-request' : f.result === 'cancelled' && f.scope === 'planning' ? 'retain-draft-unless-explicit-abandon' : action === 'retry-worker' ? 'new-attempt-from-original-checkpoint' : 'none';
  return { action, scope: f.scope, delaySeconds, followUp,
    implementationAttemptsConsumed: f.role === 'worker' && f.dispatched ? 1 : 0,
    retain: f.scope === 'planning' ? 'draft' as const : f.role === 'worker' ? 'quarantined-attempt-evidence' as const : f.scope === 'optional-request' ? 'request-diagnostics' as const : 'same-candidate' as const,
    automaticModelFallback: false as const, projectHold: f.scope !== 'optional-request' && ['user', 'block', 'usage', 'recovery', 'acceptance-failure'].includes(action),
    directCompletion: false as const,
  } as const;
}
