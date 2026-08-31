# Densa ADE Phase 1 Current-State Release Audit

You are Codex operating in the repository at:

`/Users/ivanuy/Desktop/Projects/active-projects/densa-ade`

Conduct a fresh, evidence-driven release audit of **Phase 1** against the **current repository state**. This is not a historical code review and not a review limited to the implementation as it existed when Phase 1 was completed. Determine whether Phase 1's original guarantees still hold after every later change now present in the checkout.

## Mandatory sequencing

1. Treat this prompt as fully constructed before any audit work begins.
2. Read the repository's current `AGENTS.md` and obey it throughout.
3. Inspect the working tree before editing and preserve all pre-existing user work. Never overwrite, revert, clean, reset, amend, squash, force-push, or otherwise destroy unrelated work.
4. Recover the authoritative original Phase 1 requirements before judging the implementation. Use the current roadmap and architecture documentation, relevant Git history/tags/commits, milestone notes, tests, fixtures, and other repository evidence. Do not rely on recollection or prior summaries as proof.
5. Audit the current implementation, fix confirmed in-scope defects, validate the result, reinspect the affected paths, and then issue the required final report and exact gate.

## Scope to recover and evaluate

Recover and review Phase 1's original:

- requirements;
- acceptance criteria;
- invariants;
- architectural intent;
- lifecycle expectations;
- failure semantics;
- intended externally observable behavior.

Build an explicit internal trace from each recovered requirement or guarantee to its current implementation and evidence. Phase 1 includes every Phase 1 milestone and all provider-neutral or Codex-specific boundaries, proof-harness behavior, fixtures, validation, and documentation that those milestones originally required. Let the authoritative repository evidence determine the exact milestone boundaries and details.

## Required audit method

Trace the recovered requirements into the current implementation and determine whether each is still genuinely guaranteed. Inspect all relevant:

- code paths and public contracts;
- adapters and process lifecycle handling;
- integrations and call sites;
- configuration and version-sensitive behavior;
- persistence or later persistence integrations that now affect Phase 1 behavior;
- workspace/Git safety mechanisms;
- validation and proof logic;
- error mapping, redaction, cancellation, cleanup, and recovery paths;
- unit, integration, regression, acceptance, fixture-based, and opt-in live-test boundaries;
- later-phase changes that could weaken, bypass, duplicate, or contradict Phase 1 guarantees.

Look beyond existing tests. Passing tests are evidence, not proof of correctness. Read implementations and realistic end-to-end control flow, compare tests with production behavior, and reason about what occurs at boundaries, under interruption, and after partial failure.

Actively search for:

- missing or incomplete implementation;
- acceptance criteria that are only partially satisfied;
- violated or weakened invariants;
- architectural drift;
- regressions introduced by later phases;
- incorrect assumptions;
- integration failures;
- lifecycle and state-transition bugs;
- persistence and recovery problems;
- weak or missing validation;
- incorrect failure handling;
- boundary-condition failures;
- meaningful edge cases;
- behavior that passes isolated tests but fails in realistic workflows.

Pay particular attention to fail-closed behavior and trust boundaries. Agent prose or an agent-reported completion must never certify success. Structured process/adapter evidence, workspace integrity, deterministic acceptance evidence, termination confirmation, redaction, bounded diagnostics, and cleanup must remain correct under malformed output, cancellation, hangs, process failures, unsafe workspace changes, and later orchestration integration.

## Findings standard

Distinguish clearly between:

- **Confirmed defect:** repository evidence demonstrates that a Phase 1 requirement, acceptance criterion, invariant, architectural boundary, lifecycle guarantee, failure semantic, or intended observable behavior is absent, incorrect, bypassable, or materially under-specified in executable behavior.
- **Speculative concern:** a risk is conceivable but current evidence does not demonstrate a violation. Investigate further where practical, but do not present speculation as a confirmed defect and do not make speculative production changes.

Do not treat stylistic preference, later intentional behavior, or a feature outside original Phase 1 scope as a defect. Preserve intentional later-phase behavior unless it conflicts with a required Phase 1 invariant or acceptance criterion.

## Fix requirements

Fix every confirmed defect that falls within Phase 1's intended requirements. Keep changes narrowly scoped to restoring or strengthening the original guarantee and the current integration that must uphold it. Do not begin unrelated roadmap work or broaden product scope.

For every confirmed defect, add or strengthen regression tests wherever practical. Tests must target the underlying failure mode rather than merely assert an implementation detail. Update documentation or contracts when the corrected guarantee requires it.

If a confirmed defect cannot be safely fixed within the available repository state or authorization, do not conceal it. Preserve evidence, explain the blocker, and return `FAIL`.

## Validation and reinspection

After fixes, run the relevant unit, integration, regression, and Phase 1 acceptance validation. Also run the repository-wide gate when practical and required by repository instructions. Live or paid-agent checks must remain opt-in; do not fabricate live evidence. If an environment restriction blocks a material validation command, retry through the permitted authorization path when appropriate. If material validation remains incomplete, account for that in the final gate.

After validation, reinspect every affected production path and its callers. Confirm that each fix restores the underlying guarantee in realistic flow and does not merely make a test pass. Review the final diff for scope, security, redaction, lifecycle correctness, and preservation of later-phase behavior.

Do not commit, tag, or push unless the governing repository instructions unambiguously require those actions for this audit itself. Never force-push.

## Required final report

At the end, provide:

1. A concise summary of what was reviewed.
2. Every confirmed finding and its resolution. If none, say so explicitly.
3. Any remaining uncertainty or unverified assumption.
4. Validation performed and its results, including any skipped or blocked validation and why.
5. A final gate on its own final line.

The final gate must be **exactly one** of:

`PASS — Cleared for release.`

Use PASS only if the available evidence supports that Phase 1's requirements, acceptance criteria, invariants, architecture, and intended behavior remain correctly implemented in the current codebase and no confirmed release-blocking issue remains.

`FAIL — Issues remain; deeper fixes are required.`

Use FAIL if any confirmed issue remains unresolved, required behavior cannot be demonstrated with sufficient confidence, or validation is incomplete in a way that materially affects release confidence.
