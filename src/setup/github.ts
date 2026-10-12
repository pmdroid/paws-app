import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { mirrorPath } from "../acp";
import {
  createTokenStore,
  createGitHubTokenProvider,
  GITHUB_REAUTH_MESSAGE,
  loginGitHub,
  MISSING_GITHUB_CLIENT_ID_MESSAGE,
  missingGitHubClientId,
  resolveGitHubOAuthClientId,
  SecretServiceUnavailableError,
  type StoredGitHubOAuth,
  type GitHubTokenStore,
} from "../auth";
import { loadConfigFile, loadRuntime, pawsPaths } from "../config";
import { readSecretFile } from "../credentials";
import { runGitHubGit } from "../github";
import type { SetupFetch, SetupGitHubHooks, SetupIO } from "./io";
import { stop } from "./stop";

const NAME = /^[A-Za-z0-9._-]+$/;
const REPOS_PATH =
  "/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100";

/** Client id setup will send. Env wins, then `github.oauth_client_id` in config.toml. */
export function resolveSetupGitHubClientId(home: string, env: NodeJS.ProcessEnv): string {
  return resolveGitHubOAuthClientId({
    env: env.PAWS_GITHUB_CLIENT_ID,
    configured: loadConfigFile(pawsPaths(home).configFile).oauthClientId,
  });
}

export async function ensureGitHubSignIn(input: {
  yes: boolean;
  home: string;
  env: NodeJS.ProcessEnv;
  io: SetupIO;
  secrets: string[];
  oauthClientId?: string | null;
  app?: boolean;
  repo?: string | null;
}): Promise<{ login: string; id: number; token: string }> {
  const store = tokenStore(input.home, input.io.github);
  let existing: StoredGitHubOAuth | null;
  try {
    existing = await store.load();
  } catch (error) {
    if (!(error instanceof SecretServiceUnavailableError) || input.yes) throw error;
    input.io.stdout(error.message);
    existing = null;
  }
  const runtime = input.app ? loadRuntime({ ...input.env, PAWS_HOME: input.home }) : null;
  if (
    existing !== null &&
    !existing.invalid &&
    (!input.app || existing.appId === runtime?.env.githubAppId)
  ) {
    remember(input.secrets, existing.accessToken);
    if (input.app) return appSignIn(input, existing);
    return { login: existing.login, id: existing.id, token: existing.accessToken };
  }
  const clientId = resolveGitHubOAuthClientId({
    env: input.env.PAWS_GITHUB_CLIENT_ID,
    configured: input.oauthClientId,
  });
  if (missingGitHubClientId(clientId)) stop(MISSING_GITHUB_CLIENT_ID_MESSAGE);
  if (input.yes) stop(GITHUB_REAUTH_MESSAGE);
  const fetchImpl = input.io.fetch;
  const user = await loginGitHub({
    ...(input.app ? { auth: "app", repo: input.repo ?? runtime?.repo } : {}),
    home: input.home,
    env: input.env,
    oauthClientId: clientId,
    store,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
    stdout: (line) => input.io.stdout(line),
    ...(input.io.github?.sleep ? { sleep: input.io.github.sleep } : {}),
    ...(input.io.github?.openBrowser ? { openBrowser: input.io.github.openBrowser } : {}),
    ...(input.io.github?.now ? { now: input.io.github.now } : {}),
    ...(input.io.github?.port !== undefined ? { port: input.io.github.port } : {}),
    ...(input.io.github?.timeoutMs !== undefined ? { timeoutMs: input.io.github.timeoutMs } : {}),
  });
  const saved = await store.load();
  if (saved === null || saved.invalid) stop(GITHUB_REAUTH_MESSAGE);
  remember(input.secrets, saved.accessToken);
  if (input.app) return appSignIn(input, saved);
  return { login: user.login, id: user.id, token: saved.accessToken };
}

async function appSignIn(
  input: {
    home: string;
    env: NodeJS.ProcessEnv;
    repo?: string | null;
    io: SetupIO;
    secrets: string[];
  },
  signedIn: StoredGitHubOAuth,
): Promise<{ login: string; id: number; token: string }> {
  const runtime = loadRuntime({ ...input.env, PAWS_HOME: input.home });
  const env = runtime.env;
  const token = await createGitHubTokenProvider({
    auth: "app",
    repo: input.repo ?? runtime.repo,
    appId: env.githubAppId,
    installationId: env.githubAppInstallationId,
    privateKeyPem: env.githubAppPrivateKeyPath
      ? readSecretFile(env.githubAppPrivateKeyPath, false)
      : null,
    ...(input.io.fetch ? { fetch: input.io.fetch } : {}),
  }).token();
  remember(input.secrets, token);
  return { login: signedIn.login, id: signedIn.id, token };
}

