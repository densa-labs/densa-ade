# Audited roadmap mutations

Phase 4 Milestone 3 makes roadmap evolution a single Densa ADE Core operation instead of an ad hoc
object or Markdown edit. SQLite stores the authoritative versioned `MasterRoadmap`; the portable
`ROADMAP.md` remains an inspectable projection and never authorizes a state change by itself.
Initial persistence requires a ready structured specification and preserves its project goal
byte-for-byte. It installs the canonical roadmap and runtime phase/task rows in one transaction;
new rows always begin PENDING. All dependency targets are installed before the edges, so valid
same-phase forward references do not depend on insertion order.

## Operations and graph safety

`RoadmapMutationService` accepts strict, model-neutral operations for adding, splitting, and
reordering tasks; replacing dependencies or acceptance criteria; adding or removing phases;
changing architecture-related task details; and marking a task superseded. Superseded tasks become
non-executable and name the tasks that replace them.

Core applies exactly one operation to a copy of the current roadmap and reparses the complete
result through `masterRoadmapSchema` before writing anything. Duplicate or missing IDs, dependency
cycles, empty required phases, invalid supersession targets, and executable tasks without concrete
acceptance criteria or validators therefore fail without advancing the authoritative revision or
appending audit history. A task split replaces downstream dependency references with all
replacement task IDs so the caller cannot accidentally leave a dangling source ID.
No-op requests are rejected instead of creating misleading `ROADMAP_CHANGED` facts.

Splits inherit the source task's incoming dependencies. Core includes indirectly shifted tasks in
the affected IDs, so inserting/reordering work cannot evade an active-task boundary check.

## Classification and approval policy

Every accepted mutation is classified `MINOR`, `SIGNIFICANT`, or `SCOPE`. Core enforces conservative
minimums:

- task additions, splits, reorders, dependency changes, and additive acceptance-criteria changes
  begin as `MINOR`;
- phase additions and architecture-detail changes are at least `SIGNIFICANT`;
- phase removals, task supersession, and removal of an existing acceptance promise are `SCOPE`.

Callers may elevate a classification but cannot lower these floors. `MINOR` changes may auto-apply.

Splits that discard existing acceptance promises or expected validator categories are SCOPE;
removing expected validators through architecture details is also SCOPE. A promise-preserving
split remains MINOR. This prevents an alternate operation from bypassing the acceptance policy.
`SIGNIFICANT` changes auto-apply only when the persisted
`allowSignificantRoadmapMutationAutoApply` project setting is exactly `true`; otherwise they require
approval. `SCOPE` changes always require explicit approval evidence, including in Continuous mode.
Approval names a durable project decision plus approving actor, timestamp, and session. Core
verifies that it is an active user decision for the exact inspected mutation. Direct clients obtain
`preview().approvalCategory`, a digest binding project, revision, before snapshot, and parsed
operations, and record that category on the approval decision. Approval timestamps must match the
decision. Generic, unrelated, stale, and replayed approvals are rejected. Master workflow approvals
remain bound to their durable proposal IDs; the supplied proposal must exactly equal the stored
one. Legacy generic approvals must be renewed for the inspected change, never silently reused.

## Persistence, events, and portable recovery

Migration 8 adds `master_roadmaps` with an optimistic revision number and extends roadmap revision
rows with session, typed operation, and optional approval evidence. One SQLite transaction:

1. replaces the expected authoritative roadmap revision;
2. stores the full before/after roadmaps, rationale, classification, actor/session, affected IDs,
   operation, and approval evidence;
3. appends version 1 `ROADMAP_CHANGED`.

The same transaction reconciles runtime task/phase positions, titles, dependencies, and acceptance
criteria. Existing states remain authoritative; accepted supersession cancels only inactive,
nonterminal retired tasks through `StateTransitionService`, retaining their events and attempts.
Actual outstanding decision/permission gates remain enforced. An event/constraint failure rolls
back the canonical graph, runtime projection, cancellation, proposal, and revision together.

Active tasks (including unfinished preparation/recovery attempts) cannot change. Completed promises
and validating/approved/completed phase snapshots cannot be rewritten. Non-PENDING phases cannot
move, which prevents insertion from stranding earlier work. Historical tasks/phases cannot be
deleted or moved across phases; use explicit replacement/supersession while preserving history.
Changes to inactive work in a RUNNING phase remain supported: the phase executor reloads the graph
at each task boundary and rechecks completion immediately before entering VALIDATING.
New incomplete dependencies cannot silently leave a previously READY task eligible; Core rejects
that mutation until the task returns to a non-ready planning state through centralized transitions.

An outdated writer cannot replace a newer revision. Event subscribers observe the change only
after commit. The service then runs `PortableProjectSynchronizer`, which regenerates `ROADMAP.md`
with the current canonical graph and complete mutation history. If a human changed a managed file,
the authoritative mutation remains durably audited and synchronization returns a conflict without
overwriting the human edit; the normal portable-sync recovery path can regenerate the file after
that conflict is resolved. A filesystem failure is returned as an explicit post-commit portable
sync failure rather than making the accepted database mutation look uncommitted or safe to replay.

Direct mutation actor, rationale, session, and approval metadata are redacted before durable
revision history is written, matching the Master workflow boundary.

## Verification

`scripts/roadmap-mutations.test.mjs` covers every operation, graph-invalid proposals, classification
floors, significant-policy behavior, the Continuous-mode scope gate, acceptance-criteria weakening,
approval decision validation, atomic roadmap/revision/event persistence, and portable Markdown
regeneration and round-trip parsing.
