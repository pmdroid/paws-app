/** Vendor APIs and package registries the allow-list proxy may dial. */
export const ALLOWED_HOSTS = [
  "api.anthropic.com",
  "claude.ai",
  "console.anthropic.com",
  "platform.claude.com",
  "api.openai.com",
  "auth.openai.com",
  "chatgpt.com",
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "pypi.python.org",
  "crates.io",
  "index.crates.io",
  "static.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
  "repo.maven.apache.org",
  "repo1.maven.org",
  "rubygems.org",
  "index.rubygems.org",
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
] as const;

const ALLOWED_PORTS = new Set([80, 443]);

/**
 * True when `host` is an allow-listed name or a subdomain of one.
 * IP addresses are rejected so the proxy cannot be pointed at the host network.
 */
export function isAllowedHost(host: string): boolean {
  const name = host.trim().toLowerCase().replace(/\.$/, "");
  if (!name || name.includes("/") || name.includes(" ") || name.includes(":")) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return false;
  return ALLOWED_HOSTS.some((allowed) => name === allowed || name.endsWith(`.${allowed}`));
}

/** HTTPS and HTTP to allow-listed hosts only. SSH and other ports are denied. */
export function authorizeTunnel(host: string, port: number): boolean {
  if (!ALLOWED_PORTS.has(port)) return false;
  return isAllowedHost(host);
}
