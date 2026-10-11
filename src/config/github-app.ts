import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
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
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const privateKeyPath = join(dir, "github-app.pem");
  writePrivateFile(privateKeyPath, readFileSync(app.privateKeyPath, "utf8"));
  writePrivateFile(join(dir, "github-app.json"), `${JSON.stringify({ ...app, privateKeyPath })}\n`);
}

function writePrivateFile(path: string, value: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, value, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}
