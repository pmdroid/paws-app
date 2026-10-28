import { acquireOperationToken } from "./auth/provider";
import type { GitHubTokenProvider } from "./auth/types";
import { repoApiPath } from "./client";
import type { GitHubClient } from "./types";

type HeadRead = {
  client: GitHubClient;
  owner: string;
  repo: string;
  tokenProvider?: GitHubTokenProvider;
  appId?: string;
  installationId?: string;
  privateKeyPem?: string;
  signal?: AbortSignal;
};

/** The head of open pull request `number`, or null when it is not open in this repository. */
export async function readOpenPullHead(
  input: HeadRead & { number: number },
): Promise<string | null> {
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
    state?: unknown;
    head?: { sha?: unknown; repo?: { full_name?: unknown } };
  };
  if (body.state !== "open" || body.head?.repo?.full_name !== `${input.owner}/${input.repo}`)
    return null;
  return typeof body.head.sha === "string" ? body.head.sha : null;
}

/**
 * The tip of `branch` on GitHub and whether it is `sha` or descends from it. A missing branch or
 * commit reads as `{ head: null, contains: false }`.
 */
export async function branchContains(
  input: HeadRead & { branch: string; sha: string },
): Promise<{ head: string | null; contains: boolean }> {
  input.signal?.throwIfAborted();
  const token = await acquireOperationToken(input, "pr");
  const compared = await input.client.request({
    method: "GET",
    path: repoApiPath(
      input.owner,
      input.repo,
      `/compare/${encodeURIComponent(input.sha)}...${encodeURIComponent(input.branch)}`,
    ),
    token,
    signal: input.signal,
  });
  if (compared.status === 404) return { head: null, contains: false };
  const body: unknown = compared.body;
  if (compared.status !== 200 || typeof body !== "object" || body === null)
    throw new Error(`Could not compare ${input.branch} with ${input.sha}`);
  const { status, commits } = body as { status?: unknown; commits?: unknown };
  const last = Array.isArray(commits)
    ? (commits.at(-1) as { sha?: unknown } | undefined)
    : undefined;
  const head = status === "identical" ? input.sha : typeof last?.sha === "string" ? last.sha : null;
  return { head, contains: status === "identical" || status === "ahead" };
}
