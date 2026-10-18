import type { AskTeamOption } from "../ask-team";
export interface FakeToolCall {
  toolCallId: string;
  title?: string;
  name?: string;
  kind?: string;
  locations?: Array<{ path: string }>;
  rawInput?: unknown;
}

export interface FakePermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export type FakeStep =
  | { type: "update"; update: Record<string, unknown>; delayMs?: number }
  | { type: "permission"; toolCall: FakeToolCall; options?: FakePermissionOption[] }
  | { type: "fs_read"; path: string }
  | { type: "fs_write"; path: string; content: string }
  | { type: "terminal"; command: string; args?: string[]; cwd?: string }
  | { type: "ask_team"; question: string; options?: readonly AskTeamOption[]; context?: string }
  | { type: "update_plan"; steps: readonly { content: string; status: string }[] }
  | { type: "open_pull_request"; title: string; body: string }
  | { type: "post_update"; text: string }
  | {
      type: "publish_artifact";
      path: string;
      displayName?: string;
      mimeType?: string;
      attachToIssue?: boolean;
      checkId?: string;
    }
  | { type: "get_closeout" }
  | { type: "run_closeout"; id: string; model?: string }
  | { type: "request_closeout_skip"; checkIds: string[]; reason: string }
  | { type: "hang" }
  | {
      type: "end";
      updatesAfterResponse?: Record<string, unknown>[];
      stopReason?: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";
    };

export interface FakeScript {
  promptCapabilities?: { image?: boolean; embeddedContext?: boolean };
  sessionId?: string;
  model?: string | null;
  models?: string[];
  modelOptions?: Array<{ value: string; name: string; description?: string }>;
  modelError?: string;
  confirmModel?: string;
  effort?: string;
  efforts?: string[];
  modelEfforts?: Record<string, string[]>;
  effortError?: string;
  confirmEffort?: string;
  authMethods?: Array<Record<string, unknown>>;
  ignoreCancel?: boolean;
  hangInitialize?: boolean;
  steps: FakeStep[];
}

export interface FakeResult {
  methods: string[];
  prompts?: unknown[];
  modelSelection?: unknown;
  effortSelection?: unknown;
  argv?: string[];
  cwd?: string;
  authenticate?: unknown;
  env?: {
    xaiApiKey: boolean;
    ghToken: boolean;
    sshAuthSock: boolean;
    aws: boolean;
  };
  mcpServers: Array<{
    name?: string;
    command?: string;
    args?: string[];
    env?: Array<{ name: string; value: string }>;
  }>;
  sessionMeta?: unknown;
  codexHome?: string;
  permissions: Array<{ toolCallId?: string; outcome: unknown }>;
  fs: Array<{ op: "read" | "write"; path: string; ok: boolean; error?: string; content?: string }>;
  terminals: Array<{
    command: string;
    ok: boolean;
    error?: string;
    output?: string;
    exitCode?: number | null;
  }>;
  askTeam?: { ok: boolean; text?: string; error?: string };
  closeouts?: string[];
  plan?: { ok: boolean; text?: string; error?: string };
  pullRequest?: { ok: boolean; text?: string; error?: string };
  updates?: Array<{ ok: boolean; text?: string; error?: string }>;
  artifact?: { ok: boolean; text?: string; error?: string };
  tools?: string[];
}
