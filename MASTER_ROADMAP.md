# Densa — Master Roadmap

> **Purpose:** This file is the implementation roadmap for Densa v0.1.
>
> **Hierarchy:** `Phase → Milestone`.
>
> Each milestone below is intentionally written as a **standalone copy-paste prompt** for a coding agent. Run milestones in order unless a milestone explicitly says otherwise.
>
> **Before every milestone:** the agent must read `AGENTS.md` and obey it.

---

# Product target

Densa v0.1 is a **macOS-only, local-first, Code - OSS-based AI development IDE** with:

- Codex as the first worker backend;
- a separate editor-independent Densa Core process;
- idea → adaptive interview → complete roadmap → execution;
- Guided, Phase-by-phase, and Continuous execution modes;
- independent validation;
- Git checkpoints and task commits;
- crash recovery;
- `WAITING_FOR_USAGE` and auto-resume when usage becomes available;
- built-in macOS keep-awake;
- Master Agent, Roadmap, Dashboard, and normal Editor surfaces;
- Open VSX;
- telemetry off by default;
- no cloud account, billing, collaboration, remote workers, or additional agent providers in v0.1.

## Global architecture

```text
┌───────────────────────────────────────────┐
│                Densa IDE                  │
│             Code - OSS fork               │
│                                           │
│ Editor | Dashboard | Roadmap | Master     │
└──────────────────┬────────────────────────┘
                   │
            versioned local IPC
                   │
┌──────────────────▼────────────────────────┐
│                Densa Core                 │
│                                           │
│ project/state       scheduler             │
│ roadmap             policy                │
│ validation          recovery              │
│ Git/workspace       event journal         │
│ context             agent adapters        │
└──────────────────┬────────────────────────┘
                   │
               CodexAdapter
                   │
                   ▼
               Codex CLI
                   │
                   ▼
              User workspace
```

## Hard sequencing rule

**Do not begin the Code - OSS fork integration until the headless Densa Core can complete a real one-phase project loop.**

The UI is not the product proof. The reliable orchestration loop is.

---

# Phase 0 — Constitution, Contracts, and Repository Foundation

## Phase 0 Milestone 0 — Bootstrap the Densa repository

### Copy-paste prompt

```text
You are implementing Densa Phase 0 Milestone 0.

Read AGENTS.md completely before changing anything.

Goal:
Create the clean repository foundation for Densa Core without implementing agent execution yet.

Requirements:
1. Use TypeScript + Node.js.
2. Establish a workspace/monorepo layout that can support:
   - packages/core
   - packages/protocol
   - packages/agent-sdk
   - packages/cli
   - packages/testing
   - apps/ide-extension later
3. Keep Densa Core editor-independent.
4. Add strict TypeScript configuration, linting, formatting, unit test tooling, and a single root command for:
   - typecheck
   - lint
   - test
   - build
5. Add a minimal architecture README explaining the process boundary:
   clients -> local IPC -> Densa Core -> agent adapter -> workspace.
6. Add a root .gitignore appropriate for Node/TypeScript, local SQLite data, temporary sockets/PIDs, and build artifacts without ignoring portable .densa project files.
7. Do not add cloud services, UI frameworks, database code, Codex integration, or Code - OSS yet.
8. Prefer the smallest stable dependency set.

Acceptance criteria:
- Fresh install succeeds from the lockfile.
- Root build succeeds.
- Root typecheck succeeds.
- Root lint succeeds.
- Root tests succeed.
- No package imports Code - OSS or vscode APIs.
- Repository boundaries are documented.

At completion, report the exact commands run and the resulting repository tree. Do not start the next milestone.
```

## Phase 0 Milestone 1 — Define versioned domain and IPC contracts

### Copy-paste prompt

```text
You are implementing Densa Phase 0 Milestone 1.

Read AGENTS.md first.

Goal:
Define Densa's stable domain contracts before implementation logic spreads through the codebase.

Implement in packages/protocol and/or packages/core-domain:
1. IDs/types for Project, Phase, Task, Attempt, AgentRun, ValidationRun, Checkpoint, Decision, RoadmapRevision, and Event.
2. The canonical ProjectState, PhaseState, and TaskState values from AGENTS.md.
3. ExecutionMode:
   - guided
   - phase
   - continuous
4. Roadmap mutation classification:
   - minor
   - significant
   - scope
5. UsageState:
   - available
   - limited with optional resetAt
   - unknown with optional reason
6. Stable machine-readable error codes for the error taxonomy in AGENTS.md.
7. A versioned client/Core protocol envelope with request, response, notification/event, protocolVersion, correlation/request IDs, and schema validation.
8. JSON-safe serialization rules. Avoid Date objects across the wire; use ISO-8601 strings.
9. Unit tests proving malformed protocol messages are rejected and valid round-trips preserve values.

Do not implement the daemon or database yet.

Acceptance criteria:
- Contracts compile independently.
- Public schemas are runtime validated, not TypeScript-only.
- No UI-specific types leak into the protocol.
- No Codex-specific types leak into project/task state.
- Tests cover version mismatch and malformed payload behavior.

Document how backwards compatibility will be handled once v0.1 ships.

Do not start the next milestone.
```

## Phase 0 Milestone 2 — Create the headless Densa CLI shell

### Copy-paste prompt

```text
You are implementing Densa Phase 0 Milestone 2.

Read AGENTS.md first.

Goal:
Create a deliberately simple CLI client that will be used to prove Densa Core before any IDE integration.

Implement a densa CLI with commands/placeholders for:
- densa doctor
- densa project init
- densa project status
- densa project start
- densa project pause
- densa project resume
- densa events
- densa version

For this milestone, commands may call local stub services; do not build orchestration yet.

Requirements:
- clear nonzero exit codes on failure;
- human-readable output by default;
- optional machine-readable JSON output;
- no global mutable singleton state;
- CLI depends on shared protocol contracts;
- commands are testable without spawning a real Codex process.

Acceptance criteria:
- CLI help is coherent.
- JSON mode is stable and tested.
- doctor reports Node, Git, platform, and placeholder agent/Core checks cleanly.
- all repo tests/build/lint/typecheck pass.

Do not start the next milestone.
```

---

# Phase 1 — Codex Integration Spike and Single-Task Proof

## Phase 1 Milestone 0 — Empirically map the installed Codex CLI contract

### Copy-paste prompt

```text
You are implementing Densa Phase 1 Milestone 0.

Read AGENTS.md first.

Goal:
Prove what the currently installed official Codex CLI actually exposes before Densa depends on it.

This is a spike, but commit the findings and test fixtures.

Tasks:
1. Detect Codex using PATH and record its version using supported CLI commands.
2. Inspect `codex --help` and relevant subcommand help locally.
3. Identify the best supported non-interactive execution mechanism.
4. Identify whether machine-readable/structured output is available.
5. Identify supported cancellation behavior from the parent process.
6. Identify how authentication-required, usage-limited, ordinary model failure, command failure, and success appear through exit codes/output.
7. Identify whether usage/reset status is available programmatically. If only interactive `/status` exists, record that limitation rather than inventing a parser.
8. Save sanitized fixtures of observed outputs/errors for tests. Never save credentials/tokens.
9. Write `docs/codex-integration-spike.md` documenting:
   - tested Codex version;
   - commands tested;
   - stable signals we can rely on;
   - unstable/presentation text we must not rely on;
   - unknowns.

Do NOT build the full adapter yet.

Acceptance criteria:
- findings are based on real local CLI behavior, not assumptions.
- no secret/auth material is committed.
- uncertainty is explicitly documented.
- there is a recommended adapter strategy and a fallback strategy.

Do not start the next milestone.
```

## Phase 1 Milestone 1 — Implement the first CodexAdapter process boundary

### Copy-paste prompt

