import type { AgentProfile } from "../config";
import type { SessionUpdate, StopReason } from "@agentclientprotocol/sdk";
import type { CheckpointResult } from "./checkpoint";
import type { AgentRole } from "./adapters";
import type { AuthCheckResult } from "./auth";
import type { AskTeamHook } from "./ask-team";

export const DEFAULT_RUN_TIMEOUT_MS = 45 * 60 * 1000;
export const DEFAULT_CANCEL_GRACE_MS = 2_000;

export type RunOutcome = StopReason | "timeout" | "error";

/** Events the Linear module can map onto agent activities. */
export type AcpEvent =
  | {
      type: "auth_checked";
      role: AgentRole;
      auth: AuthCheckResult;
    }
  | {
      type: "session_started";
      role: AgentRole;
      sessionId: string;
      cwd: string;
      identity?: AgentIdentity;
    }
  | {
      type: "session_update";
      sessionId: string;
      update: SessionUpdate;
    }
  | {
      type: "permission";
      toolCallId: string;
      decision: "allow" | "deny" | "cancelled";
      reason: string;
      optionId?: string;
      title?: string | null;
      kind?: string | null;
      name?: string | null;
    }
  | {
      type: "ask_team";
      question: string;
      phase: "asked" | "answered";
      answer?: string;
    }
  | {
      type: "prompt_complete";
      stopReason: string;
    }
  | {
      type: "cancelled";
      reason: "timeout" | "cancel";
    }
  | {
      type: "checkpoint";
      reason: "prompt_complete" | "cancel" | "timeout" | "error";
      checkpoint: CheckpointResult;
    }
  | {
      type: "error";
      message: string;
    };

export type AcpEventListener = (event: AcpEvent) => void | Promise<void>;

export type AgentIdentity = { session: string; model: string; provider: string };

export interface RunAgentOptions {
  profile?: AgentProfile;
  readOnly?: boolean;
  prepareOnly?: boolean;
  role: AgentRole;
  itemId: string;
  runId: string;
  prompt: string;
  worktreePath: string;
  pawsRoot: string;
  home?: string;
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  cancelGraceMs?: number;
  signal?: AbortSignal;
  onEvent?: AcpEventListener;
  askTeam?: AskTeamHook;
  /** When false, a dirty worktree is left uncommitted. Defaults to committing. */
  checkpoint?: boolean;
  /**
   * Run the adapter in the sandbox. The worktree is the only bind mount.
   * Omit it and the host spawn is unchanged.
   */
  docker?: {
    agent: "claude" | "codex";
    proxyUrl: string;
    image?: string;
    bin?: string;
  };
}

export interface RunAgentResult {
  identity?: AgentIdentity;
  models?: Array<{ id: string; name: string }>;
  role: AgentRole;
  sessionId?: string;
  stopReason: RunOutcome;
  acpStopReason?: StopReason;
  auth?: AuthCheckResult;
  checkpoint?: CheckpointResult;
  timedOut: boolean;
  cancelled: boolean;
  authRequired: boolean;
  errorMessage?: string;
  pid?: number;
  agentExited: boolean;
}

export interface ExecuteItemOptions extends Omit<RunAgentOptions, "worktreePath" | "role"> {
  owner: string;
  repo: string;
  remoteUrl: string;
  role?: AgentRole;
  startRef?: string;
}

export interface ExecuteItemResult {
  mirrorPath: string;
  worktreePath: string;
  branch: string;
  run: RunAgentResult;
}
