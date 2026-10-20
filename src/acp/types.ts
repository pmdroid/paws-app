import type { GitCommitIdentity, GitCommitPolicy } from "../core";
import type { AgentInputFile } from "./input-files";
import type { AgentProfile } from "../config";
import type { PolicyFilesLoad } from "../closeout-spec";
import { DEFAULT_MAX_AWAKE_MS } from "../core";
import type { SessionUpdate, StopReason } from "@agentclientprotocol/sdk";
import type { CheckpointResult } from "./checkpoint";
import type { AgentRole } from "./adapters";
import type { AuthCheckResult } from "./auth";
import type {
  AskTeamHook,
  CloseoutProgressHook,
  PostUpdateHook,
  PullRequestHook,
  UpdatePlanHook,
} from "./ask-team";
import type { ArtifactLimits, PublishArtifactHook } from "./artifacts";

export const DEFAULT_RUN_TIMEOUT_MS = DEFAULT_MAX_AWAKE_MS;
export const DEFAULT_CANCEL_GRACE_MS = 2_000;
export const FOLLOW_UP_INTERRUPTION = "follow_up";

export type RunOutcome = StopReason | "timeout" | "error";

/** Events the Linear module can map onto agent activities. */
export type AcpEvent =
  | { type: "progress"; text: string; messageChunk?: boolean }
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
      reason: "timeout" | "cancel" | typeof FOLLOW_UP_INTERRUPTION;
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
  repository?: string;
  skillsRoot?: string;
  checkoutExclusions?: readonly string[];
  networkGit?: (args: string[]) => Promise<string>;
  profile?: AgentProfile;
  readOnly?: boolean;
  hostAccess?: boolean;
  prepareOnly?: boolean;
  role: AgentRole;
  itemId: string;
  runId: string;
  prompt: string;
  inputFiles?: readonly AgentInputFile[];
  prepareInputFiles?: (input: {
    workspace: string;
    prompt: string;
    signal: AbortSignal;
  }) => Promise<{ prompt: string; inputFiles: readonly AgentInputFile[] }>;
  worktreePath: string;
  pawsRoot: string;
  home?: string;
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  checkpointEnv?: NodeJS.ProcessEnv;
  checkpointIdentity?: GitCommitIdentity;
  commitPolicy?: GitCommitPolicy;
  closeoutPolicy?: () => Promise<PolicyFilesLoad>;
  checkpointExcludePaths?: readonly string[];
  timeoutMs?: number;
  cancelGraceMs?: number;
  signal?: AbortSignal;
  onEvent?: AcpEventListener;
  askTeam?: AskTeamHook;
  updatePlan?: UpdatePlanHook;
  pullRequest?: PullRequestHook;
  postUpdate?: PostUpdateHook;
  publishArtifact?: PublishArtifactHook;
  closeoutProgress?: CloseoutProgressHook;
  artifactLimits?: ArtifactLimits;
  /** When false, a dirty worktree is left uncommitted. Defaults to committing. */
  checkpoint?: boolean;
  resume?: { sessionId: string; replayPrompt: string };
}

export interface RunAgentResult {
  identity?: AgentIdentity;
  models?: Array<{ id: string; name: string }>;
  effort?: string | null;
  efforts?: Array<{ id: string; name: string }>;
  role: AgentRole;
  sessionId?: string;
  stopReason: RunOutcome;
  acpStopReason?: StopReason;
  auth?: AuthCheckResult;
  checkpoint?: CheckpointResult;
  timedOut: boolean;
  cancelled: boolean;
  interrupted?: boolean;
  transcriptPath?: string;
  authRequired: boolean;
  errorMessage?: string;
  closeoutReport?: string;
  pid?: number;
  agentExited: boolean;
}

export interface ExecuteItemOptions extends Omit<RunAgentOptions, "worktreePath" | "role"> {
  owner: string;
  repo: string;
  remoteUrl: string;
  role?: AgentRole;
  startRef?: string;
  promptRunner?: (options: RunAgentOptions) => Promise<RunAgentResult>;
}

export interface ExecuteItemResult {
  mirrorPath: string;
  worktreePath: string;
  branch: string;
  run: RunAgentResult;
}
