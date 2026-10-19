import { acquireOperationToken } from "./auth/provider";
import type { GitHubTokenProvider } from "./auth/types";
import { repoApiPath } from "./client";
import type { GitHubClient } from "./types";

export async function mergedPullHeads(input: {
  client: GitHubClient;
  owner: string;
  repo: string;
  branch: string;
  tokenProvider?: GitHubTokenProvider;
  appId?: string;
  installationId?: string;
  privateKeyPem?: string;
  signal?: AbortSignal;
}): Promise<string[]> {
  input.signal?.throwIfAborted();
  const token = await acquireOperationToken(input, "pr");
  const query = new URLSearchParams({
    state: "closed",
    head: `${input.owner}:${input.branch}`,
    base: "main",
    per_page: "100",
  });
  const listed = await input.client.request({
    method: "GET",
    path: repoApiPath(input.owner, input.repo, `/pulls?${query}`),
    token,
    signal: input.signal,
  });
  if (listed.status !== 200 || !Array.isArray(listed.body))
    throw new Error("Could not list the merged Paws pull requests");
  const repository = `${input.owner}/${input.repo}`;
  return listed.body.flatMap((pull) =>
    typeof pull === "object" &&
    pull !== null &&
    typeof pull.merged_at === "string" &&
    pull.head?.ref === input.branch &&
    pull.head?.repo?.full_name === repository &&
    pull.base?.ref === "main" &&
    pull.base?.repo?.full_name === repository &&
    typeof pull.head?.sha === "string"
      ? [pull.head.sha]
      : [],
  );
}
