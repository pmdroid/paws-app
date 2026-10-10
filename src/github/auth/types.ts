import type { GitHubClient } from "../types";

/** One GitHub operation. Each call fetches a new token; nothing is cached. */
export type TokenPurpose = "push" | "pr" | "merge";

/**
 * `github.auth` in config.
 * Omitted still selects `gh` here so existing callers keep the developer login.
 * New configs set `oauth` explicitly. `src/auth` is the selector those configs use.
 */
export type GitHubAuthMode = "gh" | "app" | "oauth";

/**
 * Supplies a token for one push, pull request, or merge.
 * Implementations must not store the token or copy it into an agent environment.
 */
export interface GitHubTokenProvider {
  readonly mode: GitHubAuthMode;
  tokenFor(purpose: TokenPurpose): Promise<string>;
}

export type DoctorCheck = {
  name: string;
  ok: boolean;
  message: string;
};

export class GhAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GhAuthError";
  }
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

/** A selected token provider. App fields are unused for `gh` mode. */
export type ProviderCredentialInput = {
  tokenProvider: GitHubTokenProvider;
  appId?: string;
  installationId?: string;
  privateKeyPem?: string;
  client?: GitHubClient;
  now?: Date;
};

export type GitHubCredentialInput = AppCredentialInput | ProviderCredentialInput;
