import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentsConfig } from "../config";

export type AgentRole = "implementer" | "reviewer";

export interface AdapterCommand {
  command: string;
  args: string[];
}

/** Package that ships the `claude-agent-acp` bin. The Zed package name is deprecated. */
export const CLAUDE_AGENT_ACP_PACKAGE = "@agentclientprotocol/claude-agent-acp";
/** Package that ships the `codex-acp` bin. The Zed package name is deprecated. */
export const CODEX_ACP_PACKAGE = "@agentclientprotocol/codex-acp";

export const CLAUDE_AGENT_ACP_BIN = "claude-agent-acp";
export const CODEX_ACP_BIN = "codex-acp";

/**
 * Grok Build ACP entry. Flags stay in this order.
 * `--always-approve` / `--yolo` are never included: tool permission goes
 * through Paws `session/request_permission`.
 */
export const GROK_AGENT_ARGS = ["--no-auto-update", "agent", "stdio"] as const;

export const GROK_LOGIN_MESSAGE = "Run `grok login`";

const AUTO_APPROVE = new Set(["--always-approve", "--yolo"]);

const PINS: Record<AgentRole, { bin: string; packageName: string }> = {
  implementer: { bin: CLAUDE_AGENT_ACP_BIN, packageName: CLAUDE_AGENT_ACP_PACKAGE },
  reviewer: { bin: CODEX_ACP_BIN, packageName: CODEX_ACP_PACKAGE },
};

export type AdapterVersions = {
  claudeAgentAcp: string;
  codexAcp: string;
};

export type AdapterPin = {
  role: AgentRole;
  bin: string;
  packageName: string;
  version: string;
  command: string;
};

export type GrokCommand = {
  command: string;
  args: string[];
  error: string | null;
};

/** Checkout root that contains the paws `package.json`. */
export function pawsPackageRoot(start: string = import.meta.dir): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const parsed: unknown = JSON.parse(readFileSync(candidate, "utf8"));
      if (isPawsPackage(parsed)) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`paws package root was not found from ${start}`);
}

/** Absolute path of the package bin. This does not search PATH. */
export function adapterBinPath(role: AgentRole, root: string = pawsPackageRoot()): string {
  return join(root, "node_modules", ".bin", PINS[role].bin);
}

/** Versions installed by `bun install`, for doctor. */
export function adapterVersions(root: string = pawsPackageRoot()): AdapterVersions {
  return {
    claudeAgentAcp: installedVersion(root, CLAUDE_AGENT_ACP_PACKAGE, CLAUDE_AGENT_ACP_BIN),
    codexAcp: installedVersion(root, CODEX_ACP_PACKAGE, CODEX_ACP_BIN),
  };
}

export function pinnedAdapters(root: string = pawsPackageRoot()): Record<AgentRole, AdapterPin> {
  const versions = adapterVersions(root);
  return {
    implementer: pin("implementer", versions.claudeAgentAcp, root),
    reviewer: pin("reviewer", versions.codexAcp, root),
  };
}

/**
 * Claude Code, Grok, or Codex for the implementer. Codex stays the reviewer.
 * Claude and Codex default to the absolute `node_modules/.bin` path.
 * Paws does not search PATH for those two unless `PAWS_CLAUDE_ACP` / `PAWS_CODEX_ACP` is set.
 * A PATH `grok` is used only when `agents.grok.path` is set.
 */
export function resolveAdapter(
  role: AgentRole,
  env: NodeJS.ProcessEnv = process.env,
  override?: AdapterCommand,
  root?: string,
  agents?: AgentsConfig,
  selected?: AgentsConfig["implementer"],
): AdapterCommand {
  if (override?.command) return { command: override.command, args: override.args ?? [] };
  const implementer =
    selected ?? (role === "reviewer" ? "codex" : (agents?.implementer ?? "claude"));
  if (implementer === "grok") {
    const resolved = resolveGrokCommand(agents, root);
    if (resolved.error) throw new Error(resolved.error);
    return { command: resolved.command, args: resolved.args };
  }
  if (implementer === "codex") return fromPinnedOrEnv(env, "PAWS_CODEX_ACP", "reviewer", root);
  return fromPinnedOrEnv(env, "PAWS_CLAUDE_ACP", "implementer", root);
}

