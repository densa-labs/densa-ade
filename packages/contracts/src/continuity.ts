import { enumeration, fail, id, integer, type Id } from './schema.js';
import { requireBooleanFacts } from './decision-facts.js';
import { projectStates, type ProjectState, type PhaseState, type ExecutionMode } from './lifecycle.js';

export const settlementSeams = ['candidate-certified', 'commit-created', 'ref-advanced', 'completion-committed', 'effect-unknown'] as const;
export interface SettlementFacts {
  seam: typeof settlementSeams[number]; cancel: boolean; revoke: boolean; pause: boolean;
  writersTerminated: boolean; ownershipProven: boolean; objectsVerified: boolean;
  ref: 'previous' | 'proposed' | 'other' | 'unknown'; compensationJournaled: boolean;
  compensationVerified: boolean; noChange: boolean; certificateCurrent: boolean; authorityCurrent: boolean;
}
/** B = accepted baseline; N = proposed commit. A proposed transaction is not acceptance. */
export function decideSettlement(f: SettlementFacts) {
  requireBooleanFacts(f, ['cancel', 'revoke', 'pause', 'writersTerminated', 'ownershipProven', 'objectsVerified', 'compensationJournaled', 'compensationVerified', 'noChange', 'certificateCurrent', 'authorityCurrent']);
  enumeration(settlementSeams).parse(f.seam); enumeration(['previous', 'proposed', 'other', 'unknown']).parse(f.ref);
  if (f.compensationVerified && (!f.compensationJournaled || f.ref !== 'previous' || !f.ownershipProven || !f.objectsVerified)) fail('RECOVERY_REQUIRED');
  const result = <const A extends string>(action: A, task: 'nonterminal' | 'COMPLETED' | 'CANCELLED' | 'INTERRUPTED', accepted: 'B' | 'N' = 'B', recoveryRequired = false) => ({ action, task, accepted, proposedCommitRole: accepted === 'N' ? 'accepted-result' as const : 'attempt-evidence-only' as const, settlementFenceRequired: task !== 'COMPLETED' || recoveryRequired, recoveryRequired, createDuplicateCommit: false as const });
  if (f.seam === 'completion-committed') return result(f.ownershipProven && f.objectsVerified && (f.ref === 'proposed' || (f.noChange && f.ref === 'previous')) ? 'preserve-completion' : 'verify-or-repair-owned-completed-replica', 'COMPLETED', 'N', !(f.ownershipProven && f.objectsVerified && (f.ref === 'proposed' || (f.noChange && f.ref === 'previous'))));
  if (!f.writersTerminated || f.seam === 'effect-unknown') return result('reconcile-before-terminal-outcome', 'nonterminal', 'B', true);
  if (!f.ownershipProven || !f.objectsVerified || ['other', 'unknown'].includes(f.ref)) return result('block-for-user-reconciliation', 'nonterminal', 'B', true);
  if (f.cancel || f.revoke) {
    if (f.seam === 'ref-advanced' && !f.noChange && !f.compensationVerified) {
      if (f.ref !== 'proposed') return result('block-for-user-reconciliation', 'nonterminal', 'B', true);
      return result(f.compensationJournaled ? 'compare-and-swap-owned-ref-N-to-B' : 'record-compensation-intent', 'nonterminal', 'B', true);
    }
    if (f.ref !== 'previous' && !f.noChange) return result('block-for-user-reconciliation', 'nonterminal', 'B', true);
    return result(f.cancel ? 'finalize-cancel' : 'interrupt-with-mandatory-user-hold', f.cancel ? 'CANCELLED' : 'INTERRUPTED');
  }
  if (f.pause) return result('retain-verified-unfinished-result-no-new-publication', 'INTERRUPTED');
  if (!f.certificateCurrent || !f.authorityCurrent) return result('hold-for-revalidation-or-authorization', 'nonterminal');
  if (f.noChange) return result('record-no-change-completion-and-accepted-pointer', 'nonterminal');
  if (f.seam === 'candidate-certified' && f.ref === 'previous') return result('journal-create-commit', 'nonterminal');
  if (f.seam === 'commit-created' && f.ref === 'previous') return result('journal-advance-owned-ref', 'nonterminal');
  if (f.seam === 'ref-advanced' && f.ref === 'proposed') return result('record-completion-and-accepted-pointer', 'nonterminal');
  return result('block-for-user-reconciliation', 'nonterminal', 'B', true);
}

