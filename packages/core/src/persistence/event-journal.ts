import type { Event } from "@densa-ade/protocol";

import {
  EventPublisher,
  type EventFilter,
  type EventReplayFilter,
  type EventSubscriber,
  type PersistedEvent,
} from "../event-publisher.js";
import type { EventRepository } from "./repositories.js";

/** Public Core boundary for durable facts, bounded replay, and live in-process subscriptions. */
export class EventJournal {
  constructor(
    private readonly repository: EventRepository,
    private readonly publisher: EventPublisher,
  ) {}

  append(event: Event): PersistedEvent {
    return this.repository.append(event);
  }

  findById(id: Event["id"]): PersistedEvent | undefined {
    return this.repository.findById(id);
  }

  latest(projectId: Event["projectId"]): PersistedEvent | undefined {
    return this.repository.latest(projectId);
  }

  replay(filter: EventReplayFilter = {}): readonly PersistedEvent[] {
    return this.repository.replay(filter);
  }

  /** Internal complete scan: replay pages are transport bounds, never a lifecycle-history bound. */
  *scan(
    filter: EventFilter & { readonly projectId: Event["projectId"] },
  ): Iterable<PersistedEvent> {
    let afterSequence = filter.afterSequence;
    for (;;) {
      const page = this.replay({
        ...filter,
        ...(afterSequence === undefined ? {} : { afterSequence }),
        limit: 1_000,
      });
      yield* page;
      if (page.length < 1_000) return;
      afterSequence = page.at(-1)!.sequenceNumber;
    }
  }

  subscribe(filter: EventFilter, subscriber: EventSubscriber): () => void {
    return this.publisher.subscribe(filter, subscriber);
  }
}
