const OWNED_SECRET_NAMES = new Set([
  "agent-session.key",
  "boat-token",
  "exe-dev-token",
  "github-app.json",
  "github-app.pem",
  "github-browser-app.json",
  "github-webhook",
  "instabox-token",
  "linear-browser-client.json",
  "linear-client.json",
  "linear-oauth.json",
  "linear-setup-pending",
  "linear-webhook",
  "runner-event.key",
  "runner-file.key",
  "runner-transcript-storage.json",
  "runner-transcript.key",
  "setup-token",
  "slack-app.json",
  "slack-oauth.json",
  "tailscale-authkey",
  "telemetry-otlp-header",
  "runner-identity/agent-read-tokens.json",
  "runner-identity/runner-authority.json",
  "runner-identity/runner-command-key.pem",
]);

const OWNED_SECRET_FAMILIES = [
  /^github-connect-[A-Za-z0-9-]+$/,
  /^github-user-grant-[0-9a-f]{64}\.grant$/,
];

const PRUNED_SECRET_FOLDERS = [
  "linear-artifacts",
  "linear-inputs",
  "runner-identity/inputs",
  "runner-identity/artifacts",
];

export function isPrunedSecretFolder(name: string): boolean {
  const path = name.split("\\").join("/");
  const base = path.slice(path.lastIndexOf("/") + 1);
  return (
    base.startsWith(".retired-") ||
    base.startsWith(".certificate-") ||
    PRUNED_SECRET_FOLDERS.includes(path)
  );
}

export function isOwnedSecretName(name: string): boolean {
  const path = name.split("\\").join("/");
  return OWNED_SECRET_NAMES.has(path) || OWNED_SECRET_FAMILIES.some((family) => family.test(path));
}
