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
  "LINEAR_ACCESS_TOKEN",
  "LINEAR_CLIENT_SECRET",
  "LINEAR_REFRESH_TOKEN",
  "LINEAR_WEBHOOK_SECRET",
  "NGROK_AUTHTOKEN",
  "NODE_AUTH_TOKEN",
  "NPM_TOKEN",
  "OPENAI_API_KEY",
  "PAWS_DASHBOARD_TOKEN",
  "SSH_AGENT_PID",
  "SSH_ASKPASS",
  "SSH_AUTH_SOCK",
]);

/** Org model credentials passed to an agent only in hosted mode. */
const HOSTED_AUTH_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_API_KEY",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
] as const;

const BLOCKED_PREFIXES = ["AWS_", "AZURE_", "CLOUDSDK_", "GH_", "GITHUB_", "GOOGLE_"];

/** True for tokens, cloud keys, and ssh-agent sockets that must not reach an agent. */
export function isBlockedEnv(key: string): boolean {
  if (BLOCKED_EXACT.has(key)) return true;
  return BLOCKED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Environment for a spawned adapter.
 * `HOME` is kept so the adapter can use the developer's existing login.
 * This function does not read credential files.
 */
export function minimalAgentEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value == null || isBlockedEnv(key)) continue;
    env[key] = value;
  }
  return env;
}

/**
 * Environment for a spawned adapter.
 * Local mode keeps the developer's login and strips API keys.
 * Hosted mode puts `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` (or a model-proxy
 * base URL) back so the CLIs can authenticate without a personal login.
 * GitHub, Linear, and dashboard secrets stay stripped. `isBlockedEnv` still
 * rejects those names if an agent tries to set them on a terminal.
 */
export function agentEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env = minimalAgentEnv(base);
  if (!hostedAgent(base)) return env;
  for (const key of HOSTED_AUTH_KEYS) {
    const value = base[key];
    if (value) env[key] = value;
  }
  const proxy = base.PAWS_MODEL_PROXY_URL;
  if (proxy) {
    if (!env.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = proxy;
    if (!env.OPENAI_BASE_URL) env.OPENAI_BASE_URL = proxy;
  }
  return env;
}

function hostedAgent(base: NodeJS.ProcessEnv): boolean {
  const mode = base.PAWS_MODE;
  if (mode === "hosted") return true;
  if (mode === "local") return false;
  return Boolean(base.RAILWAY_ENVIRONMENT || base.RAILWAY_PROJECT_ID);
}
