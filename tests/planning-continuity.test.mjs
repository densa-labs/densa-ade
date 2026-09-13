import assert from 'node:assert/strict';
import test from 'node:test';
import * as c from '../dist/contracts/src/index.js';

const ident = (kind, n = 1) => `${kind}_12345678-1234-4234-8234-${String(n).padStart(12, '0')}`;
const projectId = ident('project'), phaseId = ident('phase');
const ref = (kind, n = 1) => ({ projectId, id: ident(kind, n) });
const rejects = (fn, code) => assert.throws(fn, { code });
const clone = value => JSON.parse(JSON.stringify(value));
const settlement = { seam: 'candidate-certified', cancel: false, revoke: false, pause: false, writersTerminated: true, ownershipProven: true, objectsVerified: true, ref: 'previous', compensationJournaled: true, compensationVerified: false, noChange: false, certificateCurrent: true, authorityCurrent: true };
test('P0M2 facts: malformed or absent boolean evidence rejects; accessors are never executed', () => {
  for (const key of Object.keys(settlement).filter(k => typeof settlement[k] === 'boolean')) {
    for (const value of ['true', 1, null]) rejects(() => c.decideSettlement({ ...settlement, [key]: value }), 'MALFORMED_MESSAGE');
    const missing = { ...settlement }; delete missing[key]; rejects(() => c.decideSettlement(missing), 'MALFORMED_MESSAGE');
  }
  let invoked = false;
  const f = Object.defineProperty({ ...settlement }, 'ownershipProven', { get() { invoked = true; return true; }, enumerable: true });
  rejects(() => c.decideSettlement(f), 'MALFORMED_MESSAGE'); assert.equal(invoked, false);
});
test('P0M2 R3a: every cancellation seam preserves B until accepted transaction and retains N as evidence', () => {
  for (const [seam, refValue, task, action, accepted] of [
    ['candidate-certified', 'previous', 'CANCELLED', 'finalize-cancel', 'B'],
    ['commit-created', 'previous', 'CANCELLED', 'finalize-cancel', 'B'],
    ['ref-advanced', 'proposed', 'nonterminal', 'compare-and-swap-owned-ref-N-to-B', 'B'],
    ['completion-committed', 'proposed', 'COMPLETED', 'preserve-completion', 'N'],
    ['effect-unknown', 'unknown', 'nonterminal', 'reconcile-before-terminal-outcome', 'B'],
  ]) {
    const result = c.decideSettlement({ ...settlement, seam, ref: refValue, cancel: true, pause: true });
    assert.equal(result.task, task); assert.equal(result.action, action); assert.equal(result.accepted, accepted);
    assert.equal(result.proposedCommitRole, accepted === 'N' ? 'accepted-result' : 'attempt-evidence-only');
  }
  const cancelled = c.decideSettlement({ ...settlement, seam: 'ref-advanced', cancel: true, compensationVerified: true });
  assert.equal(cancelled.task, 'CANCELLED'); assert.equal(cancelled.accepted, 'B');
  for (const patch of [{ ref: 'other' }, { ref: 'unknown' }, { ownershipProven: false }, { objectsVerified: false }]) {
    const blocked = c.decideSettlement({ ...settlement, seam: 'ref-advanced', ref: 'proposed', cancel: true, ...patch });
    assert.equal(blocked.action, 'block-for-user-reconciliation'); assert.equal(blocked.settlementFenceRequired, true);
  }
  assert.equal(c.decideSettlement({ ...settlement, seam: 'ref-advanced', ref: 'proposed', cancel: true, compensationJournaled: false }).action, 'record-compensation-intent');
  assert.equal(c.decideSettlement({ ...settlement, cancel: true, writersTerminated: false }).task, 'nonterminal');
  assert.equal(c.decideSettlement({ ...settlement, revoke: true }).task, 'INTERRUPTED');
  assert.equal(c.decideSettlement({ ...settlement, revoke: true, cancel: true }).task, 'CANCELLED');
  assert.equal(c.decideSettlement({ ...settlement, seam: 'ref-advanced', ref: 'proposed', pause: true }).action, 'retain-verified-unfinished-result-no-new-publication');
  rejects(() => c.decideSettlement({ ...settlement, compensationVerified: true, ref: 'other' }), 'RECOVERY_REQUIRED');
});
test('P0M2 R3a: normal settlement proposals never manufacture acceptance; no-change follows transaction ordering', () => {
  for (const [seam, refValue, expected] of [['candidate-certified', 'previous', 'journal-create-commit'], ['commit-created', 'previous', 'journal-advance-owned-ref'], ['ref-advanced', 'proposed', 'record-completion-and-accepted-pointer']]) {
    const result = c.decideSettlement({ ...settlement, seam, ref: refValue });
    assert.equal(result.action, expected); assert.equal(result.accepted, 'B'); assert.equal(result.task, 'nonterminal');
    assert.equal(c.decideSettlement({ ...settlement, seam, ref: refValue, certificateCurrent: false }).action, 'hold-for-revalidation-or-authorization');
  }
  for (const seam of ['candidate-certified', 'commit-created', 'ref-advanced']) {
    assert.equal(c.decideSettlement({ ...settlement, seam, noChange: true }).action, 'record-no-change-completion-and-accepted-pointer');
    assert.equal(c.decideSettlement({ ...settlement, seam, noChange: true, cancel: true }).task, 'CANCELLED');
  }
  assert.equal(c.decideSettlement({ ...settlement, seam: 'completion-committed', noChange: true, cancel: true }).task, 'COMPLETED');
});