export async function chooseGitHubRepo(input: {
  token: string;
  repo: string | null;
  yes: boolean;
  io: SetupIO;
  store: GitHubTokenStore;
}): Promise<{ owner: string; repo: string }> {
  if (input.repo !== null && input.repo.trim().length > 0) {
    const selected = splitRepo(input.repo.trim());
    await assertPush(input.token, selected, input.io.fetch, input.store);
    return selected;
  }
  if (input.yes) stop("Pass --repo owner/name.");
  const fetchImpl = input.io.fetch ?? fetch;
  const repos = await listPushRepos(input.token, fetchImpl, input.store);
  input.io.stdout("Filter repositories (empty keeps the newest 30):");
  const filter = (await input.io.readLine())?.trim().toLowerCase() ?? "";
  const shown = repos.filter((repo) => repo.fullName.toLowerCase().includes(filter)).slice(0, 30);
  if (shown.length === 0) {
    stop("No GitHub repository with push access matched. Pass --repo owner/name.");
  }
  input.io.stdout("Repositories you can push to:");
  shown.forEach((repo, index) => {
    input.io.stdout(`  ${index + 1}) ${repo.fullName}`);
  });
  input.io.stdout("Choose a repository (number or owner/name):");
  const choice = (await input.io.readLine())?.trim() ?? "";
  return matchChoice(choice, shown);
}

export async function cloneGitHubMirror(input: {
  home: string;
  owner: string;
  repo: string;
  token: string;
  env: NodeJS.ProcessEnv;
}): Promise<string> {
  const dest = mirrorPath(input.home, input.owner, input.repo);
  await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
  const remoteUrl = `https://github.com/${input.owner}/${input.repo}.git`;
  const operation = existsSync(dest) ? "fetch" : "clone";
  try {
    await runGitHubGit({
      operation,
      remoteUrl,
      token: input.token,
      cwd: dirname(dest),
      dest,
      env: input.env,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "git failed";
    stop(
      `Could not create the bare mirror of ${input.owner}/${input.repo}. ${message}`.replace(
        input.token,
        "[redacted]",
      ),
    );
  }
  return dest;
}

export function tokenStore(home: string, hooks: SetupGitHubHooks | undefined): GitHubTokenStore {
  return hooks?.store ?? createTokenStore({ home });
}

async function listPushRepos(
  token: string,
  fetchImpl: SetupFetch,
  store: GitHubTokenStore,
): Promise<{ fullName: string }[]> {
  const found: { fullName: string }[] = [];
  let url: string | null = `https://api.github.com${REPOS_PATH}`;
  for (let page = 0; url !== null && page < 20; page += 1) {
    const response = await fetchImpl(url, { headers: githubHeaders(token) });
    if (response.status === 401) {
      await store.markInvalid();
      stop(GITHUB_REAUTH_MESSAGE);
    }
    if (!response.ok) stop(`Could not list GitHub repositories (status ${response.status}).`);
    const body: unknown = await response.json();
    if (!Array.isArray(body)) stop("GitHub repository list was not a list.");
    for (const item of body) {
      if (!isRecord(item) || typeof item.full_name !== "string") continue;
      const permissions = isRecord(item.permissions) ? item.permissions : null;
      if (permissions?.push !== true) continue;
      found.push({ fullName: item.full_name });
    }
    url = nextPage(response.headers.get("link"));
  }
  return found;
}

async function assertPush(
  token: string,
  repo: { owner: string; repo: string },
  fetchImpl: SetupFetch | undefined,
  store: GitHubTokenStore,
): Promise<void> {
  const response = await (fetchImpl ?? fetch)(
    `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`,
    { headers: githubHeaders(token) },
  );
  if (response.status === 401) {
    await store.markInvalid();
    stop(GITHUB_REAUTH_MESSAGE);
  }
  if (!response.ok) {
    stop(`Could not read ${repo.owner}/${repo.repo} (GitHub status ${response.status}).`);
  }
  const body: unknown = await response.json();
  const permissions = isRecord(body) && isRecord(body.permissions) ? body.permissions : null;
  if (permissions?.push !== true) {
    stop(`The signed-in user cannot push to ${repo.owner}/${repo.repo}.`);
  }
}

function matchChoice(
  choice: string,
  shown: readonly { fullName: string }[],
): {
  owner: string;
  repo: string;
} {
  if (choice.length === 0) stop("Pass --repo owner/name.");
  const asNumber = Number(choice);
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= shown.length) {
    const selected = shown[asNumber - 1];
    if (selected === undefined) stop("Pass --repo owner/name.");
    return splitRepo(selected.fullName);
  }
  const named = shown.find((repo) => repo.fullName.toLowerCase() === choice.toLowerCase());
  if (named === undefined)
    stop(`Pass --repo as one of: ${shown.map((repo) => repo.fullName).join(", ")}.`);
  return splitRepo(named.fullName);
}

function splitRepo(value: string): { owner: string; repo: string } {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash !== value.lastIndexOf("/")) stop("Pass --repo as owner/name.");
  const owner = value.slice(0, slash);
  const repo = value.slice(slash + 1).replace(/\.git$/, "");
  if (!NAME.test(owner) || !NAME.test(repo)) stop("Pass --repo as owner/name.");
  return { owner, repo };
}

function nextPage(header: string | null): string | null {
  if (header === null) return null;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>;\s*rel="?next"?/.exec(part.trim());
    const link = match?.[1];
    if (link === undefined) continue;
    if (link.startsWith("https://") || link.startsWith("http://")) return link;
    if (link.startsWith("/")) return `https://api.github.com${link}`;
  }
  return null;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "paws",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function remember(secrets: string[], value: string): void {
  if (value.length >= 8 && !secrets.includes(value)) secrets.push(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
