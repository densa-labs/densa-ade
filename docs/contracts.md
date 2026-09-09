# P0M1 wire contracts

These are executable schema contracts, not a daemon, authority service or persistent journal. Import [the contracts entry point](../packages/contracts/src/index.ts). The package has no dependencies, editor imports or Node-specific imports. Its independent [TypeScript configuration](../packages/contracts/tsconfig.json) compiles without Core, adapters or clients.

## Identity and scope

IDs are opaque, immutable, kind-prefixed lowercase UUID-shaped strings. The prefix supplies both a runtime discriminator and a TypeScript brand; paths and names cannot substitute. Generation and persisted uniqueness belong to their producer services. The nil UUID is rejected. Revisions and sequence numbers are nonnegative safe integers; JSON numbers are safe integers, never floating-point approximations. Times use exact UTC `YYYY-MM-DDTHH:mm:ss.sssZ` strings.

References carry both project ID and entity ID. Project-scoped schemas reject nested references to another project; parsing a request can additionally bind it to an authenticated project supplied by the caller. Storage must still verify actual entity ownership with R0 composite keys in P1M0. Syntactically valid IDs do not prove that records exist or confer authority.

Every command must carry an expected aggregate revision: the project reference for project mutations or authenticated principal ID for user-level mutations. Additional relevant entity revisions are supported, with unique targets. P1M1 must transactionally advance the aggregate revision for each mutation affecting that scope, validate all expected targets, and check entity ownership. Client identity/principal claims require P3 authentication; they are not authenticated by this package. Quit's payload principal must match its envelope principal; its exact observed execution/revision set remains explicit. Cross-project Quit observations are intentional under R1a, and cannot expand the observed set.

## Canonical digest and replay

Canonical wire JSON uses recursively sorted object keys (ECMAScript UTF-16 ordering), unchanged array order, compact JSON string encoding, and safe integer number encoding. Unpaired surrogates, negative zero, sparse arrays, undefined, functions, cycles, getters, symbol keys, prototype-control keys and non-JSON object types are rejected. `decodeMessage` requires this canonical encoding; this rejects duplicate keys and ambiguous numeric spellings before later dispatch. Encode with `canonicalJson`. The choice of a canonical wire encoding is a P0M1 implementation choice, not a general-purpose JSON parser promise.

`commandDigest` uses Web Crypto SHA-256 over a version-1 canonical material object containing protocol/partition/schema/capability versions, action, authenticated client/principal identity, project scope (null for user scope), expected revision targets sorted by their canonical encoding, and payload. Only command ID, payload digest itself and delivery correlation ID are excluded. Revision-array ordering is set-like; payload-array ordering is significant. The digest is `sha256:` followed by 64 lowercase hexadecimal digits. New delivery correlation does not create a new mutation. A different command ID is always a distinct command even if its digest matches.

`verifyCommandDigest` recalculates the digest. `classifyCommand` compares a recorded same-ID digest before current revisions: matching digest replays the original outcome, including operation ID or committed projection warning; a differing digest raises COMMAND_ID_CONFLICT even when current revisions are stale. A new stale command raises STALE_REVISION. The pure classifier does not lookup, persist, dispatch, retry or repair anything. P1M1 owns the atomic lookup/check/write, lifetime tombstones and original-result replay. P1M3 owns separately journaled projection repair after committed partial success. Correlation alone is never a deduplication key.

## Envelopes and limits

Requests discriminate query versus command and each action has a strict top-level payload schema. Extra fields, missing required fields, wrong identity kinds, mismatched scope, unavailable partitions and incompatible versions reject before any handler. Internal renewal/repair catalog actions are rejected by the client parser; P9M0 invokes their services under Core authority. `requireImplemented` defaults to an empty trusted handler set and raises FEATURE_UNAVAILABLE. No catalog entry is currently advertised as implemented.

The command result union is rejected, in-progress, outcome-unknown, or committed. Committed results always include a warning array; projection warnings require a repair operation ID. Unknown effects require an operation ID and `recoveryRequired: true`. Journal phases are intended, dispatched-outcome-unknown, verified-completed and verified-not-applied; verified outcomes require a verification digest. These schemas do not perform transitions or prove external verification. P0M2 owns lifecycle tables, P1M1 durability, and later effect producers own their verification material.

Events carry an independent event version, identity, project, sequence, time, originating command, revision and versioned bounded fact payload. Snapshot watermarks and bounded contiguous event pages permit snapshot/replay composition. Pages reject gaps, duplicate event IDs, nonprogressing continuation, incorrect next cursors and cross-project facts. An archived cursor has a distinct resnapshot-required envelope. P1M3 must produce these facts after commit and prove continuity across restart.

