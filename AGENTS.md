# AGENTS.md — Densa Engineering Constitution

> **Scope:** These instructions apply to the entire Densa repository unless a more specific nested `AGENTS.md` deliberately narrows them.
>
> **Read this file before changing code.** If a milestone conflicts with this file, stop and surface the conflict rather than silently violating an invariant.

## 0. Product definition

Densa is a local-first, Code - OSS-based AI development IDE that turns a user's idea into a structured project roadmap, delegates implementation to coding agents, validates their work independently, persists execution state, and lets the user choose how much control to retain.

The four primary user surfaces are:

1. **Editor** — "I want to work on the code."
2. **Roadmap** — "I want to see or change what will happen."
3. **Master Agent** — "I want to steer the project."
4. **Dashboard** — "I want to understand everything happening."

Densa is **not** primarily an AI chat sidebar. The core product is the project lifecycle and orchestration layer.

## 1. Non-negotiable architecture

### 1.1 Densa Core is authoritative

The authoritative project state lives in **Densa Core**, a local process independent of the IDE UI.

The IDE, CLI, Dashboard, Roadmap, and Master Agent are clients of Densa Core. They may request mutations, but they do not directly mutate authoritative state.

Never make the renderer, a webview, an extension-host object, or an in-memory React store the source of truth.

### 1.2 Densa Core must remain editor-independent

Densa Core must not import VS Code workbench APIs or depend on Code - OSS internals.

The architectural direction is:

```text
Densa IDE / densa CLI
        |
        | versioned local protocol
        v
    Densa Core
        |
        +-- Project state
        +-- Roadmap engine
        +-- Scheduler
        +-- Policy engine
        +-- Validation
        +-- Git/workspace
        +-- Recovery
        +-- Agent adapters
                |
                v
             Codex CLI
```

A future CLI, remote UI, or another editor must be able to reuse Densa Core.

### 1.3 The Code - OSS fork stays thin

If a feature can reasonably live outside Code - OSS core, it **must**.

Prefer, in order:

1. normal extension contribution APIs;
2. a built-in Densa extension;
3. isolated `vs/workbench/contrib/...` integration;
4. minimal workbench/core patching only when the required product UX cannot be achieved otherwise.

Do not rewrite or fork the editor, Explorer, terminal, SCM, debugger, extension host, Monaco, or other mature upstream systems merely to make them "more Densa."

Every direct Code - OSS core patch must include a short comment or adjacent documentation explaining:
- why an extension/built-in contribution could not do the job;
- what upstream area is touched;
- how to test the patch during upstream merges.

### 1.4 Do not couple Densa to unstable private VS Code agent APIs

Densa may learn from VS Code's agent architecture, but v0.1 must not require private/experimental Agent Host APIs or undocumented internal protocols.

If a stable public protocol later becomes a better fit, add it behind an adapter. Do not redesign Densa Core around it mid-v0.1.

## 2. State-machine rules

### 2.1 All state transitions go through one domain service

Never set task, phase, or project status ad hoc.

Use centralized transition functions that:
- validate the current state;
- validate the requested next state;
- persist the transition transactionally;
- append an audit event;
- return the new state.

### 2.2 Canonical project states

```text
DRAFT
PLANNING
READY
RUNNING
PAUSED
WAITING_FOR_USER
WAITING_FOR_USAGE
BLOCKED
COMPLETED
FAILED
```

### 2.3 Canonical phase states

```text
PENDING
READY
RUNNING
VALIDATING
AWAITING_APPROVAL
COMPLETED
BLOCKED
```

### 2.4 Canonical task states

```text
PENDING
READY
RUNNING
VALIDATING
RETRYING
WAITING_FOR_USER
WAITING_FOR_USAGE
BLOCKED
INTERRUPTED
COMPLETED
CANCELLED
```

Do not invent a new state because it is convenient. If a missing state is genuinely required, update the domain model, transitions, persistence migration, event schema, tests, and documentation together.

### 2.5 State transitions must be crash-safe

