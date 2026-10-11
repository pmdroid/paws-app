import { existsSync } from "node:fs";
import { readSecretFile, writeSecretFile } from "../credentials";
import { join } from "node:path";
import type { EnvSource } from "./env";
import { pawsPaths } from "./paths";

export type GitHubAppCredentials = {
  appId: string;
  clientId: string;
  clientSecret: string;
  privateKeyPath: string;
  installationId: string | null;
};

export function loadGitHubAppCredentials(
  home: string,
  env: EnvSource,
): GitHubAppCredentials | null {
  const path = join(pawsPaths(home).secretsDir, "github-app.json");
  let saved: Partial<GitHubAppCredentials> = {};
  if (existsSync(path)) {
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
  const appId = env.GITHUB_APP_ID ?? saved.appId;
  const clientId = env.PAWS_GITHUB_CLIENT_ID ?? saved.clientId;
  const clientSecret = env.PAWS_GITHUB_CLIENT_SECRET ?? saved.clientSecret;
  const privateKeyPath = env.GITHUB_APP_PRIVATE_KEY_PATH ?? saved.privateKeyPath;
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
    appId,
    clientId,
    clientSecret,
    privateKeyPath,
    installationId: env.GITHUB_APP_INSTALLATION_ID ?? saved.installationId ?? null,
  };
}

export function saveGitHubAppCredentials(home: string, app: GitHubAppCredentials): void {
  const dir = pawsPaths(home).secretsDir;
  const privateKeyPath = join(dir, "github-app.pem");
  writeSecretFile(privateKeyPath, readSecretFile(app.privateKeyPath, false)!);
  writeSecretFile(join(dir, "github-app.json"), `${JSON.stringify({ ...app, privateKeyPath })}\n`);
}
