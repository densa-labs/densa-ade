import type { Event, Phase, Project, Task } from "@densa-ade/protocol";

export const DEFAULT_EVENT_REPLAY_LIMIT = 500;
export const MAX_EVENT_REPLAY_LIMIT = 1_000;
export const MAX_EVENT_PAYLOAD_BYTES = 64 * 1_024;

export interface PersistedEvent extends Event {
  readonly sequenceNumber: number;
}

export interface EventFilter {
  readonly projectId?: Project["id"];
  readonly phaseId?: Phase["id"];
  readonly taskId?: Task["id"];
  readonly types?: readonly Event["type"][];
  /** Exclusive per-project cursor. Requires projectId because sequences restart per project. */
  readonly afterSequence?: number;
}

export interface EventReplayFilter extends EventFilter {
  readonly limit?: number;
}

export type EventSubscriber = (event: Readonly<PersistedEvent>) => void;

export interface EventPublisherOptions {
  readonly onSubscriberError?: (error: unknown, event: Readonly<PersistedEvent>) => void;
}

interface Subscription {
  readonly filter: Readonly<EventFilter>;
  readonly subscriber: EventSubscriber;
}

export function matchesEventFilter(event: PersistedEvent, filter: EventFilter): boolean {
  return (
    (filter.projectId === undefined || event.projectId === filter.projectId) &&
    (filter.phaseId === undefined || event.phaseId === filter.phaseId) &&
    (filter.taskId === undefined || event.taskId === filter.taskId) &&
    (filter.types === undefined || filter.types.includes(event.type)) &&
    (filter.afterSequence === undefined || event.sequenceNumber > filter.afterSequence)
  );
}

/** Synchronous Core-local fan-out. Persistence invokes publish only from an after-commit hook. */
export class EventPublisher {
  readonly #subscriptions = new Set<Subscription>();
  readonly #onSubscriberError: NonNullable<EventPublisherOptions["onSubscriberError"]>;

  constructor(options: EventPublisherOptions = {}) {
    this.#onSubscriberError = options.onSubscriberError ?? (() => undefined);
  }

  subscribe(filter: EventFilter, subscriber: EventSubscriber): () => void {
    const subscription = Object.freeze({
      filter: Object.freeze({
        ...filter,
        ...(filter.types === undefined ? {} : { types: Object.freeze([...filter.types]) }),
      }),
      subscriber,
    });
    this.#subscriptions.add(subscription);
    return () => {
      this.#subscriptions.delete(subscription);
    };
  }

  publish(event: Readonly<PersistedEvent>): void {
    for (const subscription of [...this.#subscriptions]) {
      if (!matchesEventFilter(event, subscription.filter)) {
        continue;
      }
      try {
        subscription.subscriber(event);
      } catch (error) {
        try {
          this.#onSubscriberError(error, event);
        } catch {
          // Diagnostics must not turn a committed fact into an apparent write failure.
        }
      }
    }
  }
}