export interface SponsoredExecution {
  projectId: Id<'project'>; executionId: Id<'execution'>; revision: number;
  sponsorId: Id<'principal'>; backgroundOnQuit: 'pause' | 'keep-running'; state: ProjectState;
}
export function decideDeparture(f: { principalId: Id<'principal'>; principalKind: 'application' | 'CLI'; event: 'quit' | 'window-close' | 'disconnect' | 'crash'; observed: readonly { projectId: Id<'project'>; executionId: Id<'execution'>; revision: number }[]; current: readonly SponsoredExecution[]; recoveryBarrier: boolean }) {
  requireBooleanFacts(f, ['recoveryBarrier']);
  id('principal').parse(f.principalId);
  enumeration(['application', 'CLI']).parse(f.principalKind); enumeration(['quit', 'window-close', 'disconnect', 'crash']).parse(f.event);
  const seen = new Set<string>();
  for (const row of f.observed) {
    id('project').parse(row.projectId); id('execution').parse(row.executionId); integer.parse(row.revision);
    if (seen.has(row.executionId)) fail(); seen.add(row.executionId);
  }
  const current = new Map<string, SponsoredExecution>();
  for (const row of f.current) {
    id('project').parse(row.projectId); id('execution').parse(row.executionId); id('principal').parse(row.sponsorId); integer.parse(row.revision);
    enumeration(projectStates).parse(row.state); enumeration(['pause', 'keep-running']).parse(row.backgroundOnQuit);
    if (current.has(row.executionId)) fail(); current.set(row.executionId, row);
  }
  const decisions = f.observed.map(observed => {
    const row = current.get(observed.executionId);
    const action = f.principalKind === 'CLI' || f.event !== 'quit' ? 'disconnect-only' : !row || row.projectId !== observed.projectId || row.sponsorId !== f.principalId ? 'outside-current-sponsorship' : row.revision !== observed.revision ? 'stale-observation' : ['COMPLETED', 'FAILED'].includes(row.state) ? 'terminal-no-op' : row.backgroundOnQuit === 'keep-running' ? 'keep-running-under-existing-holds' : f.recoveryBarrier ? 'record-pause-behind-recovery-barrier' : 'record-pause-and-fence-scheduling';
    return { executionId: observed.executionId, action } as const;
  });
  return { decisions, acknowledgment: 'after-durable-departure-intent' as const, awaitProcessExit: false as const, transferSponsorship: false as const, autoApprove: false as const };
}
export function decideSponsorship(f: { action: 'start' | 'resume' | 'transfer' | 'observe' | 'approve' | 'reconnect'; actor: Id<'principal'>; current: Id<'principal'> | null; revisionCurrent: boolean; explicitlyAuthorized: boolean }) {
  requireBooleanFacts(f, ['revisionCurrent', 'explicitlyAuthorized']);
  id('principal').parse(f.actor); if (f.current !== null) id('principal').parse(f.current);
  enumeration(['start', 'resume', 'transfer', 'observe', 'approve', 'reconnect']).parse(f.action);
  if (f.action === 'start' || f.action === 'transfer') {
    if (!f.revisionCurrent) fail('STALE_REVISION');
    if (!f.explicitlyAuthorized) fail('UNAUTHORIZED');
    if (f.action === 'transfer' && f.current === null) fail('INVALID_TRANSITION');
    if (f.action === 'start' && f.current !== null) fail('INVALID_TRANSITION');
    return { sponsor: f.actor, auditTransfer: f.action === 'transfer' };
  }
  return { sponsor: f.current, auditTransfer: false };
}
export function initialBackgroundPolicy(f: { project: 'pause' | 'keep-running' | null; user: 'pause' | 'keep-running' | null }) {
  for (const v of [f.project, f.user]) if (v !== null) enumeration(['pause', 'keep-running']).parse(v);
  return { value: f.project ?? f.user ?? 'pause', source: f.project !== null ? 'project' : f.user !== null ? 'user' : 'shipped', application: 'persist-at-start' } as const;
}

