import { assetPath, compiled } from "../assets";
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

export const OPENCODE_PACKAGE = "@opencode/cli";
export const OPENCODE_ACP_BIN = "opencode";

/**
 * Grok Build ACP entry. Flags stay in this order.
 * `--always-approve` / `--yolo` are never included: tool permission goes
 * through Paws `session/request_permission`.
 */
export const GROK_AGENT_ARGS = ["--no-auto-update", "agent", "stdio"] as const;

export const GROK_LOGIN_MESSAGE = "Run `grok login`";

export const OPENCODE_AGENT_ARGS = ["acp"] as const;

export const OPENCODE_LOGIN_MESSAGE = "Run `opencode auth login`";

const AUTO_APPROVE = new Set(["--always-approve", "--yolo"]);

const PINS: Record<AgentRole, { bin: string; packageName: string }> = {
  implementer: { bin: CLAUDE_AGENT_ACP_BIN, packageName: CLAUDE_AGENT_ACP_PACKAGE },
  reviewer: { bin: CODEX_ACP_BIN, packageName: CODEX_ACP_PACKAGE },
};

export type AdapterVersions = {
  claudeAgentAcp: string;
  codexAcp: string;
  opencode?: string;
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

export type OpencodeCommand = {
  command: string;
  args: string[];
  error: string | null;
};

/** Checkout root that contains the paws `package.json`. */
export function pawsPackageRoot(start: string = import.meta.dir): string {
  if (compiled()) return assetPath(".");
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

/** Runner install root: releases under `releases/`, `current` points at one, agent launchers in `bin/`. */
export const RUNNER_BASE = "/opt/paws-runner";

/**
 * The installed launcher for `bin` when `root` is a runner release, which has no agents in its own
 * `node_modules` (`deploy/linux/install.py` installs them). The launcher runs the agent's current
 * version and holds that version for the session.
 */
function installedLauncher(root: string, bin: string, base: string): string | null {
  if (!root.startsWith(`${base}/releases/`) && root !== `${base}/current`) return null;
  if (existsSync(join(root, "node_modules", ".bin", bin))) return null;
  const launcher = join(base, "bin", bin);
  return existsSync(launcher) ? launcher : null;
}

/** Absolute path of the package bin, or a runner's installed launcher. This does not search PATH. */
export function adapterBinPath(
  role: AgentRole,
  root: string = pawsPackageRoot(),
  runnerBase: string = RUNNER_BASE,
): string {
  const bin = PINS[role].bin;
  return installedLauncher(root, bin, runnerBase) ?? join(root, "node_modules", ".bin", bin);
}

/**
 * The `claude` or `codex` CLI the runner starts for a sign-in check or a usage read. On a runner
 * release this is the installed launcher's absolute path, so it does not depend on `PATH`. In a
 * checkout it stays the bare name: the developer's own CLI from their `PATH`.
 */
export function providerCliPath(
  cli: "claude" | "codex",
  root: string = pawsPackageRoot(),
  runnerBase: string = RUNNER_BASE,
): string {
  return installedLauncher(root, cli, runnerBase) ?? cli;
}

/** Versions installed by `bun install`, for doctor. */
export function adapterVersions(root: string = pawsPackageRoot()): AdapterVersions {
  const opencode = installedVersionOrNull(root, OPENCODE_PACKAGE);
  return {
    claudeAgentAcp: installedVersion(root, CLAUDE_AGENT_ACP_PACKAGE, CLAUDE_AGENT_ACP_BIN),
    codexAcp: installedVersion(root, CODEX_ACP_PACKAGE, CODEX_ACP_BIN),
    ...(opencode === null ? {} : { opencode }),
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
 * Grok and OpenCode always use the pinned packages.
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
    const resolved = resolveGrokCommand(root);
    if (resolved.error) throw new Error(resolved.error);
    return { command: resolved.command, args: resolved.args };
  }
  if (implementer === "opencode") {
    const resolved = resolveOpencodeCommand(root);
    if (resolved.error) throw new Error(resolved.error);
    return { command: resolved.command, args: resolved.args };
  }
  if (implementer === "codex") return fromPinnedOrEnv(env, "PAWS_CODEX_ACP", "reviewer", root);
  return fromPinnedOrEnv(env, "PAWS_CLAUDE_ACP", "implementer", root);
}

/** Pinned `@xai-official/grok` in `node_modules/.bin`. */
export function resolveGrokCommand(
  packageRoot: string = pawsPackageRoot(),
  runnerBase: string = RUNNER_BASE,
): GrokCommand {
  const args = [...GROK_AGENT_ARGS];
  rejectAutoApprove(args);
  const launcher = installedLauncher(packageRoot, "grok", runnerBase);
  if (launcher) return { command: launcher, args, error: null };
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
      error: `@xai-official/grok: no platform binary installed for ${target}. Run \`bun install\` in the Paws checkout.`,
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

export function selectGrokAuthMethod(methods: readonly { id: string }[]): string | null {
  return methods.some((method) => method.id === "cached_token") ? "cached_token" : null;
}

export function resolveOpencodeCommand(
  packageRoot: string = pawsPackageRoot(),
  runnerBase: string = RUNNER_BASE,
): OpencodeCommand {
  const args = [...OPENCODE_AGENT_ARGS];
  rejectAutoApprove(args);
  const launcher = installedLauncher(packageRoot, OPENCODE_ACP_BIN, runnerBase);
  if (launcher) return { command: launcher, args, error: null };
  const native = join(
    packageRoot,
    "node_modules",
    "@opencode",
    `cli-${process.platform}-${process.arch}${process.arch === "x64" ? "-baseline" : ""}`,
    "bin",
    "opencode",
  );
  return { command: existsSync(native) ? native : OPENCODE_ACP_BIN, args, error: null };
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

function installedVersionOrNull(root: string, packageName: string): string | null {
  const manifestPath = join(root, "node_modules", packageName, "package.json");
  if (!existsSync(manifestPath)) return null;
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  return isRecord(parsed) && typeof parsed.version === "string" && parsed.version.length > 0
    ? parsed.version
    : null;
}

function isPawsPackage(value: unknown): boolean {
  return isRecord(value) && value.name === "paws";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
