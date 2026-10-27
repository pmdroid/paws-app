import { acquireOperationToken } from "./auth/provider";
import type { GitHubTokenProvider } from "./auth/types";
import { repoApiPath } from "./client";
import type { GitHubClient } from "./types";

export type MergedPull = {
  number: number;
  title: string;
  url: string;
  mergedAt: string;
  /** The commit the merge put on the base branch. */
  mergeCommitSha: string | null;
};

export type PullComment = {
  author: string | null;
  body: string;
  url: string;
  createdAt: string;
};

type ReadInput = {
  client: GitHubClient;
  owner: string;
  repo: string;
  tokenProvider?: GitHubTokenProvider;
  appId?: string;
  installationId?: string;
  privateKeyPem?: string;
  signal?: AbortSignal;
};

const MAX_PAGES = 10;

/**
 * Pull requests merged at or after `since`, most recently updated first. Reads closed pull
 * requests by update time and stops at the first page older than `since`.
 */
export async function listMergedPullsSince(
  input: ReadInput & { since: Date },
): Promise<MergedPull[]> {
  const token = await acquireOperationToken(input, "pr");
  const since = input.since.getTime();
  const pulls: MergedPull[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    input.signal?.throwIfAborted();
    const query = new URLSearchParams({
      state: "closed",
      sort: "updated",
      direction: "desc",
      per_page: "100",
      page: String(page),
    });
    const listed = await input.client.request({
      method: "GET",
      path: repoApiPath(input.owner, input.repo, `/pulls?${query}`),
      token,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (listed.status !== 200 || !Array.isArray(listed.body))
      throw new Error(`GitHub pull request list failed: status ${listed.status}`);
    let older = false;
    for (const pull of listed.body as unknown[]) {
      const parsed = mergedPull(pull);
      const updated = Date.parse(field(pull, "updated_at") ?? "");
      if (Number.isFinite(updated) && updated < since) older = true;
      if (parsed && Date.parse(parsed.mergedAt) >= since) pulls.push(parsed);
    }
    if (older || listed.body.length < 100) return pulls;
  }
  return pulls;
}

/** One pull request, or null when it does not exist or is not merged. */
export async function readMergedPull(
  input: ReadInput & { number: number },
): Promise<MergedPull | null> {
  const token = await acquireOperationToken(input, "pr");
  const read = await input.client.request({
    method: "GET",
    path: repoApiPath(input.owner, input.repo, `/pulls/${input.number}`),
    token,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (read.status === 404) return null;
  if (read.status !== 200)
    throw new Error(`GitHub pull request read failed: status ${read.status}`);
  return mergedPull(read.body);
}

/** The pull request's top-level conversation comments, oldest first. */
export async function readPullComments(
  input: ReadInput & { number: number },
): Promise<PullComment[]> {
  const token = await acquireOperationToken(input, "pr");
  const comments: PullComment[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    input.signal?.throwIfAborted();
    const listed = await input.client.request({
      method: "GET",
      path: repoApiPath(
        input.owner,
        input.repo,
        `/issues/${input.number}/comments?per_page=100&page=${page}`,
      ),
      token,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (listed.status !== 200 || !Array.isArray(listed.body))
      throw new Error(`GitHub pull request comments read failed: status ${listed.status}`);
    for (const comment of listed.body as unknown[]) {
      const body = field(comment, "body");
      const url = field(comment, "html_url");
      if (body === null || url === null) continue;
      const user = (comment as { user?: { login?: unknown } | null }).user;
      comments.push({
        author: typeof user?.login === "string" ? user.login : null,
        body,
        url,
        createdAt: field(comment, "created_at") ?? "",
      });
    }
    if (listed.body.length < 100) return comments;
  }
  throw new Error("GitHub pull request has too many comments");
}

function mergedPull(value: unknown): MergedPull | null {
  const number = (value as { number?: unknown } | null)?.number;
  const mergedAt = field(value, "merged_at");
  const url = field(value, "html_url");
  if (typeof number !== "number" || mergedAt === null || url === null) return null;
  return {
    number,
    title: field(value, "title") ?? "",
    url,
    mergedAt,
    mergeCommitSha: field(value, "merge_commit_sha"),
  };
}

function field(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const found = (value as Record<string, unknown>)[key];
  return typeof found === "string" ? found : null;
}
