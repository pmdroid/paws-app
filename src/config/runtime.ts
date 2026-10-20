import { existsSync } from "node:fs";
import { readSecretFile } from "../credentials";
import { isAbsolute, join } from "node:path";
import { DEFAULT_MAX_AWAKE_MS, DEFAULT_MAX_TURNS } from "../core";
import { loadEnv, type EnvSource, type PawsEnv } from "./env";
import {
  emptyConfigFile,
  loadConfigFile,
  PAWS_GITHUB_OAUTH_CLIENT_ID,
  type GitHubConfigAuth,
  type LinearConfigMode,
  type PawsConfigFile,
} from "./file";
import { pawsPaths } from "./paths";
import { loadGitHubAppCredentials } from "./github-app";

/**
 * What the process runs with. `config.toml` and the secret files it names
 * are the source. Environment variables override a single field when set.
 */
export type RuntimeConfig = {
  env: PawsEnv;
  file: PawsConfigFile;
  /** True when `config.toml` was present. */
  configured: boolean;
  configError: string | null;
  linearMode: LinearConfigMode;
  linearTeam: string | null;
  linearTeamId: string | null;
  linearViewerId: string | null;
  /** Personal API key for comment mode. Not logged. */
  linearApiKey: string | null;
  /** OAuth access token for agent-session mode. Not logged. */
  linearAccessToken: string | null;
  linearRefreshToken: string | null;
  linearClientId: string | null;
  linearClientSecret: string | null;
  githubAuth: GitHubConfigAuth;
  oauthClientId: string | null;
  trackerKind: "linear";
  repo: string | null;
  publicUrl: string | null;
  checkout: string | null;
  maxTurns: number;
  maxAwakeMs: number;
  webhooks: boolean;
};

export function loadRuntime(source: EnvSource = process.env): RuntimeConfig {
  const env = loadEnv(source);
  env.linearWebhookSecret ??= readSecretFile(
    join(pawsPaths(env.home).secretsDir, "linear-webhook"),
  );
  env.githubWebhookSecret ??= readSecretFile(
    join(pawsPaths(env.home).secretsDir, "github-webhook"),
  );
  const app = loadGitHubAppCredentials(env.home, source);
  if (app !== null) {
    env.githubAppId = app.appId;
    env.githubAppInstallationId = app.installationId;
    env.githubAppPrivateKeyPath = app.privateKeyPath;
  }
  const configPath = pawsPaths(env.home).configFile;
  const configured = existsSync(configPath);
  let file = emptyConfigFile();
  let configError: string | null = null;
  if (configured) {
    try {
      file = loadConfigFile(configPath);
    } catch (error) {
      configError = error instanceof Error ? error.message : "config.toml could not be parsed";
    }
  }

  if (file.retiredTrackerConfigured || (file.trackerSpecified && file.trackerKind !== "linear")) {
    configError =
      'Paws uses Linear for issue tracking. Set [tracker] kind = "linear", remove [tracker.github], and connect Linear through the Paws website. Keep your existing database as an archive and use a new --home if it contains GitHub issue work.';
  }
  const linearMode = resolveMode(file, source, configured, configError);
  const secrets = readLinearSecrets(env.home, file, linearMode);
  const apiFromEnv = optional(source, "LINEAR_API_KEY");
  const accessFromEnv = optional(source, "LINEAR_ACCESS_TOKEN");
  const linearApiKey =
    linearMode === "comments" ? (apiFromEnv ?? accessFromEnv ?? secrets.apiKey) : null;
  const linearAccessToken =
    linearMode === "agent-session" ? (accessFromEnv ?? secrets.accessToken) : null;
  const githubAuth = resolveGitHubAuth(file, source, configured);

  return {
    env,
    file,
    configured,
    configError,
    linearMode,
    linearTeam: optional(source, "LINEAR_TEAM") ?? file.linearTeam,
    linearTeamId: optional(source, "LINEAR_TEAM_ID") ?? file.linearTeamId,
    linearViewerId:
      optional(source, "LINEAR_APP_USER_ID") ??
      optional(source, "LINEAR_VIEWER_ID") ??
      file.linearViewerId,
    linearApiKey,
    linearAccessToken,
    linearRefreshToken: optional(source, "LINEAR_REFRESH_TOKEN") ?? secrets.refreshToken,
    linearClientId: optional(source, "LINEAR_CLIENT_ID") ?? secrets.clientId,
    linearClientSecret: optional(source, "LINEAR_CLIENT_SECRET") ?? secrets.clientSecret,
    githubAuth,
    oauthClientId: resolveOAuthClientId(file, source, githubAuth) ?? app?.clientId ?? null,
    trackerKind: "linear",
    repo: optional(source, "PAWS_GITHUB_REPOSITORY") ?? file.repo ?? env.githubRepository,
    publicUrl: optional(source, "PAWS_PUBLIC_URL") ?? file.publicUrl,
    checkout: optional(source, "PAWS_CHECKOUT") ?? file.checkout,
    maxTurns: positiveInt(optional(source, "PAWS_MAX_TURNS")) ?? file.maxTurns ?? DEFAULT_MAX_TURNS,
    maxAwakeMs:
      positiveInt(optional(source, "PAWS_MAX_AWAKE_MS")) ?? file.maxAwakeMs ?? DEFAULT_MAX_AWAKE_MS,
    webhooks: resolveWebhooks(file, source),
  };
}

