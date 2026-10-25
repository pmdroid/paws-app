import type { AppBotIdentity } from "../core";
import { createAppTokenProvider, createFetchGitHubClient } from "../github";
import type { GitHubClient } from "../github";
import { gitHubAppBot } from "./github-app";

/** The only GitHub credential Paws uses. */
export type GitHubAuthSource = "app";

export type GitHubFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Shown when GitHub App credentials are missing. Names the setup document. */
export const MISSING_GITHUB_APP_MESSAGE =
  "GitHub App credentials are missing. Set GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID and GITHUB_APP_PRIVATE_KEY_PATH, or connect the App in Settings > Integrations. See docs/github-app.md.";

/**
 * GitHub App installation token provider. `token()` mints an installation token,
 * `user()` and `botIdentity()` read the App bot account.
 */
export type GitHubTokenProvider = {
  token(): Promise<string>;
  user(): Promise<{ login: string; id: number }>;
  readonly source: GitHubAuthSource;
  botIdentity?(): Promise<AppBotIdentity>;
};

export type GitHubTokenProviderConfig = {
  /** Resolved `github.auth`. Only `app` exists. */
  auth?: GitHubAuthSource | null;
  repo?: string | null;
  access?: "read" | "write";
  appId?: string | null;
  installationId?: string | null;
  privateKeyPem?: string | null;
  client?: GitHubClient;
  fetch?: GitHubFetch;
  now?: () => number;
};

export function createGitHubTokenProvider(config: GitHubTokenProviderConfig): GitHubTokenProvider {
  if (config.auth != null && config.auth !== "app")
    throw new Error(`github.auth must be "app". See docs/github-app.md.`);
  const { appId, installationId, privateKeyPem } = config;
  if (!appId || !installationId || !privateKeyPem) throw new Error(MISSING_GITHUB_APP_MESSAGE);
  const names = namesOf(config.repo);
  const client = config.client ?? createFetchGitHubClient(asFetch(config.fetch));
  const app = createAppTokenProvider({
    client,
    appId,
    installationId,
    privateKeyPem,
    owner: names.owner,
    repo: names.repo,
    ...(config.access ? { access: config.access } : {}),
    ...(config.now ? { now: () => new Date(config.now?.() ?? Date.now()) } : {}),
  });
  const resolveBot = async () =>
    gitHubAppBot({ client, appId, privateKeyPem, token: await app.tokenFor("pr") });
  return {
    source: "app",
    botIdentity: resolveBot,
    token: () => app.tokenFor("push"),
    user: async () => {
      const bot = await resolveBot();
      return { login: bot.login, id: bot.id };
    },
  };
}

function namesOf(repo: string | null | undefined): { owner: string; repo: string } {
  const value = repo?.trim() ?? "";
  const slash = value.indexOf("/");
  if (slash <= 0 || slash !== value.lastIndexOf("/")) {
    throw new Error("github.repo must be owner/name");
  }
  return { owner: value.slice(0, slash), repo: value.slice(slash + 1) };
}

function asFetch(
  fetchImpl: GitHubFetch | undefined,
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  const impl = fetchImpl ?? fetch;
  return (input, init) => impl(String(input), init);
}