```text
You are implementing Densa Phase 1 Milestone 1.

Read AGENTS.md and the Codex integration spike first.

Goal:
Implement the minimal AgentAdapter-backed Codex process runner.

Requirements:
1. AgentAdapter remains provider-neutral.
2. CodexAdapter supports:
   - detect/version
   - status/auth-required classification where reliably possible
   - execute one task in a specified cwd
   - stream structured AgentEvents
   - capture final exit/result
   - cancel a running execution
3. Child processes must:
   - have bounded captured output;
   - stream incremental events;
   - be cancellable;
   - clean up process trees correctly;
   - never expose secrets in logs.
4. All Codex-specific parsing stays inside CodexAdapter.
5. If the installed CLI does not expose a stable signal, return unknown rather than guessing.
6. Add FakeAgentAdapter in packages/testing for deterministic tests.
7. Add adapter contract tests that run against the fake; add opt-in live Codex smoke tests that are excluded from routine test runs.

Acceptance criteria:
- fake adapter passes the full contract suite.
- live smoke test can execute a trivial task when Codex is authenticated.
- cancellation produces a deterministic terminal event.
- missing Codex and unauthenticated Codex produce classified errors.
- scheduler/core code does not yet exist and is not smuggled into the adapter.

Do not start the next milestone.
```

## Phase 1 Milestone 2 — Prove one task can modify and validate a temporary repo

### Copy-paste prompt

```text
You are implementing Densa Phase 1 Milestone 2.

Read AGENTS.md first.

Goal:
Prove the smallest end-to-end Densa value loop without persistence or IDE UI.

Build a temporary-repository harness that:
1. creates a tiny fixture project;
2. defines one explicit task with acceptance criteria;
3. builds a scoped Task Packet;
4. invokes AgentAdapter/CodexAdapter;
5. observes file changes;
6. runs a deterministic validation command;
7. reports PASS or FAIL independently of the agent's final prose.

Use the FakeAgentAdapter for automated tests and allow an opt-in live Codex demonstration.

Important:
- the agent's claim of success cannot set PASS.
- preserve full attempt diagnostics locally.
- do not add automatic retry yet.
- do not add SQLite yet.
- do not add Code - OSS.

Acceptance criteria:
- an automated fake-agent test demonstrates pass and fail paths.
- a live Codex run, when explicitly enabled, can change the fixture and be independently validated.
- a deliberately lying fake agent that says "done" but fails the test is classified as FAIL.

This milestone is the first proof of Densa's core philosophy. Do not start the next milestone.
```

---

# Phase 2 — Authoritative State, SQLite, Events, and Recovery Primitives

## Phase 2 Milestone 0 — Implement centralized state transitions

### Copy-paste prompt

```text
You are implementing Densa Phase 2 Milestone 0.

Read AGENTS.md first.

Goal:
Create the authoritative domain state machine.

Implement centralized transition services for:
- ProjectState
- PhaseState
- TaskState

Requirements:
1. Encode valid transitions explicitly.
2. Reject illegal transitions with stable error codes.
3. Every accepted transition returns enough information to append an event later.
4. Do not let callers assign status fields directly.
5. Add exhaustive unit tests for valid and invalid transitions.
6. Include interruption/waiting paths:
   - WAITING_FOR_USER
   - WAITING_FOR_USAGE
   - INTERRUPTED
   - PAUSED/BLOCKED where applicable.

Acceptance criteria:
- direct state mutation is not part of public domain APIs.
- illegal jumps such as PENDING -> COMPLETED are rejected.
- recovery-relevant transitions are represented.
- tests make the intended lifecycle obvious.

Do not start the next milestone.
```

## Phase 2 Milestone 1 — Add SQLite repository and migrations

### Copy-paste prompt

```text
You are implementing Densa Phase 2 Milestone 1.

Read AGENTS.md first.

Goal:
Persist Densa's authoritative runtime state in SQLite.

Create migration-backed tables/repositories for at least:
- projects
- specifications
- phases
- tasks
- task_dependencies
- acceptance_criteria
- attempts
- agent_runs
- validation_runs
- decisions
- roadmap_revisions
- checkpoints
- events
- project_settings

Requirements:
- explicit schema migrations;
- foreign keys and integrity constraints;
- transactions for multi-record state changes;
- timestamps stored consistently;
- repository interfaces separated from orchestration logic;
- temporary databases for tests;
- no secrets in persisted prompt/log fields by default.

Acceptance criteria:
- a fresh DB migrates from zero to current.
- migration tests pass.
- project/phase/task round-trip tests pass.
- rollback on failed transaction is verified.
- state transitions can be persisted atomically with an event.

Do not start the next milestone.
```

## Phase 2 Milestone 2 — Implement append-only event journal and subscriptions

### Copy-paste prompt

```text
You are implementing Densa Phase 2 Milestone 2.

Read AGENTS.md first.

Goal:
Make important project activity auditable and streamable.

Implement:
1. append-only persisted Event records with eventVersion;
2. ordered sequence numbers per project;
3. an in-process event publisher used only after the DB transaction commits;
4. replay from a sequence number;
5. filters by project, phase, task, and event type;
6. bounded payload/log handling;
7. tests for ordering, replay, and no publication on rolled-back transactions.

Events must represent facts, not UI commands.

Acceptance criteria:
- reconnecting a client can request events after sequence N.
- event order is deterministic.
- state and event cannot disagree because of a partially committed transaction.
- old events are never rewritten.

Do not start the next milestone.
```

## Phase 2 Milestone 3 — Build portable `.densa/` synchronization

### Copy-paste prompt

```text
You are implementing Densa Phase 2 Milestone 3.

Read AGENTS.md first.

Goal:
Create a human-readable portable project representation without making it the detailed runtime database.

Implement safe generation/update of:
- .densa/project.json
- .densa/SPEC.md
- .densa/ROADMAP.md
- .densa/DECISIONS.md
- .densa/config.json
- .densa/reports/
- .densa/logs/ where appropriate

Requirements:
- deterministic formatting;
- atomic file replacement;
- never write secrets;
- tolerate the folder being missing and recreate it;
- detect meaningful human edits rather than overwriting them blindly;
- document which fields are authoritative in SQLite vs portable in .densa.

Acceptance criteria:
- project state can export to .densa.
- important project intent remains understandable without opening SQLite.
- a write interruption cannot leave half-written JSON.
- secret-like test values never appear in exported files.

Do not start the next milestone.
```

## Phase 2 Milestone 4 — Recovery inspection and interrupted-run classification

### Copy-paste prompt

```text
You are implementing Densa Phase 2 Milestone 4.

Read AGENTS.md first.

Goal:
Give Densa enough recovery primitives to understand an interrupted run after restart.

Implement a RecoveryInspector that compares:
- persisted project/task/attempt state;
- recorded agent PID/run metadata;
- whether the process still exists;
- workspace/Git state;
- last persisted events/checkpoint.

It must classify at least:
- cleanly idle;
- active and process alive;
- task marked running but process gone;
- validation interrupted;
- workspace diverged from checkpoint;
- recovery state unknown.

For this milestone, produce a recovery plan/result; do not automatically alter user files.

Acceptance criteria:
- tests simulate abrupt termination between important lifecycle steps.
- a task left RUNNING with a dead worker becomes recoverably classifiable as INTERRUPTED.
- unknown situations are surfaced as unknown, not guessed.
- no destructive recovery action occurs yet.

Do not start the next milestone.
```

---

# Phase 3 — Git, Workspace Isolation, Checkpoints, and Rollback Safety

## Phase 3 Milestone 0 — Implement workspace preflight and dirty-state policy

### Copy-paste prompt

```text
You are implementing Densa Phase 3 Milestone 0.

Read AGENTS.md first.

Goal:
Make Densa safe around real Git repositories and user changes.

Implement WorkspacePreflight that detects:
- is this a Git repo?
- current branch/HEAD;
- staged changes;
- unstaged changes;
- untracked files;
- merge/rebase/cherry-pick state;
- detached HEAD;
- ignored Densa runtime artifacts;
- whether Densa already owns a run/branch.

Define safe behavior for:
- clean repo;
- dirty repo with user changes;
- repo already mid-merge/rebase;
- non-Git directory.

Do not automatically destroy or stash user work.

Acceptance criteria:
- integration tests use temporary real Git repos.
- dirty user changes are never discarded.
- unsafe repository operations result in a classified stop/decision.
- preflight output is structured and suitable for UI later.

Do not start the next milestone.
```

## Phase 3 Milestone 1 — Add Densa run branch and checkpoint model

### Copy-paste prompt

