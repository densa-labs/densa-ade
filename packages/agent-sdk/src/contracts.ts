import type { DensaAdeErrorCode, JsonObject, UsageState } from "@densa-ade/protocol";

export type AgentDetection =
  | {
      status: "available";
      adapterId: string;
      command: string;
      version: string;
    }
  | {
      status: "unavailable";
      adapterId: string;
      reason: string;
    };

export type AgentStatus =
  | { status: "available"; version: string }
  | { status: "authentication-required"; version: string }
  | { status: "unavailable"; reason: string }
  | { status: "unknown"; reason: string; version?: string };

export interface AgentRunRequest {
  runId: string;
  cwd: string;
  prompt: string;
  /** Provider-neutral JSON Schema for adapters that support constrained final responses. */
  outputSchema?: JsonObject;
  /** Least-privilege workspace access requested for this logical agent role. */
  accessMode?: "read-only" | "workspace-write";
}

export interface AgentError {
  code: DensaAdeErrorCode;
  message: string;
  details?: JsonObject;
}

export type AgentRunOutcome = "succeeded" | "failed" | "cancelled";

export type AgentEvent =
  | {
      type: "run.started";
      runId: string;
      occurredAt: string;
      /** Optional local worker PID; Core captures and persists OS identity for recovery. */
      processId?: number;
    }
  | {
      type: "progress";
      runId: string;
      occurredAt: string;
      stage: string;
    }
  | {
      type: "message";
      runId: string;
      occurredAt: string;
      text: string;
      truncated: boolean;
    }
  | {
      type: "tool";
      runId: string;
      occurredAt: string;
      toolType: string;
      status: "started" | "completed" | "failed";
      command?: string;
      output?: string;
      exitCode?: number;
      truncated: boolean;
    }
  | {
      type: "diagnostic";
      runId: string;
      occurredAt: string;
      stream: "adapter" | "stderr";
      text: string;
      truncated: boolean;
    }
  | {
      type: "run.terminal";
      runId: string;
      occurredAt: string;
      outcome: AgentRunOutcome;
      exitCode?: number;
      finalMessage?: string;
      error?: AgentError;
    };

export interface AgentAdapter {
  readonly adapterId: string;
  detect(): Promise<AgentDetection>;
  getStatus(): Promise<AgentStatus>;
  execute(request: AgentRunRequest): AsyncIterable<AgentEvent>;
  cancel(runId: string): Promise<void>;
  getUsageState(): Promise<UsageState>;
}

export function isTerminalAgentEvent(
  event: AgentEvent,
): event is Extract<AgentEvent, { type: "run.terminal" }> {
  return event.type === "run.terminal";
}
