import type {
  GitHubApp,
  InstallationToken,
  MergePullRequest,
  MergeResult,
  MintTokenInput,
  OpenPullRequest,
  PullRequestRef,
  PullRequests,
} from "./app";

export type FakeGitHub = GitHubApp &
  PullRequests & {
    minted: MintTokenInput[];
    opened: OpenPullRequest[];
    merged: MergePullRequest[];
  };

export function createFakeGitHub(): FakeGitHub {
  const minted: MintTokenInput[] = [];
  const opened: OpenPullRequest[] = [];
  const merged: MergePullRequest[] = [];
  let nextNumber = 1;
  return {
    minted,
    opened,
    merged,
    async mintInstallationToken(input) {
      minted.push(input);
      const token: InstallationToken = {
        token: "fake-installation-token",
        expiresAt: Date.now() + 60 * 60 * 1000,
        repository: input.repository,
      };
      return token;
    },
    async open(input) {
      opened.push(input);
      const number = nextNumber;
      nextNumber += 1;
      const ref: PullRequestRef = {
        number,
        url: `https://github.com/${input.repository}/pull/${number}`,
      };
      return ref;
    },
    async merge(input) {
      merged.push(input);
      const result: MergeResult = { merged: true, sha: `fake-merge-${input.expectedHeadSha}` };
      return result;
    },
  };
}
