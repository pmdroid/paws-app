import type { ItemId } from "../core";

export type AcpStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

export type AcpUpdateKind = "message" | "tool_call" | "plan" | "usage" | "error";

export type AcpUpdate = {
  sessionId: string;
  kind: AcpUpdateKind;
  summary: string;
};

export type StartAcpRun = {
  itemId: ItemId;
  worktree: string;
  prompt: string;
  onUpdate?: (update: AcpUpdate) => void;
};

/**
 * Client side of ACP (`@agentclientprotocol/sdk` when QM-05 lands).
 * Paws spawns the developer's already-logged-in adapter and never calls `authenticate`.
 */
export interface AcpRunner {
  start(input: StartAcpRun): Promise<{ sessionId: string }>;
  cancel(sessionId: string): Promise<void>;
}