function task(n, patch = {}) {
  return { projectId, id: ident('task', n), phaseId, kind: 'implementation', required: true, state: 'PENDING', requirementIds: [ident('requirement', n)], criteria: [{ id: ident('criterion', n), requirementId: ident('requirement', n), validationDeclared: true, validationFeasible: true }], dependencies: [], supersededBy: [], ...patch };
}
function plan() { return { projectId, phases: [{ projectId, id: phaseId }], tasks: [task(1, { state: 'COMPLETED' }), task(3, { dependencies: [ref('task', 1)] }), task(2, { dependencies: [ref('task', 1)] })], requiredRequirements: [ident('requirement', 1), ident('requirement', 2), ident('requirement', 3)], blockingDecisionIds: [] }; }
const readiness = { phaseId, mode: 'Phase', taskApprovals: [], validCoverageTaskIds: [ident('task', 1)], exhaustedTaskIds: [], coverageObligations: [], completedPhaseIds: [], phaseAuthorized: true, renewalRunning: false, implementationLeaseAvailable: true, controlsClear: true, identityWorkspaceValid: true, trustPolicyValid: true, configurationValid: true, decisionsResolved: true, validationAvailable: true, repair: null };
test('P0M2 R5 graph: schedulable serial graph, stable-ID tie break, criteria/coverage and all structural failures', () => {
  assert.equal(c.planningGraph.parse(plan()).tasks.length, 3);
  assert.equal(c.decideReadiness(plan(), readiness).next, ident('task', 2));
  const invalid = [];
  const mutate = fn => { const p = plan(); fn(p); invalid.push(p); };
  mutate(p => p.tasks[1].dependencies.push(ref('task', 99)));
  mutate(p => { p.tasks[1].dependencies = [ref('task', 2)]; p.tasks[2].dependencies = [ref('task', 3)]; });
  mutate(p => { p.phases.push({ projectId, id: ident('phase', 2) }); p.tasks[0].phaseId = ident('phase', 2); });
  mutate(p => p.tasks[1].criteria = []); mutate(p => p.tasks[1].criteria[0].validationFeasible = false);
  mutate(p => p.tasks[1].criteria[0].validationDeclared = false); mutate(p => p.tasks[1].requirementIds = []);
  mutate(p => p.requiredRequirements.push(ident('requirement', 99))); mutate(p => p.blockingDecisionIds.push(ident('decision')));
  mutate(p => p.tasks.push(clone(p.tasks[0]))); mutate(p => p.phases.push(clone(p.phases[0])));
  mutate(p => p.tasks[1].criteria[0].requirementId = ident('requirement', 99));
  mutate(p => p.tasks[0].state = 'CANCELLED'); mutate(p => p.tasks[0].supersededBy = [ref('task', 2)]);
  for (const p of invalid) { assert.ok(c.inspectPlanningGraph(p).length); rejects(() => c.planningGraph.parse(p), 'DEPENDENCY_BLOCKED'); assert.equal(c.decideReadiness(p, readiness).next, null); }
  const cross = plan(); cross.tasks[0].projectId = ident('project', 2);
  rejects(() => c.planningGraph.parse(cross), 'CROSS_PROJECT_REFERENCE');
  const crossRef = plan(); crossRef.tasks[1].dependencies[0].projectId = ident('project', 2);
  rejects(() => c.planningGraph.parse(crossRef), 'CROSS_PROJECT_REFERENCE');
  const cyclicLineage = plan();
  cyclicLineage.tasks[0].state = 'CANCELLED'; cyclicLineage.tasks[0].supersededBy = [ref('task', 3)];
  cyclicLineage.tasks[1].state = 'CANCELLED'; cyclicLineage.tasks[1].supersededBy = [ref('task', 1)];
  assert.ok(c.inspectPlanningGraph(cyclicLineage).some(e => e.endsWith(':supersession-cycle')));
});
test('P0M2 readiness: cancelled/superseded dependencies are unsatisfied; phase gates, every hold and mode approval', () => {
  for (const field of ['implementationLeaseAvailable', 'controlsClear', 'identityWorkspaceValid', 'trustPolicyValid', 'configurationValid', 'decisionsResolved', 'validationAvailable', 'phaseAuthorized']) assert.equal(c.decideReadiness(plan(), { ...readiness, [field]: false }).next, null, field);
  assert.equal(c.decideReadiness(plan(), { ...readiness, validCoverageTaskIds: [] }).next, null);
  assert.equal(c.decideReadiness(plan(), { ...readiness, mode: 'Guided' }).next, null);
  assert.equal(c.decideReadiness(plan(), { ...readiness, mode: 'Guided', taskApprovals: [ident('task', 3)] }).next, ident('task', 3));
  assert.equal(c.decideReadiness(plan(), { ...readiness, mode: 'Continuous' }).next, ident('task', 2));
  assert.equal(c.decideReadiness(plan(), { ...readiness, exhaustedTaskIds: [ident('task', 2), ident('task', 3)] }).next, null);
  const qualification = plan(); qualification.tasks[2].kind = 'qualification';
  const q = c.decideReadiness(qualification, { ...readiness, exhaustedTaskIds: [ident('task', 2), ident('task', 3)] });
  assert.equal(q.next, ident('task', 2)); assert.equal(q.decisions[0].path, 'validation-only-renewal');
  const phased = plan(); phased.phases.push({ projectId, id: ident('phase', 2) }); phased.tasks[1].phaseId = ident('phase', 2);
  assert.equal(c.decideReadiness(phased, { ...readiness, phaseId: ident('phase', 2) }).next, null);
  assert.equal(c.decideReadiness(phased, { ...readiness, phaseId: ident('phase', 2), completedPhaseIds: [phaseId] }).next, ident('task', 3));
});
test('P0M2 R3b A/B/C: renewal runs before dependent readiness; admitted repair bypasses only named failed coverage', () => {
  const pending = { ...readiness, coverageObligations: [{ taskId: ident('task', 1), state: 'pending-renewal' }], validCoverageTaskIds: [] };
  assert.equal(c.decideReadiness(plan(), pending).next, null);
  const repairedPlan = plan(); repairedPlan.tasks.push(task(4)); repairedPlan.requiredRequirements.push(ident('requirement', 4));
  const repair = { taskIds: [ident('task', 4)], approved: true, namedFailedCoverageTaskIds: [ident('task', 1)], baselineProvenanceVerified: true };
  const failed = { ...pending, repair, coverageObligations: [{ taskId: ident('task', 1), state: 'failed-coverage' }] };
  assert.equal(c.decideReadiness(repairedPlan, failed).next, ident('task', 4));
  assert.equal(c.decideReadiness(repairedPlan, { ...failed, renewalRunning: true }).next, null);
  assert.equal(c.decideReadiness(repairedPlan, { ...pending, repair }).next, null);
  assert.equal(c.decideReadiness(repairedPlan, { ...failed, repair: { ...repair, approved: false } }).next, null);
  assert.equal(c.decideReadiness(repairedPlan, { ...failed, repair: { ...repair, baselineProvenanceVerified: false } }).next, null);
  assert.equal(c.decideReadiness(repairedPlan, { ...failed, coverageObligations: [...failed.coverageObligations, { taskId: ident('task', 2), state: 'failed-coverage' }] }).next, null);
  repairedPlan.tasks[3].dependencies = [ref('task', 1)];
  assert.equal(c.decideReadiness(repairedPlan, failed).next, null); // lineage must not become a hard dependency on invalid coverage
  assert.equal(c.decideReadiness(plan(), readiness).next, ident('task', 2)); // matching renewal released C
});

