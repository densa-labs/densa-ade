# `@densa/cli`

The `densa` executable is a headless, non-authoritative client for Densa Core. Project and event
commands use `@densa/protocol` over the authenticated local Unix socket. Exiting the CLI does not
stop an active Core process.

```text
densa core start
densa core status
densa core stop
densa doctor
densa project init
densa project status
densa project start
densa project pause
densa project cancel
densa project resume
densa project stop
densa events
densa version
```

Human-readable output is the default. Pass `--json` anywhere in the command to emit one JSON
object with `schemaVersion`, `command`, `ok`, and either `data` or `error`. JSON failures are
written to stdout for predictable machine consumption and use a nonzero process exit code.

The command runner accepts injected Core lifecycle, client, doctor, ID, and I/O services. Tests can
therefore prove command behavior without starting Core or an agent process, while process-level
tests exercise the real daemon lifecycle separately.
