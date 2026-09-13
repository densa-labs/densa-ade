import { array, boolean, enumeration, fail, id, object, ref, schema, type Infer, type Id } from './schema.js';
import { taskStates, executionModes, type ExecutionMode } from './lifecycle.js';
import { requireBooleanFacts } from './decision-facts.js';

const criterion = object({ id: id('criterion'), requirementId: id('requirement'), validationDeclared: boolean, validationFeasible: boolean });
const task = object({ projectId: id('project'), id: id('task'), phaseId: id('phase'), kind: enumeration(['implementation', 'qualification']), required: boolean,
  state: enumeration(taskStates), requirementIds: array(id('requirement')), criteria: array(criterion), dependencies: array(ref('task')), supersededBy: array(ref('task')) });
const graph = object({ projectId: id('project'), phases: array(object({ projectId: id('project'), id: id('phase') })), tasks: array(task), requiredRequirements: array(id('requirement')), blockingDecisionIds: array(id('decision')) });
export type PlanningGraph = Infer<typeof graph>;
export type PlannedTask = PlanningGraph['tasks'][number];
export const planningGraph = schema(value => {
  const plan = graph.parse(value);
  const errors = inspectPlanningGraph(plan);
  if (errors.length) fail('DEPENDENCY_BLOCKED');
  return plan;
});
function duplicates(values: readonly string[]): boolean { return new Set(values).size !== values.length; }
/** Graph inspection reports all bounded semantic errors; schema parsing precedes it. */
export function inspectPlanningGraph(input: PlanningGraph): string[] {
  const plan = graph.parse(input);
  const errors: string[] = [];
  if (!plan.phases.length || !plan.tasks.length || !plan.requiredRequirements.length) errors.push('empty-required-plan');
  if (duplicates(plan.phases.map(p => p.id)) || duplicates(plan.tasks.map(t => t.id)) || duplicates(plan.requiredRequirements)) errors.push('duplicate-identity');
  if (plan.blockingDecisionIds.length) errors.push('unresolved-blocking-decisions');
  const phases = new Map(plan.phases.map((p, index) => [p.id, index]));
  const tasks = new Map(plan.tasks.map(t => [t.id, t]));
  const criterionIds = new Set<string>();
  for (const t of plan.tasks) {
    if (!phases.has(t.phaseId)) errors.push(`${t.id}:unknown-phase`);
    if (!t.requirementIds.length || !t.criteria.length) errors.push(`${t.id}:empty-acceptance`);
    if (duplicates(t.requirementIds) || duplicates(t.dependencies.map(d => d.id)) || duplicates(t.supersededBy.map(d => d.id))) errors.push(`${t.id}:duplicate-reference`);
    for (const c of t.criteria) {
      if (t.state !== 'CANCELLED' && !t.supersededBy.length) {
        if (criterionIds.has(c.id)) errors.push(`${t.id}:duplicate-criterion`); criterionIds.add(c.id);
      }
      if (!t.requirementIds.includes(c.requirementId)) errors.push(`${t.id}:criterion-without-requirement`);
      if (!c.validationDeclared || !c.validationFeasible) errors.push(`${t.id}:infeasible-validation`);
    }
    for (const r of t.requirementIds) if (!t.criteria.some(c => c.requirementId === r)) errors.push(`${t.id}:requirement-without-criterion`);
    for (const d of t.dependencies) {
      const target = tasks.get(d.id);
      if (!target) errors.push(`${t.id}:missing-dependency`);
      else {
        if ((phases.get(target.phaseId) ?? Infinity) > (phases.get(t.phaseId) ?? -1)) errors.push(`${t.id}:later-phase-dependency`);
        if (target.state === 'CANCELLED' || target.supersededBy.length) errors.push(`${t.id}:dependency-needs-explicit-reconnection`);
      }
    }
    if (t.supersededBy.length && t.state !== 'CANCELLED') errors.push(`${t.id}:superseded-parent-not-cancelled`);
    for (const successor of t.supersededBy) if (!tasks.has(successor.id) || successor.id === t.id) errors.push(`${t.id}:invalid-successor`);
  }
  for (const required of plan.requiredRequirements) if (!plan.tasks.some(t => t.required && !t.supersededBy.length && t.state !== 'CANCELLED' && t.requirementIds.includes(required))) errors.push(`${required}:missing-required-coverage`);
  // Stable IDs break ties; DFS examines every node, including disconnected cycles.
  const visiting = new Set<string>(), visited = new Set<string>();
  function visit(t: PlannedTask): void {
    if (visiting.has(t.id)) { errors.push(`${t.id}:dependency-cycle`); return; }
    if (visited.has(t.id)) return;
    visiting.add(t.id);
    for (const dep of t.dependencies) { const target = tasks.get(dep.id); if (target) visit(target); }
    visiting.delete(t.id); visited.add(t.id);
  }
  for (const t of plan.tasks) visit(t);
  const lineageVisiting = new Set<string>(), lineageVisited = new Set<string>();
  function visitLineage(t: PlannedTask): void {
    if (lineageVisiting.has(t.id)) { errors.push(`${t.id}:supersession-cycle`); return; }
    if (lineageVisited.has(t.id)) return;
    lineageVisiting.add(t.id);
    for (const successor of t.supersededBy) { const target = tasks.get(successor.id); if (target) visitLineage(target); }
    lineageVisiting.delete(t.id); lineageVisited.add(t.id);
  }
  for (const t of plan.tasks) visitLineage(t);
  return [...new Set(errors)];
}