test('P0M2 R5 split: exact acceptance union, transitive incoming/outgoing obligations and immutable completed work', () => {
  const parent = task(4, { dependencies: [ref('task', 1)], requirementIds: [ident('requirement', 4), ident('requirement', 5)], criteria: [...task(4).criteria, ...task(5).criteria] });
  const successors = [task(5, { dependencies: [ref('task', 1)] }), task(6, { requirementIds: task(4).requirementIds, criteria: task(4).criteria, dependencies: [ref('task', 5)] })];
  const old = task(7, { dependencies: [ref('task', 4)] });
  const f = { parent, successors, previousConsumers: [old], rewiredConsumers: [{ ...old, dependencies: [ref('task', 6)] }], mapping: [{ consumerId: old.id, successorIds: [ident('task', 6)] }], quiescent: true, revisionApproved: true };
  assert.deepEqual(c.inspectSplit(f).errors, []); assert.equal(c.inspectSplit(f).parentSatisfied, false);
  const variants = [
    { ...f, parent: { ...parent, state: 'COMPLETED' } }, { ...f, quiescent: false }, { ...f, revisionApproved: false },
    { ...f, successors: [successors[0]] }, { ...f, rewiredConsumers: [old] }, { ...f, mapping: [] },
    { ...f, successors: [{ ...successors[0], dependencies: [] }, successors[1]] },
    { ...f, successors: [successors[0], { ...successors[1], criteria: successors[1].criteria.map(c => ({ ...c, validationFeasible: false })) }] },
  ];
  for (const value of variants) assert.ok(c.inspectSplit(value).errors.length);
});
test('P0M2 mutation classification and admission: scope/security floors, quiescence, staleness and exact approval', () => {
  const base = { suggested: 'MINOR', architecture: false, security: false, persistence: false, promiseAdded: false, promiseRemoved: false, acceptanceWeakened: false };
  assert.equal(c.classifyMutation(base), 'MINOR');
  for (const field of ['architecture', 'security', 'persistence']) assert.equal(c.classifyMutation({ ...base, [field]: true }), 'SIGNIFICANT');
  for (const field of ['promiseAdded', 'promiseRemoved', 'acceptanceWeakened']) assert.equal(c.classifyMutation({ ...base, [field]: true, security: true }), 'SCOPE');
  assert.equal(c.classifyMutation({ ...base, suggested: 'SCOPE' }), 'SCOPE');
  const f = { classification: 'SCOPE', preset: 'Autonomous', significantChangesAuthorized: true, repairAdmission: false, affectedActive: false, writersTerminated: true, settlementReconciled: true, proposalRevisionsCurrent: true, approval: 'approved', approvalBindsExactProposal: true, semanticGraphValid: true };
  assert.equal(c.decideMutation(f).action, 'propose-atomic-plan-rows-invalidations-decisions-event');
  assert.equal(c.decideMutation({ ...f, approvalBindsExactProposal: false }).action, 'request-exact-approval');
  assert.equal(c.decideMutation({ ...f, proposalRevisionsCurrent: false }).action, 'reconcile-and-present-fresh-proposal');
  assert.equal(c.decideMutation({ ...f, affectedActive: true }).action, 'persist-proposal-and-quiesce');
  assert.equal(c.decideMutation({ ...f, approval: 'denied' }).action, 'block-denied-proposal');
  assert.equal(c.decideMutation({ ...f, classification: 'MINOR', repairAdmission: true, approval: 'pending' }).action, 'request-exact-approval');
  assert.equal(c.decideMutation({ ...f, classification: 'SIGNIFICANT', approval: 'pending' }).approvalRequired, false);
});

