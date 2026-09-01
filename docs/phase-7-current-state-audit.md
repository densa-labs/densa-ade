# Phase 7 current-state audit

Date: 2026-09-01

Audited current revision: `500e52431ae7fb42319ae3104f543bd8c0dd92d0` plus the repairs recorded by this audit

Sealed prompt: `docs/phase-7-current-state-audit-prompt.md`

Prompt SHA-256: `53bf87510150a54910ea7920e837db58fb67cca12f15382ab450f07b83ad077a`

## Review summary

The audit recovered Phase 7 Milestones 0-5 from `MASTER_ROADMAP.md`, their original milestone
commits (`751e38a`, `c9aae9c`, `c6c1d96`, `cae5493`, `11aa231`, and `7101caa`), the
`densa-phase-7-complete` checkpoint, the engineering constitution, and the Phase 7 architecture
documents. It reconstructed the intended contracts for reliable usage-limit classification,
conservative auto-resume, centralized authorization, opaque secret references and redaction,
Core-owned macOS keep-awake, and authenticated local daemon IPC.

Those contracts were traced through the current adapter, transition and recovery services,
scheduler and task/phase orchestrators, SQLite settings/events/decisions, roadmap mutation and
project-decision integrations, secret store and child-process boundary, keep-awake platform and
execution control, protocol schemas, daemon/CLI lifecycle, reconnect/replay behavior, and later
Core-v1 integrations. Existing tests and historical completion were treated as evidence rather than
proof. Adversarial scenarios exercised cross-operation approval reuse, malformed persisted recovery
state, secret-shaped metadata, truncated secret syntax, daemon-owned keep-awake recovery, and
concurrent daemon startup.

## Reconstructed contract and current traceability

| Phase 7 area                     | Required guarantee                                                                                                                                                                                                                            | Current authoritative paths and evidence                                                                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Usage classification and waiting | Only corroborated provider-neutral `limited` evidence may enter durable `WAITING_FOR_USAGE`; unknown/auth/process failures stay distinct and reset times are never fabricated.                                                                | Codex adapter classification, task/orchestration transition boundary, persisted settings/events, recovery inspector, fixture and lifecycle tests.             |
| Conservative auto-resume         | Explicit opt-in, durable bounded schedule/backoff, no early timer-only resume, and revalidation of Core state, workspace/Git, pending decisions, permissions, recovery, and backend availability.                                             | `UsageAutoResumeService`, scheduler/recovery/workspace probes, execution modes and rundowns, fake-clock/restart/divergence regressions.                       |
| Permission policy                | One Core domain service owns Cautious/Standard/Autonomous decisions; dangerous categories remain non-overridable; ask/deny and explicit overrides are durable; authorization is project/operation bound.                                      | `PermissionPolicyService`, project decisions, roadmap mutations, secrets, orchestrators, SQLite decisions/events, preset and adversarial authorization tests. |
| Secrets and redaction            | Only opaque project-scoped references persist; Keychain values use stdin, child injection is minimal and scoped, secret use is permission-gated and audited without values, and revoke is explicit.                                           | `SecretService`, macOS/fake stores, `SecretRedactor`, task packets and event boundaries, child-process and serialized-evidence regressions.                   |
| Keep-awake                       | Core owns idempotent project/reason lifecycle, requests idle-system sleep prevention only, honors battery evidence/threshold, cleans up on stop/shutdown, recovers stale assertions, and exposes authoritative status.                        | `KeepAwakeManager`, macOS/fake platforms, execution control, daemon startup/shutdown and `keep-awake.status`, lifecycle/recovery/socket tests.                |
| Secure daemon and IPC            | A durable editor-independent daemon uses a private Unix socket and rotating credential, validates bounded versioned frames, rejects invalid auth/version, supports readers/replay/reconnect, and safely recovers stale or concurrent startup. | `CoreDaemon`, protocol envelopes/schemas, daemon client/CLI, SQLite event journal, real Unix-socket and process-lifecycle tests.                              |

The architecture remains consistent with Core authority: UI/CLI clients request or observe state,
while SQLite-backed Core services own mutation, recovery, permission, secret, keep-awake, and daemon
lifecycle decisions. Intentional later changes to Core-v1 methods and event pagination preserve the
Phase 7 security and durability boundaries.

## Confirmed findings and resolutions

