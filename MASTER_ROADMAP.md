# Densa ADE — Master Roadmap

> **Purpose:** This file is the implementation roadmap for Densa ADE v1, the first usable public release of Densa ADE.
>
> **Hierarchy:** `Phase → Milestone`.
>
> Each milestone below is intentionally written as a **standalone copy-paste prompt** for a coding agent. Run milestones in order unless a milestone explicitly says otherwise.
>
> **Before every milestone:** the agent must read `AGENTS.md` and obey it.

---

# Product target

Densa ADE v1 is the **first usable public release of Densa ADE**. It is a deliberately focused, macOS-only, local-first, Code - OSS-based AI development IDE with:

- Densa ADE Core;
- Codex as the first worker backend;
- a separate editor-independent Densa ADE Core process;
- idea → adaptive interview → complete roadmap → execution;
- Phase and Milestone execution;
- Guided, Phase-by-phase, and Continuous execution modes;
- independent validation;
- Git checkpoints and task commits;
- crash recovery;
- `WAITING_FOR_USAGE` and auto-resume when usage becomes available;
- built-in macOS keep-awake;
- Master Agent, Roadmap, Dashboard, and normal Editor surfaces;
- onboarding;
- Open VSX;
- permissions and security controls;
- a secure Sparkle network updater;
- carefully scoped optional telemetry that users can disable, off by default;
- a distributable macOS application.

Densa ADE v1 does **not** include additional agent providers unless separately approved, parallel implementation agents, Windows or Linux support, cloud execution, Densa ADE accounts, team collaboration, remote workers, billing, a mobile companion, or automatic pushes for user projects.

## Phase summary

| Phase | Focus | Milestones |
| ---: | --- | ---: |
| **0** | Foundation & contracts | **3** — M0–M2 |
| **1** | Codex integration spike | **3** — M0–M2 |
| **2** | State, SQLite & recovery | **5** — M0–M4 |
| **3** | Git & workspace safety | **4** — M0–M3 |
| **4** | Specification & roadmap generation | **4** — M0–M3 |
| **5** | Orchestrator & execution modes | **6** — M0–M5 |
| **6** | Validation | **5** — M0–M4 |
| **7** | Usage, security & Core daemon | **6** — M0–M5 |
| **8** | Master Agent | **4** — M0–M3 |
| **9** | Headless product proof | **3** — M0–M2 |
| **10** | **Code - OSS fork begins** | **5** — M0–M4 |
| **11** | Roadmap/Dashboard/Master UI | **5** — M0–M4 |
| **12** | Onboarding, product integration & telemetry | **5** — M0–M4 |
| **13** | Hardening, updates & public release | **5** — M0–M4 |

**Total: 63 milestones.**

## Global architecture

```text
┌───────────────────────────────────────────┐
│                  Densa ADE                    │
│             Code - OSS fork               │
│                                           │
│ Editor | Dashboard | Roadmap | Master     │
└──────────────────┬────────────────────────┘
                   │
            versioned local IPC
                   │
┌──────────────────▼────────────────────────┐
│                Densa ADE Core                 │
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

**Do not begin the Code - OSS fork integration until the headless Densa ADE Core can complete a real one-phase project loop.**

The UI is not the product proof. The reliable orchestration loop is.

---

# Phase 0 — Constitution, Contracts, and Repository Foundation

## Phase 0 Milestone 0 — Bootstrap the Densa ADE repository

### Copy-paste prompt

```text
You are implementing Densa ADE Phase 0 Milestone 0.

Read AGENTS.md completely before changing anything.

Goal:
Create the clean repository foundation for Densa ADE Core without implementing agent execution yet.

Requirements:
1. Use TypeScript + Node.js.
2. Establish a workspace/monorepo layout that can support:
   - packages/core
   - packages/protocol
   - packages/agent-sdk
   - packages/cli
   - packages/testing
   - apps/ide-extension later
3. Keep Densa ADE Core editor-independent.
4. Add strict TypeScript configuration, linting, formatting, unit test tooling, and a single root command for:
   - typecheck
   - lint
   - test
   - build
5. Add a minimal architecture README explaining the process boundary:
   clients -> local IPC -> Densa ADE Core -> agent adapter -> workspace.
6. Add a root .gitignore appropriate for Node/TypeScript, local SQLite data, temporary sockets/PIDs, and build artifacts without ignoring portable .densa-ade project files.
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
You are implementing Densa ADE Phase 0 Milestone 1.

Read AGENTS.md first.

Goal:
Define Densa ADE's stable domain contracts before implementation logic spreads through the codebase.

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

Document how backwards compatibility will be handled once v1 ships.

Do not start the next milestone.
```

## Phase 0 Milestone 2 — Create the headless Densa ADE CLI shell

### Copy-paste prompt

```text
You are implementing Densa ADE Phase 0 Milestone 2.

Read AGENTS.md first.

Goal:
Create a deliberately simple CLI client that will be used to prove Densa ADE Core before any IDE integration.

Implement a densa-ade CLI with commands/placeholders for:
- densa-ade doctor
- densa-ade project init
- densa-ade project status
- densa-ade project start
- densa-ade project pause
- densa-ade project resume
- densa-ade events
- densa-ade version

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
You are implementing Densa ADE Phase 1 Milestone 0.

Read AGENTS.md first.

Goal:
Prove what the currently installed official Codex CLI actually exposes before Densa ADE depends on it.

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
You are implementing Densa ADE Phase 1 Milestone 1.

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
You are implementing Densa ADE Phase 1 Milestone 2.

Read AGENTS.md first.

Goal:
Prove the smallest end-to-end Densa ADE value loop without persistence or IDE UI.

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

This milestone is the first proof of Densa ADE's core philosophy. Do not start the next milestone.
```

---

# Phase 2 — Authoritative State, SQLite, Events, and Recovery Primitives

## Phase 2 Milestone 0 — Implement centralized state transitions

### Copy-paste prompt

```text
You are implementing Densa ADE Phase 2 Milestone 0.

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
You are implementing Densa ADE Phase 2 Milestone 1.

Read AGENTS.md first.

Goal:
Persist Densa ADE's authoritative runtime state in SQLite.

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
You are implementing Densa ADE Phase 2 Milestone 2.

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

## Phase 2 Milestone 3 — Build portable `.densa-ade/` synchronization

### Copy-paste prompt

```text
You are implementing Densa ADE Phase 2 Milestone 3.

Read AGENTS.md first.

Goal:
Create a human-readable portable project representation without making it the detailed runtime database.

Implement safe generation/update of:
- .densa-ade/project.json
- .densa-ade/SPEC.md
- .densa-ade/ROADMAP.md
- .densa-ade/DECISIONS.md
- .densa-ade/config.json
- .densa-ade/reports/
- .densa-ade/logs/ where appropriate

Requirements:
- deterministic formatting;
- atomic file replacement;
- never write secrets;
- tolerate the folder being missing and recreate it;
- detect meaningful human edits rather than overwriting them blindly;
- document which fields are authoritative in SQLite vs portable in .densa-ade.

Acceptance criteria:
- project state can export to .densa-ade.
- important project intent remains understandable without opening SQLite.
- a write interruption cannot leave half-written JSON.
- secret-like test values never appear in exported files.

Do not start the next milestone.
```

## Phase 2 Milestone 4 — Recovery inspection and interrupted-run classification

### Copy-paste prompt

```text
You are implementing Densa ADE Phase 2 Milestone 4.

Read AGENTS.md first.

Goal:
Give Densa ADE enough recovery primitives to understand an interrupted run after restart.

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
You are implementing Densa ADE Phase 3 Milestone 0.

Read AGENTS.md first.

Goal:
Make Densa ADE safe around real Git repositories and user changes.

Implement WorkspacePreflight that detects:
- is this a Git repo?
- current branch/HEAD;
- staged changes;
- unstaged changes;
- untracked files;
- merge/rebase/cherry-pick state;
- detached HEAD;
- ignored Densa ADE runtime artifacts;
- whether Densa ADE already owns a run/branch.

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

## Phase 3 Milestone 1 — Add Densa ADE run branch and checkpoint model

### Copy-paste prompt

```text
You are implementing Densa ADE Phase 3 Milestone 1.

Read AGENTS.md first.

Goal:
Create safe, auditable Git checkpoints for Densa ADE-controlled work.

Implement:
- creation/reuse of a Densa ADE run branch using a predictable safe naming scheme;
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
- Densa ADE never pushes.

Do not start the next milestone.
```

## Phase 3 Milestone 2 — Commit passing tasks atomically

### Copy-paste prompt

```text
You are implementing Densa ADE Phase 3 Milestone 2.

Read AGENTS.md first.

Goal:
Map validated task completion to clear Git history.

After validation PASS:
1. verify the workspace still corresponds to the expected attempt;
2. stage only intended task changes according to policy;
3. create a task commit such as:
   densa-ade: <TASK-ID> <short title>
4. persist commit SHA on the task/attempt;
5. only then transition the task to COMPLETED.

If commit fails, the task must not become COMPLETED.

Acceptance criteria:
- commit creation is tested in temporary repos.
- task state and Git commit cannot diverge because of transaction ordering.
- unrelated preserved user changes are not accidentally swept into a Densa ADE task commit.
- no push occurs.

Do not start the next milestone.
```

## Phase 3 Milestone 3 — Implement bounded rollback/retry workspace reset

### Copy-paste prompt

```text
You are implementing Densa ADE Phase 3 Milestone 3.

Read AGENTS.md first.

Goal:
Safely return a failed Densa ADE attempt to its known checkpoint without destroying user work.

Implement rollback only for files/state proven to belong to the current Densa ADE attempt.

Requirements:
- compare current state with checkpoint;
- detect post-start human edits;
- if human edits overlap Densa ADE edits, stop and require resolution rather than overwriting;
- clean up Densa ADE-created temporary artifacts;
- preserve attempt diagnostics in Densa ADE state before rollback;
- never use an unscoped destructive reset against unknown user state.

Acceptance criteria:
- tests cover clean rollback.
- tests cover overlapping human edits and demonstrate Densa ADE refuses destructive rollback.
- failed attempt history survives rollback.
- next attempt starts from a known state.

Do not start the next milestone.
```

---

# Phase 4 — Specification, Adaptive Interview, and Master Roadmap Generation

## Phase 4 Milestone 0 — Define project specification model

### Copy-paste prompt

```text
You are implementing Densa ADE Phase 4 Milestone 0.

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
You are implementing Densa ADE Phase 4 Milestone 1.

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
You are implementing Densa ADE Phase 4 Milestone 2.

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
You are implementing Densa ADE Phase 4 Milestone 3.

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
You are implementing Densa ADE Phase 5 Milestone 0.

Read AGENTS.md first.

Goal:
Select the next executable task from the persisted roadmap safely and deterministically.

Implement a serial v1 Scheduler that:
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
You are implementing Densa ADE Phase 5 Milestone 1.

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
You are implementing Densa ADE Phase 5 Milestone 2.

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
You are implementing Densa ADE Phase 5 Milestone 3.

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
- report is persisted to .densa-ade/reports.
- phase-by-phase mode pauses at the correct boundary.

