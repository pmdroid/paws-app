import { acquireOperationToken } from "./auth/provider";
import type { GitHubTokenProvider } from "./auth/types";
import { repoApiPath } from "./client";
import type { GitHubClient } from "./types";

export async function closeStoppedPull(input: {
  client: GitHubClient;
  owner: string;
  repo: string;
  branch: string;
  tokenProvider?: GitHubTokenProvider;
  appId?: string;
  installationId?: string;
  privateKeyPem?: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  input.signal?.throwIfAborted();
  const token = await acquireOperationToken(input, "pr");
  const query = new URLSearchParams({
    state: "open",
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
  if (listed.status !== 200 || !Array.isArray(listed.body) || listed.body.length > 1)
    throw new Error("Could not identify the stopped Paws pull request");
  if (listed.body.length === 0) return false;
  const pull = listed.body[0];
  if (typeof pull !== "object" || pull === null)
    throw new Error("The stopped pull request is invalid");
  const repository = `${input.owner}/${input.repo}`;
  if (
    !Number.isSafeInteger(pull.number) ||
    pull.number < 1 ||
    pull.state !== "open" ||
    pull.head?.ref !== input.branch ||
    pull.head?.repo?.full_name !== repository ||
    pull.base?.ref !== "main" ||
    pull.base?.repo?.full_name !== repository
  )
    throw new Error("The stopped pull request does not match its repository branch");
  input.signal?.throwIfAborted();
  const closed = await input.client.request({
    method: "PATCH",
    path: repoApiPath(input.owner, input.repo, `/pulls/${pull.number}`),
    token,
    body: { state: "closed" },
    signal: input.signal,
  });
  if (
    closed.status !== 200 ||
    typeof closed.body !== "object" ||
    closed.body === null ||
    !("number" in closed.body) ||
    closed.body.number !== pull.number ||
    !("state" in closed.body) ||
    closed.body.state !== "closed"
  )
    throw new Error("Closing the stopped Paws pull request failed");
  return true;
}
