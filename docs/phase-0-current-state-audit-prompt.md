# Densa ADE Phase 0 Current-State Audit and Remediation Prompt

You are Codex operating in the Densa ADE repository at:

`/Users/ivanuy/Desktop/Projects/active-projects/densa-ade`

Audit **Phase 0 against the current repository state**, not merely against the implementation that existed when the phase was originally completed. Execute this prompt immediately after it is fully constructed. Do not begin Phase 1 or any later milestone.

## 1. Global audit rules

### 1.1 Authority and source-of-truth order

Resolve conflicts and later amendments using this order:

1. the user's current audit request and explicit scope limits;
2. the current repository `AGENTS.md` and any applicable nested instructions;
3. the current `MASTER_ROADMAP.md`, `MODEL_POLICY.md`, current architecture and protocol documentation, and deliberate later amendments;
4. the original Phase 0 milestone prompts, acceptance criteria, implementation commits, phase tag, tests, and release evidence;
5. current implementation and tests as evidence of behavior, but never as authority to silently weaken a requirement;
6. historical reports and memory only as discovery leads, never as current proof.

When sources conflict, record the conflict. Treat a later change as a valid supersession only when authoritative evidence shows it deliberately replaced the earlier requirement without weakening a still-applicable invariant. Do not infer supersession merely because code drifted.

### 1.2 Fresh, sealed, evidence-driven audit

- Treat this prompt as fully constructed before implementation inspection begins.
- Capture the exact starting commit and tree, branch/upstream, authoritative remote SHA, working-tree state and ownership, toolchain/runtime, and validation environment.
- Preserve all pre-existing user or concurrent work. Never reset, clean, overwrite, amend, squash, force-push, or otherwise destroy unrelated work.
- Build a requirement-source inventory and a requirement-to-evidence ledger before deciding the gate.
- Audit current production flows and later integrations, not only historical files or tests.
- Passing historical tests and phase tags are discovery evidence, not proof of the current state.
- Do not use synthetic fixtures or fakes as real-agent or real-user evidence.
- Keep confirmed facts, disproven concerns, speculative risks, out-of-scope defects, and remaining uncertainty distinct.
- Assign every suspected issue a stable finding ID and record its disposition; do not silently drop concerns.

### 1.3 Findings and severity

A **confirmed defect** is demonstrated repository or runtime evidence that a still-applicable requirement, acceptance criterion, invariant, architectural boundary, lifecycle guarantee, failure semantic, compatibility contract, or intended observable behavior is absent, incorrect, bypassable, or materially under-specified in executable behavior.

A **disproven concern** is a plausible suspected issue that inspection or execution shows is not currently a violation.

A **remaining uncertainty** is material behavior that could not be verified, an assumption that remains unproven, or an unresolved specification conflict. Do not promote uncertainty to a confirmed defect without evidence, and do not hide it to obtain PASS.

Use release-oriented severity:

- **Critical:** immediate security, integrity, or destructive-data risk.
- **High:** a core Phase 0 guarantee is absent or realistically bypassable; normally release-blocking.
- **Medium:** material but bounded incorrectness or compatibility/lifecycle failure.
- **Low:** limited impact that still violates an explicit requirement.

### 1.4 Remediation discipline

- Fix every confirmed in-scope Phase 0 defect.
- Determine and record the violated requirement and root cause first.
- Prefer a red-to-green regression test where feasible.
- Apply the smallest architecturally correct fix; do not broaden scope or begin later roadmap work.
- Add or strengthen coverage for the underlying failure mode, not just an implementation detail.
- Reinspect the production path and callers after the fix.
- Perform a cross-gate impact review for earlier or later guarantees the fix may affect.
- If a confirmed defect cannot be safely fixed with current authority or repository state, preserve the evidence and return FAIL.

### 1.5 Validation standard

Run all validation relevant to Phase 0 and any cross-cutting repair, including focused regressions plus repository-wide validation. Where applicable run clean dependency/build/typecheck/test validation, protocol contract checks, CLI process and exit-code checks, daemon/IPC lifecycle checks, failure paths, editor-independence boundary checks, `git diff --check`, and a clean or clean-equivalent validation.

Do not weaken or skip tests to pass. Live/paid Codex checks remain opt-in. If a material test is blocked by sandbox restrictions, retry with the permitted authorization path. Record exact commands, exit status, totals, skips, failures, material warnings, and environment limitations. A narrow test cannot substitute for the broad gate after a cross-cutting fix.