Do not start the next milestone.
```

## Phase 5 Milestone 4 — Implement Guided, Phase, and Continuous modes

### Copy-paste prompt

```text
You are implementing Densa ADE Phase 5 Milestone 4.

Read AGENTS.md first.

Goal:
Implement Densa ADE's three user-control modes over the same orchestrator.

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
You are implementing Densa ADE Phase 5 Milestone 5.

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
You are implementing Densa ADE Phase 6 Milestone 0.

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
You are implementing Densa ADE Phase 6 Milestone 1.

Read AGENTS.md first.

Goal:
Determine appropriate deterministic validation commands for common local projects without blindly executing arbitrary discovered text.

Implement safe project inspection for initial v1 ecosystems, prioritizing:
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
- malicious package/script names cannot inject extra shell commands through Densa ADE.
- unknown project returns a safe result rather than pretending validation exists.

Do not start the next milestone.
```

## Phase 6 Milestone 2 — Map acceptance criteria to evidence

### Copy-paste prompt

```text
You are implementing Densa ADE Phase 6 Milestone 2.

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
You are implementing Densa ADE Phase 6 Milestone 3.

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
You are implementing Densa ADE Phase 6 Milestone 4.

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
You are implementing Densa ADE Phase 7 Milestone 0.

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
You are implementing Densa ADE Phase 7 Milestone 1.

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
You are implementing Densa ADE Phase 7 Milestone 2.

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
You are implementing Densa ADE Phase 7 Milestone 3.

Read AGENTS.md first.

Goal:
Support necessary credentials without turning Densa ADE logs/state into a secret leak.

Implement:
- SecretRef type;
- macOS Keychain-backed storage abstraction for v1;
- scoped environment injection into child processes;
- log/event/prompt redaction utilities;
- permission checks before secret use;
- clear deletion/revocation path.

Never persist raw secrets in:
- SQLite event payloads;
- .densa-ade;
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
You are implementing Densa ADE Phase 7 Milestone 4.

Read AGENTS.md first.

Goal:
Keep the Mac available for opted-in long-running Densa ADE work without keeping the display unnecessarily awake.

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
- Densa ADE does not keep the machine awake after the final active reason is released.
- battery policy can decline/release keep-awake.

Do not start the next milestone.
```

## Phase 7 Milestone 5 — Implement local Core daemon and secure IPC

### Copy-paste prompt

```text
You are implementing Densa ADE Phase 7 Milestone 5.

Read AGENTS.md first.

Goal:
Turn Densa ADE Core into a durable local daemon that can outlive a UI client.

Implement on macOS:
- Core daemon process;
- user-local Unix-domain socket;
- user-only filesystem permissions;
- per-instance/session auth token or equivalent local trust credential;
- versioned JSON-RPC-style request/response plus event notifications using packages/protocol;
- reconnect and event replay from sequence number;
- PID/socket stale-state cleanup;
- `densa-ade core start|status|stop`.

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
You are implementing Densa ADE Phase 8 Milestone 0.

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
You are implementing Densa ADE Phase 8 Milestone 1.

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
You are implementing Densa ADE Phase 8 Milestone 2.

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
You are implementing Densa ADE Phase 8 Milestone 3.

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

# Phase 9 — Headless v1 Proof Before IDE Fork

## Phase 9 Milestone 0 — Run the first real one-phase Densa ADE project

### Copy-paste prompt

```text
You are implementing Densa ADE Phase 9 Milestone 0.

Read AGENTS.md first.

Goal:
Prove the complete headless product loop on a small real fixture project before touching Code - OSS.

Using the CLI and Densa ADE Core:
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
- the whole loop runs without hand-editing Densa ADE's DB.
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
You are implementing Densa ADE Phase 9 Milestone 1.

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

## Phase 9 Milestone 2 — Freeze Core v1 protocol for IDE integration

### Copy-paste prompt

```text
You are implementing Densa ADE Phase 9 Milestone 2.

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
- a fake client can implement every planned v1 UI interaction without direct DB access.
- no UI feature requires importing Core internals.
- protocol schemas are considered frozen for the first IDE integration pass.

Do not start the next milestone.
```

---

# Phase 10 — Thin Code - OSS Fork and Densa ADE App Shell

## Phase 10 Milestone 0 — Bootstrap the thin Code - OSS downstream and upstream provenance

### Copy-paste prompt

```text
You are implementing Densa ADE Phase 10 Milestone 0.

Read AGENTS.md first.

Prerequisite:
Phase 9 and Gate C must be complete in full. Do not proceed merely because the one-phase proof passed; the Phase 9 continuous/recovery proof and frozen client-facing Core protocol must also be complete.

Goal:
Create the minimal, maintainable Code - OSS downstream boundary for Densa ADE while preserving the existing Densa ADE monorepo. This milestone establishes repository topology, exact upstream provenance, patch accounting, and reproducible development bootstrap only. It deliberately does not own product identity, Core shipping, IPC, or product UI.

Architecture invariants:
1. The existing Densa ADE repository remains the authoritative monorepo for Densa ADE Core, protocol, CLI, testing, and Densa-owned client code. Do not replace or flatten its root package/workspace with the Code - OSS repository.
2. Before importing or wiring Code - OSS source, choose and document an explicit repository topology that gives the Code - OSS downstream an isolated working root and preserves the existing `packages/*` and `apps/*` architecture.
3. The chosen topology must preserve a reproducible relationship to one exact official `microsoft/vscode` upstream commit. Record the upstream repository URL, ref/tag if used, exact commit SHA, and merge-base/baseline used to measure Densa changes.
4. Do not silently create a second remote repository or reorganize the whole monorepo to make Code - OSS fit. If the only safe design appears to require a new repository, stop and record that as a blocking architecture decision for explicit approval.
5. Prefer standard Code - OSS/VS Code extension and contribution mechanisms for future Densa-owned functionality. Direct workbench/upstream source patches are allowed only when required behavior cannot reasonably be achieved through a stable contribution mechanism.
6. Core/protocol/CLI remain editor-independent and must not import Code - OSS/vscode internals.

Tasks:
1. Establish the Code - OSS downstream topology and upstream tracking strategy.
2. Pin the initial upstream baseline to an exact official Code - OSS commit and add machine-readable or clearly structured provenance so the base revision can be recovered later.
3. Create a documented patch inventory that distinguishes:
   - untouched upstream files;
   - direct modifications to upstream files;
   - new Densa-owned files.
   For every direct upstream patch, record path, purpose, why a contribution/extension mechanism was insufficient, and likely upstream-sync conflict risk.
4. Configure documented development/bootstrap commands so a clean checkout can prepare and build the downstream reproducibly on macOS using the pinned upstream's required toolchain/lockfiles. Do not require undocumented global dependencies.
5. Record the Densa revision and pinned Code - OSS base revision in build/debug metadata or another inspectable development surface.
6. Preserve all applicable upstream license/copyright/third-party notices from inherited Code - OSS source and document source provenance. Do not change Densa ADE's overall licensing policy in this milestone.
7. Exercise the documented upstream fetch/sync workflow far enough to prove the configured upstream, pinned base, and patch inventory are valid. Fetching upstream must not itself rewrite Densa-owned state or silently advance the pinned baseline.
8. Record the macOS architecture used for this milestone's build proof. Do not yet claim the final v1 architecture support matrix; that is frozen and release-tested later.
9. Establish a candidate engineering support target before downstream implementation spreads: candidate minimum macOS version, intended CPU architectures, app-shell architecture, bundled Core/runtime architecture, and Codex architecture expectations. This is an engineering target, not yet a public support claim; Phase 13 validates and freezes the public matrix. If the pinned Code - OSS/Electron baseline, bundled runtime, or Codex support cannot satisfy the intended target, record that immediately as an architecture decision rather than discovering it at release packaging.
10. Add an upstream-security freshness record for the pinned baseline and define required re-review checkpoints at minimum at Gate D, Phase 12 completion, and release-candidate cut. Upstream fetch/review must never silently advance the baseline.
11. Make patch accounting mechanically checkable: add a script/CI check that fails when a direct modification relative to the pinned upstream baseline has no inventory entry or when an inventoried patch no longer exists. New Densa-owned files must remain distinguishable from direct upstream modifications.

Scope boundaries:
- Do not establish shipping Densa ADE bundle/data/URL identity here; that is Phase 10 Milestone 1.
- Do not decide or implement how Core/CLI are bundled into the public application here; that is Phase 10 Milestone 1.
- Do not implement Core daemon discovery or IPC; that is Phase 10 Milestone 2.
- Do not add Densa Home/Welcome project actions; that is Phase 10 Milestone 3.
- Do not add Dashboard/Roadmap/Master navigation surfaces; that is Phase 10 Milestone 4.
- Do not configure Open VSX, telemetry, Sparkle, signing, notarization, or release packaging.
- Do not perform broad branding/resource replacement.
- Do not rewrite upstream subsystems.

Acceptance criteria:
- Phase 9 and Gate C completion are verified before Code - OSS work begins.
- the existing Densa ADE monorepo remains intact and Core/protocol/CLI packages remain editor-independent.
- the repository topology and exact pinned official Code - OSS upstream SHA are documented and reproducible.
- the patchset can be deterministically enumerated relative to that pinned baseline, with every direct upstream modification inventoried and justified.
- a clean checkout can follow the documented bootstrap/build procedure using the pinned upstream requirements, and an ordinary build does not leave unexplained tracked-file changes.
- both the Densa revision and Code - OSS base revision are inspectable for debugging/upstream maintenance.
- applicable upstream license/provenance notices are preserved.
- the upstream fetch/sync workflow is exercised successfully without silently advancing the pinned baseline.
- a candidate macOS/CPU engineering target is recorded early enough to constrain downstream/runtime choices without being misrepresented as final public support.
- upstream-security freshness checkpoints are documented.
- automated patch-inventory validation detects unexplained direct upstream modifications.
- no product identity, Core IPC, product UI, Open VSX, telemetry, updater, signing, or release-packaging work is smuggled into this milestone.

At completion, report:
- chosen repository topology and rationale;
- pinned upstream URL/ref/SHA;
- exact Densa-vs-upstream patch inventory summary;
- macOS architecture used for this build proof and candidate v1 engineering support target;
- exact bootstrap/build commands and results;
- upstream-security freshness record/review checkpoints;
- patch-inventory validation command/result;
- known upstream-sync risks.

Do not start the next milestone.
```

## Phase 10 Milestone 1 — Establish Densa ADE product identity and bundled Core runtime topology

### Copy-paste prompt

```text
You are implementing Densa ADE Phase 10 Milestone 1.

Read AGENTS.md first.

Goal:
Define and prove the shipping application identity and runtime layout that makes Densa ADE a self-contained macOS product rather than a Code - OSS development build that happens to find an external Node/Core checkout.

Product identity:
1. Change downstream shipping product/build identity to Densa ADE using shipping-equivalent configuration, not only a development-only override.
2. Audit the pinned upstream product metadata field-by-field. For every nontrivial identity/service field, classify it as KEEP, OVERRIDE, DISABLE/REMOVE, or DEFER with rationale. At minimum inspect current equivalents of:
   - visible product names;
   - application/CLI name;
   - user-data/shared-data folder names;
   - macOS bundle identifier;
   - URL protocol/scheme;
   - issue-reporting/help URLs;
   - extension-gallery/service metadata;
   - AI/chat/provider-related product metadata;
   - telemetry/update/service URLs where present;
   - inherited updater configuration where present.
   Do not assume the upstream field set is stable; inspect the pinned revision.
