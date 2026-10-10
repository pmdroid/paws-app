import { createGitHubApp, mintInstallationToken } from "../token";
import { GitHubTokenError, type GitHubClient } from "../types";
import { createGhCliAuth, type GhCliOptions } from "./gh";
import { createOAuthGitAuth } from "./oauth";
import type { GitHubAuthMode, GitHubTokenProvider, TokenPurpose } from "./types";

export type AppTokenProviderOptions = {
  client: GitHubClient;
  appId: string;
  installationId: string;
  privateKeyPem: string;
  owner: string;
  repo: string;
  now?: () => Date;
};

export type GitHubAuthConfig = {
  /** `github.auth`. Omitted or empty selects `"gh"`. */
  auth?: string | null;
};

/**
 * `github.auth = "app"` selects the GitHub App.
 * `oauth` selects the signed-in user token.
 * Omitted or empty stays `"gh"` so old configs keep the developer login.
 */
export function githubAuthMode(config?: GitHubAuthConfig | null): GitHubAuthMode {
  const auth = config?.auth;
  if (auth === undefined || auth === null || auth === "" || auth === "gh") return "gh";
  if (auth === "app") return "app";
  if (auth === "oauth") return "oauth";
  throw new Error(`github.auth must be "gh", "app", or "oauth", got ${auth}`);
}

/** Installation token via the existing GitHub App mint path. One token per call. */
export function createAppTokenProvider(options: AppTokenProviderOptions): GitHubTokenProvider {
  const app = createGitHubApp({
    client: options.client,
    appId: options.appId,
    privateKeyPem: options.privateKeyPem,
    ...(options.now ? { now: options.now } : {}),
  });
  const repository = `${options.owner}/${options.repo}`;
  return {
    mode: "app",
    async tokenFor(): Promise<string> {
      const minted = await app.mintInstallationToken({
        installationId: options.installationId,
        repository,
      });
      return minted.token;
    },
  };
}

/**
 * Select the token provider from `github.auth`.
 * `"app"` keeps the GitHub App mint. The default is `gh auth token`.
 */
export function createTokenProvider(
  config: GitHubAuthConfig | null | undefined,
  options: {
    gh?: GhCliOptions;
    app?: AppTokenProviderOptions;
    oauth?: { owner: string; repo: string; token: () => Promise<string> };
  },
): GitHubTokenProvider {
  const mode = githubAuthMode(config);
  if (mode === "app") {
    if (!options.app) {
      throw new Error('github.auth is "app" but GitHub App credentials were not provided');
    }
    return createAppTokenProvider(options.app);
  }
  if (mode === "oauth") {
    if (!options.oauth) {
      throw new Error('github.auth is "oauth" but an OAuth token source was not provided');
    }
    return createOAuthGitAuth(options.oauth);
  }
  if (!options.gh) {
    throw new Error('github.auth is "gh" but gh CLI options were not provided');
  }
  return createGhCliAuth(options.gh);
}

export async function acquireOperationToken(
  input: {
    tokenProvider?: GitHubTokenProvider | undefined;
    client?: GitHubClient | undefined;
    appId?: string | undefined;
    installationId?: string | undefined;
    privateKeyPem?: string | undefined;
    owner: string;
    repo: string;
    now?: Date | undefined;
  },
  purpose: TokenPurpose,
): Promise<string> {
  if (input.tokenProvider) return input.tokenProvider.tokenFor(purpose);
  if (
    input.client === undefined ||
    input.appId === undefined ||
    input.installationId === undefined ||
    input.privateKeyPem === undefined
  ) {
    throw new GitHubTokenError("GitHub App credentials are required");
  }
  const minted = await mintInstallationToken({
    client: input.client,
    appId: input.appId,
    installationId: input.installationId,
    privateKeyPem: input.privateKeyPem,
    owner: input.owner,
    repo: input.repo,
    ...(input.now ? { now: input.now } : {}),
  });
  return minted.token;
}