The persisted state must always tell recovery logic what happened last.

Prefer:
1. persist intent/state transition;
2. perform external side effect;
3. persist outcome.

If a crash can happen between steps, recovery must be able to distinguish "not started", "started but outcome unknown", and "completed."

## 3. Persistence and auditability

### 3.1 SQLite is the detailed runtime source of truth

Use SQLite with explicit schema migrations.

Never mutate a production schema manually. Every schema change gets:
- a migration;
- a migration test;
- backward/forward assumptions documented when relevant.

### 3.2 `.densa/` is the portable human/agent representation

Expected shape:

```text
.densa/
├── project.json
├── SPEC.md
├── ROADMAP.md
├── DECISIONS.md
├── config.json
├── reports/
└── logs/
```

Do not put secrets in `.densa/`.

SQLite may contain richer runtime details than `.densa/`, but important project intent, decisions, and phase reports must remain inspectable without opening the database.

### 3.3 Events are append-only facts

Events describe things that happened. Do not edit old events to make history look cleaner.

Examples:
- `PROJECT_STARTED`
- `ROADMAP_GENERATED`
- `ROADMAP_CHANGED`
- `PHASE_STARTED`
- `TASK_STARTED`
- `AGENT_STARTED`
- `AGENT_FINISHED`
- `VALIDATION_STARTED`
- `VALIDATION_FAILED`
- `RETRY_STARTED`
- `TASK_COMPLETED`
- `PHASE_COMPLETED`
- `USAGE_LIMIT_REACHED`
- `PROJECT_PAUSED`
- `PROJECT_RESUMED`
- `PROJECT_COMPLETED`

Event payloads are versioned. Changing a payload schema requires compatibility handling.

## 4. Roadmap rules

### 4.1 The roadmap is complete before autonomous execution starts

For normal project creation, Densa produces the full phase-level roadmap before Phase 1 begins.

The roadmap may evolve later, but the user must be able to see the intended project arc before execution.

### 4.2 Every executable task requires acceptance criteria

A task without testable/verifiable completion criteria is not READY.

Acceptance criteria should be concrete. Prefer:
- "endpoint returns 400 for malformed cursor"
over:
- "pagination works well."

### 4.3 Roadmap changes are classified

**MINOR**
- add/reorder an implementation task;
- split a task for execution;
- add a missing test task.
- May be automatic, but must be logged.

**SIGNIFICANT**
- alter implementation architecture;
- replace a major library/framework choice;
- materially modify persistence or security architecture.
- Automatic only if current user policy explicitly allows it; otherwise ask.

**SCOPE**
- add/remove a major user feature;
- contradict the user specification;
- weaken a promised requirement;
- change the fundamental product goal.
- Always ask the user.

Never silently delete a feature because implementation is difficult.

### 4.4 Roadmap history must explain why

Every mutation records:
- old value;
- new value;
- classification;
- reason;
- actor/session;
- timestamp;
- affected phases/tasks.

## 5. Agent rules

### 5.1 Agents are replaceable workers

All worker integration goes through `AgentAdapter`.

Do not leak Codex-specific assumptions into scheduler, state, validation, UI, or roadmap code.

A conceptual adapter exposes capabilities equivalent to:

```ts
interface AgentAdapter {
  detect(): Promise<AgentDetection>;
  getStatus(): Promise<AgentStatus>;
  execute(run: AgentRunRequest): AsyncIterable<AgentEvent>;
  cancel(runId: string): Promise<void>;
  getUsageState(): Promise<UsageState>;
}
```

The exact type may evolve, but the boundary must remain.

### 5.2 User authentication stays with the official agent

Densa must never scrape browser cookies, steal session tokens, store ChatGPT passwords, or impersonate an unsupported login flow.

For Codex, the user authenticates with the official Codex client/CLI. Densa invokes the authenticated tool.

### 5.3 Do not parse presentation text when structured output exists

Prefer documented machine-readable modes and stable exit/status contracts.