```text
You are implementing Densa Phase 3 Milestone 1.

Read AGENTS.md first.

Goal:
Create safe, auditable Git checkpoints for Densa-controlled work.

Implement:
- creation/reuse of a Densa run branch using a predictable safe naming scheme;
- checkpoint metadata before each task;
- association of checkpoint -> task/attempt -> starting commit;
- internal refs if useful, but do not push;
- preservation of user-authored dirty work per policy.

Do not use destructive global reset/clean shortcuts.

Acceptance criteria:
- starting a task records a known Git base.
- checkpoint metadata survives Core restart.
- temporary repo tests prove user work is not lost.
- branch collisions are handled.
- Densa never pushes.

Do not start the next milestone.
```

## Phase 3 Milestone 2 — Commit passing tasks atomically

### Copy-paste prompt

```text
You are implementing Densa Phase 3 Milestone 2.

Read AGENTS.md first.

Goal:
Map validated task completion to clear Git history.

After validation PASS:
1. verify the workspace still corresponds to the expected attempt;
2. stage only intended task changes according to policy;
3. create a task commit such as:
   densa: <TASK-ID> <short title>
4. persist commit SHA on the task/attempt;
5. only then transition the task to COMPLETED.

If commit fails, the task must not become COMPLETED.

Acceptance criteria:
- commit creation is tested in temporary repos.
- task state and Git commit cannot diverge because of transaction ordering.
- unrelated preserved user changes are not accidentally swept into a Densa task commit.
- no push occurs.

Do not start the next milestone.
```

## Phase 3 Milestone 3 — Implement bounded rollback/retry workspace reset

### Copy-paste prompt

```text
You are implementing Densa Phase 3 Milestone 3.

Read AGENTS.md first.

Goal:
Safely return a failed Densa attempt to its known checkpoint without destroying user work.

Implement rollback only for files/state proven to belong to the current Densa attempt.

Requirements:
- compare current state with checkpoint;
- detect post-start human edits;
- if human edits overlap Densa edits, stop and require resolution rather than overwriting;
- clean up Densa-created temporary artifacts;
- preserve attempt diagnostics in Densa state before rollback;
- never use an unscoped destructive reset against unknown user state.

Acceptance criteria:
- tests cover clean rollback.
- tests cover overlapping human edits and demonstrate Densa refuses destructive rollback.
- failed attempt history survives rollback.
- next attempt starts from a known state.

Do not start the next milestone.
```

---

# Phase 4 — Specification, Adaptive Interview, and Master Roadmap Generation

## Phase 4 Milestone 0 — Define project specification model

### Copy-paste prompt

```text
You are implementing Densa Phase 4 Milestone 0.

Read AGENTS.md first.

Goal:
Create the structured representation of what the user wants before roadmap generation.

Define a ProjectSpecification that can capture:
- project goal;
- target users;
- core user journeys;
- required features;
- non-goals;
- architecture constraints;
- platform/runtime constraints;
- integrations;
- data/storage needs;
- security/privacy requirements;
- UX constraints;
- deployment intent;
- explicit user decisions;
- unresolved questions.

Requirements:
- versioned schema;
- human-readable SPEC.md renderer;
- no model-specific types;
- preserve exact user constraints rather than "helpfully" weakening them.

Acceptance criteria:
- example specs round-trip through structured form and SPEC.md.
- unresolved high-impact questions are representable.
- contradictory constraints can be detected/surfaced.

Do not start the next milestone.
```

## Phase 4 Milestone 1 — Implement adaptive interview planning

### Copy-paste prompt

```text
You are implementing Densa Phase 4 Milestone 1.

Read AGENTS.md first.

Goal:
Build the Master-role interview flow that asks only questions that materially affect the project.

Implement:
1. analysis of an initial idea into a draft specification;
2. unresolved-question generation;
3. priority/risk ranking, with architecture/security/data/integration questions above cosmetics;
4. batching of closely related questions;
5. answer ingestion into the structured specification;
6. a stop condition when remaining ambiguity is low-impact or can safely use explicit defaults.

Use the Master Agent through an abstraction that can be backed by FakeAgentAdapter in tests and Codex in opt-in integration tests.

Requirements:
- do not use a fixed questionnaire;
- record user answers as decisions;
- show proposed defaults when reasonable;
- never silently invent a major requirement.

Acceptance criteria:
- tests demonstrate different initial ideas produce different question sets.
- low-impact cosmetics do not block planning.
- unresolved critical ambiguity prevents READY.
- resulting SPEC.md is updated after each answer batch.

Do not start the next milestone.
```

## Phase 4 Milestone 2 — Generate a complete dependency-aware roadmap

### Copy-paste prompt

```text
You are implementing Densa Phase 4 Milestone 2.

Read AGENTS.md first.

Goal:
Turn a sufficiently resolved ProjectSpecification into the complete initial Master Roadmap.

Roadmap requirements:
- phases with clear goals;
- tasks inside phases;
- dependency graph;
- concrete acceptance criteria per executable task;
- risk level;
- expected validators/categories;
- explicit phase completion criteria;
- stable IDs;
- no circular dependencies.

The roadmap must cover the complete intended project arc before Phase 1 execution starts.

Add structural validation that rejects:
- duplicate IDs;
- missing dependencies;
- dependency cycles;
- executable tasks without acceptance criteria;
- empty required phases.

Acceptance criteria:
- fake/model-generated roadmap is parsed through a strict schema.
- invalid roadmaps are rejected with actionable errors.
- ROADMAP.md renders clearly.
- a sample project can be topologically scheduled from the roadmap.

Do not start the next milestone.
```

## Phase 4 Milestone 3 — Implement audited roadmap mutations

### Copy-paste prompt

```text
You are implementing Densa Phase 4 Milestone 3.

Read AGENTS.md first.

Goal:
Allow the roadmap to evolve without losing user trust or history.

Implement mutation operations for:
- add task;
- split task;
- reorder task;
- change dependency;
- modify acceptance criteria;
- add/remove phase;
- change architecture-related task details;
- mark task superseded.

Every mutation must:
- classify as MINOR, SIGNIFICANT, or SCOPE;
- respect current policy for whether it can auto-apply;
- store before/after;
- store rationale;
- store actor/session;
- emit ROADMAP_CHANGED;
- regenerate portable ROADMAP.md.

SCOPE mutations must require explicit user approval.

Acceptance criteria:
- mutation policy is tested.
- a scope change cannot auto-apply even in Continuous mode.
- roadmap remains graph-valid after every accepted mutation.
- user can inspect mutation history.

Do not start the next milestone.
```

---

# Phase 5 — Orchestrator, Scheduler, Task Packets, and Execution Modes

## Phase 5 Milestone 0 — Implement dependency scheduler

### Copy-paste prompt

```text
You are implementing Densa Phase 5 Milestone 0.

Read AGENTS.md first.

Goal:
Select the next executable task from the persisted roadmap safely and deterministically.

Implement a serial v0.1 Scheduler that:
- evaluates hard dependencies;
- respects project/phase/task state;
- respects outstanding user decisions;
- respects permissions/blocked states;
- chooses only READY work;
- never schedules more than one implementation worker concurrently.

Define deterministic tie-breaking for multiple READY tasks.

Acceptance criteria:
- DAG scheduling tests cover dependencies, blocked tasks, completed prerequisites, and multiple ready tasks.
- no task runs before dependencies complete.
- serial execution is enforced.
- scheduler itself does not invoke agents.

Do not start the next milestone.
```

## Phase 5 Milestone 1 — Implement Task Packet context builder

### Copy-paste prompt

```text
You are implementing Densa Phase 5 Milestone 1.

Read AGENTS.md first.

Goal:
Generate focused worker context without dumping the entire project history.

Build TaskPacket from:
- short project summary;
- relevant global constraints;
- relevant architectural decisions;
- current phase goal;
- exact task goal;
- acceptance criteria;
- dependencies;
- relevant file paths/content summaries where appropriate;
- previous attempt diagnostics for retries;
- permission envelope;
- explicit instruction not to alter unrelated scope.

Requirements:
- deterministic structure;
- bounded size;
- secret filtering;
- no raw unrelated Master conversation;
- no raw full event history;
- record which context sources were included for audit.

Acceptance criteria:
- tests prove irrelevant decisions are omitted.
- retries include the relevant prior failure.
- secrets marked in fixtures are redacted/omitted.
- packet can be rendered to a worker prompt cleanly.

Do not start the next milestone.
```

