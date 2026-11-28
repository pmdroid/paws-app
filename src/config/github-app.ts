import { readSecretFile, secretFileExists } from "../credentials";
import { join } from "node:path";
import type { EnvSource } from "./env";
import { envSetting, settingSources } from "./env-settings";
import { pawsPaths } from "./paths";

export type GitHubAppCredentials = {
  appId: string;
  clientId: string;
  clientSecret: string;
  privateKeyPath: string;
  installationId: string | null;
  privateKeyPem?: string;
  webhookSecret?: string;
};

function readSavedGitHubApp(home: string): Partial<GitHubAppCredentials> {
  const dir = pawsPaths(home).secretsDir;
  const browser = join(dir, "github-browser-app.json");
  const path = secretFileExists(browser) ? browser : join(dir, "github-app.json");
  let saved: Partial<GitHubAppCredentials> = {};
  if (secretFileExists(path)) {
    try {
      const parsed: unknown = JSON.parse(readSecretFile(path)!);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
      saved = parsed;
    } catch {
      throw new Error(
        "Could not read secrets/github-app.json. Restore a valid GitHub App credentials file.",
      );
    }
  }
  return saved;
}

export function gitHubAppSources(home: string, env: EnvSource) {
  return settingSources(env, "github", readSavedGitHubApp(home));
}

export function loadGitHubAppCredentials(
  home: string,
  env: EnvSource,
): GitHubAppCredentials | null {
  const saved = readSavedGitHubApp(home);
  const appId = envSetting(env, "github", "appId") ?? saved.appId;
  const clientId = envSetting(env, "github", "clientId") ?? saved.clientId;
  const clientSecret = envSetting(env, "github", "clientSecret") ?? saved.clientSecret;
  const privateKeyPath = envSetting(env, "github", "privateKeyPath") ?? saved.privateKeyPath;
  if (
    typeof appId !== "string" ||
    !appId.trim() ||
    typeof clientId !== "string" ||
    !clientId.trim() ||
    typeof clientSecret !== "string" ||
    !clientSecret.trim() ||
    typeof privateKeyPath !== "string" ||
    !privateKeyPath.trim()
  )
    return null;
  return {
    ...(envSetting(env, "github", "privateKeyPath") ? {} : { privateKeyPem: saved.privateKeyPem }),
    webhookSecret: envSetting(env, "github", "webhookSecret") ?? saved.webhookSecret,
    appId,
    clientId,
    clientSecret,
    privateKeyPath,
    installationId: env.GITHUB_APP_INSTALLATION_ID ?? saved.installationId ?? null,
  };
}