3. Establish one stable Densa ADE macOS identity for v1, including bundle identifier and non-colliding application/data/URL identities.
4. Prove Densa ADE can coexist with Code - OSS/VS Code without sharing application identity, URL scheme, user-data, or shared-data locations.
5. Keep visual branding temporary: text identity and Densa-owned placeholder assets only. Do not ship inherited proprietary product branding merely because it exists upstream.

Bundled runtime contract:
6. Define and document the public runtime topology for Densa ADE Core and CLI. The public Densa ADE application must not depend on an undocumented external repository checkout or an arbitrary system Node installation.
7. Choose and document how Core is shipped, for example a bundled runtime/executable or another self-contained equivalent. Record:
   - canonical path inside or alongside `Densa ADE.app`;
   - bundled runtime/toolchain requirements;
   - how Core obtains its own version and protocol version;
   - where writable state, SQLite, logs, sockets, and caches live outside the read-only application bundle;
   - how development overrides differ from shipping lookup without becoming the production default;
   - the production anti-hijack rule: shipping Core discovery is derived from the signed Densa application/runtime topology and cannot be redirected by workspace settings, `.densa-ade` project files, arbitrary inherited environment variables, or a stale developer override. Development overrides must require an explicit development mode/build and must be inspectable.
8. Decide whether the `densa-ade` CLI ships in v1. If it ships, define and implement one supported install/launch mechanism and ensure it invokes the same compatible Core/runtime as the application. If it does not ship publicly, mark it explicitly as developer/internal for v1 rather than leaving the public behavior ambiguous.
9. Define the uninstall/cleanup contract now and choose the actual user-invokable mechanism that Phase 12 will expose/test. macOS app deletion alone must not be described as automatically cleaning daemon state. The cleanup operation must cover app-owned daemon state, sockets/PIDs, optional shell-command links, caches, optional telemetry queue, and revocable Keychain references without deleting user project files automatically.
10. Reconcile the candidate engineering support target from Milestone 0 with the chosen Code - OSS/Electron baseline and bundled Core/runtime. Record any architecture/minimum-macOS conflict before IDE integration begins.

Required smoke test:
Using a clean Densa ADE development launch on macOS:
1. launch Densa ADE as Densa ADE;
2. open a folder and edit/save a file;
3. open the integrated terminal and run a trivial command;
4. use the Command Palette for a standard editor command;
5. close/reopen the window or folder without losing ordinary editor behavior;
6. verify Densa uses its intended application/data/URL identities;
7. verify the shipping runtime locator can resolve the intended bundled Core/runtime location and report its version without relying on an arbitrary global Node or source checkout;
8. verify a workspace/project setting or ordinary production environment variable cannot redirect the shipping runtime locator to an arbitrary executable;
9. verify Code - OSS/VS Code can coexist without sharing Densa product state.

Acceptance criteria:
- Densa ADE launches from shipping-equivalent product configuration as a distinct macOS app identity.
- every relevant inherited product/service metadata field has an explicit KEEP/OVERRIDE/DISABLE/DEFER decision.
- inherited update/telemetry/AI/service configuration is not silently retained by accident.
- Densa ADE has its own bundle/application/data/URL identities and can coexist with Code - OSS/VS Code.
- the public Core/runtime distribution topology is documented and self-contained enough that a clean machine does not need an undocumented development checkout or arbitrary global Node installation.
- writable runtime data is outside the application bundle and has an explicit lifecycle.
- the public CLI decision is explicit; if the CLI ships, its supported install/launch mechanism is implemented and tied to the same compatible runtime.
- uninstall/cleanup semantics and the future user-invokable cleanup mechanism are explicit and do not silently remove user project work.
- shipping runtime lookup cannot be silently hijacked by workspace/project configuration or development overrides.
- the candidate support target is checked against the actual downstream/runtime topology early.
- ordinary editor/file/terminal/Command Palette behavior still works.

At completion, report:
- product identity values;
- upstream metadata decision table;
- bundled Core/runtime topology and paths;
- public CLI decision/implementation;
- uninstall/cleanup contract and chosen user-invokable mechanism;
- shipping runtime anti-hijack rule;
- candidate support-target reconciliation;
- exact smoke-test commands/results.

Do not start the next milestone.
```

## Phase 10 Milestone 2 — Connect the IDE to bundled Densa ADE Core securely

### Copy-paste prompt

```text
You are implementing Densa ADE Phase 10 Milestone 2.

Read AGENTS.md first.

Goal:
Make Densa ADE a secure protocol client of the bundled Densa ADE Core runtime while preserving Core authority, multi-client correctness, Code - OSS Workspace Trust, and safe lifecycle behavior.

Implement:
- the minimal built-in Densa ADE extension/contribution package with a stable Densa-owned identity; it must load as a built-in/system contribution without external registry installation and own the IDE-facing protocol client boundary;
- shipping runtime/Core discovery using the Phase 10 Milestone 1 topology;
- Core start/status/connection lifecycle;
- secure local IPC connection;
- protocol handshake/version check;
- reconnect and event replay;
- connection status;
- commands through protocol only;
- multi-window/multi-client request identity, idempotency, authoritative revision preconditions, and stale-request rejection for every state-changing operation;
- Workspace Trust integration.

Protocol/concurrency prerequisite:
Before wiring state-changing IDE actions, verify the Phase 9 client protocol contains enough concurrency semantics to make multi-client mutation safe. At minimum, state-changing requests need a unique command/request identity usable for idempotency and an authoritative precondition such as `expectedProjectRevision`, `expectedEventSequence`, or a domain-specific equivalent. Core must return a structured stale/conflict result with current authoritative revision/state. A correlation ID alone is not a concurrency control.

If the Phase 9 frozen protocol lacks these primitives, implement the smallest versioned, contract-tested protocol amendment before enabling IDE mutations. Record it as an IDE-integration protocol correction, preserve backwards-compatibility behavior where practical, and update protocol compatibility documentation. Do not implement client-side last-write-wins as a substitute.

Security and authority requirements:
1. The extension/workbench must not import or directly mutate the Core database.
2. Core remains authoritative for project state. UI connection loss does not change project truth.
3. Densa autonomous execution must respect the editor workspace's trust state. An untrusted/restricted workspace must not be able to start or resume Densa worker execution, validators, dependency installation, terminal/process execution, or other Densa-triggered active operations unless the user deliberately establishes trust through the supported editor flow.
4. Do not merely hide buttons in untrusted workspaces; Core-bound command handlers must enforce the trust precondition before sending execution-capable requests.
5. Explicitly declare the built-in Densa extension's untrusted-workspace capability/limited-mode behavior using the pinned Code - OSS contribution model. Read-only status/roadmap inspection may remain available where safe.
6. Define trust-revocation semantics for a project that is already active or whose Core continues after all windows close. Treat trust as a continuing authorization invariant for Densa-triggered active operations: loss of trust must prevent new worker/validator/process actions and move execution to a safe paused/waiting boundary rather than letting a background Core silently continue privileged workspace actions.
7. Core remains alive if the final IDE window closes while project policy allows background execution and trust/policy still permit it. Explicit application quit/stop semantics must be defined so Densa does not accidentally strand an unwanted daemon or silently terminate an active run.
8. Development-only Core path overrides must be explicit and available only in development/test mode; production lookup must not honor workspace/project redirects or ordinary stale developer environment configuration.

Compatibility requirements:
- define the v1 compatibility model now for app/client version, Core version, and protocol version, including the supported compatibility window and fail-closed behavior; Phase 13 may extend this model with Sparkle build ordering, bundled-runtime version, and SQLite schema migration rules but must not invent the client/Core contract from scratch;
- handshake exposes app/client version, Core version, and protocol version needed to diagnose skew;
- unsupported protocol/Core combinations fail closed with a clear user-facing state rather than attempting undefined operations;
- reconnect never double-applies events;
- stale approvals/mutations/commands are revalidated against authoritative state before application.

Multi-client tests:
- two IDE windows attach to the same project;
- one pauses while another has a stale action queued;
- concurrent mode/approval requests resolve deterministically through Core using revision/precondition checks;
- duplicate/retried command IDs are idempotent and cannot double-apply a mutation;
- closing one client does not disturb the other or the active Core run;
- trust revoked in one window prevents further Densa active operations, including from a background Core, until trust is deliberately restored;
- reconnecting clients catch up from persisted sequence numbers without duplicates.

Acceptance criteria:
- open/close/reopen Densa ADE while a fake long-running Core project continues.
- reconnect catches up via event replay with no duplicate event application.
- protocol mismatch shows a clear error and cannot corrupt state.
- the built-in Densa extension is present without registry installation and owns the typed protocol-client boundary.
- the shipping application launches/locates the bundled Core using the documented runtime topology without production path hijacking.
- no direct Core DB dependency exists in IDE code.
- untrusted/restricted workspaces cannot start Densa execution through hidden commands, direct command-palette invocation, stale UI actions, or a still-running background Core after trust loss.
- state-changing requests have idempotency and authoritative revision/precondition semantics; stale/duplicate requests are safely rejected/reconciled.
- the initial app/Core/protocol compatibility model is documented and tested.
- explicit quit/background-Core behavior is tested.

Do not start the next milestone.
```

## Phase 10 Milestone 3 — Add Densa ADE navigation shells and secure custom-surface foundation

### Copy-paste prompt

```text
You are implementing Densa ADE Phase 10 Milestone 3.

Read AGENTS.md first.

Goal:
Establish the primary Densa ADE navigation shells and one secure, reusable custom-surface foundation for Phase 11.

Add:
- Dashboard command/view shell;
- Roadmap command/view shell;
- Master Agent command/view shell;
- Densa ADE command-palette group;
- appropriate Activity Bar entries or equivalent contribution surfaces.

Dashboard and Roadmap should open as full editor-area tabs/custom editors where practical, not be cramped into a narrow chat sidebar.

Custom-surface security requirements:
1. Treat all project text, roadmap text, agent/reviewer output, Git metadata, logs, diagnostics, Markdown, URLs, and user content as untrusted display data.
2. Use typed/versioned message schemas between extension host and custom UI. Reject unknown/invalid messages.
3. Enforce a strict Content Security Policy for webview-like surfaces and grant only the capabilities actually needed.
4. Restrict local resource roots/resources to explicit required locations.
5. Sanitize rendered Markdown/HTML. Do not interpret model/agent output as executable HTML, JavaScript, editor commands, or privileged message payloads.
6. Do not automatically execute `command:` links or arbitrary external/resource links from generated content. Route privileged actions through explicit Densa command handlers and policy/state validation.
7. Do not automatically load remote images/resources from agent-generated content.
8. Reuse one security wrapper/component rather than reimplementing ad hoc rules per surface.
9. Keep direct workbench patches isolated/minimal.

Accessibility baseline:
- keyboard navigation and visible focus;
- semantic labels for controls/status;
- reasonable high-contrast/theme behavior;
- zoom/resizing without hiding required controls.

