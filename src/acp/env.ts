const BLOCKED_EXACT = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_API_KEY",
  "CODEX_API_KEY",
  "GH_ENTERPRISE_TOKEN",
  "GH_TOKEN",
  "GIT_ASKPASS",
  "GIT_SSH_COMMAND",
  "GITHUB_PAT",
  "GITHUB_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "KUBECONFIG",
  "NODE_AUTH_TOKEN",
  "NPM_TOKEN",
  "OPENAI_API_KEY",
  "SSH_AGENT_PID",
  "SSH_ASKPASS",
  "SSH_AUTH_SOCK",
  "XAI_API_KEY",
]);

const BLOCKED_PREFIXES = ["AWS_", "AZURE_", "CLOUDSDK_", "GH_", "GITHUB_", "GOOGLE_"];

/** True for tokens, cloud keys, and ssh-agent sockets that must not reach an agent. */
export function isBlockedEnv(key: string): boolean {
  if (BLOCKED_EXACT.has(key)) return true;
  return BLOCKED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export type AgentEnvOptions = {
  /** Pass `XAI_API_KEY` through. Only the Grok implementer sets this, and only when config allows it. */
  allowXaiApiKey?: boolean;
};

/**
 * Environment for a spawned adapter.
 * `HOME` is kept so the adapter can use the developer's existing login.
 * This function does not read credential files or `~/.grok/auth.json`.
 * `XAI_API_KEY` is removed unless `allowXaiApiKey` is set.
 */
export function minimalAgentEnv(
  base: NodeJS.ProcessEnv = process.env,
  options: AgentEnvOptions = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value == null || isBlockedEnv(key)) {
      if (key === "XAI_API_KEY" && options.allowXaiApiKey && value != null && value.length > 0) {
        env[key] = value;
      }
      continue;
    }
    env[key] = value;
  }
  return env;
}
