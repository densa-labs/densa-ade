import type {
  AgentAdapter,
  AgentDetection,
  AgentError,
  AgentEvent,
  AgentRunOutcome,
  AgentRunRequest,
  AgentStatus,
} from "@densa/agent-sdk";
import type { UsageState } from "@densa/protocol";

type NonTerminalAgentEvent = Exclude<
  AgentEvent,
  { type: "run.started" } | { type: "run.terminal" }
>;
export type FakeAgentScriptEvent = NonTerminalAgentEvent extends infer Event
  ? Event extends AgentEvent
    ? Omit<Event, "runId" | "occurredAt">
    : never
  : never;

export interface FakeAgentAdapterOptions {
  detection?: AgentDetection;
  status?: AgentStatus;
  usageState?: UsageState;
  events?: FakeAgentScriptEvent[];
  outcome?: AgentRunOutcome;
  error?: AgentError;
  finalMessage?: string;
  exitCode?: number;
  holdOpen?: boolean;
  onExecute?: (request: AgentRunRequest) => void | Promise<void>;
  now?: () => string;
}

interface FakeRunControl {
  cancelled: boolean;
  release: () => void;
  cancellation: Promise<void>;
}

/** Deterministic AgentAdapter implementation for scheduler and adapter contract tests. */
export class FakeAgentAdapter implements AgentAdapter {
  readonly adapterId = "fake";
  readonly requests: AgentRunRequest[] = [];
  readonly cancelledRunIds: string[] = [];

  private readonly options: FakeAgentAdapterOptions;
  private readonly now: () => string;
  private readonly activeRuns = new Map<string, FakeRunControl>();

  constructor(options: FakeAgentAdapterOptions = {}) {
    this.options = options;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async detect(): Promise<AgentDetection> {
    return (
      this.options.detection ?? {
        status: "available",
        adapterId: this.adapterId,
        command: "fake-agent",
        version: "1.0.0",
      }
    );
  }

  async getStatus(): Promise<AgentStatus> {
    return this.options.status ?? { status: "available", version: "1.0.0" };
  }

  async *execute(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    this.requests.push(request);
    let release = (): void => undefined;
    const cancellation = new Promise<void>((resolve) => {
      release = resolve;
    });
    const control: FakeRunControl = { cancelled: false, release, cancellation };
    this.activeRuns.set(request.runId, control);

    try {
      yield { type: "run.started", runId: request.runId, occurredAt: this.now() };
      await this.options.onExecute?.(request);
      for (const event of this.options.events ?? []) {
        if (control.cancelled) {
          yield this.cancelledEvent(request.runId);
          return;
        }
        yield { ...event, runId: request.runId, occurredAt: this.now() } as AgentEvent;
        await Promise.resolve();
      }

      if (this.options.holdOpen === true && !control.cancelled) await control.cancellation;
      if (control.cancelled) {
        yield this.cancelledEvent(request.runId);
        return;
      }

      const outcome = this.options.outcome ?? "succeeded";
      yield {
        type: "run.terminal",
        runId: request.runId,
        occurredAt: this.now(),
        outcome,
        ...(this.options.exitCode === undefined ? {} : { exitCode: this.options.exitCode }),
        ...(this.options.finalMessage === undefined
          ? {}
          : { finalMessage: this.options.finalMessage }),
        ...(this.options.error === undefined ? {} : { error: this.options.error }),
      };
    } finally {
      this.activeRuns.delete(request.runId);
    }
  }

  async cancel(runId: string): Promise<void> {
    const control = this.activeRuns.get(runId);
    if (control === undefined || control.cancelled) return;
    control.cancelled = true;
    this.cancelledRunIds.push(runId);
    control.release();
  }

  async getUsageState(): Promise<UsageState> {
    return this.options.usageState ?? { status: "available" };
  }

  private cancelledEvent(runId: string): AgentEvent {
    return {
      type: "run.terminal",
      runId,
      occurredAt: this.now(),
      outcome: "cancelled",
    };
  }
}
