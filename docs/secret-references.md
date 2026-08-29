# Secret references and scoped credential use

Phase 7 Milestone 3 keeps credential values outside Densa's authoritative SQLite state and portable
`.densa/` projection. Persistable configuration uses `SecretRef`, an opaque project-scoped locator
whose schema deliberately has no value field. The v1 `MacOsKeychainSecretStore` maps that locator to
a generic-password item in the user's default macOS Keychain.

Keychain writes invoke `/usr/bin/security` without a shell and send the value through stdin. The
value is never placed in process arguments. The store interface requires the unforgeable
`secret_access` authorization context introduced by the permission policy milestone, so callers
cannot bypass Core by invoking a raw credential helper without a matching project authorization.

`SecretService` is the Core-owned lifecycle boundary:

- `put()` stores a value only after an allow decision or a recorded one-operation approval;
- `runChild()` resolves references after authorization, constructs an explicit minimal environment,
  injects values into only that child, captures bounded output, and removes the local bindings when
  the child exits;
- `revoke()` deletes the Keychain item and records a value-free audit fact;
- denied and approval-required decisions return a structured `PERMISSION_DENIED` result without
  touching the store.

Secret audit events contain reference IDs, environment variable names, outcomes, and a redacted
reason only. They never contain values. `SECRET_USE_STARTED` is persisted before child execution so
recovery can distinguish an operation that may have started from one that did not; a matching
`SECRET_USE_FINISHED` records the bounded outcome.

The shared redactor covers prompts, log text, JSON event payloads, explicit secret markers, common
credential shapes, sensitive object keys, and the exact transient values resolved for a scoped
operation. Redaction is defense in depth: raw values still must not be inserted into task packets,
project settings, events, reports, or `.densa/` in the first place.
