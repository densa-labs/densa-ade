# `@densa/cli`

The `densa` executable is a headless client shell for proving Densa Core before IDE integration.
It does not own project state. Project and event commands construct requests from
`@densa/protocol` and currently stop at an explicit unavailable-Core placeholder.

```text
densa doctor
densa project init
densa project status
densa project start
densa project pause
densa project resume
densa events
densa version
```

Human-readable output is the default. Pass `--json` anywhere in the command to emit one JSON
object with `schemaVersion`, `command`, `ok`, and either `data` or `error`. JSON failures are
written to stdout for predictable machine consumption and use a nonzero process exit code.

The command runner accepts injected Core, doctor, ID, and I/O services. Tests can therefore prove
command behavior without starting Core or an agent process.