export interface ReopenFacts {
  previousState: ProjectState; explicitCommand: boolean; revisionCurrent: boolean; noLiveWriter: boolean;
  journalResolved: boolean; baselineChoice: 'accepted-result' | 'source'; hasAcceptedResult: boolean;
  resultVerified: boolean; originalBaselineVerified: boolean; sourceIdentityVerified: boolean;
  sourceDiverged: boolean; acceptedLineageConfirmed: boolean; sourceCleanCommittedBranch: boolean;
  sourcePreflightPassed: boolean;
}
export function decideReopen(f: ReopenFacts) {
  requireBooleanFacts(f, ['explicitCommand', 'revisionCurrent', 'noLiveWriter', 'journalResolved', 'hasAcceptedResult', 'resultVerified', 'originalBaselineVerified', 'sourceIdentityVerified', 'sourceDiverged', 'acceptedLineageConfirmed', 'sourceCleanCommittedBranch', 'sourcePreflightPassed']);
  enumeration(projectStates).parse(f.previousState); enumeration(['accepted-result', 'source']).parse(f.baselineChoice);
  if (!f.explicitCommand || !['COMPLETED', 'FAILED'].includes(f.previousState)) fail('INVALID_TRANSITION');
  if (!f.revisionCurrent) fail('STALE_REVISION');
  if (!f.noLiveWriter || !f.journalResolved) return { kind: 'hold' as const, reason: 'recovery-required' as const };
  if (!f.sourceIdentityVerified) return { kind: 'hold' as const, reason: 'source-identity' as const };
  if (f.baselineChoice === 'source' && (!f.sourceCleanCommittedBranch || !f.sourcePreflightPassed)) return { kind: 'hold' as const, reason: 'source-preflight' as const };
  if (f.baselineChoice === 'accepted-result') {
    if (f.hasAcceptedResult ? !f.resultVerified : !f.originalBaselineVerified) return { kind: 'hold' as const, reason: 'missing-or-corrupt-baseline' as const };
    if (f.sourceDiverged && !f.acceptedLineageConfirmed) return { kind: 'hold' as const, reason: 'confirm-accepted-lineage' as const };
  }
  return { kind: 'proposed' as const, newExecution: true as const, projectIdentity: 'unchanged' as const, state: 'DRAFT' as const,
    baseline: f.baselineChoice === 'source' ? 'explicit-source' as const : f.hasAcceptedResult ? 'last-transactionally-accepted-result' as const : 'original-approved-baseline' as const,
    specification: 'new-unapproved-revision-preserving-requirement-ids' as const, roadmapApprovalRequired: true as const, specificationApprovalRequired: true as const,
    taskInitialization: { newIds: true as const, state: 'PENDING' as const, implementationAttempts: 0 as const }, phaseInitialization: 'PENDING' as const,
    unchangedRequirements: 'validation-only-baseline-qualification' as const, changedOrUnfulfilledRequirements: 'new-linked-implementation-or-repair-tasks' as const,
    inheritedCoverage: 'reference-observations-only' as const, historicalStates: 'unchanged' as const, omittedPromisesRequireScopeApproval: true as const,
  };
}