ANSI/terminal scraping is allowed only as an isolated fallback inside an adapter with:
- fixtures;
- tests;
- version detection;
- a safe `unknown` result when parsing fails.

Never let a brittle regex decide that a project is safe to continue.

### 5.4 Master and worker roles are logically separate

In v0.1 both may use Codex, but they have distinct sessions and context.

**Master role**
- interview;
- project specification;
- roadmap planning;
- roadmap revisions;
- explanations;
- high-level recovery reasoning.

**Worker role**
- implementation;
- tests;
- fixes;
- refactors scoped to the assigned task.

Do not stuff raw worker transcripts into the Master context by default.

### 5.5 Agents never certify their own success

An agent saying "done" is evidence of process completion, not task completion.

Only Densa's validation pipeline may transition a task to `COMPLETED`.

## 6. Execution and scheduling rules

### 6.1 Scheduling is dependency-driven

A task becomes READY only when:
- all hard dependencies are completed;
- required project/phase state permits it;
- required permissions are available;
- no blocking user decision is outstanding.

Do not rely on array order alone.

### 6.2 v0.1 executes one implementation worker at a time

Do not introduce parallel code-writing workers before v0.1.

Parallelism creates merge conflicts, resource contention, and more complex recovery. Design interfaces so parallelism is possible later, but execute serially now.

### 6.3 Every task begins from a known workspace checkpoint

Before agent execution:
- inspect Git/worktree status;
- identify user changes;
- establish a checkpoint;
- persist checkpoint metadata.

Never assume the workspace is clean.

### 6.4 Operations must be resumable or explicitly non-resumable

Long-running flows must define what happens after:
- IDE closes;
- Core crashes;
- worker crashes;
- machine sleeps/restarts;
- user modifies files;
- usage becomes unavailable;
- validation is interrupted.

Prefer idempotent/re-entrant handlers.

## 7. Git and workspace safety

### 7.1 Never destroy user work

Do not use broad destructive cleanup (`git reset --hard`, `git clean -fdx`, blanket file deletion) against a user's workspace unless Densa can prove the content belongs to its isolated checkpoint/worktree and policy explicitly allows it.

If user-authored uncommitted changes are present, preserve them or stop and ask.

### 7.2 Densa does not push in v0.1

Densa may:
- create a Densa working branch;
- create task commits;
- create internal refs/checkpoints.

Densa does **not** automatically push to remotes.

### 7.3 Successful tasks get atomic commits

A successful task should have a commit that maps clearly to its task ID unless there is a documented reason not to.

Example:

```text
densa: SEARCH-004 implement cursor pagination
```

A failed attempt should not be hidden. Attempt history remains in Densa state even if the code is rolled back.

## 8. Validation rules

### 8.1 Prefer deterministic evidence first

Order of confidence:

1. compiler/build result;
2. typecheck;
3. lint/static analysis;
4. unit/integration tests;
5. browser/E2E tests;
6. structured acceptance checks;
7. independent AI review.

AI review supplements deterministic validation; it does not replace available deterministic checks.

### 8.2 Validation is task-aware

Do not run Playwright for a pure documentation task or skip browser testing for a user-visible browser behavior solely because the unit tests passed.

### 8.3 Phase completion is stricter than task completion

Before a phase is `COMPLETED`, run:
- project build if applicable;
- relevant type/lint checks;
- relevant test suite;
- phase acceptance sweep;
- fresh-context independent review for risky or phase-level claims.

### 8.4 Validation failures produce actionable retry context

Retries should receive:
- failing command;
- exit code;
- concise relevant logs;
- failing acceptance criterion;
- relevant diff/paths;
- prior attempt summary.

Do not blindly rerun the same prompt four times.

## 9. Retry and failure rules

Default maximum attempts per task: **4**.

A retry must have new evidence or a revised strategy.

After the maximum:
- do not silently skip;
- transition to `BLOCKED` or `WAITING_FOR_USER`;
- explain what failed;
- preserve diagnostics;
- propose bounded options.

