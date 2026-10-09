export type AgentRole = "implementer" | "reviewer";

export interface AdapterCommand {
  command: string;
  args: string[];
}

const DEFAULTS: Record<AgentRole, AdapterCommand> = {
  implementer: { command: "claude-agent-acp", args: [] },
  reviewer: { command: "codex-acp", args: [] },
};

/**
 * Claude Code (implementer) and Codex (reviewer).
 * `PAWS_CLAUDE_ACP` / `PAWS_CODEX_ACP` override the executable for local spikes.
 */
export function resolveAdapter(
  role: AgentRole,
  env: NodeJS.ProcessEnv = process.env,
  override?: AdapterCommand,
): AdapterCommand {
  if (override?.command) return { command: override.command, args: override.args ?? [] };
  const configured = role === "implementer" ? env.PAWS_CLAUDE_ACP : env.PAWS_CODEX_ACP;
  if (configured?.trim()) {
    const parts = configured.trim().split(/\s+/);
    const command = parts[0];
    if (!command) return DEFAULTS[role];
    return { command, args: parts.slice(1) };
  }
  return DEFAULTS[role];
}
