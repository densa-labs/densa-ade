# Acceptance evidence

Densa ADE treats a validator run and an acceptance decision as separate facts. A validator can pass
while task completion remains blocked because one or more required criteria have no usable
evidence.

Each validation-plan entry declares an evidence source and the exact task-owned criterion text it
evaluates. Core persists that mapping with the validator result. Criterion state is then derived
deterministically:

- `satisfied` — every required linked result passed, or an explicitly manual criterion has an
  audited approval;
- `failed` — a required linked result failed/errored, or a manual reviewer rejected the criterion;
- `not_evaluated` — no required result exists, or a required result was skipped;
- `manual_review_required` — the plan explicitly marked an unsupported criterion as manual and no
  review decision exists.

Advisory results remain visible evidence but cannot satisfy a required criterion. Worker prose is
not an evidence source and cannot enter the acceptance report.

Pre-migration validator results are labeled `legacy_unspecified`; they remain inspectable but are
inconclusive because Core cannot safely reconstruct their evidence source.

Manual decisions are durable SQLite records paired atomically with a
`MANUAL_ACCEPTANCE_REVIEW_RECORDED` event containing the actor, reason, criterion, decision, and
validation run. A manual criterion cannot also consume automatic validator evidence.

Task completion requires both a passing plan run and a report in which every criterion is
`satisfied`. Phase callers use the explicit phase gate with the exact validation run selected for
each task; a missing run or unresolved task report blocks completion. Legacy validation runs created
before the plan framework remain readable, but do not fabricate criterion-level evidence.
