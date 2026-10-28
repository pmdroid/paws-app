import type { ShowPreviewHook, ReviewPreviewHook } from "../live-preview";
import type { AgentProfile } from "../config";
import type { ItemId } from "../core";
import type { AgentRole } from "./adapters";
import type { AskTeamHook } from "./ask-team";
import type { ArtifactLimits, PublishArtifactHook } from "./artifacts";
import type { AcpEventListener } from "./types";

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
  profile?: AgentProfile;
  itemId: ItemId;
  worktree: string;
  prompt: string;
  onUpdate?: (update: AcpUpdate) => void;
  /** Richer stream. Linear maps these; `onUpdate` stays the short summary. */
  onEvent?: AcpEventListener;
  role?: AgentRole;
  runId?: string;
  pawsRoot?: string;
  home?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  askTeam?: AskTeamHook;
  publishArtifact?: PublishArtifactHook;
  showPreview?: ShowPreviewHook;
  reviewPreview?: ReviewPreviewHook;
  artifactLimits?: ArtifactLimits;
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
};

/**
 * Client side of ACP (`@agentclientprotocol/sdk` when QM-05 lands).
 * Paws spawns the developer's already-logged-in adapter and never calls `authenticate`.
 */
export interface AcpRunner {
  start(input: StartAcpRun): Promise<{ sessionId: string }>;
  cancel(sessionId: string): Promise<void>;
}
