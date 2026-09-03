# Applications

Densa ADE clients live here. Phase 10 Milestone 0 adds `apps/ide-extension`, the
built-in protocol-only IDE client for the thin Code-OSS downstream
(see `../code-oss/` and `../docs/code-oss-downstream.md`).

The extension imports `@densa-ade/protocol` only — never `@densa-ade/core`,
SQLite, or workbench internals. Densa ADE Core remains authoritative and
editor-independent.
