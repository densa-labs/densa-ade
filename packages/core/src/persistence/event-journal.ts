import type { Event } from "@densa/protocol";

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

  subscribe(filter: EventFilter, subscriber: EventSubscriber): () => void {
    return this.publisher.subscribe(filter, subscriber);
  }
}