Messages have a 1 MiB UTF-8 cap, 32 levels, 4096 visited values, 262144 UTF-16 units per string, and at most 100 page entries. Page requests require 1–100 when supplied. These protocol limits are separate from R6 retained artifact limits. Large documents/results require producer-owned bounded pagination or an explicit input-size failure; no silent truncation. Errors expose stable codes, a bounded message and current revisions. P1M0/P2M1 must supply privacy-safe diagnostic messages; these schemas do not redact arbitrary text.

`parseResponse` binds action, correlation, command identity, result kind and project scope to the request. Query results carry a watermark and bounded JSON value. Domain contents (planning decisions, authority grants, evidence/configuration snapshots, read models and event fact types) are validated by their explicit P0M2/P0M3/P0M4 or service producers before production use. This milestone supplies message boundaries, not those later domain schemas. Draft documents are unapproved text plus revision/digest; proposal/candidate/snapshot references must resolve exact records. Generic setting values are wire scalars only; P0M4/P1M4 own the setting-key/type/boundary allowlist. No text, scalar or reference authorizes execution by itself.

## Compatibility and partition table

| Axis / partition | P0M1 contract | Compatibility and completion owner |
| --- | --- | --- |
| Protocol / command / event / operation / digest | Independent explicit version 1 schemas | Unsupported versions fail closed; P3M1 transport and P11M4 production catalog proof |
| H headless/project Core | Schema 1, capability 1, zero installed operations | Exact actions below; P11M4 requires every H handler and production evidence, including internal renewal/repair |
| I client | Schema 1, capability 0, zero installed operations | Presentation/activation/navigation/launcher and later gallery/telemetry bindings; P12/P13/P14 actual client implementation |
| U updater | Schema/capability null, no operations or payload schemas | P15M0 defines the catalog; P15M4 route proof and P16M3 packaged update proof |
| L release tooling | Schema/capability null; maintainer-only, no shipping commands | P15M4 defines authority/operations; P16 implementation and verification |
| App / Core / storage schema / runtime / build | Separately named identity fields, no supported product combination claimed | P12/P15/P16 establish exact supported combinations under R8 |

The handshake parser refuses unsupported versions, duplicate/unknown operation IDs, externally advertised internal operations and reserved U/L actions. I presentation bindings are not Core operations. Later I services and U require additive versioned amendments with owners and route proof; an amendment changing H requires R7a/Gate D revalidation. Storage compatibility is not inferred from protocol compatibility.

Every public H row is a shared client binding consumed by CLI P3M2 and the IDE's secure Core client P12M2. Surface-specific rendering is owned by P13; no second Core mutation is introduced for it. Internal rows are reached through normal Core start/resume, not public clients. `clientBindings` separately enumerates I activation, navigation, editor/window presentation, onboarding presentation preference, surface rendering/focus, shell-launcher installation, gallery and optional telemetry transport.

## H action ownership

All rows use request schema version 1 and their individually defined strict payload schema. Queries use query-watermark-v1 responses; commands/internal operations use command-result-v1. Result domain payload validation is owned by the listed service milestone. A later payload producer denotes additional domain validation beyond this milestone's structural wire boundary, not a missing successful runtime stub.