### 1.6 Publication and progression

- Do not begin the next gate or next phase.
- Record progression status separately from the Phase 0 gate.
- Record publication status separately, including whether an audit commit/tag/push was created.
- Never force-push, rewrite, or publish a partial/failed audit as complete.
- Any permitted audit snapshot must include only audit-owned paths after exact staged-diff and secret/runtime-artifact review; preserve unrelated work.

## 2. Audit target

Audit **Phase 0 against the current repository state, not merely against the implementation that existed when the phase was originally completed.**

Phase 0 is expected to encompass all milestones currently titled under **Constitution, Contracts, and Repository Foundation**, but recover the exact contract from authoritative sources rather than relying on that shorthand.

## 3. Reconstruct the phase contract

Recover and review Phase 0's original:

- requirements;
- acceptance criteria;
- invariants;
- architectural intent;
- lifecycle expectations;
- failure semantics;
- intended externally observable behavior;
- documented dependencies on earlier phases;
- assumptions later phases were allowed to rely on.

Build the requirement-source inventory and requirement-to-evidence ledger before deciding whether the phase passes. Explicitly identify intentionally superseded requirements and the evidence authorizing each supersession.

## 4. Trace every applicable requirement into the current implementation

For every still-applicable material requirement:

- identify the current implementation path;
- identify state and ownership boundaries;
- identify trust and process boundaries where relevant;
- identify persistence behavior where relevant;
- identify integration points;
- identify configuration involved;
- identify tests and validation supporting the guarantee;
- identify later-phase changes that could have affected it;
- determine whether the requirement is still genuinely guaranteed in the current repository state.

Inspect all relevant code, integrations, configuration, persistence and recovery mechanisms, validation, tests, process boundaries, later-phase changes, and release/runtime paths touched by Phase 0.

At minimum, recover and examine the current form of these Phase 0 pillars:

- repository/workspace and editor-independence foundation;
- versioned domain and local IPC contracts, including deliberate later protocol supersessions and compatibility/fail-closed behavior;
- the headless Densa ADE CLI shell, current Core boundary, exit semantics, output behavior, lifecycle, and warning-free lightweight commands.

## 5. Active investigation

Actively search for missing/incomplete behavior, partial acceptance, weakened invariants, architectural drift, later-phase regressions, incorrect assumptions, integration or lifecycle failures, invalid state transitions, persistence/recovery failures, stale or partial state, weak validation, incorrect failure handling, boundary conditions, platform-specific failures, public API/CLI/configuration compatibility regressions, and isolated-test success that fails in realistic workflows.

For each concern:

1. assign a finding ID;
2. identify the potentially violated requirement;
3. inspect the implementation and integration path;
4. reproduce or otherwise confirm/disprove it where practical;
5. classify and record its disposition;
6. fix and regression-test it if confirmed and in scope.

## 6. Required final report

Write `docs/phase-0-current-state-audit.md` as a standalone evidence record and report these sections in this order:

### Audit baseline

Exact starting commit/tree; branch and upstream; authoritative remote target SHA; working-tree ownership classification; relevant toolchain/runtime; validation environment.

### Phase contract

Recovered requirements and any intentionally superseded requirements with evidence.

### Requirement-to-evidence summary

For every material requirement: requirement ID; status; implementation path; validation/evidence; remaining uncertainty.

### Confirmed findings

For every confirmed finding: finding ID; violated requirement; severity; root cause; affected files/components; fix; regression coverage; final verification.

### Disproven concerns

Every meaningful suspected issue investigated and disproven.

### Confirmed out-of-scope defects

Any confirmed defect outside primary Phase 0 scope and its disposition.

### Remaining uncertainty

Every remaining uncertainty, unverified assumption, validation limitation, or specification conflict.

### Validation

Exact commands and results, including exit status, test totals, skips, failures, warnings, and environment limitations.

### Final diff and side-effect review

All audit-related changes; exact scope/security review; confirmation that unrelated user work was preserved.

### Exact final audited state

Final tree identity and resulting commit SHA if one was created.

### Final gate

Exactly one of:

`PASS — Cleared for this gate.`

`FAIL — Issues remain; deeper fixes or decisions are required.`

Then record progression status and publication status separately. If FAIL, stop and do not continue to the next gate.