Acceptance criteria:
- user can open Dashboard, Roadmap, and Master Agent shells alongside source tabs.
- closing/reopening surfaces does not affect Core execution.
- commands work from Command Palette and respect Workspace Trust where execution-capable.
- malicious fixture content cannot inject script, invoke privileged commands, escape allowed local resources, or silently load arbitrary remote content.
- typed UI messages reject malformed/unknown payloads.
- keyboard-only navigation works across the shell controls.

Do not start the next milestone.
```

## Phase 10 Milestone 4 — Build Densa ADE Home/Welcome and project-entry actions

### Copy-paste prompt

```text
You are implementing Densa ADE Phase 10 Milestone 4.

Read AGENTS.md first.

Goal:
Provide clear Densa ADE project-entry actions while preserving normal Code - OSS startup/editing behavior and the thin-downstream rule.

Provide actions:
- Open Folder
- Open File
- New Window
- Start Project
- Open Dashboard
- Open Roadmap
- Open Master Agent
- Resume Project
- Recent Densa ADE projects/status where available

Contribution rule:
Prefer supported extension/contribution mechanisms such as commands, walkthroughs, views/welcome contributions, or a Densa-owned getting-started surface. Do not create a broad workbench patch solely to mimic a specific upstream Welcome layout. If a direct upstream patch is truly required, add it to the Phase 10 patch inventory with justification and sync-risk classification.

Requirements:
- normal Code - OSS welcome/open flows remain usable.
- actions call Core protocol or open Densa ADE surfaces.
- unavailable project actions explain what is needed.
- do not invent project state locally.
- execution-capable actions obey Workspace Trust and Phase 10 Milestone 2 command enforcement.
- Densa ADE remains fully usable as a normal editor even when Core/Codex is unavailable.

Acceptance criteria:
- standard editor use is not blocked by Densa ADE setup.
- Start Project reaches the existing Core project-creation flow when workspace trust/policy permit it.
- Resume opens the persisted project correctly.
- an untrusted workspace cannot use Home/Welcome actions to bypass execution restrictions.
- no unjustified broad Welcome/workbench patch is introduced.

Do not start the next milestone.
```
---

# Phase 11 — Dashboard, Roadmap, Master Agent UI, and Phase Reports

## Phase 11 Milestone 0 — Implement Roadmap UI

### Copy-paste prompt

```text
You are implementing Densa ADE Phase 11 Milestone 0.

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
- before large-fixture testing, create `docs/IDE_PERFORMANCE_BUDGETS.md` with explicit numeric v1 thresholds for at least initial Roadmap payload size/item count, event-page size, maximum retained rendered history, large-roadmap fixture size, reconnect/catch-up target, and acceptable retained-memory growth for repeated reopen/live-update tests. These budgets may be revised deliberately with evidence, but PASS/FAIL must never depend on words such as "reasonable" or "responsive" alone.
- all data comes from Core protocol.
- optimistic UI cannot mark things completed.
- roadmap changes show audit history.
- all generated/project content uses the secure custom-surface foundation from Phase 10 Milestone 3.
- initial payloads/history are bounded/paginated; do not fetch or render unbounded project history merely because it exists.
- long lists/graphs must use incremental/virtualized or equivalent bounded rendering when needed.
- keyboard navigation, focus, semantic labels, high contrast, and zoom remain usable.

Acceptance criteria:
- fixture project renders all canonical states.
- phase approval transitions through Core.
- invalid/stale mutation request gets reconciled cleanly.
- the defined numeric Roadmap/history/reconnect/memory budgets pass against the large synthetic fixture.
- malicious roadmap/Markdown/URL fixtures cannot execute privileged UI behavior.

Do not start the next milestone.
```

## Phase 11 Milestone 1 — Implement Dashboard command center

### Copy-paste prompt

```text
You are implementing Densa ADE Phase 11 Milestone 1.

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
- event/history queries are paginated/bounded; do not hydrate the entire journal into the UI by default.
- repeated live updates/reopens must not produce unbounded retained memory or duplicate rendered events.
- use the Phase 10 Milestone 3 secure custom-surface foundation and accessibility baseline.

Acceptance criteria:
- reconnect/reload yields the same Dashboard facts.
- tests/retries/commits/events are clickable into detail.
- WAITING_FOR_USAGE and BLOCKED states are clear and actionable.
- a large event-history fixture remains responsive with bounded initial loading.
- generated diagnostics/log content cannot inject privileged UI actions.

Do not start the next milestone.
```

## Phase 11 Milestone 2 — Implement Master Agent UI

### Copy-paste prompt

```text
You are implementing Densa ADE Phase 11 Milestone 2.

Read AGENTS.md first.

Goal:
Provide a project-level conversation/control surface for the Master Agent.

Support examples:
- "Why did you change the roadmap?"
- "Don't use Firebase anywhere."
- "Add mobile support before QA."
- "Pause after the authentication phase/task."
- "What is blocking us?"
- "Switch to Continuous after this phase."

Conversation/session contract:
- explicitly decide and implement whether Master chat transcripts are persisted locally or intentionally ephemeral. For v1, if history is shown after reopen, persist bounded local Master session/message records through Core with pagination, retention/deletion semantics, timestamps, and project/session identity; never make the UI's own storage authoritative. If transcripts are intentionally ephemeral, the UI must say so and must not imply reloadable history.
- durable Decisions/Constraints remain authoritative independently of transcript retention. Deleting/closing chat must not delete a durable approved decision unless the user performs an explicit decision operation.

Deferred-control contract:
- natural-language future-boundary requests such as "pause after authentication" must resolve to a concrete persisted roadmap boundary (specific task/phase ID) before application. Implement/use a typed Core deferred-control operation such as pause-after-task/phase or equivalent safe-boundary intent. Do not promise arbitrary semantic conditions that are not represented in Core state.
- deferred controls must be auditable, cancellable, survive restart, obey Workspace Trust/policy, and be revalidated if the target roadmap element is superseded/moved.

UI must:
- distinguish explanation from proposed state change;
- show proposed roadmap/constraint changes before required approval;
- link to affected tasks/phases/decisions;
- never apply scope changes solely from assistant prose;
- treat all Master/model output as untrusted display data, never executable commands/messages/HTML;
- route every privileged state change through explicit typed Core commands and revalidation;
- render deferred-control proposals as concrete target task/phase + safe boundary, never as ungrounded prose;
- bound/paginate persisted conversation history when persistence is enabled and avoid dumping raw worker logs by default.

Acceptance criteria:
- proposal/approval flow is clear.
- stale proposal is revalidated before application.
- transcript persistence/ephemerality, retention, deletion, and pagination behavior is explicit and tested; closing Master never loses durable approved decisions.
- a deferred pause/control survives restart, targets a concrete roadmap ID, and cannot fire after its target becomes stale without revalidation.
- worker logs are not dumped into Master chat by default.
- a proposal opened in one window cannot be applied after another client has made it stale without Core revalidation.
- malicious model-output fixtures cannot invoke commands, inject script, or escape the UI security boundary.

Do not start the next milestone.
```

## Phase 11 Milestone 3 — Implement phase-completion rundown UX

### Copy-paste prompt

```text
You are implementing Densa ADE Phase 11 Milestone 3.

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

Requirements:
- report content uses persisted facts and the Phase 10 Milestone 3 secure rendering foundation.
- report/history loading is bounded for large projects.
- accessibility baseline applies to every report action/detail.

Acceptance criteria:
- report facts come from persisted state.
- Start Next Phase is unavailable until phase validation passed.
- Continuous still stores/viewable phase reports.
- report remains available after restart.
- stale approval from another client/window is rejected/reconciled rather than applying against outdated state.

Do not start the next milestone.
```

## Phase 11 Milestone 4 — Add pause/intervene/live-run UX and cross-surface client correctness

### Copy-paste prompt

```text
You are implementing Densa ADE Phase 11 Milestone 4.

Read AGENTS.md first.

Goal:
Make live autonomous execution understandable and controllable, and prove that all Phase 11 surfaces remain correct across reconnects, multiple windows, stale actions, and accessibility paths.

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

If the user edits files while paused, show that Densa ADE detected workspace changes and will revalidate/recontextualize before resume.

Cross-surface requirements:
- state changes are only shown after Core acknowledgment/event.
- UI commands are idempotent where the Core command semantics are idempotent.
- two windows/surfaces must not turn stale UI state into an authoritative change.
- all Phase 11 surfaces must be reconstructable from persisted Core state after reload.
- keyboard-only operation must reach primary actions and details; focus must remain understandable after live updates/modals.
- high-contrast/theme and zoom checks cover Dashboard, Roadmap, Master, and phase rundown.

Acceptance criteria:
- pause/cancel/stop/resume paths are tested end-to-end with FakeAgent.
- cancel does not leave an orphan process.
- manual intervention path is tested.
- two-window conflicting pause/resume/approval/mode-change scenarios resolve deterministically.
- reconnect/reload produces the same authoritative facts without duplicate actions/events.
- Phase 11 accessibility smoke tests pass.

Do not start the next milestone.
```

---

# Phase 12 — Onboarding, Settings, Open VSX, Telemetry, and Densa ADE Product Polish

## Phase 12 Milestone 0 — Build first-launch onboarding and editor transition

### Copy-paste prompt

```text
You are implementing Densa ADE Phase 12 Milestone 0.

Read AGENTS.md first.

Goal:
Implement the Densa ADE first-launch flow discussed in the product spec without creating a large permanent workbench/window-state patch merely for a cosmetic resize effect.

Experience:
1. Densa ADE opens into onboarding, using a compact presentation when it can be implemented safely through existing window/surface mechanisms.
2. Onboarding checks:
   - Codex detected/version plus the absolute resolved executable path and provenance classification supplied by Core/CodexAdapter;
   - Codex authentication readiness where reliably detectable;
   - Git availability;
   - default execution mode;
   - default permissions preset;
   - keep-awake preference;
   - "Share optional diagnostics" privacy/telemetry setting.
3. On completion, transition into the normal full IDE workspace.

Defaults:
- Phase-by-phase
- Standard permissions
- built-in keep-awake enabled for active autonomous execution subject to battery policy; `WAITING_FOR_USAGE` does not keep the Mac awake indefinitely by default. If a user opts into keep-awake while waiting, make that a separate explicit preference and show its energy implication.
- optional telemetry off

Requirements:
- user can skip nonessential optional integrations.
- Densa ADE remains usable as an editor even if Codex is unavailable.
- do not invent auth/usage state.
- production Codex discovery must not silently execute a workspace-local shim or an executable selected by project content. Core records the absolute resolved executable path/version/source; unusual/nonstandard locations require explicit user confirmation or a documented trusted discovery rule. Workspace/project settings may not silently redirect the worker backend.
- onboarding must survive restart/crash without corrupting window geometry or creating a second authoritative app state.
- if compact-window resizing would require a broad/high-risk Code - OSS patch, prefer a normal-sized onboarding surface and record the deviation rather than compromising the thin-fork architecture.
- onboarding actions that can start execution obey Workspace Trust.
- accessibility baseline applies to the onboarding flow.