| Action | Kind | Scope | Service/result owner | Additional payload producer |
| --- | --- | --- | --- | --- |
| core.start | command | user | P3M0 | P0M1 |
| core.status | query | user | P3M0 | P0M1 |
| core.stop | command | user | P3M0 | P0M1 |
| protocol.handshake | query | user | P3M1 | P0M1 |
| capability.query | query | user | P3M1 | P0M1 |
| command.outcome | query | user | P1M1 | P0M1 |
| snapshot.query | query | project | P1M3 | P0M1 |
| events.query | query | project | P1M3 | P0M1 |
| project.create | command | user | P1M2 | P0M1 |
| project.adopt | command | user | P5M0 | P0M1 |
| project.gitInit | command | project | P5M0 | P0M1 |
| project.status | query | project | P11M1 | P0M1 |
| project.start | command | project | P9M2 | P0M1 |
| project.pause | command | project | P9M4 | P0M1 |
| project.resume | command | project | P9M2 | P0M1 |
| task.cancel | command | project | P9M4 | P0M1 |
| project.stop | command | project | P9M4 | P0M1 |
| project.reopen | command | project | P9M8 | P0M4 |
| specification.query | query | project | P6M0 | P0M1 |
| specification.propose | command | project | P6M0 | P0M2 |
| interview.begin | command | project | P6M1 | P0M1 |
| interview.answer | command | project | P6M1 | P0M1 |
| interview.cancel | command | project | P6M1 | P0M1 |
| interview.abandon | command | project | P6M0 | P0M1 |
| interview.restart | command | project | P6M0 | P0M1 |
| interview.status | query | project | P6M1 | P0M1 |
| roadmap.query | query | project | P6M2 | P0M1 |
| roadmap.generate | command | project | P6M2 | P0M1 |
| roadmap.propose | command | project | P6M2 | P0M2 |
| mutation.preview | query | project | P6M3 | P0M1 |
| mutation.propose | command | project | P6M3 | P0M2 |
| approval.query | query | project | P1M1 | P0M1 |
| approval.approve | command | project | P9M7 | P0M3 |
| approval.deny | command | project | P9M7 | P0M3 |
| settings.query | query | project | P1M4 | P0M1 |
| settings.update | command | project | P1M4 | P0M4 |
| settings.clearOverride | command | project | P1M4 | P0M4 |
| settings.defaults.query | query | user | P1M4 | P0M1 |
| settings.defaults.update | command | user | P1M4 | P0M4 |
| settings.effective | query | project | P1M4 | P0M4 |
| settings.correction.preview | query | project | P1M4 | P0M4 |
| settings.correctHeldRole | command | project | P9M6 | P0M4 |
| decisions.query | query | project | P1M5 | P0M1 |
| decision.record | command | project | P1M5 | P0M2 |
| decision.supersede | command | project | P1M5 | P0M2 |
| trust.query | query | project | P2M0 | P0M1 |
| trust.grant | command | project | P2M0 | P0M3 |
| trust.revoke | command | project | P2M0 | P0M3 |
| secretReference.authorize | command | project | P2M1 | P0M3 |
| secretReference.revoke | command | project | P2M1 | P0M3 |
| worker.status | query | project | P11M1 | P0M1 |
| worker.retry | command | project | P9M3 | P0M1 |
| validation.status | query | project | P11M1 | P0M1 |
| validation.cancel | command | project | P9M4 | P0M1 |
| validation.retry | command | project | P7M4 | P0M4 |
| renewal.status | query | project | P7M6 | P0M1 |
| renewal.drain | internal | project | P9M0 | P0M1 |
| renewal.execute | internal | project | P7M6 | P0M4 |
| repair.status | query | project | P6M4 | P0M1 |
| repair.propose | command | project | P6M4 | P0M4 |
| repair.admit | internal | project | P9M0 | P0M4 |
| results.query | query | project | P8M1 | P0M1 |
| results.diff | query | project | P8M1 | P0M1 |
| results.export | command | project | P8M1 | P0M1 |
| usage.query | query | project | P10M0 | P0M1 |
| power.query | query | user | P10M2 | P0M1 |
| master.request | command | project | P11M0 | P0M1 |
| master.status | query | project | P11M0 | P0M1 |
| master.cancel | command | project | P11M0 | P0M1 |
| deferred.query | query | project | P11M0 | P0M1 |
| deferred.set | command | project | P11M0 | P0M1 |
| deferred.cancel | command | project | P11M0 | P0M1 |
| diagnostics.query | query | project | P10M3 | P0M1 |
| diagnostics.retention | query | project | P1M6 | P0M1 |
| diagnostics.export | command | project | P10M3 | P0M1 |
| diagnostics.deleteOptional | command | project | P10M3 | P0M1 |
| history.purge | command | project | P1M6 | P0M1 |
| maintenance.run | command | project | P10M3 | P0M1 |
| identity.inspect | query | user | P1M2 | P0M1 |
| identity.relink | command | project | P1M2 | P0M1 |
| identity.copyAsNew | command | user | P1M2 | P0M1 |
| portable.conflicts | query | project | P1M3 | P0M1 |
| portable.importProposal | command | project | P6M3 | P0M1 |
| portable.exportNew | command | project | P1M3 | P0M1 |
| portable.replaceInspected | command | project | P1M3 | P0M1 |
| portable.repair | command | project | P1M3 | P0M1 |
| lifecycle.sponsored | query | user | P10M4 | P0M1 |
| lifecycle.transfer | command | project | P10M4 | P0M1 |
| lifecycle.background | command | project | P10M4 | P0M1 |
| client.quit | command | user | P10M4 | P0M1 |
| execution.query | query | project | P11M1 | P0M1 |
| phase.query | query | project | P11M1 | P0M1 |
| task.query | query | project | P11M1 | P0M1 |
| attempt.query | query | project | P11M1 | P0M1 |
| holds.query | query | project | P11M1 | P0M1 |
| report.query | query | project | P11M1 | P0M1 |
| recovery.status | query | project | P10M1 | P0M1 |
| recovery.reconcile | command | project | P10M1 | P0M1 |
