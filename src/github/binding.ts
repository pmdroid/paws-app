import type { GitHubTokenProvider } from "./auth";
import type { GitHubClient } from "./types";

export type GitHubBinding = {
  appId: string;
  installationId: string;
  privateKeyPem: string;
  client: GitHubClient;
  tokenProvider?: GitHubTokenProvider;
};
