# `@densa-ade/cli`

The `densa-ade` executable is a headless, non-authoritative client for Densa ADE Core. Project and event
commands use `@densa-ade/protocol` over the authenticated local Unix socket. Exiting the CLI does not
stop an active Core process.

```text
densa-ade core start
densa-ade core status
densa-ade core stop
densa-ade doctor
densa-ade project init
densa-ade project status
densa-ade project start
densa-ade project pause
densa-ade project cancel
densa-ade project resume
densa-ade project stop
densa-ade events
densa-ade version
```

Human-readable output is the default. Pass `--json` anywhere in the command to emit one JSON
object with `schemaVersion`, `command`, `ok`, and either `data` or `error`. JSON failures are
written to stdout for predictable machine consumption and use a nonzero process exit code.

The command runner accepts injected Core lifecycle, client, doctor, ID, and I/O services. Tests can
therefore prove command behavior without starting Core or an agent process, while process-level
tests exercise the real daemon lifecycle separately.
