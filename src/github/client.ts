import type { GitHubClient, GitHubResponse } from "./types";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function createFetchGitHubClient(
  fetchImpl: FetchLike = fetch,
  baseUrl = "https://api.github.com",
): GitHubClient {
  return {
    async request({ method, path, token, body, signal }): Promise<GitHubResponse> {
      signal?.throwIfAborted();
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "paws",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
      const text = await response.text();
      let parsed: unknown = {};
      if (text !== "") {
        try {
          parsed = JSON.parse(text);
        } catch {
          return { status: response.status, body: { message: "non-json response" }, text };
        }
      }
      return { status: response.status, body: parsed };
    },
  };
}

export function repoApiPath(owner: string, repo: string, suffix: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${suffix}`;
}