const renewal = { terminalExecution: false, obligation: 'pending', candidateCurrent: true, coverageMatches: false, pauseOrRevocation: false, recoveryBarrier: false, workerActive: false, authorityAvailable: true, roleHold: 'none', phaseStage: 'RUNNING' };
test('P0M2 R3b renewal decisions: deduplication, stale callbacks, control barriers and zero worker attempts', () => {
  const key = { executionId: ident('execution'), requirementId: ident('requirement'), requirementRevision: 2, candidateDigest: `sha256:${'a'.repeat(64)}`, planRevision: 3 };
  assert.equal(c.renewalKey(key), c.renewalKey(clone(key)));
  for (const patch of [{ executionId: ident('execution', 2) }, { requirementRevision: 3 }, { planRevision: 4 }, { candidateDigest: `sha256:${'b'.repeat(64)}` }]) assert.notEqual(c.renewalKey(key), c.renewalKey({ ...key, ...patch }));
  for (const [patch, action] of [
    [{}, 'dispatch-validation-only-renewal'], [{ terminalExecution: true }, 'explicit-reopen-required'],
    [{ recoveryBarrier: true }, 'retain-behind-control-barrier'], [{ pauseOrRevocation: true }, 'retain-behind-control-barrier'],
    [{ workerActive: true }, 'await-worker-quiescence'], [{ candidateCurrent: false }, 'fence-old-callbacks-and-deduplicate-current-obligation'],
    [{ obligation: 'superseded' }, 'fence-old-callbacks-and-deduplicate-current-obligation'], [{ authorityAvailable: false }, 'hold-user'],
    [{ roleHold: 'blocked' }, 'hold-blocked'], [{ roleHold: 'usage' }, 'hold-usage'], [{ roleHold: 'user' }, 'hold-user'],
    [{ obligation: 'failed' }, 'deduplicated-repair-proposal'], [{ obligation: 'running' }, 'await-current-renewal'],
    [{ obligation: 'passed', coverageMatches: true }, 'ordinary-readiness'], [{ obligation: 'passed' }, 'record-current-renewal-obligation'],
  ]) {
    const result = c.decideRenewal({ ...renewal, ...patch }); assert.equal(result.action, action); assert.equal(result.implementationAttempts, 0); assert.equal(result.mutateHistoricalCompletion, false); assert.equal(result.gitChanges, false);
  }
});
test('P0M2 R3b historical repair: new recovery phase, explicit approval, renewed original coverage and gate before release', () => {
  const f = { failedPhaseCompleted: true, currentOpenPhase: true, approval: 'pending', exhausted: false, repairSettled: false, originalCoverageRenewed: false, recoveryAcceptancePassed: false, recoveryReviewPassed: false, mode: 'Phase', recoveryApprovalBound: false, remainingRegression: false, controlsClear: true };
  assert.equal(c.decideRepair(f).action, 'request-explicit-repair-approval'); assert.equal(c.decideRepair(f).location, 'new-recovery-phase-before-suspended-phase');
  assert.equal(c.decideRepair({ ...f, currentOpenPhase: false }).location, 'append-new-recovery-phase');
  assert.equal(c.decideRepair({ ...f, failedPhaseCompleted: false }).location, 'active-phase-before-consumers');
  assert.equal(c.decideRepair({ ...f, approval: 'approved' }).action, 'admit-only-approved-repair-slice');
  assert.equal(c.decideRepair({ ...f, approval: 'denied' }).action, 'block');
  assert.equal(c.decideRepair({ ...f, approval: 'approved', exhausted: true }).action, 'block');
  const settled = { ...f, approval: 'approved', repairSettled: true };
  assert.equal(c.decideRepair(settled).action, 'renew-original-promises');
  assert.equal(c.decideRepair({ ...settled, originalCoverageRenewed: true }).action, 'run-recovery-phase-acceptance-and-fresh-review');
  const validated = { ...settled, originalCoverageRenewed: true, recoveryAcceptancePassed: true, recoveryReviewPassed: true };
  assert.equal(c.decideRepair(validated).action, 'await-recovery-phase-approval');
  assert.equal(c.decideRepair({ ...validated, recoveryApprovalBound: true }).action, 'release-matching-consumers');
  assert.equal(c.decideRepair({ ...validated, mode: 'Continuous' }).action, 'release-matching-consumers');
  assert.equal(c.decideRepair({ ...validated, remainingRegression: true }).action, 'same-obligation-explicit-revised-proposal');
});

