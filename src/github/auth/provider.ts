import { createGitHubApp, mintInstallationToken } from "../token";
import { GitHubTokenError, type GitHubClient } from "../types";
import type { GitHubTokenProvider, TokenPurpose } from "./types";

export type AppTokenProviderOptions = {
  access?: "read" | "write";
  client: GitHubClient;
  appId: string;
  installationId: string;
  privateKeyPem: string;
  owner: string;
  repo: string;
  now?: () => Date;
};

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
        ...(options.access ? { access: options.access } : {}),
      });
      return minted.token;
    },
  };
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