export function renewalKey(f: { executionId: Id<'execution'>; requirementId: Id<'requirement'>; requirementRevision: number; candidateDigest: string; planRevision: number }) {
  id('execution').parse(f.executionId); id('requirement').parse(f.requirementId); integer.parse(f.requirementRevision); integer.parse(f.planRevision);
  if (!/^sha256:[0-9a-f]{64}$/.test(f.candidateDigest)) fail();
  return `${f.executionId}/${f.requirementId}/${f.requirementRevision}/${f.candidateDigest}/${f.planRevision}`;
}
export function decideRenewal(f: { terminalExecution: boolean; obligation: 'none' | 'pending' | 'running' | 'passed' | 'failed' | 'superseded'; candidateCurrent: boolean; coverageMatches: boolean; pauseOrRevocation: boolean; recoveryBarrier: boolean; workerActive: boolean; authorityAvailable: boolean; roleHold: 'none' | 'user' | 'usage' | 'blocked'; phaseStage: 'RUNNING' | 'VALIDATING' }) {
  requireBooleanFacts(f, ['terminalExecution', 'candidateCurrent', 'coverageMatches', 'pauseOrRevocation', 'recoveryBarrier', 'workerActive', 'authorityAvailable']);
  enumeration(['none', 'pending', 'running', 'passed', 'failed', 'superseded']).parse(f.obligation);
  enumeration(['none', 'user', 'usage', 'blocked']).parse(f.roleHold); enumeration(['RUNNING', 'VALIDATING']).parse(f.phaseStage);
  const holdActions = { user: 'hold-user', usage: 'hold-usage', blocked: 'hold-blocked' } as const;
  const action = f.terminalExecution ? 'explicit-reopen-required' : f.recoveryBarrier || f.pauseOrRevocation ? 'retain-behind-control-barrier' : f.workerActive ? 'await-worker-quiescence' : !f.candidateCurrent || f.obligation === 'superseded' ? 'fence-old-callbacks-and-deduplicate-current-obligation' : f.roleHold !== 'none' ? holdActions[f.roleHold] : !f.authorityAvailable ? 'hold-user' : f.obligation === 'failed' ? 'deduplicated-repair-proposal' : (f.obligation === 'passed' || f.obligation === 'none') && f.coverageMatches ? 'ordinary-readiness' : f.obligation === 'running' ? 'await-current-renewal' : f.obligation === 'none' || f.obligation === 'passed' ? 'record-current-renewal-obligation' : 'dispatch-validation-only-renewal';
  return { action, phase: action === 'deduplicated-repair-proposal' ? 'BLOCKED' : f.phaseStage, project: action === 'hold-user' || action === 'deduplicated-repair-proposal' ? 'WAITING_FOR_USER' : action === 'hold-usage' ? 'WAITING_FOR_USAGE' : action === 'hold-blocked' ? 'BLOCKED' : 'retain-or-run-under-control', implementationAttempts: 0, mutateHistoricalCompletion: false, gitChanges: false, ordinaryDispatchAllowed: action === 'ordinary-readiness' } as const;
}
export function decideRepair(f: { failedPhaseCompleted: boolean; currentOpenPhase: boolean; approval: 'pending' | 'approved' | 'denied'; exhausted: boolean; repairSettled: boolean; originalCoverageRenewed: boolean; recoveryAcceptancePassed: boolean; recoveryReviewPassed: boolean; mode: ExecutionMode; recoveryApprovalBound: boolean; remainingRegression: boolean; controlsClear: boolean }) {
  requireBooleanFacts(f, ['failedPhaseCompleted', 'currentOpenPhase', 'exhausted', 'repairSettled', 'originalCoverageRenewed', 'recoveryAcceptancePassed', 'recoveryReviewPassed', 'recoveryApprovalBound', 'remainingRegression', 'controlsClear']);
  enumeration(['pending', 'approved', 'denied']).parse(f.approval); enumeration(['Guided', 'Phase', 'Continuous']).parse(f.mode);
  const location = f.failedPhaseCompleted ? f.currentOpenPhase ? 'new-recovery-phase-before-suspended-phase' : 'append-new-recovery-phase' : 'active-phase-before-consumers';
  const action = f.exhausted || f.approval === 'denied' ? 'block' : f.approval === 'pending' ? 'request-explicit-repair-approval' : !f.controlsClear ? 'retain-control-hold' : f.remainingRegression ? 'same-obligation-explicit-revised-proposal' : !f.repairSettled ? 'admit-only-approved-repair-slice' : !f.originalCoverageRenewed ? 'renew-original-promises' : f.failedPhaseCompleted && (!f.recoveryAcceptancePassed || !f.recoveryReviewPassed) ? 'run-recovery-phase-acceptance-and-fresh-review' : f.failedPhaseCompleted && f.mode !== 'Continuous' && !f.recoveryApprovalBound ? 'await-recovery-phase-approval' : 'release-matching-consumers';
  return { action, location, historicalPhase: 'unchanged', suspendedPhase: action === 'release-matching-consumers' ? 'release-recorded-stage' : 'BLOCKED' as PhaseState, resetExhaustedAttempts: false, hardDependenciesOnFailedCoverage: false, newApprovalAlwaysRequired: true } as const;
}
