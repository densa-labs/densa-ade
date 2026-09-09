# Development evidence and freshness

This directory records development evidence under roadmap R7/R7a. It is not Core's authoritative runtime evidence store or a P0M4 runtime certificate schema. The [ledger](ledger.json) preserves all R contracts/subcontracts, the full requirement ownership table, direct milestone prerequisites, and R9 staged replacements. All runtime contract rows remain PENDING until their owners prove them; the P0M0 acceptance report can certify only foundation checks.

Before reusing a prior PASS, append an impact assessment identifying changed behavior, requirement/contract IDs, and both producer-to-consumer and behavior-to-route dependency edges with reasons. Traverse transitively; unknown impact requires broader gates. Add STALE status observations for affected evidence without modifying historical observations. Unchanged APIs or passing old tests alone are not no-impact proof. Record justified unaffected claims and all pending gates that do not exist yet.

After implementing and checking the final diff, append a final assessment. Replacement evidence must bind the current candidate and superseded IDs; keep failed attempts and their diagnostics. Record phase, integration, security, failure/recovery and larger-gate reruns as applicable. R3 runtime invalidation and R8 rebuild/resign rules remain independent. Do not promote foundation unit checks into production, live provider, restart, actual IDE, or signed-artifact proof. Phase completion and risky claims require a fresh-context independent review under AGENTS/MODEL_POLICY; implementation self-review is not that audit.

Every evidence record must include:

- Stable evidence ID, milestone, criterion IDs, class, observation time, result and limitations.
- Roadmap and other authority hashes; implementation commit/tree or uncommitted candidate manifest digest; prerequisite evidence IDs.
- Exact commands, exit/status, bounded output artifact paths and SHA-256 digests; tool/config/model versions.
- Superseded evidence IDs, affected requirements/routes, and replacement evidence links where applicable.

Classes are U (unit), I (real local integration), P (normal production route), F (injected failure), S (adversarial security), R (actual restart), E (actual end-to-end), and K (exact packaged artifact). Simulations, fakes, and injected branches must say so. There is no product route in P0M0.

Candidate manifests use sorted repository-relative paths, file content SHA-256 and executable mode; the manifest bytes have their own SHA-256. Include authoritative ignored documents as separately identified specification inputs. Exclude dependencies, generated builds, `.git`, pre-existing `audit/`, and the evidence record/manifest being generated to avoid recursive hashes. List exact exclusions in the evidence record. Evidence output files have separate digests. This documents an uncommitted development candidate, not an immutable runtime candidate or independent certification.

The document-link check covers README, license, authoritative local Markdown, and Markdown under docs. It validates local inline/image/reference-definition targets and Markdown heading fragments. Remote URLs are not fetched; general HTML and arbitrary Markdown syntax are outside this bounded checker. Existing website/assets and unrelated audit prompt prose are outside this milestone's documentation surface. Missing authority files are a setup failure, not a reason to invent specification content.
