import type { GitHubClient } from "../types";

/** One GitHub operation. Each call fetches a new token; nothing is cached. */
export type TokenPurpose = "push" | "pr" | "merge";

/** `github.auth` in config. The default is the developer's `gh` login. */
export type GitHubAuthMode = "gh" | "app";

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
