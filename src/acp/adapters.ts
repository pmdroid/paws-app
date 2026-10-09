import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
 * Claude Code (implementer) and Codex (reviewer).
 * The default command is the absolute `node_modules/.bin` path from the
 * pinned npm package. Paws does not search PATH and does not install globally.
 * `PAWS_CLAUDE_ACP` / `PAWS_CODEX_ACP` override the executable for local spikes.
 */
export function resolveAdapter(
  role: AgentRole,
  env: NodeJS.ProcessEnv = process.env,
  override?: AdapterCommand,
  root?: string,
): AdapterCommand {
  if (override?.command) return { command: override.command, args: override.args ?? [] };
  const configured = role === "implementer" ? env.PAWS_CLAUDE_ACP : env.PAWS_CODEX_ACP;
  if (configured?.trim()) {
    const parts = configured.trim().split(/\s+/);
    const command = parts[0];
    if (command) return { command, args: parts.slice(1) };
  }
  return { command: adapterBinPath(role, root), args: [] };
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