## Phase 5 Milestone 2 — Implement one complete task lifecycle with retries

### Copy-paste prompt

```text
You are implementing Densa Phase 5 Milestone 2.

Read AGENTS.md first.

Goal:
Build the persistent orchestrator loop for a single task.

Lifecycle:
READY
-> checkpoint
-> RUNNING
-> AgentAdapter.execute
-> VALIDATING
-> PASS => commit => COMPLETED
-> FAIL => record diagnostics => rollback safely => RETRYING => next attempt
-> after 4 failed attempts => BLOCKED or WAITING_FOR_USER

Requirements:
- persist attempt number before execution;
- stream events;
- never mark complete from agent prose;
- retry prompt must include new failure evidence;
- cancellation/interruption paths are explicit;
- retry count survives restart.

Acceptance criteria:
- deterministic FakeAgent tests cover pass first try, fail then pass, four failures, cancellation, process crash.
- Git/task state remain coherent.
- failed diagnostics persist.
- no Code - OSS dependency exists.

Do not start the next milestone.
```

## Phase 5 Milestone 3 — Implement phase lifecycle

### Copy-paste prompt

```text
You are implementing Densa Phase 5 Milestone 3.

Read AGENTS.md first.

Goal:
Execute all tasks in one phase, then perform phase validation and produce a durable phase report.

Implement:
- phase start;
- serial task scheduling until no READY task remains;
- blocked-task handling;
- phase validation hook;
- phase report generation;
- phase -> AWAITING_APPROVAL for phase-by-phase mode;
- phase -> COMPLETED and next phase eligibility for continuous mode only after validation passes.

Phase report includes:
- tasks completed;
- tests/validators;
- commits;
- files changed summary;
- important decisions;
- roadmap changes;
- retries/failures;
- unresolved issues;
- next phase summary.

Acceptance criteria:
- fake project executes a multi-task phase.
- a blocked required task prevents phase completion.
- report is persisted to .densa/reports.
- phase-by-phase mode pauses at the correct boundary.

Do not start the next milestone.
```

## Phase 5 Milestone 4 — Implement Guided, Phase, and Continuous modes

### Copy-paste prompt

```text
You are implementing Densa Phase 5 Milestone 4.

Read AGENTS.md first.

Goal:
Implement Densa's three user-control modes over the same orchestrator.

GUIDED:
- after each validated task, stop for user approval before scheduling the next.

PHASE:
- run all tasks in the current phase;
- validate;
- produce report;
- stop at AWAITING_APPROVAL;
- user action starts the next phase.

CONTINUOUS:
- after a valid phase, save report and continue automatically;
- still stop for policy-required user decisions, scope changes, unsafe operations, hard failures, secrets, or other non-overridable conditions.

Support switching execution mode during a project, effective at a safe boundary.

Acceptance criteria:
- integration tests prove distinct stop boundaries.
- Continuous cannot bypass mandatory user decisions.
- mode persists across restart.
- mode changes emit audit events.

Do not start the next milestone.
```

## Phase 5 Milestone 5 — Implement pause, resume, stop, and intervention semantics

### Copy-paste prompt

```text
You are implementing Densa Phase 5 Milestone 5.

Read AGENTS.md first.

Goal:
Give the user reliable control over a live project.

Define and implement:
- graceful pause: finish/interrupt according to current safe point, persist state, stop scheduling;
- immediate cancel of current agent run where supported;
- resume with workspace/recovery revalidation;
- stop project without deleting work;
- human intervention detection while paused;
- re-contextualization when files changed manually.

Requirements:
- UI is not needed yet; expose Core/CLI operations.
- actions are idempotent.
- repeated pause/stop commands do not corrupt state.
- post-pause manual changes are never silently overwritten.

Acceptance criteria:
- tests cover pause during worker run, pause between tasks, resume after manual edit, stop, repeated commands.
- no orphan worker process remains after cancellation.
- resume always performs recovery/workspace checks first.

Do not start the next milestone.
```

---

# Phase 6 — Validation Framework, Browser Testing, and Independent Review

## Phase 6 Milestone 0 — Build validator plugin framework

### Copy-paste prompt

```text
You are implementing Densa Phase 6 Milestone 0.

Read AGENTS.md first.

Goal:
Make validation a first-class provider-neutral pipeline.

Create a Validator interface and ValidationPlan that can compose validators such as:
- command/build;
- typecheck;
- lint;
- unit/integration tests;
- structured acceptance checks;
- browser/E2E;
- independent AI review.

Each validation result must include:
- validator ID/version;
- status;
- start/end;
- command/config where safe;
- exit code where applicable;
- bounded diagnostics;
- related acceptance criteria;
- retry relevance.

Acceptance criteria:
- validators can be faked in unit tests.
- validation ordering is deterministic.
- one validator failure produces a failed overall result unless policy explicitly says advisory.
- results persist and replay.

Do not start the next milestone.
```

## Phase 6 Milestone 1 — Detect project validation commands safely

### Copy-paste prompt

```text
You are implementing Densa Phase 6 Milestone 1.

Read AGENTS.md first.

Goal:
Determine appropriate deterministic validation commands for common local projects without blindly executing arbitrary discovered text.

Implement safe project inspection for initial v0.1 ecosystems, prioritizing:
- Node/package.json scripts;
- TypeScript config;
- common test/lint/build scripts.

The detector may propose commands; the Policy/Validation layer decides whether to run them.

Requirements:
- no shell interpolation vulnerabilities;
- structured argv rather than concatenated shell strings where possible;
- unknown project types return explicit unknown/manual configuration;
- user-configured validator commands override guesses and are audited.

Acceptance criteria:
- fixture projects produce expected validation plans.
- malicious package/script names cannot inject extra shell commands through Densa.
- unknown project returns a safe result rather than pretending validation exists.

Do not start the next milestone.
```

## Phase 6 Milestone 2 — Map acceptance criteria to evidence

### Copy-paste prompt

```text
You are implementing Densa Phase 6 Milestone 2.

Read AGENTS.md first.

Goal:
Track whether each task acceptance criterion has actual evidence.

Implement criterion states such as:
- satisfied;
- failed;
- not_evaluated;
- manual_review_required.

Associate evidence from:
- deterministic validators;
- targeted checks;
- browser tests;
- independent review.

Requirements:
- do not infer satisfied from the worker's claim.
- phase completion must fail if required criteria remain not_evaluated unless explicitly marked manual and approved.
- render a concise acceptance report.

Acceptance criteria:
- tests cover mixed evidence sources.
- unsupported criteria surface manual_review_required.
- required unevaluated criteria block task/phase completion according to policy.

Do not start the next milestone.
```

## Phase 6 Milestone 3 — Add Playwright browser validation

### Copy-paste prompt

```text
You are implementing Densa Phase 6 Milestone 3.

Read AGENTS.md first.

Goal:
Provide browser validation for relevant web tasks using Playwright.

Implement:
- detection/configuration of app start command and URL;
- managed dev-server process lifecycle;
- Playwright runner abstraction;
- screenshots/artifacts on failure;
- bounded browser logs;
- timeout/cancellation;
- cleanup on crash/cancel.

Do not automatically enable browser validation for irrelevant tasks.

Acceptance criteria:
- fixture web app can be started, tested, and shut down.
- failing browser test records useful artifacts.
- orphan dev servers are cleaned up.
- browser validation can contribute evidence to acceptance criteria.

Do not start the next milestone.
```

## Phase 6 Milestone 4 — Add fresh-context independent review

### Copy-paste prompt

```text
You are implementing Densa Phase 6 Milestone 4.

Read AGENTS.md first.

Goal:
Add independent AI review without letting the implementing worker grade itself.

Implement a Reviewer role through AgentAdapter using a fresh logical session/context.

Reviewer receives:
- task/phase goal;
- acceptance criteria;
- relevant diff;
- deterministic validator results;
- relevant architecture constraints;
- no instruction to defend the worker.

Reviewer output must be structured:
- pass/advisory/fail;
- findings with severity;
- criterion mapping;
- confidence/unknowns.

Use this review by default for:
- risky tasks;
- phase-final review.

Acceptance criteria:
- Fake reviewer tests cover pass/fail/advisory.
- deterministic failures cannot be overridden to PASS by reviewer prose.
- review findings persist and are visible in phase report.

Do not start the next milestone.
```

