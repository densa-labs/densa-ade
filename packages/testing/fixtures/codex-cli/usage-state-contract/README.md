# Codex usage-state contract fixtures

These are synthetic, sanitized adapter-contract fixtures, not transcripts from an exhausted user
account. They exercise only machine-readable fields present in the version-scoped Codex event
model. Densa ADE must never classify the human-readable `message` text.

`codex_error_info: "usage_limit_exceeded"` is the sole usage-limited discriminator. `reset_at` is
an optional Unix timestamp supplied by the structured event; when it is absent or invalid, Densa ADE
must omit `resetAt`. Other structured failures, including `unauthorized`, remain non-usage errors.