Acceptance criteria:
- onboarding completion persists.
- transition does not create a second authoritative app state.
- reopening skips onboarding unless reset.
- missing Codex gives install/setup guidance without blocking basic editing.
- the detected Codex absolute path/version/provenance is inspectable, and a workspace-local/path-hijack fixture cannot silently replace the configured backend.
- `WAITING_FOR_USAGE` does not hold keep-awake indefinitely under the default policy.
- window restore/fullscreen/multi-monitor smoke tests do not strand the app in an unusable onboarding geometry.
- no unjustified broad workbench patch is introduced solely for compact-resize polish.

Do not start the next milestone.
```

## Phase 12 Milestone 1 — Configure Open VSX and define the third-party extension trust boundary

### Copy-paste prompt

```text
You are implementing Densa ADE Phase 12 Milestone 1.

Read AGENTS.md first.

Goal:
Provide a coherent extension experience for the Code - OSS downstream using Open VSX while accurately defining what Densa ADE's own permission system does and does not control.

Tasks:
- configure the downstream extension gallery appropriately for Open VSX;
- verify install/search/update behavior for compatible extensions;
- clearly label registry/source in settings/about where appropriate;
- handle extensions unavailable from Open VSX gracefully;
- do not claim compatibility with proprietary Microsoft Marketplace-only extensions;
- verify Workspace Trust/Restricted Mode behavior remains available and understandable in the downstream;
- audit the pinned Code - OSS/Open VSX client behavior for extension package integrity verification, publisher/namespace identity and trust signals, install/update provenance, and any scanner/security metadata actually exposed by the pinned client. Document what Densa verifies versus what the registry claims; do not assume Microsoft VS Code Marketplace publisher-trust semantics are inherited unchanged;
- add a user-visible source/provenance detail for installed third-party extensions where the pinned client supports it;
- perform the scheduled upstream-security freshness review from Phase 10 Milestone 0 before closing Phase 12 registry/product integration work;
- document that Densa Cautious/Standard/Autonomous permissions govern Densa ADE Core/agent operations and are not a sandbox for arbitrary third-party extension code;
- do not imply that installing an Open VSX extension grants it Densa-specific sandboxing that does not exist.

Acceptance criteria:
- a known Open VSX extension can be searched, installed, enabled, and removed in a development build.
- failures are understandable.
- Densa ADE's built-in extension remains independent of external registry availability.
- Workspace Trust remains functional after Open VSX configuration.
- the pinned client's actual Open VSX package/publisher/integrity behavior is documented and tested rather than assumed.
- the Phase 12 upstream-security freshness review is recorded.
- user-facing/security documentation accurately distinguishes Densa agent permissions from third-party extension execution.

Do not start the next milestone.
```

## Phase 12 Milestone 2 — Implement Densa ADE settings and policy UI

### Copy-paste prompt

```text
You are implementing Densa ADE Phase 12 Milestone 2.

Read AGENTS.md first.

Goal:
Expose important Densa ADE configuration without overwhelming the user.

Settings:
- default execution mode;
- Cautious/Standard/Autonomous permission preset;
- retry behavior/status: v1's four-attempt cap is presented as a fixed orchestration invariant unless a configurable retry-limit contract already exists in Core/protocol. Do not expose a writable retry-count setting merely in UI and thereby create a post-freeze execution rule.
- auto-continue after usage returns;
- keep-awake preference;
- battery threshold;
- preferred agent (Codex only in v1, but use adapter ID);
- validation preferences;
- "Share optional diagnostics" (off by default) and privacy information;
- advanced project-specific overrides.

Requirements:
- dangerous permission changes clearly explain effect.
- project settings can override user defaults.
- setting changes affecting a running project apply only at safe boundaries where required.
- settings persist through Core/client contracts, not hidden UI storage when they affect execution.
- permission copy must not imply control over arbitrary third-party extension code.
- settings that can enable execution remain subject to Workspace Trust.
- accessibility baseline applies to custom settings surfaces.

Acceptance criteria:
- defaults match product spec.
- the retry UI cannot imply configurability unless the Core/protocol actually owns and validates that setting; otherwise v1 clearly presents the fixed four-attempt cap.
- settings round-trip after restart.
- policy changes are auditable when they affect an active project.
- dangerous changes cannot bypass safe-boundary or trust checks through direct command invocation.

Do not start the next milestone.
```

## Phase 12 Milestone 3 — Implement recovery, waiting, and workspace-relocation UX

### Copy-paste prompt

```text
You are implementing Densa ADE Phase 12 Milestone 3.

Read AGENTS.md first.

Goal:
Make crashes, usage waits, blocked states, and unavailable workspaces feel like normal recoverable product states rather than mysterious failures.

Build UX for:
- Core disconnected/reconnecting;
- interrupted task recovered after restart;
- workspace divergence requiring review;
- workspace folder moved/renamed;
- workspace volume temporarily unavailable;
- workspace folder missing/deleted;
- workspace permission/access denied;
- WAITING_FOR_USAGE with known resetAt;
- WAITING_FOR_USAGE with unknown reset;
- auto-resume enabled/disabled;
- BLOCKED after retries;
- authentication required;
- permission/user decision required.

Workspace re-link requirements:
- implement/use an authoritative Core `relinkWorkspace` (or equivalent) domain/protocol operation; the UI must never directly rewrite a stored workspace path or DB record. The operation validates the new workspace, persists the binding transactionally, emits an audit event, and returns structured conflict/recovery results using the Phase 10 revision/precondition semantics.
- never silently assume another folder is the same project based only on name/path similarity;
- explicitly detect copied/cloned `.densa-ade` project identity or duplicate project IDs appearing in multiple folders. Require the user to choose a safe resolution such as re-link existing identity versus adopt/create a distinct project; do not auto-merge histories.
- allow an explicit re-link/reopen flow when the stored workspace path is unavailable;
- re-run workspace/Git/recovery validation before resume after re-link;
- preserve original project identity/history and audit the path change;
- never auto-delete the project record merely because the folder is temporarily unavailable.

Cleanup/uninstall requirements:
- implement the user-invokable cleanup mechanism selected in Phase 10 Milestone 1 (for example an in-app maintenance command and, if the public CLI ships, a matching CLI entry point). It must stop/confirm daemon state safely, remove only documented app-owned sockets/PIDs/caches/telemetry queue/shell links and revocable app-owned Keychain references, and never delete user workspaces or portable `.densa-ade` project files automatically.
- document that dragging `Densa ADE.app` to Trash alone does not execute cleanup automatically.

General requirements:
- never show a fake countdown.
- show what Densa ADE safely persisted.
- provide clear next actions.
- keep detailed diagnostics accessible but not dumped on the user by default.

Acceptance criteria:
- each state can be reproduced with fixtures.
- reconnect/restart does not create duplicate actions.
- user can distinguish "waiting" from "broken."
- moved, missing, temporarily unavailable, permission-denied, copied-project-ID, and duplicate-project-ID workspace scenarios are separately tested.
- re-link cannot resume execution until the authoritative Core operation and workspace/Git/recovery checks pass.
- cleanup/uninstall behavior is actually invokable and tested; it removes only app-owned state and never user projects.

Do not start the next milestone.
```

## Phase 12 Milestone 4 — Implement privacy-conscious telemetry, diagnostics, and collector contract

### Copy-paste prompt

```text
You are implementing Densa ADE Phase 12 Milestone 4.

Read AGENTS.md first.

Goal:
Implement a small, privacy-conscious telemetry and diagnostics system for Densa ADE v1 using strict data minimization. Do not transmit optional telemetry to a production collector unless both the client schema and the server-side privacy/retention contract are explicitly defined and approved.

Telemetry categories:
1. Essential operational traffic may exist independently only for a specifically named user-visible service/feature whose network interaction is necessary to perform that feature, such as an explicit Sparkle update check/download. Do not use vague categories such as "compatibility" or "local reliability" as a catch-all for non-optional analytics. For every essential network request, document destination/owner, trigger, transmitted fields/metadata, retention assumptions where known, and how the user can avoid the feature when feasible. Sparkle update traffic must not be falsely described as optional telemetry.
2. Optional diagnostic/product telemetry is controlled by the user-facing "Share optional diagnostics" setting. It is off by default, visible in Settings, and can be disabled at any time without dark patterns.

Optional telemetry may include only explicitly useful, allowlisted fields such as:
- Densa ADE app/Core version and coarse macOS/CPU architecture compatibility data;
- Guided, Phase-by-phase, or Continuous execution mode;
- project run started and phase/milestone completed or failed;
- retry occurrence and validator category/pass-fail result;
- agent adapter identifier, structured Densa ADE error code, and Core crash/restart or recovery outcome;
- updater check/update success or failure;
- high-level Dashboard, Roadmap, or Master Agent surface usage when genuinely useful.

Never upload as ordinary telemetry:
- source code, file contents, project/specification/roadmap content, filenames, or absolute paths;
- Git remote URLs, repository names, project names, or other repository identity;
- prompts, user-entered natural language, Master Agent conversations, or worker transcripts;
- environment variables, secrets, API keys, credentials, cookies/tokens, or Codex authentication data;
- personal/account identity, arbitrary command stdout/stderr, or unsanitized raw crash dumps.

Use an anonymous random installation identifier only if aggregate reliability measurement truly requires it. Do not create user tracking or cross-product identity. If used, define generation, local storage, reset, uninstall/cleanup deletion, rotation policy, and server-side retention/linkability; resetting Densa diagnostics identity must not require deleting user projects.

Client engineering requirements:
- one centralized telemetry abstraction independent of feature/UI code;
- small typed/versioned event schemas with explicit allowlisted properties;
- reject unknown fields rather than uploading them automatically;
- batching and retry with bounded local storage and reasonable network timeouts;
- telemetry failures never block or break Densa ADE execution;
- easy local disablement and deterministic fakes for development/tests;
- sanitization/redaction tests and negative tests proving forbidden data cannot enter an upload;
- disabling optional telemetry must also prevent queued optional events from later transmitting.

Collector/privacy contract:
Before any optional production transmission is enabled, create `docs/TELEMETRY_BACKEND.md` that defines at minimum:
- exact collector endpoint/owner;
- TLS requirement;
- authentication/abuse protections where applicable;
- server-side event schema enforcement;
- retention period and deletion/rotation behavior;
- who can access collected data;
- treatment/retention of IP addresses, reverse-proxy/CDN logs, User-Agent, and request metadata;
- database/backups/log retention implications;
- incident/credential response expectations;
- how the published privacy language maps to actual server behavior.

If no approved collector/privacy contract exists for v1, keep production optional telemetry transport disabled even if the local setting/schema/diagnostic plumbing exists. Local diagnostics may still function.

Documentation:
- create `docs/TELEMETRY.md` listing every v1 event, its properties, purpose, optional/essential category, retention assumptions, and explicit non-collected data.
- Settings copy must concisely explain what is and is not collected.

Acceptance criteria:
- optional events are transmitted only when "Share optional diagnostics" is enabled and a production collector/privacy contract is explicitly configured.
- disabling optional telemetry stops its transmission, including after restart and with queued batches.
- every essential network request is tied to a named feature/service and cannot become a loophole for analytics; its trigger/destination/data are documented.
- any anonymous installation identifier has explicit reset/uninstall/server-retention semantics.
- schema/allowlist tests reject unknown or forbidden properties.
- tests cover source code, prompts, project/repository identity, paths, secrets, auth data, arbitrary logs, and queued-event disablement.
- bounded retry/storage behavior survives network failure without affecting an active project run.
- Settings state, privacy language, `docs/TELEMETRY.md`, and `docs/TELEMETRY_BACKEND.md` (when production collection exists) match actual behavior.
- no production optional telemetry is silently enabled with an undefined retention/IP/logging policy.