---

# Phase 7 — Usage Waiting, Security Policy, Secrets, Keep-Awake, and Reliability

## Phase 7 Milestone 0 — Implement usage-state classification and WAITING_FOR_USAGE

### Copy-paste prompt

```text
You are implementing Densa Phase 7 Milestone 0.

Read AGENTS.md and the Codex integration spike first.

Goal:
Pause cleanly when the agent backend is unavailable because of usage limits.

Implement:
- provider-neutral UsageState;
- CodexAdapter mapping from only reliable observed signals;
- optional resetAt if genuinely available;
- `unknown` when it is not;
- transition to WAITING_FOR_USAGE only when classified as usage-limited;
- checkpoint current project/task state before waiting;
- persisted reason/reset information.

Do not hard-code a five-hour or weekly timer.
Do not scrape unstable UI text outside the adapter.

Acceptance criteria:
- fixtures cover limited with reset time, limited without reset time, unknown failure, auth failure.
- only actual usage-limited classification enters WAITING_FOR_USAGE.
- UI/CLI-facing data cannot claim a reset time that was not observed.

Do not start the next milestone.
```

## Phase 7 Milestone 1 — Implement conservative auto-resume after usage returns

### Copy-paste prompt

```text
You are implementing Densa Phase 7 Milestone 1.

Read AGENTS.md first.

Goal:
Allow an opted-in project to resume automatically when agent usage becomes available again.

Behavior:
- if reliable resetAt exists, do not attempt before it except a small safe verification window if justified;
- if resetAt is unknown, use conservative bounded probing with backoff;
- before resume:
  1. verify Core state;
  2. verify workspace/Git state;
  3. verify no mandatory user decision is pending;
  4. verify the agent backend is available;
- emit PROJECT_RESUMED/usage-related events;
- continue from a recoverable task boundary.

Requirements:
- auto-resume is opt-in/project setting;
- no tight polling loop;
- cancellation/disable stops future probes.

Acceptance criteria:
- fake clock tests verify backoff.
- project does not resume early merely because time passed.
- workspace divergence blocks auto-resume safely.
- restart while waiting preserves the waiting schedule/state.

Do not start the next milestone.
```

## Phase 7 Milestone 2 — Implement permission policy engine

### Copy-paste prompt

```text
You are implementing Densa Phase 7 Milestone 2.

Read AGENTS.md first.

Goal:
Centralize authorization decisions for autonomous operations.

Implement policy presets:
- Cautious
- Standard
- Autonomous

Represent operations such as:
- read/write inside workspace;
- access outside workspace;
- install dependency;
- network use;
- Git mutation;
- destructive file operation;
- secret access;
- privilege escalation;
- roadmap significant/scope change;
- remote push.

Policy result:
- allow
- deny
- ask_user

Requirements:
- policy checks are domain logic, not UI conditionals.
- Autonomous still denies/asks for the non-overridable dangerous categories in AGENTS.md.
- every ask/deny decision is auditable.

Acceptance criteria:
- table-driven tests cover all presets and sensitive operations.
- no code path can bypass policy by calling a raw destructive helper directly; sensitive helpers require an authorization token/context.
- user overrides are explicit and persisted.

Do not start the next milestone.
```

## Phase 7 Milestone 3 — Implement secret references and redaction

### Copy-paste prompt

```text
You are implementing Densa Phase 7 Milestone 3.

Read AGENTS.md first.

Goal:
Support necessary credentials without turning Densa logs/state into a secret leak.

Implement:
- SecretRef type;
- macOS Keychain-backed storage abstraction for v0.1;
- scoped environment injection into child processes;
- log/event/prompt redaction utilities;
- permission checks before secret use;
- clear deletion/revocation path.

Never persist raw secrets in:
- SQLite event payloads;
- .densa;
- logs;
- task packets unless the actual external operation requires the value at execution time.

Acceptance criteria:
- tests use fake secret store.
- secret fixture values do not appear in serialized events/logs/task packets.
- injected environment exists only for the scoped child.
- denied secret access produces a structured permission result.

Do not start the next milestone.
```

## Phase 7 Milestone 4 — Implement built-in macOS keep-awake manager

### Copy-paste prompt

```text
You are implementing Densa Phase 7 Milestone 4.

Read AGENTS.md first.

Goal:
Keep the Mac available for opted-in long-running Densa work without keeping the display unnecessarily awake.

Implement a macOS keep-awake abstraction with:
- acquire/release lifecycle;
- reason/project association;
- display sleep still allowed;
- battery threshold policy;
- immediate cleanup on project stop;
- recovery cleanup of stale assertions/state;
- status exposed through Core protocol.

Amphetamine may be detected later as an optional integration, but must not be required.

Acceptance criteria:
- abstraction is testable with a fake platform implementation.
- repeated acquire/release is idempotent.
- Densa does not keep the machine awake after the final active reason is released.
- battery policy can decline/release keep-awake.

Do not start the next milestone.
```

## Phase 7 Milestone 5 — Implement local Core daemon and secure IPC

### Copy-paste prompt

```text
You are implementing Densa Phase 7 Milestone 5.

Read AGENTS.md first.

Goal:
Turn Densa Core into a durable local daemon that can outlive a UI client.

Implement on macOS:
- Core daemon process;
- user-local Unix-domain socket;
- user-only filesystem permissions;
- per-instance/session auth token or equivalent local trust credential;
- versioned JSON-RPC-style request/response plus event notifications using packages/protocol;
- reconnect and event replay from sequence number;
- PID/socket stale-state cleanup;
- `densa core start|status|stop`.

Do not expose a TCP listener publicly.

Acceptance criteria:
- CLI can start/connect/disconnect/reconnect.
- a second client can read status/events without becoming authoritative.
- invalid token/protocol version is rejected.
- killing the client does not kill an active Core run.
- stale socket/PID recovery is tested.

Do not start the next milestone.
```

---

# Phase 8 — Master Agent, Steering, Decisions, and Project-Level Reasoning

## Phase 8 Milestone 0 — Implement Master Agent service boundary

### Copy-paste prompt

```text
You are implementing Densa Phase 8 Milestone 0.

Read AGENTS.md first.

Goal:
Create the project-level Master Agent as a coordinator, not a direct unrestricted code editor.

Implement MasterAgentService using a logically separate agent session.

Supported intents:
- explain project status;
- explain why a task/roadmap decision exists;
- answer questions about current phase;
- propose roadmap changes;
- propose project constraint changes;
- request pause/resume/mode change through Core commands;
- summarize failures/blockers.

Master Agent cannot directly mutate authoritative state. It must call validated Core domain operations.

Acceptance criteria:
- Master cannot bypass policy/state transition services.
- fake-agent tests map structured Master proposals to Core commands.
- Master conversation is not required for worker execution.
- responses can cite internal task/decision/event IDs.

Do not start the next milestone.
```

## Phase 8 Milestone 1 — Implement project decisions and constraints

### Copy-paste prompt

```text
You are implementing Densa Phase 8 Milestone 1.

Read AGENTS.md first.

Goal:
Make user steering durable across future worker runs.

Implement project-level Decision/Constraint records with:
- ID;
- statement;
- category;
- source (user/master/system);
- timestamp;
- scope;
- active/superseded status;
- supersedes relationship;
- affected roadmap/task references.

Example:
"Do not use Firebase anywhere in this project."

Requirements:
- relevant active constraints are included in future Task Packets.
- superseded decisions remain auditable.
- DECISIONS.md is updated.
- conflicts between new and existing constraints are surfaced.

Acceptance criteria:
- adding a constraint affects future Task Packets.
- old worker sessions are not treated as authoritative memory.
- conflicting constraints trigger a decision flow.

Do not start the next milestone.
```

## Phase 8 Milestone 2 — Implement Master-led roadmap revision workflow

### Copy-paste prompt

