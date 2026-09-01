# Core daemon and secure local IPC

Phase 7 Milestone 5 moves Densa ADE Core into a user-local process that is independent of any CLI,
IDE, Dashboard, or other client. On macOS the process listens only on a Unix-domain socket. It
does not open a TCP port.

## Runtime ownership

The default runtime directory is `~/.densa-ade/runtime` and is created with mode `0700`. The socket,
PID metadata, rotating per-instance authentication token, and SQLite database are private to the
current user. The socket, PID, token, and database use mode `0600`; the private directory also
protects SQLite's transient files.

The token is generated for every daemon instance and stored only in the private runtime token
file. Every request carries it in the transport frame. The daemon compares it without
value-dependent timing and rejects unauthenticated requests before dispatch. Tokens are not
included in responses, notifications, events, or diagnostics.

Startup first acquires `core.start.lock` with exclusive creation and records the candidate instance,
PID, and timestamp. A live lock owner blocks concurrent startup; a dead lock owner permits recovery.
While holding that lock, startup recovers stale runtime paths, persists PID/instance intent, recovers
Core-owned keep-awake state, and begins listening. Cleanup is ownership-aware, so a losing concurrent
starter cannot remove the winning instance's token, PID metadata, or socket. A socket without PID
metadata is probed and is never removed while it accepts connections. This avoids replacing a live
endpoint and makes SIGKILL residue recoverable.

## Protocol and replay

Transport messages are newline-delimited JSON with a one-megabyte frame bound. The inner request,
response, and notification envelopes are the versioned contracts in `@densa-ade/protocol`. Wrong
protocol versions return `PROTOCOL_VERSION_MISMATCH`; wrong credentials return
`AUTHENTICATION_REQUIRED`.

`events.replay` reads committed facts after an exclusive per-project sequence number.
`events.subscribe` returns the initial replay and then emits `core.event` notifications for facts
published after SQLite commit. IPC replay defaults to 50 and is capped at 200 events per request so
a client can page without exceeding the transport bound. A second or reconnecting client is a reader
of Core state; it does not become authoritative.

`keep-awake.status` accepts a schema-validated project identifier and returns the authoritative Core
status. Clients must use this method rather than inferring an operating-system assertion from local
UI state or persisted demand.

## CLI lifecycle

```text
densa-ade core start
densa-ade core status
densa-ade core stop
```

`start` launches a detached Node process and waits for an authenticated status response. Client
exit or termination does not stop Core. `stop` is an authenticated request that closes clients,
the socket, and owned process metadata cleanly. Repeating start or stop is idempotent.
