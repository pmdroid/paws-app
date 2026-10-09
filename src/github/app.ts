export type InstallationToken = {
  token: string;
  expiresAt: number;
  repository: string;
};

export type MintTokenInput = {
  installationId: string;
  repository: string;
};

/** Mints a short-lived installation token for one repo. The private key never enters the agent env. */
export interface GitHubApp {
  mintInstallationToken(input: MintTokenInput): Promise<InstallationToken>;
}

export type OpenPullRequest = {
  repository: string;
  head: string;
  base: string;
  title: string;
  body: string;
};

export type PullRequestRef = {
  number: number;
  url: string;
};

export type MergePullRequest = {
  repository: string;
  number: number;
  expectedHeadSha: string;
};

export type MergeResult = {
  merged: boolean;
  sha: string;
};

/** Opens and squash-merges PRs. `expectedHeadSha` is the fail-closed guard. */
export interface PullRequests {
  open(input: OpenPullRequest): Promise<PullRequestRef>;
  merge(input: MergePullRequest): Promise<MergeResult>;
}
