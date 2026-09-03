# Core protocol v1

Protocol `1.0.0` is the frozen editor-neutral boundary for the first Densa ADE IDE integration.
The operation and view schemas live in `@densa-ade/protocol`; an IDE client imports that package and
uses `CoreV1Client`, never `@densa-ade/core`, SQLite repositories, or workbench/webview types.

## Current runtime composition

The daemon composes every catalog operation through authoritative Core services. Reads derive
from persisted facts via `CoreRuntimeViews`; mutations go through `CoreRuntimeMutations` with
centralized state transitions, domain authorization, canonical workspace binding, and audit
events. Interview answers persist as explicit user decisions; roadmap generation preserves the
exact specification goal and materializes runtime phases/tasks through the initial-roadmap
service; revision proposals use the durable revision workflow; Master responses use the
Core-owned rundown; approvals move phase/task lifecycle state; settings use execution-mode,
permission-policy, and keep-awake boundaries; permission resolutions append durable audit
facts.

`npm run proof:p9m2` checks read-operation routing against a real disposable daemon. The
workflow suite `scripts/core-v1-runtime-workflow.test.mjs` exercises the complete
idea-to-start path, revision approval, guided/phase approvals, settings/permissions, and a
file-backed restart through a real daemon. The fake-client schema suite proves contracts only.

## Planned UI coverage

| UI interaction        | Protocol operations                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Home and project list | `system.bootstrap`, `projects.list`, `projects.get`                                                                       |
| Start Project         | `projects.create`, `projects.interview.answer`, `projects.specification.get`, `roadmaps.generate`, `projects.start`       |
| Dashboard             | `dashboard.get`, `tasks.approve`, `phases.report.get`, `attempts.list`, `decisions.list`, `usage.get`, `events.subscribe` |
| Roadmap               | `roadmaps.get`, `roadmaps.revisions.list`, `roadmaps.revisions.propose`, `roadmaps.revisions.resolve`                     |
| Master Agent          | `master.send`                                                                                                             |
| Phase approval        | `phases.approve`                                                                                                          |
| Guided task approval  | `tasks.approve`                                                                                                           |
| Execution controls    | `projects.pause`, `projects.resume`, `projects.stop`                                                                      |
| Settings and policy   | `settings.get`, `settings.update`, `permissions.resolve`                                                                  |
| Permission approval   | `permissions.resolve`                                                                                                     |
| Event history         | `events.replay`, `events.subscribe`                                                                                       |
| Run logs              | `logs.list` and `run.log.appended` notifications                                                                          |
| Git drill-down        | `git.status`, `git.commit.get`                                                                                            |
| Validation drill-down | `validation.list`, `validation.get`                                                                                       |

`CORE_V1_METHODS` is the normative operation catalog. Every method has one strict request-payload
schema and one strict result schema in `coreV1OperationContracts`. Unknown object fields are
rejected. The `CoreV1Client` facade validates both directions and constructs the versioned request
envelope.

The facade also rejects typed result identities inconsistent with the requested project, task,
phase, validation run, approval decision, proposal, or commit. Opaque historical payloads remain
data, not ownership declarations. Server-side authorization and canonical workspace ownership
checks remain mandatory; client response checks do not replace them.

Core returns authoritative snapshots or mutation outcomes. Clients may cache them for rendering,
but must not infer a successful state transition from a button click, a Master response, or worker
prose.

## Bounded histories

Event and log requests accept at most 200 entries. The default page size is 50. Event replay uses an
exclusive, per-project integer `afterSequence`; log and project-list pagination use opaque cursors.
An opaque cursor has no client-visible ordering semantics and must not be fabricated or modified.
`hasMore: true` always includes a next cursor for cursor-based pages.

Implemented event replay/subscription pages also stop at the transport's 1 MiB encoded frame
limit. A page can therefore contain fewer than the requested number of entries with `hasMore`
still true. Continue from its last applied event, not by adding the requested page size. A single
persisted event too large for a frame fails explicitly with `PERSISTENCE_FAILURE`.

Run-log content is bounded to 16 KiB per entry and includes a `redacted` fact. Large domain snapshots
are bounded to 5,000 phase/task/detail records. A future need beyond that bound requires an additive
paginated operation rather than silently making responses unbounded.

## Reconnect semantics

The local socket connection is disposable; Core lifecycle and authoritative execution do not depend
on a client remaining connected.

For a selected project, a reconnecting client must:

1. reconnect and call `system.bootstrap` to confirm the instance and protocol version;
2. call `events.replay` with its last durably applied sequence, repeating while `hasMore` is true;
3. call `events.subscribe` using the newest applied sequence;
4. apply the subscription response's replay page before accepting live `core.event` notifications;
5. ignore a duplicate sequence already applied, reject a gap, and replay again from the last
   contiguous sequence when a gap or another disconnect is observed;
6. refresh the relevant authoritative snapshot (`projects.get`, `dashboard.get`, or `roadmaps.get`)
   before issuing a mutation whose UI preconditions may have changed.

The subscription response installs the live listener at the same synchronous Core boundary as its
replay snapshot. Notifications are hints to refresh or apply committed facts; they are not a second
source of truth. Run-log cursors are independent of durable event sequence numbers, so log views
resume through `logs.list` with their last opaque cursor.

The daemon writes subscription replay before live notifications. If the response has `hasMore`,
continue replay before applying newer notifications; a detected gap always requires recovery.
The reconnect recipe above is implementable: bootstrap, replay, subscribe, and snapshot refresh
are all production-routed.

`CoreIpcClient` shares one connection among concurrent first requests and rejects duplicate pending
request IDs. Connection setup defaults to a 5-second timeout and requests to 30 seconds; callers can
configure positive bounded millisecond values. A request timeout disconnects the client and reports
an unknown operation outcome. It does not cancel an authoritative mutation or retry it. Refresh
authoritative state before deciding whether a mutation can safely be retried. Disconnect/reconnect
clears pending requests without allowing an old socket's close event to invalidate the new socket.

## Compatibility policy

The protocol major is the compatibility unit.

- New methods may ship in v1. Clients discover them through `system.bootstrap` capabilities and
  ignore unknown capability names.
- Existing method names and strict payload/result fields, state meanings, cursor semantics, and
  mutation outcomes are frozen for the first IDE pass.
- Adding, removing, or renaming a field, changing a field's meaning, or changing reconnect ordering
  requires a new protocol major.
- A Core and client that do not share a supported major fail closed with
  `PROTOCOL_VERSION_MISMATCH`. They do not attempt best-effort decoding.
- Persisted event `eventVersion` is independent from the transport protocol version. Historical
  facts are upgraded by version-aware readers and are never rewritten for transport compatibility.

The first IDE integration may add client-local view models around these responses, but those models
must not cross the Core boundary or become authoritative project state.
