/**
 * Environment for a command started by the runner.
 *
 * Same idea as `closeoutEnv` in `src/closeout`: copy the parent environment
 * and drop credentials before the child starts. This module does not import
 * `src/closeout`. GitHub tokens, the OAuth token, the ssh-agent socket, and
 * cloud keys stay out of the command.
 */

const DENY = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_PAT",
  "PAWS_GITHUB_TOKEN",
  "OAUTH_TOKEN",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
]);

const PREFIXES = ["AWS_", "AZURE_", "CLOUDSDK_", "GH_", "GITHUB_", "GOOGLE_"];

export function scrubCommandEnv(parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (isScrubbed(key)) continue;
    env[key] = value;
  }
  return env;
}

export function credentialSecrets(parent: NodeJS.ProcessEnv = process.env): string[] {
  const found = new Set<string>();
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined || value.length < 8) continue;
    if (!isScrubbed(key)) continue;
    found.add(value);
  }
  return [...found].sort((left, right) => right.length - left.length);
}

function isScrubbed(key: string): boolean {
  if (DENY.has(key)) return true;
  if (PREFIXES.some((prefix) => key.startsWith(prefix))) return true;
  if (key.includes("OAUTH") && key.includes("TOKEN")) return true;
  return /API_KEY|PASSWORD|SECRET|TOKEN/i.test(key);
}
