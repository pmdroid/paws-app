import { existsSync } from "node:fs";
import { readSecretFile } from "../credentials";
import { isAbsolute, join } from "node:path";
import { DEFAULT_MAX_AWAKE_MS, DEFAULT_MAX_TURNS } from "../core";
import { loadEnv, type EnvSource, type PawsEnv } from "./env";
import {
  emptyConfigFile,
  loadConfigFile,
  type GitHubConfigAuth,
  type PawsConfigFile,
} from "./file";
import { pawsPaths } from "./paths";
import { loadGitHubAppCredentials } from "./github-app";

export const LINEAR_WORKSPACE_REQUIRED =
  "Paws needs a Linear workspace. Set PAWS_PUBLIC_DASHBOARD=1 with PAWS_PUBLIC_URL and the Linear app OAuth client, restart Paws, then sign in to the dashboard as a Linear workspace admin (docs/workspace-access.md).";

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
  linearTeam: string | null;
  linearTeamId: string | null;
  linearViewerId: string | null;
  /** OAuth access token for agent-session mode. Not logged. */
  linearAccessToken: string | null;
  linearRefreshToken: string | null;
  linearClientId: string | null;
  linearClientSecret: string | null;
  githubAuth: GitHubConfigAuth;
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

  const secrets = readLinearSecrets(env.home, file);
  const linearAccessToken = optional(source, "LINEAR_ACCESS_TOKEN") ?? secrets.accessToken;
  const githubAuth: GitHubConfigAuth = "app";

  return {
    env,
    file,
    configured,
    configError,
    linearTeam: optional(source, "LINEAR_TEAM") ?? file.linearTeam,
    linearTeamId: optional(source, "LINEAR_TEAM_ID") ?? file.linearTeamId,
    linearViewerId:
      optional(source, "LINEAR_APP_USER_ID") ??
      optional(source, "LINEAR_VIEWER_ID") ??
      file.linearViewerId,
    linearAccessToken,
    linearRefreshToken: optional(source, "LINEAR_REFRESH_TOKEN") ?? secrets.refreshToken,
    linearClientId: optional(source, "LINEAR_CLIENT_ID") ?? secrets.clientId,
    linearClientSecret: optional(source, "LINEAR_CLIENT_SECRET") ?? secrets.clientSecret,
    githubAuth,
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

function resolveWebhooks(file: PawsConfigFile, source: EnvSource): boolean {
  const flagged = optional(source, "LINEAR_WEBHOOKS");
  if (flagged === "1" || flagged === "true") return true;
  if (flagged === "0" || flagged === "false") return false;
  return file.webhooks === true;
}

type LinearSecrets = {
  accessToken: string | null;
  refreshToken: string | null;
  clientId: string | null;
  clientSecret: string | null;
};

function readLinearSecrets(home: string, file: PawsConfigFile): LinearSecrets {
  const client = readJson(home, file.linearClientFile ?? "secrets/linear-client.json");
  const oauth = readJson(home, file.linearSecret ?? "secrets/linear-oauth.json");
  return {
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