export interface ReadinessFacts {
  phaseId: Id<'phase'>; mode: ExecutionMode; taskApprovals: readonly Id<'task'>[];
  validCoverageTaskIds: readonly Id<'task'>[]; exhaustedTaskIds: readonly Id<'task'>[];
  coverageObligations: readonly { taskId: Id<'task'>; state: 'pending-renewal' | 'failed-coverage' }[];
  completedPhaseIds: readonly Id<'phase'>[]; phaseAuthorized: boolean;
  renewalRunning: boolean; implementationLeaseAvailable: boolean;
  controlsClear: boolean; identityWorkspaceValid: boolean; trustPolicyValid: boolean;
  configurationValid: boolean; decisionsResolved: boolean; validationAvailable: boolean;
  repair: null | { taskIds: readonly Id<'task'>[]; approved: boolean; namedFailedCoverageTaskIds: readonly Id<'task'>[]; baselineProvenanceVerified: boolean };
}
export function decideReadiness(input: PlanningGraph, f: ReadinessFacts) {
  requireBooleanFacts(f, ['phaseAuthorized', 'renewalRunning', 'implementationLeaseAvailable', 'controlsClear', 'identityWorkspaceValid', 'trustPolicyValid', 'configurationValid', 'decisionsResolved', 'validationAvailable']);
  if (f.repair !== null) requireBooleanFacts(f.repair, ['approved', 'baselineProvenanceVerified']);
  const plan = graph.parse(input); id('phase').parse(f.phaseId); enumeration(executionModes).parse(f.mode);
  if (!plan.phases.some(p => p.id === f.phaseId)) fail('NOT_FOUND');
  const tasks = new Map(plan.tasks.map(t => [t.id, t]));
  for (const ids of [f.taskApprovals, f.validCoverageTaskIds, f.exhaustedTaskIds, f.coverageObligations.map(o => o.taskId), f.repair?.taskIds ?? [], f.repair?.namedFailedCoverageTaskIds ?? []]) for (const value of ids) { id('task').parse(value); if (!tasks.has(value)) fail('NOT_FOUND'); }
  for (const o of f.coverageObligations) enumeration(['pending-renewal', 'failed-coverage']).parse(o.state);
  for (const phase of f.completedPhaseIds) { id('phase').parse(phase); if (!plan.phases.some(p => p.id === phase)) fail('NOT_FOUND'); }
  const earlierPhasesComplete = plan.phases.slice(0, plan.phases.findIndex(p => p.id === f.phaseId)).every(p => f.completedPhaseIds.includes(p.id));
  const globalHolds = [
    ...inspectPlanningGraph(plan).map(e => `plan:${e}`),
    ...(!f.controlsClear ? ['control-or-recovery'] : []), ...(!f.identityWorkspaceValid ? ['identity-or-workspace'] : []),
    ...(!f.trustPolicyValid ? ['trust-or-policy'] : []), ...(!f.configurationValid ? ['configuration'] : []),
    ...(!f.decisionsResolved ? ['mandatory-decision'] : []), ...(!f.validationAvailable ? ['required-validation'] : []),
    ...(!f.implementationLeaseAvailable ? ['global-implementation-lease'] : []), ...(f.renewalRunning ? ['renewal-running'] : []),
    ...(!earlierPhasesComplete ? ['prior-phase-gate'] : []), ...(!f.phaseAuthorized ? ['phase-start-not-authorized'] : []),
  ];
  const decisions = plan.tasks.filter(t => t.phaseId === f.phaseId && !['COMPLETED', 'CANCELLED'].includes(t.state)).map(t => {
    const repair = f.repair?.approved === true && f.repair.baselineProvenanceVerified && f.repair.taskIds.includes(t.id);
    const reasons = [...globalHolds];
    if (!['PENDING', 'READY'].includes(t.state)) reasons.push('task-not-pending-or-ready');
    if (f.coverageObligations.some(o => !(repair && o.state === 'failed-coverage' && f.repair?.namedFailedCoverageTaskIds.includes(o.taskId)))) reasons.push('renewal-before-ordinary-readiness');
    if (f.exhaustedTaskIds.includes(t.id) && t.kind === 'implementation') reasons.push('four-attempts-exhausted');
    if (t.supersededBy.length) reasons.push('superseded');
    if (f.mode === 'Guided' && !f.taskApprovals.includes(t.id)) reasons.push('bound-task-approval');
    for (const d of t.dependencies) {
      const dep = tasks.get(d.id);
      if (!dep || dep.state !== 'COMPLETED' || dep.supersededBy.length) reasons.push(`dependency-not-satisfied:${d.id}`);
      // Repair lineage is not a hard edge on the invalid coverage it repairs (R3b).
      else if (!f.validCoverageTaskIds.includes(d.id)) reasons.push(`dependency-coverage-stale:${d.id}`);
    }
    return { taskId: t.id, eligible: reasons.length === 0, reasons, path: t.kind === 'qualification' ? 'validation-only-renewal' as const : 'implementation-reservation' as const, approvedRepair: repair };
  }).sort((a, b) => a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0);
  return { decisions, next: decisions.find(d => d.eligible)?.taskId ?? null };
}