function resolveMode(
  file: PawsConfigFile,
  source: EnvSource,
  configured: boolean,
  configError: string | null,
): LinearConfigMode {
  if (configError !== null) return "comments";
  const flagged = optional(source, "LINEAR_MODE") ?? optional(source, "PAWS_LINEAR_MODE");
  if (flagged === "comments") return "comments";
  if (flagged === "agent" || flagged === "agent-session") return "agent-session";
  if (file.linearMode !== null) return file.linearMode;
  if (source.PAWS_PUBLIC_DASHBOARD === "1") return "agent-session";
  if (
    !configured &&
    optional(source, "LINEAR_CLIENT_ID") &&
    optional(source, "LINEAR_ACCESS_TOKEN")
  ) {
    return "agent-session";
  }
  return "comments";
}

function resolveGitHubAuth(
  file: PawsConfigFile,
  source: EnvSource,
  configured: boolean,
): GitHubConfigAuth {
  const flagged = optional(source, "GITHUB_AUTH") ?? optional(source, "PAWS_GITHUB_AUTH");
  if (flagged === "oauth" || flagged === "gh" || flagged === "app") return flagged;
  if (file.githubAuth !== null) return file.githubAuth;
  if (
    !configured &&
    optional(source, "GITHUB_APP_ID") &&
    optional(source, "GITHUB_APP_INSTALLATION_ID") &&
    optional(source, "GITHUB_APP_PRIVATE_KEY_PATH")
  ) {
    return "app";
  }
  // An existing file that omits github.auth is an old config and stays on gh.
  // A missing file also stays on gh so the process keeps the gh CLI path.
  // New configs written by setup set auth = "oauth" explicitly.
  return "gh";
}

function resolveOAuthClientId(
  file: PawsConfigFile,
  source: EnvSource,
  auth: GitHubConfigAuth,
): string | null {
  const fromEnv = optional(source, "PAWS_GITHUB_CLIENT_ID");
  if (fromEnv !== null) return fromEnv;
  if (file.oauthClientId !== null) return file.oauthClientId;
  if (auth === "oauth") return PAWS_GITHUB_OAUTH_CLIENT_ID;
  return null;
}

function resolveWebhooks(file: PawsConfigFile, source: EnvSource): boolean {
  const flagged = optional(source, "LINEAR_WEBHOOKS");
  if (flagged === "1" || flagged === "true") return true;
  if (flagged === "0" || flagged === "false") return false;
  return file.webhooks === true;
}

type LinearSecrets = {
  apiKey: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  clientId: string | null;
  clientSecret: string | null;
};

function readLinearSecrets(
  home: string,
  file: PawsConfigFile,
  mode: LinearConfigMode,
): LinearSecrets {
  const secret = readText(home, file.linearSecret);
  const client = readJson(home, file.linearClientFile ?? "secrets/linear-client.json");
  if (mode === "comments") {
    return {
      apiKey: secret,
      accessToken: null,
      refreshToken: null,
      clientId: null,
      clientSecret: null,
    };
  }
  const oauth = readJson(home, file.linearSecret ?? "secrets/linear-oauth.json");
  return {
    apiKey: null,
    accessToken: jsonString(oauth, "accessToken"),
    refreshToken: jsonString(oauth, "refreshToken"),
    clientId: jsonString(client, "clientId"),
    clientSecret: jsonString(client, "clientSecret"),
  };
}

function readText(home: string, relative: string | null): string | null {
  const path = secretPath(home, relative);
  if (path === null || !existsSync(path)) return null;
  const text = readSecretFile(path)!.trim();
  return text.length > 0 ? text : null;
}

function readJson(home: string, relative: string | null): Record<string, unknown> | null {
  const text = readText(home, relative);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function secretPath(home: string, relative: string | null): string | null {
  if (relative === null || relative.trim().length === 0) return null;
  const trimmed = relative.trim();
  return isAbsolute(trimmed) ? trimmed : join(home, trimmed);
}

function jsonString(record: Record<string, unknown> | null, key: string): string | null {
  if (record === null) return null;
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optional(source: EnvSource, key: string): string | null {
  const value = source[key];
  if (value === undefined || value.trim().length === 0) return null;
  return value.trim();
}

function positiveInt(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
  return parsed;
}
