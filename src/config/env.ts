import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_HOST = "127.0.0.1";
export const HOSTED_HOST = "0.0.0.0";
export const DEFAULT_PORT = 8787;

export type EnvSource = Record<string, string | undefined>;

export type PawsMode = "local" | "hosted";

export type PawsEnv = {
  mode: PawsMode;
  hosted: boolean;
  home: string;
  host: string;
  port: number;
  publicUrl: string | null;
  linearClientId: string | null;
  linearClientSecret: string | null;
  linearAccessToken: string | null;
  linearRefreshToken: string | null;
  linearWebhookSecret: string | null;
  githubAppId: string | null;
  githubAppInstallationId: string | null;
  githubAppPrivateKeyPath: string | null;
  /** PEM from `GITHUB_APP_PRIVATE_KEY`. Hosted mode does not read a key file. */
  githubAppPrivateKey: string | null;
  githubWebhookSecret: string | null;
  anthropicApiKey: string | null;
  anthropicAuthToken: string | null;
  anthropicBaseUrl: string | null;
  openaiApiKey: string | null;
  openaiBaseUrl: string | null;
  modelProxyUrl: string | null;
  dashboardToken: string | null;
};

export function loadEnv(source: EnvSource = process.env): PawsEnv {
  const hosted = isHostedSource(source);
  return {
    mode: hosted ? "hosted" : "local",
    hosted,
    home: readHome(source, hosted),
    host: optional(source, "PAWS_HOST") ?? (hosted ? HOSTED_HOST : DEFAULT_HOST),
    port: readListenPort(source, hosted),
    publicUrl: readPublicUrl(source, hosted),
    linearClientId: optional(source, "LINEAR_CLIENT_ID"),
    linearClientSecret: optional(source, "LINEAR_CLIENT_SECRET"),
    linearAccessToken: optional(source, "LINEAR_ACCESS_TOKEN"),
    linearRefreshToken: optional(source, "LINEAR_REFRESH_TOKEN"),
    linearWebhookSecret: optional(source, "LINEAR_WEBHOOK_SECRET"),
    githubAppId: optional(source, "GITHUB_APP_ID"),
    githubAppInstallationId: optional(source, "GITHUB_APP_INSTALLATION_ID"),
    githubAppPrivateKeyPath: optional(source, "GITHUB_APP_PRIVATE_KEY_PATH"),
    githubAppPrivateKey: readPrivateKey(source),
    githubWebhookSecret: optional(source, "GITHUB_WEBHOOK_SECRET"),
    anthropicApiKey: optional(source, "ANTHROPIC_API_KEY"),
    anthropicAuthToken: optional(source, "ANTHROPIC_AUTH_TOKEN"),
    anthropicBaseUrl: optional(source, "ANTHROPIC_BASE_URL"),
    openaiApiKey: optional(source, "OPENAI_API_KEY"),
    openaiBaseUrl: optional(source, "OPENAI_BASE_URL"),
    modelProxyUrl: optional(source, "PAWS_MODEL_PROXY_URL"),
    dashboardToken: optional(source, "PAWS_DASHBOARD_TOKEN"),
  };
}

/**
 * `PAWS_MODE=hosted` opts in. `PAWS_MODE=local` opts out.
 * An unset mode follows Railway (`RAILWAY_ENVIRONMENT` or `RAILWAY_PROJECT_ID`).
 */
export function isHostedSource(source: EnvSource): boolean {
  const mode = optional(source, "PAWS_MODE");
  if (mode === "hosted") return true;
  if (mode === "local") return false;
  if (mode !== null) {
    throw new Error(`PAWS_MODE must be local or hosted, got ${mode}`);
  }
  return (
    optional(source, "RAILWAY_ENVIRONMENT") !== null ||
    optional(source, "RAILWAY_PROJECT_ID") !== null
  );
}

/** Turn a one-line PEM (`\n` escapes) into a real PEM. Does not validate the key. */
export function normalizePrivateKey(value: string): string {
  const trimmed = value.trim();
  const pem = trimmed.includes("\n") ? trimmed : trimmed.replace(/\\n/g, "\n");
  return pem.endsWith("\n") ? pem : `${pem}\n`;
}

export function privateKeyLooksLikePem(value: string): boolean {
  return value.includes("BEGIN") && value.includes("PRIVATE KEY") && value.includes("END");
}

function readPrivateKey(source: EnvSource): string | null {
  const inline = optional(source, "GITHUB_APP_PRIVATE_KEY");
  if (inline === null) return null;
  return normalizePrivateKey(inline);
}

function readHome(source: EnvSource, hosted: boolean): string {
  const explicit = optional(source, "PAWS_HOME");
  if (explicit !== null) return explicit;
  if (hosted) {
    const mount = optional(source, "RAILWAY_VOLUME_MOUNT_PATH");
    if (mount !== null) return mount;
  }
  return join(homedir(), ".paws");
}

function readListenPort(source: EnvSource, hosted: boolean): number {
  if (hosted) {
    const railway = optional(source, "PORT");
    if (railway !== null) return parsePort(railway, "PORT");
  }
  return parsePort(source["PAWS_PORT"], "PAWS_PORT");
}

function readPublicUrl(source: EnvSource, hosted: boolean): string | null {
  const explicit = optional(source, "PAWS_PUBLIC_URL");
  if (explicit !== null) return explicit.replace(/\/+$/, "");
  if (!hosted) return null;
  const domain = optional(source, "RAILWAY_PUBLIC_DOMAIN");
  if (domain === null) return null;
  const host = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (host.length === 0) return null;
  return `https://${host}`;
}

function parsePort(value: string | undefined, name: string): number {
  if (value === undefined || value.length === 0) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${name} must be an integer from 0 to 65535, got ${value}`);
  }
  return port;
}

function optional(source: EnvSource, key: string): string | null {
  const value = source[key];
  if (value === undefined || value.length === 0) return null;
  return value;
}
