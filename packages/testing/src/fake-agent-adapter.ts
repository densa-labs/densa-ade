import type {
  AgentAdapter,
  AgentDetection,
  AgentError,
  AgentEvent,
  AgentRunOutcome,
  AgentRunRequest,
  AgentStatus,
} from "@densa-ade/agent-sdk";
import type { UsageState } from "@densa-ade/protocol";

type NonTerminalAgentEvent = Exclude<
  AgentEvent,
  { type: "run.started" } | { type: "run.terminal" }
>;
export type FakeAgentScriptEvent = NonTerminalAgentEvent extends infer Event
  ? Event extends AgentEvent
    ? Omit<Event, "runId" | "occurredAt">
    : never
  : never;

export interface FakeAgentRunScript {
  events?: FakeAgentScriptEvent[];
  outcome?: AgentRunOutcome;
  error?: AgentError;
  finalMessage?: string;
  exitCode?: number;
  holdOpen?: boolean;
  onExecute?: (request: AgentRunRequest) => void | Promise<void>;
}

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
  /** Per-run overrides; the final entry is reused if execution exceeds the script length. */
  scripts?: readonly FakeAgentRunScript[];
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
    const script =
      this.options.scripts?.[
        Math.min(this.requests.length - 1, Math.max(0, (this.options.scripts?.length ?? 1) - 1))
      ];
    let release = (): void => undefined;
    const cancellation = new Promise<void>((resolve) => {
      release = resolve;
    });
    const control: FakeRunControl = { cancelled: false, release, cancellation };
    this.activeRuns.set(request.runId, control);

    try {
      yield { type: "run.started", runId: request.runId, occurredAt: this.now() };
      await (script?.onExecute ?? this.options.onExecute)?.(request);
      for (const event of script?.events ?? this.options.events ?? []) {
        if (control.cancelled) {
          yield this.cancelledEvent(request.runId);
          return;
        }
        yield { ...event, runId: request.runId, occurredAt: this.now() } as AgentEvent;
        await Promise.resolve();
      }

      if ((script?.holdOpen ?? this.options.holdOpen) === true && !control.cancelled)
        await control.cancellation;
      if (control.cancelled) {
        yield this.cancelledEvent(request.runId);
        return;
      }

      const outcome = script?.outcome ?? this.options.outcome ?? "succeeded";
      yield {
        type: "run.terminal",
        runId: request.runId,
        occurredAt: this.now(),
        outcome,
        ...((script?.exitCode ?? this.options.exitCode) === undefined
          ? {}
          : { exitCode: script?.exitCode ?? this.options.exitCode }),
        ...((script?.finalMessage ?? this.options.finalMessage) === undefined
          ? {}
          : { finalMessage: script?.finalMessage ?? this.options.finalMessage }),
        ...((script?.error ?? this.options.error) === undefined
          ? {}
          : { error: script?.error ?? this.options.error }),
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