```text
You are implementing Densa Phase 8 Milestone 2.

Read AGENTS.md first.

Goal:
Let the user steer the roadmap naturally while preserving mutation policy and auditability.

Flow:
user request
-> Master interprets intent
-> structured proposed mutations
-> classify MINOR/SIGNIFICANT/SCOPE
-> Core validates graph/policy
-> ask user if required
-> apply transactionally
-> emit events
-> regenerate ROADMAP.md
-> explain affected work

Examples to support:
- "Add mobile support before QA."
- "Don't use Firebase."
- "Move search earlier."
- "Pause after authentication."
- "Replace the deployment phase with local-only packaging."

Acceptance criteria:
- significant/scope policy is respected.
- roadmap cannot become cyclic/invalid.
- user can inspect before/after and rationale.
- running task changes are handled at a safe boundary rather than mutating context mid-flight without control.

Do not start the next milestone.
```

## Phase 8 Milestone 3 — Implement concise project/phase/task rundown generation

### Copy-paste prompt

```text
You are implementing Densa Phase 8 Milestone 3.

Read AGENTS.md first.

Goal:
Generate trustworthy human-readable rundowns from persisted facts rather than from an agent's memory.

Create structured summaries for:
- current project status;
- phase completion;
- blocked project;
- usage waiting;
- recent changes;
- retry/failure history.

Inputs should come from authoritative state, events, Git metadata, validator results, and decisions. The Master may turn the structured facts into prose, but may not invent missing metrics.

Acceptance criteria:
- if token/cost/reset information is unknown, summaries say unknown/omit it.
- phase report facts match DB/Git/validation state.
- Fake Master cannot alter underlying numbers.
- summaries include drill-down IDs/references for future UI.

Do not start the next milestone.
```

---

# Phase 9 — Headless v0.1 Proof Before IDE Fork

## Phase 9 Milestone 0 — Run the first real one-phase Densa project

### Copy-paste prompt

```text
You are implementing Densa Phase 9 Milestone 0.

Read AGENTS.md first.

Goal:
Prove the complete headless product loop on a small real fixture project before touching Code - OSS.

Using the CLI and Densa Core:
1. accept a project idea/spec;
2. generate a complete roadmap;
3. choose Phase-by-phase mode;
4. execute Phase 1 using CodexAdapter;
5. create checkpoints;
6. validate each task independently;
7. retry if needed;
8. commit passing tasks;
9. run phase validation;
10. produce phase report;
11. stop at AWAITING_APPROVAL.

Use an intentionally small project so failures are diagnosable.

Acceptance criteria:
- the whole loop runs without hand-editing Densa's DB.
- all state survives a Core restart during the experiment.
- phase report is accurate.
- Git history maps to tasks.
- no task is marked complete solely from agent prose.
- write a postmortem documenting every reliability issue discovered.

Do not start Code - OSS work until this passes.
```

## Phase 9 Milestone 1 — Prove Continuous mode and usage/recovery paths with fakes

### Copy-paste prompt

```text
You are implementing Densa Phase 9 Milestone 1.

Read AGENTS.md first.

Goal:
Stress the headless orchestrator with deterministic failure scenarios before adding UI complexity.

Build an end-to-end test harness that simulates:
- two or more phases in Continuous mode;
- agent failure then retry;
- validation failure then corrected retry;
- usage-limited state then auto-resume;
- Core restart mid-task;
- Core restart while WAITING_FOR_USAGE;
- user pause;
- manual workspace change while paused;
- scope mutation requiring approval;
- four failed attempts -> BLOCKED.

Use FakeAgentAdapter/FakeClock where possible so CI is deterministic.

Acceptance criteria:
- each scenario ends in the correct persisted state.
- no user work is destroyed.
- event replay tells a coherent story.
- no busy polling.
- tests are stable across repeated runs.

Do not start the next milestone.
```

## Phase 9 Milestone 2 — Freeze Core v0.1 protocol for IDE integration

### Copy-paste prompt

```text
You are implementing Densa Phase 9 Milestone 2.

Read AGENTS.md first.

Goal:
Stabilize the client-facing Core protocol before the IDE depends on it.

Review all operations required by:
- Home/Start Project;
- Dashboard;
- Roadmap;
- Master Agent;
- phase approvals;
- pause/resume/stop;
- settings/policy;
- usage state;
- events;
- run logs;
- Git/validation drill-down.

Add any missing versioned request/response/event schemas now.

Requirements:
- protocol contract tests;
- no IDE-specific React/webview types;
- pagination/bounds for large event/log histories;
- reconnect semantics documented;
- protocol version compatibility documented.

Acceptance criteria:
- a fake client can implement every planned v0.1 UI interaction without direct DB access.
- no UI feature requires importing Core internals.
- protocol schemas are considered frozen for the first IDE integration pass.

Do not start the next milestone.
```

---

# Phase 10 — Thin Code - OSS Fork and Densa IDE Shell

## Phase 10 Milestone 0 — Bootstrap the thin Code - OSS downstream

### Copy-paste prompt

```text
You are implementing Densa Phase 10 Milestone 0.

Read AGENTS.md first.

Prerequisite:
Phase 9 must be complete. Do not proceed if the headless one-phase loop is not proven.

Goal:
Create the minimal Densa Code - OSS downstream without implementing Dashboard/Roadmap yet.

Tasks:
1. establish a clean upstream tracking strategy;
2. change downstream product identity to Densa using appropriate product configuration;
3. use temporary text/placeholder visual branding only; logo comes later;
4. preserve Code - OSS editor behavior;
5. document every direct upstream patch;
6. create/prepare a built-in Densa extension/contribution package;
7. configure development scripts so Densa can be built/launched reproducibly on macOS.

Do not rewrite upstream subsystems.

Acceptance criteria:
- Densa launches as a distinct app identity.
- normal editor/file/terminal basics still work.
- patchset relative to upstream is small and documented.
- upstream remote/sync workflow is documented.

Do not start the next milestone.
```

## Phase 10 Milestone 1 — Connect IDE client to Densa Core

### Copy-paste prompt

```text
You are implementing Densa Phase 10 Milestone 1.

Read AGENTS.md first.

Goal:
Make the Densa IDE a client of the existing Densa Core daemon.

Implement:
- Core discovery/start;
- secure local IPC connection;
- protocol handshake/version check;
- reconnect;
- event subscription/replay;
- connection status;
- commands through protocol only.

Requirements:
- the extension/workbench must not import the Core database.
- Core remains alive if the IDE window closes while project policy allows it.
- UI connection loss does not change project truth.

Acceptance criteria:
- open/close/reopen Densa while a fake long-running Core project continues.
- reconnect catches up via event replay.
- protocol mismatch shows a clear error rather than corrupting state.
- no duplicate event application after reconnect.

Do not start the next milestone.
```

## Phase 10 Milestone 2 — Build the Densa Home/Welcome actions

### Copy-paste prompt

```text
You are implementing Densa Phase 10 Milestone 2.

Read AGENTS.md first.

Goal:
Add the Densa actions to the familiar editor welcome experience without making the app cease to function like Code - OSS.

Provide actions:
- Open Folder
- Open File
- New Window
- Start Project
- Open Dashboard
- Open Roadmap
- Open Master Agent
- Resume Project
- Recent Densa projects/status where available

Requirements:
- normal Code - OSS welcome/open flows remain usable.
- actions call Core protocol or open Densa surfaces.
- unavailable project actions explain what is needed.
- do not invent project state locally.

Acceptance criteria:
- standard editor use is not blocked by Densa setup.
- Start Project reaches the existing Core project creation flow.
- Resume opens the persisted project correctly.

Do not start the next milestone.
```

## Phase 10 Milestone 3 — Add Densa Activity Bar/commands and custom editor surfaces

### Copy-paste prompt

```text
You are implementing Densa Phase 10 Milestone 3.

Read AGENTS.md first.

Goal:
Establish the primary navigation shells for Densa.

Add:
- Dashboard command/view;
- Roadmap command/view;
- Master Agent command/view;
- Densa command-palette group;
- appropriate Activity Bar entries or equivalent contribution surfaces.

Dashboard and Roadmap should open as full editor-area tabs/custom editors where practical, not be cramped into a narrow chat sidebar.

Requirements:
- reuse standard VS Code contribution mechanisms when possible.
- keep direct workbench patches isolated/minimal.
- no major visual polish yet; focus on navigation and data correctness.

Acceptance criteria:
- user can open [Dashboard] [Roadmap] [Master Agent] alongside source tabs.
- closing/reopening surfaces does not affect Core execution.
- commands work from Command Palette.

Do not start the next milestone.
```

