import type { UsageAutoResumeClock } from "@densa-ade/core";

interface PendingTimer {
  readonly callback: () => void;
  readonly dueAt: number;
}

/** Deterministic manual clock for services that schedule bounded background work. */
export class FakeClock implements UsageAutoResumeClock {
  #currentTime: number;
  #nextId = 1;
  readonly #timers = new Map<number, PendingTimer>();

  constructor(startingTime: number | string) {
    this.#currentTime = typeof startingTime === "number" ? startingTime : Date.parse(startingTime);
    if (!Number.isFinite(this.#currentTime)) throw new Error("FakeClock requires a valid time");
  }

  now(): number {
    return this.#currentTime;
  }

  set(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < this.#currentTime) {
      throw new Error("FakeClock cannot move backwards or to an invalid time");
    }
    this.#currentTime = milliseconds;
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.#nextId++;
    this.#timers.set(id, { callback, dueAt: this.#currentTime + Math.max(0, delayMs) });
    return id;
  }

  clearTimeout(id: unknown): void {
    if (typeof id === "number") this.#timers.delete(id);
  }

  get pendingCount(): number {
    return this.#timers.size;
  }

  /** Runs all currently due callbacks without sleeping or recursively polling. */
  runDue(): number {
    const due = [...this.#timers.entries()]
      .filter(([, timer]) => timer.dueAt <= this.#currentTime)
      .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0]);
    for (const [id, timer] of due) {
      this.#timers.delete(id);
      timer.callback();
    }
    return due.length;
  }
}