Retry counters persist across crashes.

## 10. Usage-limit rules

Usage state is:

```ts
type UsageState =
  | { status: "available" }
  | { status: "limited"; resetAt?: string }
  | { status: "unknown"; reason?: string };
```

Rules:
- never hard-code a fixed reset interval;
- never fabricate a countdown;
- never claim usage is available from an ambiguous error;
- when limited, checkpoint and transition to `WAITING_FOR_USAGE`;
- if an actual reset time is available, persist it;
- otherwise probe availability conservatively;
- before auto-resume, revalidate workspace and project state.

## 11. Keep-awake rules

Built-in macOS keep-awake is the default v0.1 mechanism.

Requirements:
- prevent idle **system** sleep only while policy says Densa should remain available;
- allow display sleep;
- release the assertion immediately when no longer needed;
- support battery thresholds;
- expose state visibly to the user.

Amphetamine may be supported as an optional integration, but it must not be a hard dependency.

## 12. Permissions and security

Ship at least these policy presets:
- **Cautious**
- **Standard** (default)
- **Autonomous**

Even Autonomous must not silently authorize:
- privilege escalation (`sudo`);
- destructive operations outside the workspace;
- access to unrelated user files;
- credential disclosure;
- secret export;
- remote pushes;
- major scope changes.

### 12.1 Secrets

Use macOS Keychain or references to user-managed secret stores when persistence is needed.

Inject secrets into child processes only for the duration and scope required.

Never:
- write secrets to `.densa/`;
- print secrets into logs/events;
- include secrets in Master/worker prompts unless strictly necessary and approved;
- commit `.env` or secret material automatically.

### 12.2 Local IPC

Densa Core's local control endpoint must not be anonymously exposed.

Use a local Unix-domain socket (macOS v0.1), user-only filesystem permissions, and a per-instance/session authentication token or equivalent local trust mechanism.

Protocol messages are versioned and schema-validated.

## 13. Observability and privacy

Telemetry is **off by default** in v0.1.

Local diagnostics may include:
- event IDs;
- task/phase IDs;
- process exit codes;
- durations;
- validator outcomes;
- file paths relative to the workspace;
- adapter version.

Do not collect or log:
- secret values;
- raw authentication tokens;
- unrelated file contents;
- full prompts/transcripts unless the feature explicitly requires local persistence and the user can inspect/delete them.

## 14. UI rules

### 14.1 UI reflects Core; it does not invent truth

If Core says usage is `unknown`, UI says unknown.

If a task is validating, UI says validating.

Never show optimistic "complete" states before persistence and validation confirm them.

### 14.2 Every important Dashboard number is drillable

Examples:
- tests -> validation details;
- retries -> attempt history;
- commits -> Git history/diff;
- phase progress -> Roadmap;
- agent run -> run log;
- roadmap mutation -> decision/audit detail.

Dashboard is not decorative telemetry.

### 14.3 Familiar editor behavior wins

Do not break standard Code - OSS interactions merely to make Densa feel novel.

Densa-specific surfaces should coexist with:
- Explorer;
- editor tabs;
- terminal;
- Problems;
- SCM;
- debugger;
- extensions.

## 15. Dependency and technology rules

v0.1 target:
- macOS;
- TypeScript/Node for Densa Core;
- SQLite;
- Git;
- Playwright where browser validation is applicable;
- Codex as the first agent adapter;
- Open VSX for extension registry in the Code - OSS distribution.

Rules:
- avoid heavy frameworks when a focused library is enough;
- justify new production dependencies;
- pin/lock dependency versions;
- add dependency licenses to release review;
- do not add Redis, Kafka, Kubernetes, cloud queues, or distributed infrastructure to solve a local v0.1 problem.

## 16. Testing ground rules

Every milestone must leave the relevant test suites green.