---

# Phase 11 — Dashboard, Roadmap, Master Agent UI, and Phase Reports

## Phase 11 Milestone 0 — Implement Roadmap UI

### Copy-paste prompt

```text
You are implementing Densa Phase 11 Milestone 0.

Read AGENTS.md first.

Goal:
Build the Roadmap surface that answers: "What is going to happen, and where are we?"

Show:
- overall phase structure;
- phase/task states;
- dependencies;
- acceptance criteria;
- current task/attempt;
- task history;
- roadmap mutations/reasons;
- phase completion criteria.

Interactions:
- select phase/task;
- inspect attempt history;
- inspect acceptance evidence;
- request allowed roadmap edits through Core/Master flow;
- approve next phase when AWAITING_APPROVAL.

Requirements:
- all data comes from Core protocol.
- optimistic UI cannot mark things completed.
- roadmap changes show audit history.

Acceptance criteria:
- fixture project renders all canonical states.
- phase approval transitions through Core.
- invalid/stale mutation request gets reconciled cleanly.

Do not start the next milestone.
```

## Phase 11 Milestone 1 — Implement Dashboard command center

### Copy-paste prompt

```text
You are implementing Densa Phase 11 Milestone 1.

Read AGENTS.md first.

Goal:
Build the Dashboard that answers: "What is happening to my project?"

Include:
PROJECT
- status
- execution mode
- phase/task progress
- elapsed runtime where deterministically known

CURRENT
- active agent/run
- current task/attempt
- current lifecycle state

HEALTH
- build/typecheck/lint/tests/browser/review results as applicable

CHANGES
- commits
- files changed
- additions/deletions if available from Git

AGENTS/USAGE
- backend/version
- run counts
- usage state/reset only if known
- retries

EVENTS
- recent persisted event timeline

Every meaningful metric must be drillable to its source detail.

Requirements:
- do not fabricate token/cost/reset metrics.
- Dashboard is live through event updates but can fully reconstruct from persisted Core state after reopen.

Acceptance criteria:
- reconnect/reload yields the same Dashboard facts.
- tests/retries/commits/events are clickable into detail.
- WAITING_FOR_USAGE and BLOCKED states are clear and actionable.

Do not start the next milestone.
```

## Phase 11 Milestone 2 — Implement Master Agent UI

### Copy-paste prompt

```text
You are implementing Densa Phase 11 Milestone 2.

Read AGENTS.md first.

Goal:
Provide a project-level conversation/control surface for the Master Agent.

Support examples:
- "Why did you change the roadmap?"
- "Don't use Firebase anywhere."
- "Add mobile support before QA."
- "Pause after authentication."
- "What is blocking us?"
- "Switch to Continuous after this phase."

UI must:
- distinguish explanation from proposed state change;
- show proposed roadmap/constraint changes before required approval;
- link to affected tasks/phases/decisions;
- never apply scope changes solely from assistant prose.

Acceptance criteria:
- proposal/approval flow is clear.
- stale proposal is revalidated before application.
- Master conversation closing does not lose durable decisions.
- worker logs are not dumped into Master chat by default.

Do not start the next milestone.
```

## Phase 11 Milestone 3 — Implement phase-completion rundown UX

### Copy-paste prompt

```text
You are implementing Densa Phase 11 Milestone 3.

Read AGENTS.md first.

Goal:
Make the Phase-by-phase stopping point feel complete and trustworthy.

When a phase reaches AWAITING_APPROVAL, show:
- phase title and duration if known;
- tasks completed;
- validator/test summary;
- commits/files changed;
- key decisions;
- roadmap changes;
- retries/issues;
- unresolved blockers;
- next phase summary.

Actions:
- Inspect Changes
- Open Roadmap
- Ask Master Agent
- Start Next Phase

In Continuous mode, save the same report but do not block unless policy requires it.

Acceptance criteria:
- report facts come from persisted state.
- Start Next Phase is unavailable until phase validation passed.
- Continuous still stores/viewable phase reports.
- report remains available after restart.

Do not start the next milestone.
```

## Phase 11 Milestone 4 — Add pause/intervene/live-run UX

### Copy-paste prompt

```text
You are implementing Densa Phase 11 Milestone 4.

Read AGENTS.md first.

Goal:
Make live autonomous execution understandable and controllable.

Expose:
- Pause
- Cancel current run where supported
- Stop Project
- Open current task
- View Agent Run
- View Changes
- Resume after intervention

Show current lifecycle state accurately:
RUNNING, VALIDATING, RETRYING, WAITING_FOR_USAGE, WAITING_FOR_USER, BLOCKED, etc.

If the user edits files while paused, show that Densa detected workspace changes and will revalidate/recontextualize before resume.

Acceptance criteria:
- UI commands are idempotent.
- state changes are only shown after Core acknowledgment/event.
- cancel does not leave an orphan process.
- manual intervention path is tested end-to-end with FakeAgent.

Do not start the next milestone.
```

---

# Phase 12 — Onboarding, Settings, Open VSX, and Densa Product Polish

## Phase 12 Milestone 0 — Build first-launch onboarding and resize transition

### Copy-paste prompt

```text
You are implementing Densa Phase 12 Milestone 0.

Read AGENTS.md first.

Goal:
Implement the Densa first-launch flow discussed in the product spec.

Experience:
1. Densa opens in a compact onboarding window.
2. Onboarding checks:
   - Codex detected/version;
   - Codex authentication readiness where reliably detectable;
   - Git availability;
   - default execution mode;
   - default permissions preset;
   - keep-awake preference;
   - privacy/telemetry setting.
3. On completion, transition/resize into the normal full IDE workspace.

Defaults:
- Phase-by-phase
- Standard permissions
- built-in keep-awake enabled for active autonomous/waiting projects subject to battery policy
- telemetry off

Requirements:
- user can skip nonessential optional integrations.
- Densa remains usable as an editor even if Codex is unavailable.
- do not invent auth/usage state.

Acceptance criteria:
- onboarding completion persists.
- resizing/transition does not create a second authoritative app state.
- reopening skips onboarding unless reset.
- missing Codex gives install/setup guidance without blocking basic editing.

Do not start the next milestone.
```

## Phase 12 Milestone 1 — Configure Open VSX and extension experience

### Copy-paste prompt

```text
You are implementing Densa Phase 12 Milestone 1.

Read AGENTS.md first.

Goal:
Provide a coherent extension experience for the Code - OSS downstream using Open VSX.

Tasks:
- configure the downstream extension gallery appropriately for Open VSX;
- verify install/search/update behavior for compatible extensions;
- clearly label registry/source in settings/about where appropriate;
- handle extensions unavailable from Open VSX gracefully;
- do not claim compatibility with proprietary Microsoft Marketplace-only extensions.

Acceptance criteria:
- a known Open VSX extension can be searched, installed, enabled, and removed in a development build.
- failures are understandable.
- Densa's built-in extension remains independent of external registry availability.

Do not start the next milestone.
```

## Phase 12 Milestone 2 — Implement Densa settings and policy UI

### Copy-paste prompt

```text
You are implementing Densa Phase 12 Milestone 2.

Read AGENTS.md first.

Goal:
Expose the important Densa configuration without overwhelming the user.

Settings:
- default execution mode;
- Cautious/Standard/Autonomous permission preset;
- retry count default (4);
- auto-continue after usage returns;
- keep-awake preference;
- battery threshold;
- preferred agent (Codex only in v0.1, but use adapter ID);
- validation preferences;
- telemetry/privacy;
- advanced project-specific overrides.

Requirements:
- dangerous permission changes clearly explain effect.
- project settings can override user defaults.
- setting changes affecting a running project apply only at safe boundaries where required.
- settings persist through Core/client contracts, not hidden UI storage when they affect execution.

Acceptance criteria:
- defaults match product spec.
- settings round-trip after restart.
- policy changes are auditable when they affect an active project.

Do not start the next milestone.
```

## Phase 12 Milestone 3 — Implement recovery and waiting UX

### Copy-paste prompt

