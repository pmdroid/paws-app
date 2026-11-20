import { journalCaught } from "../journal";
import { readSecretFile, secretFileExists } from "../credentials";
import { join } from "node:path";
import { DEFAULT_MAX_AWAKE_MS } from "../core";
import { loadEnv, type EnvSource, type PawsEnv } from "./env";
import {
  emptyConfigFile,
  loadConfigFile,
  type GitHubConfigAuth,
  type PawsConfigFile,
} from "./file";
import { pawsPaths } from "./paths";
import { loadGitHubAppCredentials } from "./github-app";
import { checkDatabaseUrl } from "./database";
import { parseRepositoryList } from "./repositories";

export const LINEAR_WORKSPACE_REQUIRED =
  "Paws needs a Linear workspace. Set PAWS_PUBLIC_DASHBOARD=1 with PAWS_PUBLIC_URL and the Linear app OAuth client, restart Paws, then sign in to the dashboard as a Linear workspace admin (docs/workspace-access.md).";

export type PawsRole = "all" | "web" | "worker";

const PAWS_ROLES: readonly PawsRole[] = ["all", "web", "worker"];

export type RuntimeConfig = {
  env: PawsEnv;
  role: PawsRole;
  file: PawsConfigFile;
  configError: string | null;
  linearTeam: string | null;
  linearTeamId: string | null;
  linearViewerId: string | null;
  /** `LINEAR_ACCESS_TOKEN`, stored once when no token is in the database. Not logged. */
  linearAccessToken: string | null;
  linearRefreshToken: string | null;
  /** Token file an older install wrote; startup imports it once. */
  linearTokenFile: string;
  linearClientId: string | null;
  linearClientSecret: string | null;
  linearOrganizationId: string | null;
  githubAuth: GitHubConfigAuth;
  trackerKind: "linear";
  /** `PAWS_GITHUB_REPOS`. Workspaces choose theirs in the dashboard. */
  repos: string[];
  publicUrl: string | null;
  maxAwakeMs: number;
  webhooks: boolean;
  databaseUrl: string | null;
};

export function startupSettings(source: EnvSource = process.env) {
  const env = loadEnv(source);
  const url = optional(source, "PAWS_DATABASE_URL");
  return {
    env,
    publicUrl: env.publicUrl ?? null,
    databaseUrl: url === null ? null : checkDatabaseUrl(url, "PAWS_DATABASE_URL"),
  };
}

export function databaseUrlOf(source: EnvSource = process.env): string | null {
  return startupSettings(source).databaseUrl;
}

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
  let file = emptyConfigFile();
  let configError: string | null = null;
  try {
    file = loadConfigFile(configPath);
  } catch (error) {
    journalCaught(error, "runtime.loadRuntime.loadConfigFile", null);
    configError = error instanceof Error ? error.message : "config.toml could not be parsed";
  }

  let databaseUrl: string | null = null;
  const databaseEnv = optional(source, "PAWS_DATABASE_URL");
  if (databaseEnv !== null) {
    try {
      databaseUrl = checkDatabaseUrl(databaseEnv, "PAWS_DATABASE_URL");
    } catch (error) {
      configError ??= (error as Error).message;
    }
  }
  let repos: string[] = [];
  const reposEnv = optional(source, "PAWS_GITHUB_REPOS");
  if (reposEnv !== null) {
    try {
      repos = parseRepositoryList(reposEnv);
    } catch (error) {
      configError ??= `PAWS_GITHUB_REPOS: ${(error as Error).message}`;
    }
  }
  const secrets = readLinearClient(env.home);
  const githubAuth: GitHubConfigAuth = "app";

  return {
    env,
    role: readRole(optional(source, "PAWS_ROLE")),
    file,
    configError,
    linearTeam: optional(source, "LINEAR_TEAM"),
    linearTeamId: optional(source, "LINEAR_TEAM_ID"),
    linearViewerId: optional(source, "LINEAR_APP_USER_ID") ?? optional(source, "LINEAR_VIEWER_ID"),
    linearAccessToken: optional(source, "LINEAR_ACCESS_TOKEN"),
    linearRefreshToken: optional(source, "LINEAR_REFRESH_TOKEN"),
    linearTokenFile: join(env.home, "secrets/linear-oauth.json"),
    linearClientId: optional(source, "LINEAR_CLIENT_ID") ?? secrets.clientId,
    linearClientSecret: optional(source, "LINEAR_CLIENT_SECRET") ?? secrets.clientSecret,
    linearOrganizationId: optional(source, "LINEAR_ORGANIZATION_ID"),
    githubAuth,
    trackerKind: "linear",
    repos,
    publicUrl: optional(source, "PAWS_PUBLIC_URL"),
    maxAwakeMs: maxAwakeMsFrom(source),
    webhooks: resolveWebhooks(source),
    databaseUrl,
  };
}

export function maxAwakeMsFrom(source: EnvSource = process.env): number {
  return positiveInt(optional(source, "PAWS_MAX_AWAKE_MS")) ?? DEFAULT_MAX_AWAKE_MS;
}

function readRole(value: string | null): PawsRole {
  if (value === null) return "all";
  const role = PAWS_ROLES.find((known) => known === value);
  if (role === undefined)
    throw new Error(`PAWS_ROLE must be one of ${PAWS_ROLES.join(", ")}, got ${value}`);
  return role;
}

function resolveWebhooks(source: EnvSource): boolean {
  const flagged = optional(source, "LINEAR_WEBHOOKS");
  return flagged === "1" || flagged === "true";
}

function readLinearClient(home: string): { clientId: string | null; clientSecret: string | null } {
  const client = readJson(join(home, "secrets/linear-client.json"));
  return {
    clientId: jsonString(client, "clientId"),
    clientSecret: jsonString(client, "clientSecret"),
  };
}

function readText(path: string): string | null {
  if (!secretFileExists(path)) return null;
  const text = readSecretFile(path)!.trim();
  return text.length > 0 ? text : null;
}

function readJson(path: string): Record<string, unknown> | null {
  const text = readText(path);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch (caughtError1) {
    journalCaught(caughtError1, "runtime.readJson.parse", null);
    return null;
  }
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