const reopen = { previousState: 'COMPLETED', explicitCommand: true, revisionCurrent: true, noLiveWriter: true, journalResolved: true, baselineChoice: 'accepted-result', hasAcceptedResult: true, resultVerified: true, originalBaselineVerified: true, sourceIdentityVerified: true, sourceDiverged: false, acceptedLineageConfirmed: false, sourceCleanCommittedBranch: true, sourcePreflightPassed: true };
test('P0M2 R1b reopen: new DRAFT execution, accepted unapplied result, renewed approval and qualification; never terminal reversal', () => {
  const result = c.decideReopen(reopen);
  assert.equal(result.state, 'DRAFT'); assert.equal(result.baseline, 'last-transactionally-accepted-result');
  assert.deepEqual(result.taskInitialization, { newIds: true, state: 'PENDING', implementationAttempts: 0 });
  assert.equal(result.phaseInitialization, 'PENDING'); assert.equal(result.historicalStates, 'unchanged');
  assert.equal(result.specificationApprovalRequired, true); assert.equal(result.roadmapApprovalRequired, true);
  assert.equal(result.unchangedRequirements, 'validation-only-baseline-qualification');
  assert.equal(result.inheritedCoverage, 'reference-observations-only');
  assert.equal(c.decideReopen({ ...reopen, previousState: 'FAILED' }).kind, 'proposed');
  assert.equal(c.decideReopen({ ...reopen, hasAcceptedResult: false }).baseline, 'original-approved-baseline');
  assert.equal(c.decideReopen({ ...reopen, baselineChoice: 'source' }).baseline, 'explicit-source');
  for (const [patch, reason] of [[{ noLiveWriter: false }, 'recovery-required'], [{ journalResolved: false }, 'recovery-required'], [{ resultVerified: false }, 'missing-or-corrupt-baseline'], [{ hasAcceptedResult: false, originalBaselineVerified: false }, 'missing-or-corrupt-baseline'], [{ sourceIdentityVerified: false }, 'source-identity'], [{ sourceDiverged: true }, 'confirm-accepted-lineage'], [{ baselineChoice: 'source', sourceCleanCommittedBranch: false }, 'source-preflight']]) assert.equal(c.decideReopen({ ...reopen, ...patch }).reason, reason);
  assert.equal(c.decideReopen({ ...reopen, sourceDiverged: true, acceptedLineageConfirmed: true }).kind, 'proposed');
  rejects(() => c.decideReopen({ ...reopen, previousState: 'RUNNING' }), 'INVALID_TRANSITION');
  rejects(() => c.decideReopen({ ...reopen, revisionCurrent: false }), 'STALE_REVISION');
});
test('P0M2 R1a departure: exact observed current sponsorship, transfer race, CLI, crash/disconnect and recovery', () => {
  const principalId = ident('principal'), other = ident('principal', 2);
  const row = (n, patch = {}) => ({ projectId: ident('project', n), executionId: ident('execution', n), revision: 4, sponsorId: principalId, backgroundOnQuit: 'pause', state: 'RUNNING', ...patch });
  const current = [row(1), row(2, { sponsorId: other }), row(3, { backgroundOnQuit: 'keep-running' }), row(4), row(5)];
  const f = { principalId, principalKind: 'application', event: 'quit', observed: current.slice(0, 4).map(({ projectId, executionId, revision }) => ({ projectId, executionId, revision })), current, recoveryBarrier: false };
  f.observed[3].revision = 3;
  const result = c.decideDeparture(f);
  assert.deepEqual(result.decisions.map(d => d.action), ['record-pause-and-fence-scheduling', 'outside-current-sponsorship', 'keep-running-under-existing-holds', 'stale-observation']);
  assert.equal(result.decisions.length, 4); assert.equal(result.awaitProcessExit, false); assert.equal(result.autoApprove, false);
  assert.equal(c.decideDeparture({ ...f, recoveryBarrier: true }).decisions[0].action, 'record-pause-behind-recovery-barrier');
  for (const event of ['window-close', 'disconnect', 'crash']) assert.ok(c.decideDeparture({ ...f, event }).decisions.every(d => d.action === 'disconnect-only'));
  assert.ok(c.decideDeparture({ ...f, principalKind: 'CLI' }).decisions.every(d => d.action === 'disconnect-only'));
  for (const action of ['observe', 'approve', 'resume', 'reconnect']) assert.equal(c.decideSponsorship({ action, actor: other, current: principalId, revisionCurrent: true, explicitlyAuthorized: true }).sponsor, principalId);
  assert.equal(c.decideSponsorship({ action: 'transfer', actor: other, current: principalId, revisionCurrent: true, explicitlyAuthorized: true }).sponsor, other);
  rejects(() => c.decideSponsorship({ action: 'transfer', actor: other, current: principalId, revisionCurrent: false, explicitlyAuthorized: true }), 'STALE_REVISION');
  rejects(() => c.decideSponsorship({ action: 'start', actor: other, current: principalId, revisionCurrent: true, explicitlyAuthorized: true }), 'INVALID_TRANSITION');
  assert.deepEqual(c.initialBackgroundPolicy({ project: null, user: null }), { value: 'pause', source: 'shipped', application: 'persist-at-start' });
  assert.equal(c.initialBackgroundPolicy({ project: 'pause', user: 'keep-running' }).value, 'pause');
  assert.equal(c.initialBackgroundPolicy({ project: null, user: 'keep-running' }).value, 'keep-running');
});
