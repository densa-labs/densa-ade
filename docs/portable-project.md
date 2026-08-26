# Portable `.densa/` project representation

Phase 2 Milestone 3 adds an explicit export boundary from authoritative SQLite state to a
deterministic, human-readable project representation. `PortableProjectSynchronizer` is available
from `@densa/core/persistence`; it reads a project through repository contracts and writes only
inside the workspace's `.densa/` directory.

## Generated shape

```text
.densa/
├── project.json
├── SPEC.md
├── ROADMAP.md
├── DECISIONS.md
├── config.json
├── reports/
├── logs/
└── .sync-state.json
```

`project.json` contains portable project identity, lifecycle state, execution mode, and timestamps.
`SPEC.md` mirrors the current specification. `ROADMAP.md` renders ordered phases, tasks,
dependencies, acceptance criteria, and roadmap-revision history. `DECISIONS.md` renders the
project's durable decisions. `config.json` contains non-secret portable project settings. The
reports and logs directories are created for later bounded artifacts; P2M3 does not invent report
or log records that do not yet exist.

Formatting is deterministic: JSON uses two-space indentation and a final newline, Markdown uses LF
line endings and a final newline, database lists have explicit stable ordering, and no export time
is added. Re-exporting unchanged SQLite state therefore produces byte-identical files.

## Authority boundary

SQLite remains authoritative for all detailed runtime data and lifecycle state, including project,
phase, and task states; attempts; agent and validation runs; checkpoints; events and their ordered
sequences; settings; and all persisted timestamps. `.densa/` is a portable view of important intent
and decisions. Editing a generated file never directly mutates SQLite or bypasses the centralized
state-transition service.

The hidden `.sync-state.json` manifest records SHA-256 hashes of the last generated managed files.
On the next synchronization:

- content equal to the newly rendered snapshot is left unchanged;
- content equal to its last generated hash may be safely replaced;
- different content is classified as a meaningful human edit.

If any meaningful edit exists, synchronization returns a `conflict` result and writes none of the
managed files or manifest. The caller can present the affected paths and route the proposed change
through a later specification, roadmap, or decision workflow. A missing `.densa/` directory is not
a conflict; it is recreated from SQLite.

## File and secret safety

Every managed file and the manifest is replaced by writing a mode-0600 temporary sibling, flushing
it, and atomically renaming it over the destination. A failure before rename preserves the complete
old file. The manifest is written last; after a process interruption, a subsequent sync recognizes
already-written desired content and safely completes the remaining files. Symlinked `.densa/`
directories or managed files fail closed with `WORKSPACE_CONFLICT`.

Portable exports do not include attempts, raw prompts, agent transcripts, event payloads, or process
logs. Free-form text and nested settings are redacted for secret-bearing keys, private-key blocks,
bearer credentials, common provider-token formats, JWTs, and explicit secret assignments before any
file write. This is a defense-in-depth boundary, not permission to store credentials in project
intent: secrets still belong in Keychain or user-managed secret stores and must be represented only
by non-secret references in SQLite.