Minimum test layers as the codebase grows:
- unit tests for domain/state transitions;
- persistence/migration tests;
- adapter contract tests with fixtures/fakes;
- process lifecycle tests;
- Git/workspace integration tests in temporary repos;
- Core IPC contract tests;
- orchestrator integration tests;
- recovery tests that simulate crashes/interruption;
- UI component/state tests;
- end-to-end Densa project smoke tests.

Do not use a live paid agent for routine unit tests. Build fakes/fixtures.

## 17. Error taxonomy

Do not collapse every failure into `Error`.

Classify at least:
- user configuration error;
- agent unavailable;
- authentication required;
- usage limited;
- permission denied;
- process failure;
- validation failure;
- workspace conflict;
- Git failure;
- persistence failure;
- protocol/version mismatch;
- internal invariant violation.

Errors crossing IPC must have stable machine-readable codes plus human-readable messages.

## 18. Performance and process rules

- Never block the UI thread with agent/process/database work.
- Stream events instead of buffering entire long-running outputs in memory.
- Bound retained logs.
- Support cancellation.
- Kill child process trees correctly on cancellation.
- Clean up temporary files, sockets, and keep-awake assertions on normal exit and crash recovery.
- Do not poll rapidly when event-driven notification is available.

## 19. Documentation rules

When a change affects architecture, update the relevant docs in the same milestone.

Important decisions go into `.densa/DECISIONS.md` for a Densa-managed project, or the repository architecture docs for Densa itself.

Do not leave important invariants only in code comments.

## 20. Milestone execution protocol

When implementing a roadmap milestone:

1. Read `AGENTS.md`.
2. Read the milestone and any prerequisite milestone notes.
3. Inspect the current repository; do not assume earlier work exists just because the roadmap says it should.
4. State or record any blocking mismatch.
5. Implement **only the milestone's scope** plus tiny prerequisite fixes required to make it correct.
6. Add/adjust tests.
7. Run the acceptance checks.
8. Fix failures before declaring completion.
9. If the milestone is complete, create its milestone commit according to §20.1.
10. If this completes the phase, create its phase checkpoint/tag according to §20.1.
11. Summarize:
   - what changed;
   - files/modules added;
   - tests/commands run;
   - commit SHA;
   - phase tag, if created;
   - unresolved risks;
   - any roadmap deviation.
12. Do not begin the next milestone unless explicitly asked.

### 20.1 Milestone Git discipline

Each successfully completed roadmap milestone MUST end with its own Git commit.

Rules:
- Run and pass the milestone's required acceptance checks before committing.
- One milestone = one logical commit. Do not combine multiple roadmap milestones into a single commit.
- Use the commit message format: `densa: P<phase>M<milestone> <short description>`.
- Do not begin the next milestone before the current milestone has been committed.
- If a milestone is PARTIAL or BLOCKED, do not create a normal completion commit; report the state and preserve the work for explicit user direction.
- At the completion of the final milestone in a phase, create the phase checkpoint/tag `densa-phase-<phase>-complete` only after all milestones in that phase are complete and their acceptance checks pass.
- Never rewrite, squash, or amend completed milestone commits unless explicitly instructed by the user.
- Never push commits or tags to a remote automatically.

## 21. Forbidden shortcuts

Do not:
- mark tasks complete because an agent says they are complete;
- bypass state-transition validation;
- store authoritative state only in memory;
- treat Code - OSS UI state as project truth;
- hide roadmap changes;
- hard-code Codex usage reset times;
- automatically push user code;
- destroy dirty user work;
- put secrets in prompts/logs without necessity and approval;
- make v0.1 depend on cloud infrastructure;
- add additional agent providers before the Codex adapter contract is proven;
- build the Code - OSS fork before the headless Densa Core loop works end-to-end;
- add parallel implementation agents before v0.1;
- weaken tests just to make a milestone pass.

## 22. Definition of done

A milestone is done only when:
- its requested behavior exists;
- its acceptance criteria pass;
- tests are green;
- failure paths have been considered;
- no architecture invariant above is knowingly violated;
- documentation/contracts are updated where required;
- no unrelated scope has been silently added.

If any of these are false, report the milestone as incomplete.
