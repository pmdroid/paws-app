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
  | { type: "update"; update: Record<string, unknown> }
  | { type: "permission"; toolCall: FakeToolCall; options?: FakePermissionOption[] }
  | { type: "fs_read"; path: string }
  | { type: "fs_write"; path: string; content: string }
  | { type: "terminal"; command: string; args?: string[]; cwd?: string }
  | { type: "ask_team"; question: string; options?: string[]; context?: string }
  | { type: "publish_artifact"; path: string; displayName?: string; mimeType?: string }
  | { type: "hang" }
  | {
      type: "end";
      stopReason?: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";
    };

export interface FakeScript {
  sessionId?: string;
  model?: string | null;
  models?: string[];
  modelError?: string;
  confirmModel?: string;
  authMethods?: Array<Record<string, unknown>>;
  ignoreCancel?: boolean;
  hangInitialize?: boolean;
  steps: FakeStep[];
}

export interface FakeResult {
  methods: string[];
  prompts?: unknown[];
  modelSelection?: unknown;
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
  artifact?: { ok: boolean; text?: string; error?: string };
  tools?: string[];
}