/** Pinned `@xai-official/grok` in `node_modules/.bin`, unless `agents.grok.path` is set. */
export function resolveGrokCommand(
  agents?: AgentsConfig,
  packageRoot: string = pawsPackageRoot(),
): GrokCommand {
  const args = [...GROK_AGENT_ARGS];
  rejectAutoApprove(args);
  const configured = agents?.grok.path?.trim() ?? "";
  if (configured.length > 0) {
    if (configured.includes("/") && !existsSync(configured)) {
      return {
        command: configured,
        args,
        error: `agents.grok.path does not exist: ${configured}`,
      };
    }
    return { command: configured, args, error: null };
  }
  const command = join(packageRoot, "node_modules", ".bin", "grok");
  if (!existsSync(command)) {
    return {
      command,
      args,
      error:
        "Pinned @xai-official/grok is not installed at node_modules/.bin/grok. Run `bun install` in the Paws checkout.",
    };
  }
  const platform = grokPlatformDir(packageRoot);
  if (!existsSync(platform)) {
    const target = `${process.platform}-${process.arch}`;
    return {
      command,
      args,
      error: `@xai-official/grok: no platform binary installed for ${target}. Set agents.grok.path to a grok executable.`,
    };
  }
  return { command, args, error: null };
}

export function rejectAutoApprove(args: readonly string[]): void {
  for (const arg of args) {
    const name = arg.startsWith("--") ? (arg.split("=")[0] ?? arg) : arg;
    if (AUTO_APPROVE.has(name)) {
      throw new Error("refusing to spawn grok with --always-approve or --yolo");
    }
  }
}

/**
 * `cached_token` is the default. `xai.api_key` is selected only when that
 * method is advertised, `XAI_API_KEY` is set, and `agents.grok.allow_api_key`
 * is true. The key value is not returned.
 */
export function selectGrokAuthMethod(
  methods: readonly { id: string }[],
  options: { apiKeyPresent: boolean; allowApiKey: boolean },
): string | null {
  const ids = new Set(methods.map((method) => method.id));
  if (options.apiKeyPresent && options.allowApiKey && ids.has("xai.api_key")) {
    return "xai.api_key";
  }
  if (ids.has("cached_token")) return "cached_token";
  return null;
}

/** True when the variable is a non-empty string. The value is not returned. */
export function xaiApiKeyPresent(env: NodeJS.ProcessEnv): boolean {
  const value = env.XAI_API_KEY;
  return typeof value === "string" && value.length > 0;
}

function fromPinnedOrEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  role: AgentRole,
  root: string | undefined,
): AdapterCommand {
  const configured = env[key];
  if (configured !== undefined && configured.trim().length > 0) {
    const parts = configured.trim().split(/\s+/);
    const command = parts[0];
    if (command) return { command, args: parts.slice(1) };
  }
  return { command: adapterBinPath(role, root), args: [] };
}

function grokPlatformDir(packageRoot: string): string {
  return join(
    packageRoot,
    "node_modules",
    "@xai-official",
    `grok-${process.platform}-${process.arch}`,
  );
}

function pin(role: AgentRole, version: string, root: string): AdapterPin {
  const spec = PINS[role];
  return {
    role,
    bin: spec.bin,
    packageName: spec.packageName,
    version,
    command: adapterBinPath(role, root),
  };
}

function installedVersion(root: string, packageName: string, bin: string): string {
  const manifestPath = join(root, "node_modules", packageName, "package.json");
  if (!existsSync(manifestPath)) {
    const expected = join(root, "node_modules", ".bin", bin);
    throw new Error(
      `${bin} is not installed at ${expected}. ` +
        "Run bun install in the paws checkout. " +
        "Paws resolves this adapter from node_modules/.bin and does not search PATH.",
    );
  }
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!isRecord(parsed) || typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error(`${packageName} package.json has no version`);
  }
  return parsed.version;
}

function isPawsPackage(value: unknown): boolean {
  return isRecord(value) && value.name === "paws";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
