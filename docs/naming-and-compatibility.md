# Naming and compatibility

The canonical product name is **Densa ADE**. The organization that develops it is **Densa Labs**.
Human-facing copy, generated prose, package descriptions, and new source identifiers must use those
names.

Canonical source identifiers use the `DensaAde`, `densaAde`, or `DENSA_ADE` form. Older exported
TypeScript names remain only as deprecated aliases where removing them would break package
consumers. Schema-versioned preflight results likewise retain their legacy field aliases alongside
the canonical fields.

The following machine-facing namespaces are canonical for all new work:

- npm scope: `@densa-ade/*`;
- CLI executable: `densa-ade`;
- portable project directory: `.densa-ade/`;
- managed Git branch namespace: `densa-ade/run/`;
- task and milestone commit prefix: `densa-ade:`;

The old package scope and CLI executable are no longer published aliases. The portable synchronizer
writes only `.densa-ade/`, new run branches use only `densa-ade/run/`, and every newly generated task
commit uses `densa-ade:`. Existing SQLite databases retain read compatibility for already-recorded
`.densa/reports/` paths and `densa/run/` branches; their Git refs and historical evidence are not
silently rewritten.

The remaining stable compatibility surfaces are:

- persisted SQLite identifiers such as `_densa_migrations` and `densa_run_branches`;
- portable canonical-block markers beginning with `densa:`;
- actor, service, temporary-path, and secret-store namespaces that begin with `densa`;
- established `DENSA_*` environment variables, wire event names, decision codes, and test sentinels.

These values are distinct identifiers rather than product display names. Recorded paths in historical
proof reports also remain unchanged because they are evidence of the paths used during those runs.
