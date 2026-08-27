# Structured project specification

Phase 4 Milestone 0 defines the editor- and model-neutral `ProjectSpecification` contract used to
record project intent before roadmap generation. The authoritative value is schema-validated
structured data in Densa Core's SQLite repository. `SPEC.md` is a deterministic portable rendering
of that value, not an independent source of lifecycle truth.

## Version 1 contract

`ProjectSpecification` has `formatVersion: 1` and records the project goal, target users, core user
journeys, required features, non-goals, architecture constraints, platform/runtime constraints,
integrations, data/storage needs, security/privacy requirements, UX constraints, deployment
intent, explicit user decisions, and unresolved questions. Unknown fields and unsupported versions
are rejected at the protocol boundary.

Every unresolved question has a stable ID, category, and `high`, `medium`, or `low` impact. This
milestone only represents and renders those questions. Deciding which questions to generate, rank,
or ask belongs to P4M1.

Specification text must contain non-whitespace content, but validation never trims or rewrites it.
Exact user wording belongs in the corresponding specification value. Interpretations must be
recorded separately as a decision or unresolved question; callers must not silently replace a
constraint with a weaker paraphrase.

## `SPEC.md` round-trip

`renderProjectSpecificationMarkdown()` creates readable sections for every contract field,
followed by a marked canonical JSON block. `parseProjectSpecificationMarkdown()` accepts that
canonical block only after validating its version and strict schema. This design makes the file
inspectable by a person while preserving whitespace, multiline values, Markdown characters, and
all structured question metadata during a lossless round-trip.

The portable synchronizer still treats manual edits as conflicts. A caller must route an intended
edit through a future audited specification workflow before regenerating `SPEC.md`; parsing a file
does not directly mutate SQLite.

## Contradiction surfacing

`detectSpecificationContradictions()` reports stable codes and paths for structural conflicts that
can be proven without guessing user intent:

- `REQUIRED_FEATURE_IS_NON_GOAL` when normalized identical scope appears as both required and
  excluded;
- `CONFLICTING_USER_DECISIONS` when the same normalized decision topic has different values.

The renderer includes detected contradictions in `SPEC.md`. The detector deliberately does not use
model inference or brittle keyword polarity rules. More semantic ambiguity remains representable
as a high-impact unresolved question rather than being silently resolved.

## Persistence compatibility

Migration 7 replaces the legacy free-form specification column with schema-versioned JSON. Existing
non-empty text is preserved exactly as the migrated project goal, with other version 1 fields
initialized to empty arrays. A legacy empty/whitespace-only record receives an explicit
no-goal-recorded placeholder so the version 1 invariant remains valid. This is a forward-only
migration consistent with the existing database policy; older Core builds cannot open the newer
schema, and the migration does not attempt a downgrade.
