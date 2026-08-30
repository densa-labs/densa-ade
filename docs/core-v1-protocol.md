# Core protocol v1

Protocol `1.0.0` is the frozen editor-neutral boundary for the first Densa ADE IDE integration.
The operation and view schemas live in `@densa-ade/protocol`; an IDE client imports that package and
uses `CoreV1Client`, never `@densa-ade/core`, SQLite repositories, or workbench/webview types.

## Planned UI coverage

| UI interaction        | Protocol operations                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Home and project list | `system.bootstrap`, `projects.list`, `projects.get`                                                                 |
| Start Project         | `projects.create`, `projects.interview.answer`, `projects.specification.get`, `roadmaps.generate`, `projects.start` |
| Dashboard             | `dashboard.get`, `phases.report.get`, `attempts.list`, `decisions.list`, `usage.get`, `events.subscribe`            |
| Roadmap               | `roadmaps.get`, `roadmaps.revisions.list`, `roadmaps.revisions.propose`, `roadmaps.revisions.resolve`               |
| Master Agent          | `master.send`                                                                                                       |
| Phase approval        | `phases.approve`                                                                                                    |
| Execution controls    | `projects.pause`, `projects.resume`, `projects.stop`                                                                |
| Settings and policy   | `settings.get`, `settings.update`                                                                                   |
| Event history         | `events.replay`, `events.subscribe`                                                                                 |
| Run logs              | `logs.list` and `run.log.appended` notifications                                                                    |
| Git drill-down        | `git.status`, `git.commit.get`                                                                                      |
| Validation drill-down | `validation.list`, `validation.get`                                                                                 |

`CORE_V1_METHODS` is the normative operation catalog. Every method has one strict request-payload
schema and one strict result schema in `coreV1OperationContracts`. Unknown object fields are
rejected. The `CoreV1Client` facade validates both directions and constructs the versioned request
envelope.

Core returns authoritative snapshots or mutation outcomes. Clients may cache them for rendering,
but must not infer a successful state transition from a button click, a Master response, or worker
prose.

## Bounded histories

Event and log requests accept at most 200 entries. The default page size is 50. Event replay uses an
exclusive, per-project integer `afterSequence`; log and project-list pagination use opaque cursors.
An opaque cursor has no client-visible ordering semantics and must not be fabricated or modified.
`hasMore: true` always includes a next cursor for cursor-based pages.

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