```text
You are implementing Densa Phase 12 Milestone 3.

Read AGENTS.md first.

Goal:
Make crashes, usage waits, and blocked states feel like normal recoverable product states rather than mysterious failures.

Build UX for:
- Core disconnected/reconnecting;
- interrupted task recovered after restart;
- workspace divergence requiring review;
- WAITING_FOR_USAGE with known resetAt;
- WAITING_FOR_USAGE with unknown reset;
- auto-resume enabled/disabled;
- BLOCKED after retries;
- authentication required;
- permission/user decision required.

Requirements:
- never show a fake countdown.
- show what Densa safely persisted.
- provide clear next actions.
- keep detailed diagnostics accessible but not dumped on the user by default.

Acceptance criteria:
- each state can be reproduced with fixtures.
- reconnect/restart does not create duplicate actions.
- user can distinguish "waiting" from "broken."

Do not start the next milestone.
```

---

# Phase 13 — v0.1 Hardening, Soak Testing, Packaging, and Release Candidate

## Phase 13 Milestone 0 — Build end-to-end reliability test matrix

### Copy-paste prompt

```text
You are implementing Densa Phase 13 Milestone 0.

Read AGENTS.md first.

Goal:
Create the v0.1 release-blocking reliability test matrix.

Automate as much as practical with fakes/temporary repos:
- new project -> spec -> roadmap -> Phase 1 -> approval;
- Guided mode task boundaries;
- Phase mode boundary;
- Continuous multi-phase flow;
- retry then success;
- four retries -> blocked;
- validation failure;
- browser validation failure;
- roadmap minor/significant/scope mutation;
- user pause/resume;
- cancel current worker;
- manual edit while paused;
- Core crash mid-run;
- IDE crash while Core continues;
- Core restart recovery;
- usage wait/resume;
- unknown usage state;
- dirty Git repo;
- Git commit failure;
- secret redaction;
- policy denial;
- protocol reconnect/replay;
- migration from a previous fixture schema.

Acceptance criteria:
- deterministic suite is repeatable.
- every regression discovered gets a focused test.
- release cannot be declared healthy while critical scenarios are flaky.

Do not start the next milestone.
```

## Phase 13 Milestone 1 — Run long soak/fault-injection tests

### Copy-paste prompt

```text
You are implementing Densa Phase 13 Milestone 1.

Read AGENTS.md first.

Goal:
Find lifecycle bugs that short happy-path tests miss.

Create soak/fault-injection tooling using FakeAgent/FakeClock plus optional live Codex runs.

Inject:
- random worker exits;
- delayed events;
- Core restart between persistence and external side effect boundaries;
- validator timeout;
- socket disconnect/reconnect;
- duplicate client requests;
- stale client version;
- disk/database errors where safely simulatable;
- Git lock/conflict;
- machine sleep/wake simulation at abstraction level.

Measure:
- orphan processes;
- leaked keep-awake assertions;
- duplicated commits/tasks/events;
- unrecoverable states;
- memory/log growth.

Acceptance criteria:
- no known critical invariant violation remains.
- every serious fault found is documented and regression-tested.
- resource cleanup is verified.

Do not start the next milestone.
```

## Phase 13 Milestone 2 — Release packaging, signing, and manual update plan

### Copy-paste prompt

```text
You are implementing Densa Phase 13 Milestone 2.

Read AGENTS.md first.

Goal:
Prepare a safe macOS v0.1 release artifact without overbuilding a full update infrastructure.

Tasks:
- produce reproducible Densa.app build;
- establish bundle identifier/versioning;
- configure macOS code signing/notarization workflow if credentials are available;
- produce a release checklist;
- include third-party license notices;
- document manual update/install flow for v0.1;
- do not add a risky custom auto-updater just to ship this milestone.

The product logo may still be placeholder if final branding is not ready.

Acceptance criteria:
- clean-machine installation instructions are tested.
- app launches with correct identity.
- Core/CLI versions are compatible and visible.
- signed/notarized path is documented even if local credentials are intentionally absent from CI.
- no signing secret is committed.

Do not start the next milestone.
```

## Phase 13 Milestone 3 — v0.1 release candidate audit

### Copy-paste prompt

```text
You are implementing Densa Phase 13 Milestone 3.

Read AGENTS.md first.

Goal:
Perform the final v0.1 engineering audit. Do not add new product features.

Audit:
1. AGENTS.md invariants.
2. Core/editor separation.
3. Code - OSS patchset size and documentation.
4. state-transition coverage.
5. DB migrations.
6. Git safety.
7. secret handling/redaction.
8. policy enforcement.
9. retry/block behavior.
10. crash recovery.
11. WAITING_FOR_USAGE honesty.
12. keep-awake cleanup.
13. protocol compatibility/reconnect.
14. validation independence.
15. Dashboard/Roadmap factual correctness.
16. Open VSX configuration.
17. telemetry default off.
18. no automatic push.
19. no hidden cloud dependency.
20. release test matrix.

Produce `docs/v0.1-release-audit.md` with:
- PASS;
- FAIL;
- DEFERRED;
for every item, evidence links/commands, and release blockers.

Acceptance criteria:
- no critical FAIL remains.
- deferred items are genuinely outside v0.1 scope.
- all release-blocking tests pass.
- the audit does not hide known issues.

Do not begin post-v0.1 expansion from this milestone.
```

---

# Post-v0.1 backlog — explicitly not authorized by this roadmap

Do **not** implement these before the v0.1 release candidate unless the roadmap is deliberately revised:

- Claude Code adapter;
- Gemini adapter;
- OpenCode/local-model adapters;
- parallel implementation agents;
- Windows;
- Linux;
- remote workers;
- cloud project execution;
- mobile companion;
- team collaboration;
- Densa accounts;
- cloud sync;
- billing/subscriptions;
- remote-control web dashboard;
- marketplace for agents;
- automatic remote Git pushes;
- multi-repo distributed orchestration.

The v0.1 moat is not the number of providers or platforms. It is **reliable, understandable orchestration**.

---

# Release gates

## Gate A — Agent integration proof
Must pass after Phase 1:
- a worker can modify a fixture repo;
- Densa independently detects pass/fail;
- cancellation works;
- Codex-specific behavior is isolated.

## Gate B — Persistence/recovery proof
Must pass after Phase 3:
- state survives restart;
- user work is not destroyed;
- checkpoints and commits are coherent.

## Gate C — Headless product proof
Must pass after Phase 9:
- idea/spec -> roadmap -> Phase 1 execution -> validation -> report -> approval;
- Core restart does not break the run.

**No Code - OSS fork work before Gate C.**

## Gate D — IDE integration proof
Must pass after Phase 11:
- IDE is only a client;
- Core can continue without the window;
- Roadmap/Dashboard/Master surfaces reflect persisted truth.

## Gate E — v0.1 release
Must pass after Phase 13:
- reliability matrix green;
- release audit has no critical FAIL;
- packaging path works;
- known limitations are documented.

---

# External assumptions to re-verify when implementation reaches them

These are deliberately not baked into Densa's core contracts:

1. **Code - OSS structure changes over time.**
   Keep the downstream patch thin and re-check the upstream source-organization guidance before deep workbench changes.

2. **VS Code's own Agent Host/AHP is evolving.**
   Densa Core should remain independent rather than depending on private/experimental agent APIs in v0.1.

3. **Codex CLI flags/output may evolve.**
   The Phase 1 spike must inspect the installed official CLI and store versioned fixtures.

4. **Codex usage/reset behavior varies.**
   Treat usage as available/limited/unknown and only show resetAt when actually observed.

5. **Extension registry/licensing constraints may evolve.**
   Re-check Open VSX/Code - OSS distribution details before release packaging.

---

# Agent handoff template

If a milestone agent needs to hand work to the next agent, use this exact structure:

```text
MILESTONE:
Phase X Milestone Y

STATUS:
COMPLETE | PARTIAL | BLOCKED

IMPLEMENTED:
- ...

KEY FILES:
- ...

TESTS RUN:
- command -> result

ARCHITECTURE/SCHEMA CHANGES:
- ...

KNOWN RISKS:
- ...

ROADMAP DEVIATIONS:
- none | ...

NEXT MILESTONE PREREQUISITES:
- ...
```

A handoff saying only "done" is not sufficient.