export const mutationClasses = ['MINOR', 'SIGNIFICANT', 'SCOPE'] as const;
export function classifyMutation(f: { suggested: typeof mutationClasses[number]; architecture: boolean; security: boolean; persistence: boolean; promiseAdded: boolean; promiseRemoved: boolean; acceptanceWeakened: boolean }) {
  requireBooleanFacts(f, ['architecture', 'security', 'persistence', 'promiseAdded', 'promiseRemoved', 'acceptanceWeakened']);
  enumeration(mutationClasses).parse(f.suggested);
  const floor = f.promiseAdded || f.promiseRemoved || f.acceptanceWeakened ? 2 : f.architecture || f.security || f.persistence ? 1 : 0;
  return mutationClasses[Math.max(mutationClasses.indexOf(f.suggested), floor)] as typeof mutationClasses[number];
}
export function decideMutation(f: { classification: typeof mutationClasses[number]; preset: 'Cautious' | 'Standard' | 'Autonomous'; significantChangesAuthorized: boolean; repairAdmission: boolean; affectedActive: boolean; writersTerminated: boolean; settlementReconciled: boolean; proposalRevisionsCurrent: boolean; approval: 'pending' | 'approved' | 'denied'; approvalBindsExactProposal: boolean; semanticGraphValid: boolean }) {
  requireBooleanFacts(f, ['significantChangesAuthorized', 'repairAdmission', 'affectedActive', 'writersTerminated', 'settlementReconciled', 'proposalRevisionsCurrent', 'approvalBindsExactProposal', 'semanticGraphValid']);
  enumeration(mutationClasses).parse(f.classification); enumeration(['Cautious', 'Standard', 'Autonomous']).parse(f.preset); enumeration(['pending', 'approved', 'denied']).parse(f.approval);
  const approvalRequired = f.repairAdmission || f.classification === 'SCOPE' || (f.classification === 'SIGNIFICANT' && !(f.preset === 'Autonomous' && f.significantChangesAuthorized));
  const action = !f.semanticGraphValid ? 'reject-invalid-plan' : !f.proposalRevisionsCurrent ? 'reconcile-and-present-fresh-proposal' : f.affectedActive || !f.writersTerminated || !f.settlementReconciled ? 'persist-proposal-and-quiesce' : f.approval === 'denied' ? 'block-denied-proposal' : approvalRequired && (f.approval !== 'approved' || !f.approvalBindsExactProposal) ? 'request-exact-approval' : 'propose-atomic-plan-rows-invalidations-decisions-event';
  return { action, approvalRequired, rewriteCompletedHistory: false, midflightContextRewrite: false } as const;
}
/** A split is accepted only with exact union preservation and an outgoing map per consumer. */
export function inspectSplit(f: { parent: PlannedTask; successors: readonly PlannedTask[]; previousConsumers: readonly PlannedTask[]; rewiredConsumers: readonly PlannedTask[]; mapping: readonly { consumerId: Id<'task'>; successorIds: readonly Id<'task'>[] }[]; quiescent: boolean; revisionApproved: boolean }) {
  requireBooleanFacts(f, ['quiescent', 'revisionApproved']);
  const errors: string[] = [];
  const parent = task.parse(f.parent), successors = f.successors.map(t => task.parse(t)), previous = f.previousConsumers.map(t => task.parse(t)), rewired = f.rewiredConsumers.map(t => task.parse(t));
  if (parent.state === 'COMPLETED') errors.push('completed-parent-is-immutable');
  if (!f.quiescent || !f.revisionApproved) errors.push('quiescence-and-approved-revision-required');
  if (!successors.length || duplicates(successors.map(t => t.id))) errors.push('missing-or-duplicate-successors');
  if ([...successors, ...previous, ...rewired].some(t => t.projectId !== parent.projectId)) errors.push('cross-project-split');
  if (successors.some(t => t.id === parent.id || t.state !== 'PENDING' || t.supersededBy.length || t.required !== parent.required || t.kind !== parent.kind || !t.criteria.length)) errors.push('invalid-new-successor');
  const eq = (a: readonly string[], b: readonly string[]) => JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());
  if (!eq(parent.requirementIds, successors.flatMap(t => t.requirementIds))) errors.push('requirement-union-changed');
  const signature = (c: PlannedTask['criteria'][number]) => JSON.stringify([c.id, c.requirementId, c.validationDeclared, c.validationFeasible]);
  if (!eq(parent.criteria.map(signature), successors.flatMap(t => t.criteria.map(signature)))) errors.push('criterion-union-or-semantics-changed');
  const successorIds = successors.map(t => t.id);
  if (successors.some(t => t.dependencies.some(d => d.id === parent.id))) errors.push('successor-depends-on-unsatisfied-parent');
  function reaches(start: Id<'task'>, target: Id<'task'>, seen = new Set<string>()): boolean {
    if (start === target) return true;
    if (seen.has(start)) return false; seen.add(start);
    return successors.find(t => t.id === start)?.dependencies.some(d => reaches(d.id, target, seen)) ?? false;
  }
  for (const incoming of parent.dependencies) if (successors.some(t => !reaches(t.id, incoming.id))) errors.push('incoming-dependency-lost');
  if (duplicates(f.mapping.map(m => m.consumerId)) || duplicates(previous.map(t => t.id)) || duplicates(rewired.map(t => t.id))) errors.push('duplicate-consumer-mapping');
  if (!eq(previous.map(t => t.id), rewired.map(t => t.id)) || !eq(previous.map(t => t.id), f.mapping.map(m => m.consumerId))) errors.push('outgoing-consumer-set-changed');
  for (const old of previous) {
    const next = rewired.find(t => t.id === old.id), map = f.mapping.find(m => m.consumerId === old.id);
    if (!old.dependencies.some(d => d.id === parent.id) || !next || !map || !map.successorIds.length || map.successorIds.some(s => !successorIds.includes(s)) || successorIds.some(s => !map.successorIds.some(mapped => reaches(mapped, s)))) { errors.push('outgoing-obligation-not-preserved'); continue; }
    if (!eq(next.dependencies.map(d => d.id), [...old.dependencies.filter(d => d.id !== parent.id).map(d => d.id), ...map.successorIds])) errors.push('consumer-not-explicitly-reconnected');
    if (JSON.stringify({ ...old, dependencies: [] }) !== JSON.stringify({ ...next, dependencies: [] })) errors.push('consumer-content-changed-during-split');
  }
  return { errors: [...new Set(errors)], parentSatisfied: false as const, parentOutcome: errors.length ? 'unchanged' as const : 'CANCELLED-with-successor-links' as const };
}
