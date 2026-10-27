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

export type PullMerge =
  | { merged: false }
  | { merged: true; sha: string | null; url: string | null };

/**
 * Whether pull request `number` merged into this repository's main, by the merge lane or by a
 * person on GitHub. An open or closed-unmerged pull request, or one on another base, is not merged.
 */
export async function readPullMerge(input: {
  client: GitHubClient;
  owner: string;
  repo: string;
  number: number;
  tokenProvider?: GitHubTokenProvider;
  appId?: string;
  installationId?: string;
  privateKeyPem?: string;
  signal?: AbortSignal;
}): Promise<PullMerge> {
  input.signal?.throwIfAborted();
  const token = await acquireOperationToken(input, "pr");
  const read = await input.client.request({
    method: "GET",
    path: repoApiPath(input.owner, input.repo, `/pulls/${input.number}`),
    token,
    signal: input.signal,
  });
  const pull: unknown = read.body;
  if (read.status !== 200 || typeof pull !== "object" || pull === null)
    throw new Error(`Could not read pull request #${input.number}`);
  const body = pull as {
    merged?: unknown;
    merged_at?: unknown;
    merge_commit_sha?: unknown;
    html_url?: unknown;
    base?: { ref?: unknown; repo?: { full_name?: unknown } };
  };
  if (
    (body.merged !== true && typeof body.merged_at !== "string") ||
    body.base?.ref !== "main" ||
    body.base?.repo?.full_name !== `${input.owner}/${input.repo}`
  )
    return { merged: false };
  return {
    merged: true,
    sha: typeof body.merge_commit_sha === "string" ? body.merge_commit_sha : null,
    url: typeof body.html_url === "string" ? body.html_url : null,
  };
}
