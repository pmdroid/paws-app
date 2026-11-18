import { readFileSync, existsSync } from "node:fs";
import { journal, journalCaught } from "../journal";
import { join } from "node:path";
/** Variables an agent and its hooks may inherit. Everything else stays with Paws. */
export const ALLOWED_AGENT_ENV: readonly string[] = [
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_COLLATE",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NUMERIC",
  "LC_TIME",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "BUN_INSTALL",
  "BUN_INSTALL_CACHE_DIR",
  "npm_config_cache",
  "NODE_COMPILE_CACHE",
  "NODE_EXTRA_CA_CERTS",
  // The runner's shared mise installs, which Paws sets in the runner worker's agent env.
  "MISE_DATA_DIR",
  "MISE_CACHE_DIR",
  // A local Docker socket only, such as the runner's rootless daemon; see `isLocalDockerHost`.
  "DOCKER_HOST",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "ComSpec",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
];
const ALLOWED_ENV = new Set(ALLOWED_AGENT_ENV);

const PROXY_ENV = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
]);

/** True for tokens, cloud keys, and ssh-agent sockets that must not reach an agent. */
export function isBlockedEnv(key: string): boolean {
  return !ALLOWED_ENV.has(key);
}

/**
 * Environment for a spawned adapter.
 * `HOME` is kept so the adapter can use the developer's existing login.
 * This function does not read credential files or `~/.grok/auth.json`.
 */
export function minimalAgentEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value == null) continue;
    if (isBlockedEnv(key)) continue;
    if (PROXY_ENV.has(key) && !isBenignProxy(value)) continue;
    if (key === "DOCKER_HOST" && !isLocalDockerHost(value)) continue;
    env[key] = value;
  }
  return env;
}

/** A `unix://` socket path. A tcp or ssh endpoint would hand the agent another host's Docker. */
function isLocalDockerHost(value: string): boolean {
  return /^unix:\/\/\/[A-Za-z0-9._/-]+$/.test(value) && !value.split("/").includes("..");
}

function isBenignProxy(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:", "socks:", "socks4:", "socks5:", "socks5h:"].includes(url.protocol) &&
      url.hostname.length > 0 &&
      !url.username &&
      !url.password &&
      (!url.pathname || url.pathname === "/") &&
      !url.search &&
      !url.hash
    );
  } catch (caughtError1) {
    journalCaught(caughtError1, "env.isBenignProxy.includes", null);
    return false;
  }
}

export function accountHomeEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
  };
}

const API_KEY_ENV: Readonly<Record<string, string>> = {
  claude: "ANTHROPIC_API_KEY",
  codex: "OPENAI_API_KEY",
  grok: "XAI_API_KEY",
  opencode: "OPENROUTER_API_KEY",
};

function readCredential(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    journal(`agent account credential ${path} is not valid JSON`);
    return null;
  }
}

export function accountAgentEnv(agent: string, home: string): Record<string, string> {
  if (agent === "claude") {
    const oauthPath = join(home, ".claude/paws-oauth.json");
    const oauth = existsSync(oauthPath)
      ? (JSON.parse(readFileSync(oauthPath, "utf8")) as { kind?: unknown; token?: unknown } | null)
      : null;
    if (
      oauth?.kind === "oauth_token" &&
      typeof oauth.token === "string" &&
      /^sk-ant-oat01-[A-Za-z0-9_-]+$/.test(oauth.token)
    )
      return { CLAUDE_CODE_OAUTH_TOKEN: oauth.token };
  }
  const variable = Object.hasOwn(API_KEY_ENV, agent) ? API_KEY_ENV[agent] : undefined;
  if (!variable) return {};
  const path = join(home, ".paws/api-key.json");
  const credential = readCredential(path);
  if (credential?.kind !== "api_key" || credential.agent !== agent) return {};
  if (typeof credential.key !== "string" || !/^\S{1,512}$/.test(credential.key)) {
    journal(`agent account API key in ${path} is malformed; no key set`);
    return {};
  }
  return { [variable]: credential.key };
}
