import { createAppTokenProvider, createFetchGitHubClient, createGhCliAuth } from "../github";
import type { GitHubClient } from "../github";
import { fetchGitHubAccount, type DeviceFetch } from "./github-device";
import { refreshStoredToken, type LoginIO } from "./login";
import { GITHUB_REAUTH_MESSAGE } from "./messages";
import { createTokenStore, type GitHubTokenStore, type StoredGitHubOAuth } from "./store";
import { gitHubAppBot } from "./github-app";

export type GitHubAuthSource = "oauth" | "gh" | "app";

/**
 * Frozen token provider. `token()` is the signed-in user's credential.
 * `source` is `github.auth`.
 */
export type GitHubTokenProvider = {
  token(): Promise<string>;
  user(): Promise<{ login: string; id: number }>;
  readonly source: GitHubAuthSource;
};

export type GitHubTokenProviderConfig = {
  /** Resolved `github.auth`. Omitted selects `oauth`. */
  auth?: GitHubAuthSource | null;
  oauthClientId?: string | null;
  repo?: string | null;
  access?: "read" | "write";
  home?: string;
  env?: Record<string, string | undefined>;
  appId?: string | null;
  installationId?: string | null;
  privateKeyPem?: string | null;
  client?: GitHubClient;
  fetch?: DeviceFetch;
  store?: GitHubTokenStore;
  now?: () => number;
  gh?: {
    owner?: string;
    repo?: string;
    ghBin?: string;
    pathPrefix?: string;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
  };
};

const SKEW_MS = 60_000;

export function createGitHubTokenProvider(config: GitHubTokenProviderConfig): GitHubTokenProvider {
  const source = selectSource(config.auth);
  if (source === "gh") return ghProvider(config);
  if (source === "app") return appProvider(config);
  return oauthProvider(config);
}

export async function invalidateOnUnauthorized(
  store: GitHubTokenStore,
  status: number,
): Promise<void> {
  if (status !== 401) return;
  await store.markInvalid();
  throw new Error(GITHUB_REAUTH_MESSAGE);
}

function selectSource(auth: GitHubAuthSource | null | undefined): GitHubAuthSource {
  if (auth === undefined || auth === null || auth === "oauth") return "oauth";
  if (auth === "gh" || auth === "app") return auth;
  throw new Error(`github.auth must be oauth, gh, or app`);
}

function oauthProvider(config: GitHubTokenProviderConfig): GitHubTokenProvider {
  const store = config.store ?? createTokenStore({ home: homeOf(config) });
  const login: LoginIO = {
    home: homeOf(config),
    ...(config.env ? { env: config.env } : {}),
    oauthClientId: config.oauthClientId ?? null,
    ...(config.fetch ? { fetch: config.fetch } : {}),
    store,
    ...(config.now ? { now: config.now } : {}),
  };
  let refreshing: Promise<string> | null = null;
  return {
    source: "oauth",
    async token() {
      const stored = await store.load();
      if (stored === null || stored.invalid || stored.accessToken.length === 0) {
        throw new Error(GITHUB_REAUTH_MESSAGE);
      }
      if (!needsRefresh(stored, config.now ?? Date.now)) return stored.accessToken;
      if (refreshing === null) {
        refreshing = refreshStoredToken(login, stored)
          .then((next) => next.accessToken)
          .finally(() => {
            refreshing = null;
          });
      }
      return refreshing;
    },
    async user() {
      const token = await this.token();
      try {
        const account = await fetchGitHubAccount({ token, fetch: fetchOf(config) });
        return { login: account.login, id: account.id };
      } catch (error) {
        if (isReauth(error)) {
          await store.markInvalid();
          throw new Error(GITHUB_REAUTH_MESSAGE, { cause: error });
        }
        throw error;
      }
    },
  };
}

function ghProvider(config: GitHubTokenProviderConfig): GitHubTokenProvider {
  const names = namesOf(config);
  const gh = createGhCliAuth({
    owner: names.owner,
    repo: names.repo,
    ...(config.access ? { access: config.access } : {}),
    ...(config.gh?.ghBin ? { ghBin: config.gh.ghBin } : {}),
    ...(config.gh?.pathPrefix ? { pathPrefix: config.gh.pathPrefix } : {}),
    ...(config.gh?.env ? { env: config.gh.env } : {}),
    ...(config.gh?.cwd ? { cwd: config.gh.cwd } : {}),
  });
  return {
    source: "gh",
    token: () => gh.tokenFor("push"),
    user: async () => {
      const token = await gh.tokenFor("pr");
      const account = await fetchGitHubAccount({ token, fetch: fetchOf(config) });
      return { login: account.login, id: account.id };
    },
  };
}

function appProvider(config: GitHubTokenProviderConfig): GitHubTokenProvider {
  const names = namesOf(config);
  if (
    config.appId == null ||
    config.installationId == null ||
    config.privateKeyPem == null ||
    config.appId.length === 0 ||
    config.installationId.length === 0 ||
    config.privateKeyPem.length === 0
  ) {
    throw new Error('github.auth is "app" but GitHub App credentials were not provided');
  }
  const client = config.client ?? createFetchGitHubClient(asFetch(config.fetch));
  const app = createAppTokenProvider({
    client,
    appId: config.appId,
    installationId: config.installationId,
    privateKeyPem: config.privateKeyPem,
    owner: names.owner,
    repo: names.repo,
    ...(config.access ? { access: config.access } : {}),
    ...(config.now ? { now: () => new Date(config.now?.() ?? Date.now()) } : {}),
  });
  let bot: { login: string; id: number } | null = null;
  return {
    source: "app",
    token: () => app.tokenFor("push"),
    user: async () => {
      if (bot !== null) return bot;
      const token = await app.tokenFor("pr");
      bot = await gitHubAppBot({
        client,
        appId: config.appId!,
        privateKeyPem: config.privateKeyPem!,
        token,
      });
      return bot;
    },
  };
}

function needsRefresh(stored: StoredGitHubOAuth, now: () => number): boolean {
  if (stored.refreshToken === null || stored.expiresAtMs === null) return false;
  return now() >= stored.expiresAtMs - SKEW_MS;
}

function homeOf(config: GitHubTokenProviderConfig): string {
  if (config.home !== undefined && config.home.length > 0) return config.home;
  const fromEnv = config.env?.PAWS_HOME?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const processHome = process.env.PAWS_HOME?.trim();
  if (processHome !== undefined && processHome.length > 0) return processHome;
  return `${process.env.HOME ?? ""}/.paws`;
}

function namesOf(config: GitHubTokenProviderConfig): { owner: string; repo: string } {
  const owner = config.gh?.owner;
  const repo = config.gh?.repo;
  if (owner !== undefined && repo !== undefined) return { owner, repo };
  const value = config.repo?.trim() ?? "";
  const slash = value.indexOf("/");
  if (slash <= 0 || slash !== value.lastIndexOf("/")) {
    throw new Error("github.repo must be owner/name");
  }
  return { owner: value.slice(0, slash), repo: value.slice(slash + 1) };
}

function fetchOf(config: GitHubTokenProviderConfig): DeviceFetch {
  return config.fetch ?? ((input, init) => fetch(input, init));
}

function asFetch(
  fetchImpl: DeviceFetch | undefined,
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  const impl = fetchImpl ?? fetch;
  return (input, init) => impl(String(input), init);
}

function isReauth(error: unknown): boolean {
  return error instanceof Error && error.message === GITHUB_REAUTH_MESSAGE;
}