Do not start the next milestone.
```

---

# Phase 13 — v1 Hardening, Soak Testing, Secure Updating, Packaging, and Release Candidate

## Phase 13 Milestone 0 — Build the release-blocking end-to-end reliability and security matrix

### Copy-paste prompt

```text
You are implementing Densa ADE Phase 13 Milestone 0.

Read AGENTS.md first.

Goal:
Create the v1 release-blocking reliability/security matrix. This matrix must cover not only Core orchestration, but the packaged app boundaries introduced in Phases 10-12.

Before running the matrix, freeze explicit numeric v1 reliability/performance budgets in `docs/V1_RELEASE_BUDGETS.md`, incorporating the Phase 11 IDE budgets. At minimum define concrete PASS/FAIL thresholds for synthetic roadmap size, event-journal size/page size, reconnect/catch-up latency under fixture conditions, repeated-reopen retained-memory growth, bounded log/storage growth, daemon/process cleanup, updater timeout/retry/storage bounds, and soak/fault-run minimum iteration or duration. Do not allow "reasonable", "responsive", "pathological", or "long soak" to be the only acceptance language.

Also define `docs/VULNERABILITY_RELEASE_POLICY.md` before release scanning. At minimum: unresolved Critical vulnerabilities block release; High severity findings block unless there is a documented, approved, evidence-backed non-reachability/mitigation risk acceptance; Medium/Low findings follow an explicit treatment policy. Apply the policy across Densa packages, pinned Code - OSS/Electron/native dependencies, bundled runtime, Sparkle, and release tooling.

Automate as much as practical with fakes/temporary repos:
- new project -> spec -> roadmap -> Phase 1 -> approval;
- Guided mode task boundaries;
- Phase mode boundary;
- Continuous multi-phase flow;
- retry then success;
- four retries -> blocked;
- validation/browser/reviewer failure;
- roadmap minor/significant/scope mutation;
- user pause/resume;
- cancel current worker;
- manual edit while paused;
- Core crash mid-run;
- IDE crash/window close while Core continues;
- explicit app quit/background-Core policy;
- Core restart recovery;
- usage wait/resume and unknown usage;
- dirty Git repo and Git commit failure;
- secret redaction and policy denial;
- protocol reconnect/replay;
- two-window/multi-client conflicting commands and stale approvals;
- Workspace Trust: untrusted workspace cannot start/resume execution through UI or direct command invocation;
- malformed/malicious custom-surface content cannot inject script/commands/resources;
- moved/missing/unavailable workspace re-link;
- migration from previous fixture schemas;
- old/new IDE-Core protocol skew;
- old/new Core-database schema skew;
- failed database migration/recovery fixture;
- explicit low-disk/`ENOSPC` fixtures for SQLite writes, migration snapshot/backup, update download/staging, and bounded log/event persistence where safely simulatable;
- packaged/bundled Core runtime discovery without development checkout/global Node dependency;
- upstream product/service metadata assertions preventing accidental Microsoft updater/telemetry/AI/service endpoints;
- Open VSX configuration and third-party extension trust-boundary documentation;
- optional telemetry disablement and forbidden-field tests;
- clean uninstall/daemon/socket/shell-link cleanup behavior without deleting user project files.

Reconcile release support matrix inputs now with the engineering target recorded in Phase 10:
- minimum supported macOS version candidate;
- intended v1 CPU architectures;
- architecture of app shell, bundled Core/runtime, Codex compatibility smoke environment, and Sparkle package.
Do not mark a platform/architecture supported until Phase 13 Milestone 3 actually builds/tests it.

Acceptance criteria:
- deterministic suite is repeatable.
- every regression discovered gets a focused test.
- release cannot be declared healthy while critical scenarios are flaky.
- trust/webview/runtime/version-skew scenarios are first-class release blockers, not manual notes.
- platform/architecture support claims are represented as explicit matrix entries rather than assumptions.
- explicit numeric release budgets exist and are used by later soak/release tests.
- the vulnerability release policy exists before scanners run, so a scanner can never "pass" merely by producing a report containing an unresolved release-blocking vulnerability.

Do not start the next milestone.
```

## Phase 13 Milestone 1 — Run long soak and fault-injection tests

### Copy-paste prompt

```text
You are implementing Densa ADE Phase 13 Milestone 1.

Read AGENTS.md first.

Goal:
Find lifecycle bugs that short happy-path tests miss before release packaging/updating is added.

Create soak/fault-injection tooling using FakeAgent/FakeClock plus optional live Codex runs. Every randomized run must use and record a deterministic seed plus the exact injected fault schedule so any discovered failure can be replayed.

Inject:
- random worker exits;
- delayed events;
- Core restart between persistence and external-side-effect boundaries;
- validator timeout;
- socket disconnect/reconnect;
- duplicate client requests;
- conflicting requests from multiple clients;
- stale client/protocol version;
- disk/database errors where safely simulatable, including explicit `ENOSPC` during event/log writes;
- update/migration-storage pressure abstractions, including insufficient free space for a required DB backup/snapshot or staged update;
- database migration interruption fixtures;
- Git lock/conflict;
- machine sleep/wake simulation at abstraction level;
- workspace disappearance/reappearance at abstraction level.

Measure:
- orphan processes;
- leaked keep-awake assertions;
- duplicated commits/tasks/events;
- stale approvals applied;
- unrecoverable states;
- memory/log growth against the numeric Phase 13 release budgets;
- unbounded UI/event history growth against the numeric Phase 11/13 budgets.

Acceptance criteria:
- no known critical invariant violation remains.
- every serious fault found is documented and regression-tested.
- resource cleanup is verified against explicit budgets.
- every failing randomized run is replayable from its seed/fault schedule.
- low-disk faults leave storage recoverable and do not silently corrupt authoritative state.
- results establish a pre-packaging baseline that will be re-run in abbreviated packaged form during Phase 13 Milestone 4 after Sparkle/release packaging exists.

Do not start the next milestone.
```

## Phase 13 Milestone 2 — Implement secure Sparkle updating and the app/Core/database upgrade transaction

### Copy-paste prompt

```text
You are implementing Densa ADE Phase 13 Milestone 2.

Read AGENTS.md first.

Goal:
Implement the secure in-app macOS updater required for Densa ADE v1 using Sparkle, with an explicit compatibility and database-upgrade transaction rather than assuming replacing `Densa ADE.app` is sufficient.

Extend and freeze the version model before updater logic:
Start from the app/Core/protocol compatibility model established in Phase 10 Milestone 2. Define and document how it composes with:
- user-visible app version;
- monotonically ordered app/build version used by Sparkle;
- Densa ADE Core version;
- client/Core protocol version;
- SQLite schema/migration version;
- bundled runtime version where relevant.
Do not reinvent the client/Core compatibility contract here and do not defer Sparkle/schema ordering until packaging.

Sparkle requirements:
- integrate Sparkle; do not create a custom update protocol;
- support network update checks and visible "Check for Updates…" action;
- use an HTTPS-hosted appcast/feed with release notes and version information;
- expose updater state, download progress, and understandable errors;
- define and document the default v1 check/download/install behavior and user controls before shipping;
- centralize the feed endpoint and define one public stable v1 channel. In addition, define a private/staging appcast or equivalent controlled pre-publication mechanism used only for release-candidate validation; this is not a public beta/nightly product channel.
- create `docs/UPDATER_OPERATIONS.md` defining feed/artifact host/domain owner, storage, TLS, publishing permissions, cache/CDN behavior where applicable, staging-to-stable promotion procedure, monitoring, artifact/feed rollback or withdrawal procedure, emergency fixed-release procedure, and response to a validly signed but broken release.
- disable/remove any inherited Code - OSS application updater so Sparkle is the only authoritative Densa ADE app-update mechanism.

Update authenticity/integrity:
- authenticate update archives with Sparkle's supported Ed25519/EdDSA update-signing flow;
- require Sparkle's signed-feed/appcast mechanism for v1 if the pinned Sparkle release supports it. Because Densa controls the Sparkle version, choosing a pinned release that cannot meet the desired feed-integrity requirement is a release-blocking architecture decision, not an automatic waiver.
- explicitly decide the v1 delta-update policy. If delta artifacts are generated/published, they are part of the signed update surface and must receive the same authenticity, staging, rollback, and old-version testing as full archives. If v1 does not need deltas, disable/omit them deliberately.
- never install an update whose required authenticity checks fail;
- never commit/store/log/telemetry-output any private Sparkle signing key;
- keep Sparkle update-signing keys separate from Apple Developer ID credentials.

Release-key operations:
Document:
- secure primary storage;
- encrypted/offline recovery backup;
- access scope;
- CI/release-machine usage;
- rotation procedure;
- lost-key and suspected-compromise response.
A key existing on one developer machine with no recovery plan is not sufficient release engineering.

App/Core/DB upgrade transaction:
Define and implement a state machine for:
1. update discovered/downloaded;
2. active project/run inspection;
3. safe install boundary or explicit user-approved interruption;
4. old Core quiesce/stop when installation requires it;
5. old socket/PID cleanup;
6. replacement of application bundle;
7. new app/Core compatibility handshake;
8. disk-space preflight sufficient for staged app/update artifacts plus the required DB pre-migration backup/snapshot;
9. database pre-migration backup/snapshot appropriate to the storage model, with integrity verification before migration;
10. schema migration;
11. post-migration Core health verification;
12. restart/reconnect/event replay;
13. explicit rescue/rollback path if the new app/Core cannot become healthy. Choose and document one release-safe strategy, such as restoring the pre-migration DB snapshot together with a retained compatible signed app/Core, transactionally reversible migrations within the supported window, or a dedicated recovery tool that can restore the snapshot without normally opening an incompatible database. Do not leave this as generic "clear recovery path" prose.
14. clear terminal failure state and user instructions if automated rescue itself cannot complete.

Compatibility rules must explicitly define:
- new IDE connecting to old Core;
- old IDE/app copy connecting to new Core;
- old Core against newer database schema;
- new Core against older schema;
- unsupported downgrade after schema migration;
- what the user sees when compatibility is unsupported.
Never let an old process continue writing a database after a newer incompatible schema migration.

Failure behavior:
- Densa ADE remains usable when DNS/server/network/feed/download checks fail.
- failed update check/download/authentication does not break Core or an active project.
- downloading may occur when safe, but install/restart waits for a safe project state or explicit user approval.
- never silently terminate an autonomous run to install.
- insufficient disk space must block staging/migration before destructive replacement when required backup/update capacity is unavailable; do not discover predictable `ENOSPC` only after an irreversible step.
- failed migration/startup must preserve diagnostics and a recoverable backup/known state rather than continuing against partially upgraded storage.
- a validly signed but functionally broken release has a documented operational response: halt promotion, withdraw/replace feed entries where safe, publish a fixed higher-version build, preserve/update migration compatibility, and communicate the limitation. Never assume signing validity means release correctness.