1. **A persisted user decision could authorize an unrelated sensitive operation.** Permission
   authorization checked only that an active user decision belonged to the same project. A decision
   for one ask-user category could therefore be supplied to secret access, remote push, or another
   operation. Authorization now requires the decision ID and exact persisted approval category as a
   pair, verifies decision kind/source/status/project/category transactionally, and still issues a
   project-and-operation-bound context. Secrets, project decisions, and roadmap mutation callers now
   pass their exact category. A regression proves cross-category and cross-operation reuse fails.

2. **Malformed persisted auto-resume state silently appeared disabled.** Invalid project/task IDs or
   a relative workspace path parsed as no state, and restore/cancel/disable/wait paths returned
   benign disabled or cancelled outcomes. These paths now distinguish absent configuration from a
   malformed persisted value and fail closed with `BLOCKED`, including state corruption during an
   active probe. Parsing validates branded identifiers and an absolute workspace path. Restart
   regressions cover malformed persistence.

3. **Phase 7 lifecycle metadata could retain secret-shaped input.** Usage auto-resume actors and
   keep-awake reason/actor fields crossed into SQLite settings and audit events without the shared
   redaction boundary. They are now redacted at ingress and again defensively when state/events are
   persisted; generated error and blocked reasons are also redacted. Regression fixtures prove the
   raw values do not survive serialization.

4. **The shared redactor leaked realistic interrupted or quoted forms.** JSON-style quoted
   assignments and unterminated explicit secret/private-key markers could bypass the original
   patterns. Redaction is now quote-aware and fail-closed for truncated markers and private-key
   blocks, with broader known-token coverage. Regression cases cover each boundary.

5. **Keep-awake recovery and status were not integrated into the daemon lifecycle.** The manager
   implemented recovery and protocol status types, but daemon startup did not recover stale
   assertions and no daemon method exposed status. The daemon now owns the shared manager used by
   execution control, recovers it before listening, disposes it during shutdown, and serves a
   schema-validated `keep-awake.status` request. A real-socket test seeds stale state and proves the
   recovery event and authoritative inactive response.

6. **Concurrent daemon starters could damage the winning instance.** Startup had no atomic owner.
   Two processes could both pass stale-state recovery, after which the losing starter's cleanup could
   remove token/PID/socket paths created by the winner. Startup now uses a private exclusive lock
   containing instance/PID/time metadata, rejects live owners, recovers dead locks, holds ownership
   through listen, and removes only its own lock. A concurrent-start regression proves exactly one
   authenticated owner survives.

All confirmed findings are resolved. No speculative concern was represented as a defect.

## Validation

- The sealed prompt remained unchanged after construction: 119 lines, SHA-256
  `53bf87510150a54910ea7920e837db58fb67cca12f15382ab450f07b83ad077a`.
- Focused permission, usage auto-resume, keep-awake, secret/redaction, roadmap mutation, and roadmap
  revision regressions passed: 47 tests, 0 failed.
- The real Unix-domain daemon suite passed: 7 tests, 0 failed. It covered credentials and protocol
  rejection, replay/subscription, stale state, CLI lifecycle, concurrent startup, and daemon-owned
  keep-awake recovery/status.
- `npm run check` passed formatting, build, TypeScript checking, ESLint, pretest compilation, and the
  complete repository test corpus: 435 tests, 432 passed, 3 skipped, 0 failed, exit code 0.
- The three skips are documented opt-in live Codex/provider checks. Current deterministic fixtures
  exercise the relevant Phase 7 structured classification and failure contracts.
- Final clean build/typecheck, candidate-diff checks, and post-validation reinspection are recorded
  in the release handoff after this report is sealed.

## Remaining uncertainty

- The default gate does not invoke a live paid/authenticated Codex account. Reliable structured
  usage, authentication, unknown-failure, and cancellation behavior is exercised with local fixtures
  and fakes; no Phase 7 guarantee relies only on live-provider prose.
- Routine tests use fake Keychain, power, and `caffeinate` boundaries so they do not modify host
  credentials or sleep policy. The real supported-host daemon and Unix-socket lifecycle is exercised;
  platform command construction, scoped stdin/environment, battery decisions, and assertion cleanup
  are deterministic contract tests. This does not block the recovered Phase 7 acceptance criteria.

## Densa Core integration-audit prerequisite

The whole-Core integration audit was not started. Current-state PASS reports now exist for Phases
1-7, but the repository does not contain equivalent reports for Phases 8 and 9. Historical phase
tags and passing tests do not satisfy the user's prerequisite. The sealed whole-Core prompt must be
constructed and executed only after both remaining phase audits pass.

## Final gate

PASS — Cleared for release.
