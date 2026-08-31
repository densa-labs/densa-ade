# Phase 2 current-state audit — 2026-08-31

## Scope and execution

The complete [audit prompt](./phase-2-current-state-audit-prompt.md) was constructed before the audit
began and executed in the same task. The target was the current working tree based on
`0af532d127a5e964b9ad6d449ddeb9079ffad918` (P9M2), including pre-existing Phase 0/1 audit changes.
Those changes were preserved. No milestone, branch, tag, commit, or remote was created or rewritten.
This is a release audit of Phase 2 guarantees, not a declaration that all later phases are audited.

The contract was recovered from `AGENTS.md`, `MASTER_ROADMAP.md` P2M0–P2M4, the original milestone
commits (`e7f2dbe`, `689e4a4`, `95bb78c`, `027076f`, `181d0d4`), and their architecture documents.
`MASTER_ROADMAP.md` is present locally but absent from the historical Phase 2 Git tree; original
milestone source, tests, documentation, and historical implementation notes provided the historical
cross-check. Historical completion claims and test counts were not used as current proof.

Intentional evolution was preserved: `.densa-ade/` is the current portable namespace; legacy run
branches/report paths remain readable; later structured specifications, Master roadmaps, decisions,
validation evidence, reports, usage waiting, and secure IPC remain authoritative Core integrations.
Gate B is formally a post-Phase-3 gate; its restart and workspace-safety guarantees were checked
through the existing Phase 3 and headless integration tests rather than relabeling its scope.

## Requirement-to-current-evidence map

| Original requirement and intended observable behavior                                                                                                                                                                                                                       | Current implementation and verification                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2M0: explicit canonical project/phase/task transitions; reject illegal jumps with stable codes; no public direct status setter; immutable snapshots; interruption/waiting/pause/block paths; append-ready accepted transitions                                             | `state-transitions.ts`, protocol `states.ts`/`domain.ts`, and `database.ts`; exhaustive transition matrices plus forged transition, event scope, stale cycle, immutable collection, rollback, and current orchestration regressions. SQL lifecycle updates remain confined to the centralized persistence boundary.                                                                    |
| P2M1: authoritative editor-independent SQLite; all originally required tables/repositories; explicit migrations and relational constraints; consistent timestamps; transactions and restart round trips; atomic state/event writes; no prompt/transcript columns by default | `persistence/{migrations,sqlite-connection,repositories,database}.ts`; zero-to-15 migration, older-schema upgrades, checksum rejection, canonical creation, graph/FK tests, transaction rollback, restart/reopen integration, and stable persistence errors. Later migrations and namespace compatibility were retained unchanged.                                                     |
| P2M2: append-only versioned facts; deterministic per-project insertion sequence; replay after exclusive N; project/phase/task/type filters; bounded payloads/replay; publication only after commit                                                                          | `event-journal.ts`, `event-publisher.ts`, repositories and transaction hooks; ordering/filtering/bounds/append-only-trigger tests, autocommit and transaction reentrancy, savepoint rollback, payload isolation, and newest matching event beyond the first replay page. Current daemon and Core v1 replay/reconnect contracts were also validated.                                    |
| P2M3: deterministic readable project/spec/roadmap/decision/config export; reports/log directories; SQLite authority; missing-folder recreation; atomic replacement; preserve human edits; no secret-like fixture values in output                                           | `portable-project.ts`, later spec/roadmap/decision renderers and phase-report synchronization; deterministic export, conflict preservation, missing directory, secret marker/token redaction, symlink rejection, and interruption-before-rename tests. Later phase reports remain regenerated from SQLite through their existing report synchronization boundary.                      |
| P2M4: compare durable lifecycle/process/checkpoint/event/workspace facts after restart; distinguish idle, live worker, missing worker, interrupted validation, diverged workspace, unknown; never perform destructive recovery or guess outcomes                            | `recovery-inspector.ts`, run/checkpoint and rollback services, current task orchestration, execution controls, and usage resume; abrupt-boundary fixtures, actual local child PID/identity and termination observations through reopened databases, validation reopen, inactive orphan detection, stale observation, future state version, offset ordering, and Git index regressions. |

Later callers inspected included scheduler readiness, task/phase completion and validation evidence,
atomic task commits, bounded rollback, execution modes and controls, usage waiting/resume,
specification/roadmap/decision mutations, portable phase reports, Core daemon/CLI, and Core v1 replay.
The full acceptance suite exercises their persisted integration; passing isolated tests alone was
not used to establish these guarantees.

## Confirmed findings and resolutions

All findings below are resolved in the working tree. No confirmed release blocker remains.

1. **Persistence accepted fabricated lifecycle changes and misattributed events.** A caller could
   construct a `PENDING → COMPLETED` transition or attach an otherwise valid fact to another entity.
   Persistence now reruns the domain transition using the current authoritative row inside the
   transaction and compares the full result before writing. Regression coverage spans all three
   entity types and verifies no rejected event or state update survives.
2. **A state cycle could revive a stale transition.** The old predicate checked only the previous
   state; returning to that state made an older snapshot acceptable again. Transitions now retain
   `previousUpdatedAt`, and full authoritative comparison rejects the stale cycle.
3. **Task snapshots had mutable criteria/dependency arrays.** The enclosing object was frozen,
   but its nested arrays could change after validation. Protocol parsing now freezes both arrays;
   regression tests verify mutation is rejected.
4. **Reentrant event writes reordered notifications.** Autocommit writes and subscriber-created
   transactions could deliver a newer sequence before older committed events to other subscribers.
   One shared post-commit queue now preserves order across both paths; multi-subscriber and nested
   rollback regressions cover this.