Testing:
- local/fake appcasts in routine automated tests;
- version ordering tests;
- malformed feed/network/no-update/download failure;
- bad archive signature rejection and good signature success;
- signed-feed verification where enabled;
- active-run defer/install behavior;
- IDE/Core skew matrix;
- migration success/failure/interruption plus insufficient-disk preflight;
- post-migration new-Core health failure followed by the chosen rescue/restore path;
- staged release/feed withdrawal or promotion failure using the documented operations workflow;
- stale old-Core process after app replacement;
- restart/reconnect/event replay after successful upgrade.

Acceptance criteria:
- a development build can discover and complete a signed update through a controlled local/fake setup.
- invalid/missing required authenticity checks cannot install.
- inherited Code - OSS application updating is disabled/removed so there is one authoritative updater.
- updater failures leave Core/active projects healthy.
- the full app/build/Core/protocol/schema/runtime version model is frozen and tested before packaging, extending rather than replacing the Phase 10 client/Core compatibility model.
- the upgrade state machine safely handles Core shutdown/restart, socket/PID cleanup, protocol skew, disk-space preflight, DB backup/migration, post-upgrade validation, and an explicitly tested rescue/restore path.
- `docs/UPDATER_OPERATIONS.md` defines staging/stable promotion and broken-release response.
- signed-feed status and the delta-update policy are explicit and tested.
- private-key backup/rotation/compromise procedures are documented and no private key appears in repository/log/test/telemetry artifacts.

Do not start the next milestone.
```

## Phase 13 Milestone 3 — Produce, sign, notarize, validate, and stage the v1 release candidate

### Copy-paste prompt

```text
You are implementing Densa ADE Phase 13 Milestone 3.

Read AGENTS.md first.

Goal:
Produce the exact macOS v1 release candidate that could become public, prove its provenance/support/signing/update behavior, and stage it privately for final packaged soak/audit. Do not publish it to the public stable appcast/download channel in this milestone.

Release identity/versioning:
- preserve the stable bundle/application/data/URL identity established in Phase 10 Milestone 1;
- use the version model frozen in Phase 13 Milestone 2;
- do not change identity merely for packaging convenience.

Define reproducibility precisely:
A release must be traceable to:
- exact Densa revision;
- exact Code - OSS upstream baseline;
- patch inventory;
- locked dependency state;
- documented build toolchain;
- deterministic/controlled unsigned build inputs where practical;
- final signed/notarized artifact provenance even when signing timestamps make byte-for-byte reproduction inappropriate.
Do not use the word "reproducible" without an evidence-producing procedure.

Upstream freshness decision:
Before final packaging:
1. review meaningful changes/security-relevant releases since the pinned Code - OSS baseline;
2. explicitly decide SYNC BEFORE V1 or FREEZE CURRENT BASE FOR V1;
3. record rationale and security implications;
4. if syncing, rerun the product metadata/service audit, automated patch-inventory validation, editor smoke tests, and affected regression suite.
5. whether syncing or freezing, record the dated upstream-security review artifact required by the Phase 10 freshness cadence.

Final inherited-metadata/service audit:
Re-inspect the final packaged upstream field set and assert that Densa does not accidentally ship:
- upstream Microsoft/VS Code app identity;
- upstream application updater;
- unintended Microsoft telemetry/update/AI/provider/service endpoints;
- proprietary Marketplace assumptions;
- incorrect issue/help URLs;
- colliding data/URL identities;
- inherited proprietary product branding/assets not authorized for Densa distribution.

Platform/architecture support:
Freeze the exact candidate v1 support matrix for final audit; do not publicly publish support claims until Milestone 4/Gate E:
- minimum macOS version;
- app architectures (for example arm64/x86_64/universal as actually produced);
- bundled Core/runtime architecture support;
- supported architecture combinations actually built/tested;
- Codex smoke-test environment for every declared support row.
Do not claim an architecture or macOS version that was not tested in the release matrix. Every declared macOS/CPU support row must pass a functional Densa + bundled Core + official supported Codex end-to-end project smoke test, not merely an editor launch. If a row cannot run the sole v1 worker backend, narrow the support claim.

Packaging/signing/notarization:
- build `Densa ADE.app` with the bundled Core/runtime topology from Phase 10 Milestone 1;
- package using the selected ZIP/DMG format;
- configure Developer ID Application signing;
- enable Hardened Runtime as required by the chosen signing/notarization path;
- audit nested code before notarization: every bundled executable/helper/framework/native module, bundled Core/runtime component, and Sparkle helper is signed as required, has the intended architecture slices, and uses only justified least-privilege entitlements. Explicitly verify no accidental development entitlement such as `get-task-allow` is present in the public candidate; document any Electron/JIT/library-validation exceptions required by the pinned runtime.
- notarize the staged release candidate and staple notarization where applicable;
- verify Gatekeeper behavior from the documented supported install path(s) using a normal non-admin user account where applicable, plus any administrator step that is genuinely required.
Unsigned/ad-hoc builds may continue for development/internal testing, but they do not satisfy Gate E public-release distribution.

Sparkle staging:
- generate feed/update artifacts using the Phase 13 Milestone 2 version scheme;
- sign update artifacts with the separate Sparkle release key;
- publish them only to the private/staging appcast or equivalent controlled pre-publication location defined in `docs/UPDATER_OPERATIONS.md`; do not modify the public stable feed yet;
- create and retain a reproducible older-version update fixture/RC so the v1 update path can be tested rather than inventing an "older build" ad hoc;
- test older fixture -> staged v1 release candidate discovery/download/install/migration/reconnect, including the configured full-archive/delta policy.

Current Codex compatibility:
Run a fresh live end-to-end Densa project smoke test on every declared support-matrix row using the v1-supported official Codex CLI/backend environment and the production discovery/provenance rules from Phase 12. Record absolute resolved Codex path/provenance, version, macOS version, CPU architecture, bundled Core/runtime version, and result for each row. The only v1 worker backend cannot be release-optional. Any declared row that fails blocks that support claim and Gate E until fixed or removed from the public matrix.

Supply-chain/release hygiene:
- run dependency/security vulnerability checks appropriate to the repositories/toolchains and evaluate every result against `docs/VULNERABILITY_RELEASE_POLICY.md`; scanner execution alone is not a pass;
- run secret scanning;
- produce an SBOM or equivalent machine-readable dependency inventory for the release;
- produce third-party license/notices inventory;
- generate release artifact hashes;
- verify lockfile/dependency integrity;
- document release credential access/environment;
- rerun automated direct-upstream patch-inventory validation and fail on any unexplained patch drift;
- do not publish private Sparkle or Apple credentials.

CLI/uninstall:
- test the public CLI decision from Phase 10 Milestone 1 on a clean installation;
- test documented uninstall/cleanup behavior for daemon/socket/shell-link/app-owned state without deleting user project files automatically.

Acceptance criteria:
- clean-machine installation and Gatekeeper launch succeed for the Developer ID-signed, notarized staged release candidate from every documented supported install path/account model.
- app launches with the same stable Densa identity and isolated data paths established in Phase 10.
- bundled Core starts without a development source checkout or arbitrary global Node requirement.
- final candidate support matrix contains only macOS/architecture rows that passed editor + bundled Core + live Codex end-to-end testing.
- final upstream freshness decision and metadata/service audit are documented.
- no unintended inherited updater/service/branding configuration remains.
- current supported Codex passes the fresh live end-to-end smoke test on every declared support-matrix row using the recorded executable provenance.
- an older signed/test fixture can discover and install the v1 candidate, including safe Core/DB upgrade behavior.
- staged Sparkle artifacts/feed pass required authenticity verification, and the public stable feed remains untouched.
- every nested executable/helper/runtime artifact passes signing/entitlement/architecture inspection.
- supply-chain scans/inventory/hashes/notices are produced, reviewed, and satisfy the explicit vulnerability release policy; unresolved release-blocking vulnerabilities cannot be waived by mere scanner completion.
- public CLI/uninstall behavior is tested according to the explicit v1 decision.
- unsigned/ad-hoc builds are clearly non-public development artifacts and cannot be used to satisfy Gate E.
- no public stable appcast/download/support-matrix publication occurs in this milestone.

Do not start the next milestone.
```

## Phase 13 Milestone 4 — Run packaged post-update soak and final v1 release audit

### Copy-paste prompt

```text
You are implementing Densa ADE Phase 13 Milestone 4.

Read AGENTS.md first.

Goal:
Perform the final v1 engineering audit against the exact packaged/signed/notarized candidate staged in Milestone 3. Only if every Gate E pre-publication condition passes may this milestone promote that exact audited candidate to the public stable appcast/download channel as its final release action. Do not add new product features and do not rebuild/change the candidate between final audit and promotion.

First, run an abbreviated post-packaging/post-updater soak against the release candidate so Sparkle, app replacement, bundled Core, DB migration, signing, and packaged paths are tested together rather than relying only on the pre-updater Phase 13 Milestone 1 soak.

Packaged soak must include at least:
- active project while update becomes available;
- deferred install at safe boundary;
- old Core shutdown and stale socket/PID cleanup;
- app replacement and new Core launch;
- migration and reconnect/event replay;
- failed update/download path while active run continues;
- multi-window reconnect after upgrade;
- sleep/wake/reopen after packaged launch;
- repeated launch/quit with no orphan daemon/keep-awake leak;
- clean-machine installed-path smoke test from every supported install path/account model;
- insufficient-disk update/migration preflight and chosen rescue/restore path;
- staged-feed withdrawal/promotion rehearsal without touching the public stable feed;
- live Codex end-to-end smoke evidence for every declared support row against this exact candidate.

Final audit:
1. AGENTS.md invariants.
2. Core/editor separation and no direct UI DB access.
3. Code - OSS patchset size/documentation and final upstream baseline decision.
4. final inherited metadata/service/updater/branding audit.
5. state-transition coverage.
6. DB migrations, migration backup/recovery, and version-skew rules.
7. Git safety.
8. secret handling/redaction.
9. policy enforcement.
10. Workspace Trust cannot be bypassed by Densa execution commands.
11. retry/block behavior.
12. crash recovery.
13. WAITING_FOR_USAGE honesty.
14. keep-awake cleanup.
15. protocol compatibility/reconnect/multi-client stale-action behavior.
16. validation independence.
17. Dashboard/Roadmap/Master factual correctness, bounded loading, and accessibility.
18. custom-surface/webview security: CSP/resource restrictions/sanitization/typed messages/no executable model output.
19. Open VSX configuration and accurate third-party extension trust-boundary documentation.
20. workspace moved/missing/unavailable recovery/re-link behavior, including copied/duplicate project identity and authoritative relink operations.
21. Codex executable provenance/discovery cannot be silently redirected by workspace/project content.
22. Sparkle integration, HTTPS feed, archive authenticity, signed-feed status, delta policy, and invalid-signature rejection.
23. updater hosting/operations contract, staging-to-stable promotion controls, and validly-signed-bad-release response are documented/rehearsed.
24. private Sparkle key absent from repository/logs/telemetry plus backup/rotation/compromise procedure present.
25. older-version fixture can update to v1; updater failure does not break Densa ADE.
26. update install/restart cannot silently destroy an active Densa run.
27. app/Core/protocol/schema/runtime version model, disk-space preflight, DB snapshot, migration, and rescue/restore transaction are enforced.
28. Developer ID Application signing, Hardened Runtime, nested-code/entitlement audit, notarization, stapling/Gatekeeper validation for the staged public candidate.
29. declared macOS/CPU support matrix matches actual tested artifacts and each declared row passed a live Codex end-to-end smoke test.
30. optional telemetry can be disabled and disabled telemetry is not transmitted.
31. telemetry allowlist excludes source code, prompts, project/repository identity, paths, secrets, auth data, arbitrary logs.
32. production telemetry collector/privacy contract exists if optional telemetry transmission is enabled; otherwise production transport remains disabled.
33. telemetry failures cannot break Densa ADE and privacy docs match implementation; essential traffic is limited to named feature/service interactions.
34. no automatic push.
35. local-first wording is accurate: Densa project/orchestration state is local-first, but external services such as Codex/Open VSX/update feed/optional telemetry are not falsely described as nonexistent/offline.
36. public CLI/uninstall/cleanup behavior matches the documented decision and does not delete user projects.
37. dependency/security scan, secret scan, SBOM/dependency inventory, notices, hashes, and release provenance are complete and every finding satisfies the vulnerability release policy.
38. automated direct-upstream patch inventory is clean and all scheduled upstream-security/external-assumption verification records are dated/current.
39. numeric release/performance/soak budgets pass.
40. release test matrix is green.

