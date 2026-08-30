# P9M1 Continuous and recovery proof

Phase 9 Milestone 1 is verified by `npm run proof:p9m1`. The harness uses file-backed SQLite databases, temporary Git repositories, `FakeAgentAdapter`, and `FakeClock`; it never invokes a paid or network agent.

The deterministic scenarios cover:

- two Continuous-mode phases, including a retryable worker failure and an independently rejected validation followed by corrected retries;
- a four-attempt validation failure that restores the exact Git checkpoint and ends `BLOCKED`;
- a structured usage limit, durable `WAITING_FOR_USAGE`, Core restart, restored bounded schedule, and availability-confirmed auto-resume to `RUNNING`/`RETRYING`;
- a Core restart with a persisted active worker whose process is gone, classified read-only as `TASK_PROCESS_GONE`;
- a user pause followed by a manual workspace edit, explicit intervention, acknowledged recontextualization, and byte-for-byte preservation of the user file;
- a scope roadmap mutation that remains unapplied without explicit approval and blocks Continuous execution through the mandatory-decision gate.

Each scenario reopens its SQLite database where restart durability is under test, checks append-only replay ordering, and asserts the authoritative final state. Timing tests advance a manual clock and inspect one bounded scheduled probe; the harness uses no interval or sleep loop. The complete Continuous/retry scenario runs three times with isolated repositories to expose ordering or shared-state instability.

The stress run found and fixed one self-conflict: an intermediate Continuous phase report was written before the next task checkpoint, so preflight correctly treated the dirty workspace as unsafe. Continuous mode now keeps the report durable in SQLite, records that portable synchronization is deferred, and projects every report at the final no-more-tasks boundary. Phase-by-phase and final-phase report synchronization remain immediate.