5. **Subscribers could mutate another subscriber's event payload.** The persisted wrapper was
   frozen but nested payload values were not. Read/delivery now recursively freezes payloads, so
   subsequent subscribers observe the durable fact unchanged.
6. **Current orchestration never persisted actual worker process metadata.** Original recovery
   fixtures supplied PIDs that the real integration never recorded. Local adapter start events now
   expose an optional PID; Core captures an opaque OS identity and atomically persists process
   metadata plus its audit fact before notifying observers. Adapter and orchestration/reopen
   regressions cover live and terminated local fixture processes; no paid model is invoked.
7. **Recovery confused worker completion with attempt completion.** It rejected a finished worker
   while independent validation was still pending, and treated a completed pre-worker attempt as
   indefinitely unfinished. Those distinct lifecycle intervals are now handled explicitly; a
   validation record bound to another attempt is rejected. Current orchestration is inspected
   through a reopened database during validation, without marking the attempt successful.
8. **Asynchronous probes could return plans based on stale authoritative state.** A project could
   become running during a workspace observation while the inspector still returned idle. Recovery
   now checks durable evidence before and after inspection and returns `UNKNOWN` on changes or probe
   failures. The race and throwing-probe regressions preserve read-only behavior.
9. **Git index-only changes were invisible to workspace fingerprints.** Different staged contents
   could share the same `HEAD`, status, and working-file diff. The staged binary diff is now included
   when nonempty; a real temporary Git repository reproduces this edge case.
10. **Timestamp offsets could select an older checkpoint as the latest.** Listings sorted timestamp
    text rather than chronological instants. Relevant validation/checkpoint and portable history
    listings now order by SQLite timestamp instant, with deterministic ID ties. A mixed-offset
    recovery regression demonstrates the corrected checkpoint selection.
11. **An inactive task's orphaned worker was ignored when another task was active.** Recovery now
    checks unfinished inactive histories before returning a plan for the active task, preserving
    the single-worker invariant. A two-task orphan regression verifies `UNKNOWN`.
12. **An unrelated later event could hide a contradictory lifecycle fact.** Recovery formerly
    examined only the project's last event. It now retrieves the newest state fact for each project,
    phase, and task and rejects contradictions or unsupported state-event versions. Repository
    lookup is bounded and selects the newest matching fact beyond the first replay page.
13. **Portable export leaked explicitly marked secrets.** Later-phase `<secret>` markers were not
    recognized by the original portable redactor. Closed and unterminated explicit markers are now
    removed before writing; export regressions verify the canary values never reach disk.
14. **SQLite open/constraint failures escaped the stable error taxonomy.** Failed database opening
    and repository writes exposed native SQLite errors instead of `PERSISTENCE_FAILURE`. Open,
    query/write, and transaction-control errors now use the stable persistence code, retain their
    local cause, and avoid including SQL/parameters in public messages. The roadmap rollback test
    still verifies the exact underlying unique-event constraint as well as rollback.

## Validation and reinspection

- Targeted pre-fix regressions demonstrated fabricated transitions, event reordering and payload
  mutation, validation/pre-worker misclassification, stale recovery, index invisibility, offset
  ordering, inactive orphans, hidden lifecycle contradictions, explicit secret leakage, and
  unclassified database-open failures.
- An intermediate focused suite passed all 91 tests, including current orchestration/reopen
  integration with local process inspection enabled.
- An intermediate `npm run check` passed formatting, build, typecheck, lint, and 350 tests, with
  three intentional opt-in live-agent skips. Final results after additional boundary tests are
  recorded below.
- Final code reinspection followed transaction locks, authoritative transition reconstruction,
  post-commit callback ownership, nested rollback, immutable payload reads, process metadata
  persistence, validation/attempt associations, recovery evidence rechecks, scoped event queries,
  Git index hashing, and portable redaction. No migration or historical event was edited.

## Remaining uncertainty and compatibility limits

- Live paid-agent scenarios were intentionally not run. Process/recovery integration uses an actual
  local fixture child and temporary SQLite/Git workspaces; it is not evidence of a live Codex model
  session or a physical machine power-loss test.
- Old runs lacking process identity remain conservatively unknown when identity is needed. A process
  may exit before identity capture; Core preserves the PID and does not fabricate identity.
- Existing fingerprints made with staged changes may now report divergence and require reinspection.
  Clean-index fingerprint compatibility is preserved. No old checkpoint is silently rewritten.
- SQLite and atomic filesystem guarantees depend on the local OS/filesystem honoring their documented
  transaction, rename, and flush behavior. Concurrent hostile filesystem replacement is not treated
  as a capability this local same-user export protocol can defeat.
- Arbitrary unmarked credentials cannot be recognized reliably; secret values must remain in approved
  stores and referenced as metadata. The tested explicit markers and known credential shapes are
  redacted, and raw prompt/transcript fields are not part of Phase 2's default schema.
- The prompt and report apply to the reviewed working tree. They do not certify an unchanged remote
  release artifact, all future edits, or the entirety of Phases 3–9.

Final validation: `npm run check` passed formatting, build, typecheck, lint, and the complete
357-test run: **354 passed, 0 failed, 3 intentional opt-in live-agent skips**. The final run includes
Core daemon/IPC and browser checks, migration/transaction tests, current headless continuous
recovery workflows, and the added local child termination/reopen regression. Local process/socket
access was authorized for these checks; no required deterministic suite was skipped.

PASS — Cleared for release.
