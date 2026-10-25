import type { GitHubClient } from "../types";

/** One GitHub operation. Each call fetches a new token; nothing is cached. */
export type TokenPurpose = "push" | "pr" | "merge";

/**
 * Where an operation token comes from. Paws mints `app` installation tokens.
 * `token` is an injected provider, used by tests and fixtures.
 */
export type GitHubAuthMode = "app" | "token";

/**
 * Supplies a token for one push, pull request, or merge.
 * Implementations must not store the token or copy it into an agent environment.
 */
export interface GitHubTokenProvider {
  readonly mode: GitHubAuthMode;
  tokenFor(purpose: TokenPurpose): Promise<string>;
}

/** App installation credentials. Used when `github.auth` is `"app"`. */
export type AppCredentialInput = {
  tokenProvider?: undefined;
  appId: string;
  installationId: string;
  privateKeyPem: string;
  client: GitHubClient;
  now?: Date;
};

/** A selected token provider. App fields are unused when it is set. */
export type ProviderCredentialInput = {
  tokenProvider: GitHubTokenProvider;
  appId?: string;
  installationId?: string;
  privateKeyPem?: string;
  client?: GitHubClient;
  now?: Date;
};

export type GitHubCredentialInput = AppCredentialInput | ProviderCredentialInput;
