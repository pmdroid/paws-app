const ALLOWED_ENV = new Set([
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
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "BUN_INSTALL",
  "BUN_INSTALL_CACHE_DIR",
  "npm_config_cache",
  "NODE_COMPILE_CACHE",
  "NODE_EXTRA_CA_CERTS",
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
]);

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
    if (value == null) continue;
    if (key === "XAI_API_KEY" && options.allowXaiApiKey && value.length > 0) {
      env[key] = value;
      continue;
    }
    if (isBlockedEnv(key)) continue;
    if (PROXY_ENV.has(key) && !isBenignProxy(value)) continue;
    env[key] = value;
  }
  return env;
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
  } catch {
    return false;
  }
}