Produce `docs/v1-release-audit.md` with PASS/FAIL/DEFERRED for every item, evidence commands/links, and release blockers.

Non-deferrable release-blocker categories:
The following may not be marked DEFERRED for Gate E:
- Core/editor authority boundary;
- Workspace Trust execution enforcement;
- webview/custom-surface security controls;
- secret leakage protections;
- Git/workspace destructive-safety invariants;
- DB migration/backup/version-skew safety;
- bundled Core runtime clean-machine launch;
- supported-platform/architecture install/launch;
- Developer ID signing/notarization/Gatekeeper public-distribution path;
- Sparkle authenticity/update-transaction safety;
- current supported Codex live smoke test;
- optional telemetry disablement/data-minimization (and collector contract if transmission is enabled);
- no unintended inherited updater/service/branding configuration;
- supply-chain release artifacts/checks and vulnerability-severity policy required by this roadmap;
- live Codex functional support on every publicly declared macOS/CPU row;
- update rescue/restore path and staging-to-stable publication controls;
- nested-code signing/entitlement audit.

Public promotion rule:
1. Complete `docs/v1-release-audit.md` and the packaged soak first while the candidate exists only in staging/private release infrastructure.
2. Evaluate Gate E as a pre-publication gate against the exact candidate hash/build.
3. If any Gate E condition fails, do not modify the public stable appcast/download channel. Fixing the issue requires a new candidate/build/version where appropriate and another Milestone 3/4 validation cycle.
4. If and only if every Gate E condition passes, promote the exact audited signed/notarized artifacts and signed appcast metadata to the public stable channel using `docs/UPDATER_OPERATIONS.md`. Publish the final support matrix, hashes, release notes, known limitations, and provenance at the same time.
5. Immediately verify public feed/download availability and authenticity after promotion. Record release timestamp, artifact hashes, feed state, and promoter identity/authorization.

Acceptance criteria:
- no release-blocking FAIL remains.
- no non-deferrable item is marked DEFERRED.
- any DEFERRED item is genuinely outside v1 scope and cannot weaken a stated v1 security/reliability/platform promise.
- packaged post-update soak and numeric release budgets pass.
- all Gate E pre-publication conditions pass with evidence for the exact staged candidate.
- the public stable release is promoted only after the gate passes; failed candidates never reach the public stable feed.
- post-promotion public feed/download authenticity checks pass and release evidence is recorded.
- audit does not hide known issues.

Do not begin post-v1 expansion from this milestone.
```

---

# Post-v1 backlog — explicitly not authorized by this roadmap

Do **not** implement these before the v1 public release unless the roadmap is deliberately revised:

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
- Densa ADE accounts;
- cloud sync;
- billing/subscriptions;
- remote-control web dashboard;
- marketplace for agents;
- automatic remote Git pushes;
- multi-repo distributed orchestration.

The v1 moat is not the number of providers or platforms. It is **reliable, understandable orchestration**.

---

# Release gates

## Gate A — Agent integration proof
Must pass after Phase 1:
- a worker can modify a fixture repo;
- Densa ADE independently detects pass/fail;
- cancellation works;
- Codex-specific behavior is isolated.

## Gate B — Persistence/recovery proof
Must pass after Phase 3:
- state survives restart;
- user work is not destroyed;
- checkpoints and commits are coherent.

## Gate C — Headless product proof
Must pass after Phase 9:
- idea/spec -> roadmap -> Phase 1 execution -> validation -> report -> approval works end-to-end;
- Core restart does not break the real one-phase run;
- deterministic Continuous-mode/retry/usage-wait/recovery/pause/workspace-divergence/scope-approval/BLOCKED scenarios pass;
- persisted events tell a coherent recoverable story across those scenarios;
- the client-facing Core protocol required by the planned v1 IDE is versioned, bounded, reconnect-capable, contract-tested, and frozen for the first IDE integration pass. If Phase 10 integration proves that a required multi-client safety primitive such as idempotency or authoritative revision preconditions is missing, only the smallest versioned, contract-tested compatibility amendment is allowed before state-changing IDE actions are enabled; record the Gate C protocol defect and do not use client-side workarounds.

**No Code - OSS fork work before all Gate C conditions pass.**

## Gate D — IDE integration proof
Must pass after Phase 11:
- IDE is a protocol client only; no UI surface directly reads/mutates Core DB/internal state;
- the bundled Core runtime can continue according to project policy without an IDE window and reconnect accurately later;
- Workspace Trust prevents Densa execution in untrusted/restricted workspaces through both visible and direct command paths;
- Roadmap/Dashboard/Master/phase-report surfaces reflect persisted Core truth after reconnect/reload;
- two-window/multi-client stale/conflicting actions resolve deterministically through Core;
- custom-surface/webview security controls prevent script/command/resource injection from project/model content;
- Dashboard/Roadmap/Master history loading is bounded and does not require unbounded journal hydration;
- primary Densa UI flows pass keyboard/focus/high-contrast/zoom accessibility smoke tests;
- ordinary Code - OSS editing/terminal/Command Palette behavior remains functional;
- final Phase 11 patch additions remain inventoried/minimal and automated patch-inventory validation has no unexplained direct upstream modifications;
- the scheduled Gate D upstream-security freshness review and dated external-assumption checks for Code - OSS/Workspace Trust are recorded.

## Gate E — v1 public release approval and publication
Must pass at the end of Phase 13 **before** public stable appcast/download promotion. Public promotion is the final action of Phase 13 Milestone 4 after these conditions pass:
- reliability/security matrix and packaged post-update soak are green;
- release audit has no release-blocking FAIL and no non-deferrable DEFERRED item;
- bundled Core/runtime launches on a clean supported Mac without development checkout/global Node assumptions;
- declared macOS/CPU support matrix is actually built/tested, and every public support row passes a fresh live end-to-end Densa project smoke test with the supported official Codex environment and recorded executable provenance;
- Workspace Trust and custom-surface security release tests pass;
- DB migration backup/recovery and IDE/Core/protocol/schema version-skew rules pass;
- Developer ID Application signing, Hardened Runtime, nested-code/entitlement inspection, notarization, and Gatekeeper validation pass for the exact staged release artifact;
- Sparkle archive/feed authenticity, signed-feed/delta policy, old-version update, active-run deferral, app/Core/DB upgrade transaction, disk-space preflight, tested rescue/restore path, and failure isolation pass;
- updater staging/hosting/promotion operations are documented and rehearsed, including response to a validly signed but broken release;
- inherited Code - OSS updater and unintended service/telemetry/AI/branding configuration are absent or explicitly approved;
- optional telemetry disablement/data-minimization tests pass; if production optional telemetry is enabled, its collector/retention/IP/logging contract is documented and matches behavior;
- dependency/security scan, secret scan, SBOM/dependency inventory, license notices, artifact hashes, and release provenance are complete, and every vulnerability finding satisfies the explicit severity/risk-acceptance release policy;
- automated direct-upstream patch inventory is clean and the scheduled upstream-security/external-assumption verification records are current;
- numeric v1 release/performance/soak budgets pass;
- public CLI/uninstall/cleanup behavior matches the documented v1 decision;
- known limitations are documented without falsely claiming fully offline operation when external Codex/Open VSX/update services are used;
- only after every condition above passes is the exact audited candidate promoted to the public stable feed/download location, followed by an immediate public authenticity/availability verification.

---

# External assumptions to re-verify when implementation reaches them

These are deliberately not baked into Densa ADE's core contracts. Every required re-check below must produce a dated verification artifact that records the exact pinned/observed version or documentation/source reviewed, the result, and any roadmap decision caused by the re-check. A prose claim that something was "re-checked" without evidence does not satisfy Gate D/E.

1. **Code - OSS structure and product metadata change over time.**
   Keep the downstream patch thin, re-check upstream contribution/source organization before deep workbench changes, and rerun the product/service metadata audit after any upstream sync and again before release.

2. **Workspace Trust/Restricted Mode and editor agent behavior evolve.**
   Re-check the pinned Code - OSS trust APIs/semantics when Phase 10 implements Densa execution gating. Densa Core must not depend on private/experimental agent APIs to enforce its own security boundary.

3. **VS Code's own Agent Host/AHP is evolving.**
   Densa ADE Core should remain independent rather than depending on private/experimental agent APIs in v1.

4. **Codex CLI flags/output may evolve.**
   The Phase 1 spike stores versioned fixtures, but Phase 13 must re-run a live smoke test against the version Densa actually supports at release.

5. **Codex usage/reset behavior varies.**
   Treat usage as available/limited/unknown and only show resetAt when actually observed.

6. **Extension registry/licensing/security behavior may evolve.**
   Re-check Open VSX/Code - OSS distribution details, publisher/namespace trust signals, package/integrity behavior, and third-party-extension security semantics during Phase 12 and again before release packaging. Do not claim Densa permission presets sandbox third-party extensions.

7. **Sparkle APIs/security recommendations evolve.**
   Re-check the pinned Sparkle release's archive-signing, signed-feed, versioning, and key-rotation guidance before shipping.

8. **Apple macOS signing/notarization/support requirements evolve.**
   Re-check Developer ID, Hardened Runtime, nested-code signing/entitlements, notarization/stapling, Gatekeeper, supported install locations/account behavior, and supported macOS/architecture requirements against current Apple tooling before Gate E.

9. **Codex installation/discovery/version support evolves.**
   Re-check the official supported installation mechanisms and supported macOS/CPU combinations before finalizing the public support matrix. Densa must record the actual resolved executable path/version/provenance and must not silently execute a workspace-selected shim.

10. **Update hosting/CDN/service operations evolve independently of client code.**
   Re-check the public/staging feed host, TLS, publishing credentials, cache behavior, monitoring, promotion procedure, and broken-release response before Gate E. A correct Sparkle client is not enough if release infrastructure is undefined or unsafe.

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
