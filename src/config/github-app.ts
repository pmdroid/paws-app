import { readSecretFile, saveSecret, secretFileExists } from "../credentials";
import { createPrivateKey } from "node:crypto";
import { join } from "node:path";
import type { EnvSource } from "./env";
import { envSetting, settingSources } from "./env-settings";
import { pawsPaths } from "./paths";

export type GitHubAppCredentials = {
  appId: string;
  clientId: string;
  clientSecret: string;
  privateKeyPem: string | null;
  installationId: string | null;
  webhookSecret: string | null;
};

const APP_RECORD = "github-browser-app.json";

function readRecord(path: string, label: string): Record<string, unknown> | null {
  if (!secretFileExists(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readSecretFile(path, false)!);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`Could not read secrets/${label}. Save the GitHub App again in Settings.`);
  }
}

function readSavedGitHubApp(home: string): Record<string, unknown> {
  return readRecord(join(pawsPaths(home).secretsDir, APP_RECORD), APP_RECORD) ?? {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function usableKey(pem: string | null): string | null {
  if (pem === null) return null;
  try {
    createPrivateKey(pem);
    return pem;
  } catch {
    return null;
  }
}

function privateKey(env: EnvSource, saved: Record<string, unknown>): string | null {
  const path = envSetting(env, "github", "privateKeyPath");
  if (path === undefined) return usableKey(text(saved.privateKeyPem));
  try {
    return usableKey(text(readSecretFile(path, false)));
  } catch {
    return null;
  }
}

export function gitHubAppSources(home: string, env: EnvSource) {
  const saved = readSavedGitHubApp(home);
  return settingSources(env, "github", { ...saved, privateKeyPath: saved.privateKeyPem });
}

export function gitHubWebhookSecret(home: string, env: EnvSource): string | null {
  return (
    envSetting(env, "github", "webhookSecret") ??
    text(readSavedGitHubApp(home).webhookSecret) ??
    null
  );
}

export function loadGitHubAppCredentials(
  home: string,
  env: EnvSource,
): GitHubAppCredentials | null {
  const saved = readSavedGitHubApp(home);
  const field = (name: "appId" | "clientId" | "clientSecret") =>
    text(envSetting(env, "github", name)) ?? text(saved[name]);
  const appId = field("appId");
  const clientId = field("clientId");
  const clientSecret = field("clientSecret");
  const keyConfigured =
    envSetting(env, "github", "privateKeyPath") !== undefined || text(saved.privateKeyPem) !== null;
  if (appId === null || clientId === null || clientSecret === null || !keyConfigured) return null;
  return {
    appId,
    clientId,
    clientSecret,
    privateKeyPem: privateKey(env, saved),
    installationId: env.GITHUB_APP_INSTALLATION_ID ?? text(saved.installationId),
    webhookSecret: gitHubWebhookSecret(home, env),
  };
}

export async function saveGitHubWebhookSecret(home: string, webhookSecret: string) {
  await saveSecret(
    join(pawsPaths(home).secretsDir, APP_RECORD),
    JSON.stringify({ ...readSavedGitHubApp(home), webhookSecret }),
  );
}

export async function importLegacyGitHubApp(home: string, env: EnvSource): Promise<void> {
  const dir = pawsPaths(home).secretsDir;
  if (secretFileExists(join(dir, APP_RECORD))) return;
  const legacy = readRecord(join(dir, "github-app.json"), "github-app.json");
  const webhookSecret = text(readSecretFile(join(dir, "github-webhook"), false)?.trim());
  if (legacy === null && (webhookSecret === null || !loadGitHubAppCredentials(home, env))) return;
  const keyPath = text(legacy?.privateKeyPath);
  let privateKeyPem = text(legacy?.privateKeyPem);
  try {
    privateKeyPem ??= keyPath === null ? null : text(readSecretFile(keyPath, false));
  } catch {
    privateKeyPem = null;
  }
  const { privateKeyPath: _, ...record } = legacy ?? {};
  await saveSecret(
    join(dir, APP_RECORD),
    JSON.stringify({
      ...record,
      ...(privateKeyPem === null ? {} : { privateKeyPem }),
      ...(text(record.webhookSecret) || webhookSecret === null ? {} : { webhookSecret }),
    }),
  );
}
