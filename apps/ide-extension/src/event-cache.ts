// Copyright 2026 Densa Labs
// SPDX-License-Identifier: Apache-2.0

/**
 * IDE-side event replay cache with duplicate suppression and gap detection.
 *
 * Core is authoritative; this cache only remembers which durable per-project
 * sequence numbers the IDE has already applied so reconnects never apply a
 * fact twice and never silently skip a fact. A gap always requires a fresh
 * `events.replay` from the last contiguous sequence (see
 * `docs/core-v1-protocol.md` reconnect semantics).
 */

import type { CoreV1PersistedEvent } from "@densa-ade/protocol";

export type IdeEventApplication = "applied" | "duplicate";

export interface IdeReplayOutcome {
  readonly applied: readonly CoreV1PersistedEvent[];
  readonly duplicates: number;
  /** True when the page skipped ahead of the last contiguous sequence. */
  readonly hasGap: boolean;
}

function eventKey(event: CoreV1PersistedEvent): string {
  return `${event.projectId}:${String(event.sequenceNumber)}:${event.id}`;
}

/** Tracks one project's contiguous durable sequence for reconnect replay. */
export class IdeProjectEventCache {
  readonly #projectId: string;
  #lastAppliedSequence = 0;
  readonly #appliedKeys = new Set<string>();

  constructor(projectId: string) {
    if (projectId.trim().length === 0) {
      throw new Error("IdeProjectEventCache requires a non-empty projectId.");
    }
    this.#projectId = projectId;
  }

  get projectId(): string {
    return this.#projectId;
  }

  get lastAppliedSequence(): number {
    return this.#lastAppliedSequence;
  }

  get appliedCount(): number {
    return this.#appliedKeys.size;
  }

  /** Reset only for explicit project switching in tests/window reload. */
  reset(): void {
    this.#lastAppliedSequence = 0;
    this.#appliedKeys.clear();
  }

  /** Seed the cache after a full snapshot refresh without inventing facts. */
  seed(lastAppliedSequence: number): void {
    if (!Number.isInteger(lastAppliedSequence) || lastAppliedSequence < 0) {
      throw new Error("IdeProjectEventCache seed must be a non-negative integer.");
    }
    if (lastAppliedSequence < this.#lastAppliedSequence) {
      throw new Error("IdeProjectEventCache cannot rewind to an older sequence.");
    }
    this.#lastAppliedSequence = lastAppliedSequence;
  }

  /**
   * Apply an ordered replay page. Duplicates (already applied sequence or ID)
   * are counted and skipped. A page that jumps ahead sets `hasGap` so the
   * caller replays again from the last contiguous sequence.
   */
  applyReplayPage(events: readonly CoreV1PersistedEvent[]): IdeReplayOutcome {
    const applied: CoreV1PersistedEvent[] = [];
    let duplicates = 0;
    let hasGap = false;
    for (const event of events) {
      if (event.projectId !== this.#projectId) {
        throw new Error("IdeProjectEventCache received an event for another project");
      }
      const key = eventKey(event);
      if (this.#appliedKeys.has(key) || event.sequenceNumber <= this.#lastAppliedSequence) {
        // Sequence-based dedup covers re-delivered replay pages after
        // reconnect; ID-based dedup covers a resent frame with the same fact.
        duplicates += 1;
        continue;
      }
      if (event.sequenceNumber !== this.#lastAppliedSequence + 1) {
        hasGap = true;
        continue;
      }
      this.#appliedKeys.add(key);
      this.#lastAppliedSequence = event.sequenceNumber;
      applied.push(event);
    }
    return { applied, duplicates, hasGap };
  }

  /** Apply one live `core.event` notification with the same dedup rules. */
  applyNotification(event: CoreV1PersistedEvent): IdeEventApplication | "gap" {
    if (event.projectId !== this.#projectId) {
      throw new Error("IdeProjectEventCache received an event for another project");
    }
    const key = eventKey(event);
    if (this.#appliedKeys.has(key) || event.sequenceNumber <= this.#lastAppliedSequence) {
      return "duplicate";
    }
    if (event.sequenceNumber !== this.#lastAppliedSequence + 1) {
      return "gap";
    }
    this.#appliedKeys.add(key);
    this.#lastAppliedSequence = event.sequenceNumber;
    return "applied";
  }
}

/** Small multi-project registry used by the IDE connection. */
export class IdeEventCache {
  readonly #projects = new Map<string, IdeProjectEventCache>();

  cacheFor(projectId: string): IdeProjectEventCache {
    let cache = this.#projects.get(projectId);
    if (cache === undefined) {
      cache = new IdeProjectEventCache(projectId);
      this.#projects.set(projectId, cache);
    }
    return cache;
  }

  lastAppliedSequence(projectId: string): number {
    return this.#projects.get(projectId)?.lastAppliedSequence ?? 0;
  }

  clear(): void {
    this.#projects.clear();
  }
}
