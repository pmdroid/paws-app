import type { GitHubClient, GitHubResponse } from "./types";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function createFetchGitHubClient(
  fetchImpl: FetchLike = fetch,
  baseUrl = "https://api.github.com",
): GitHubClient {
  return {
    async request({ method, path, token, body, signal, responseType }): Promise<GitHubResponse> {
      signal?.throwIfAborted();
      const response = await fetchImpl(`${baseUrl}${path}`, {
        ...(responseType === "text" ? { redirect: "manual" as const } : {}),
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
      if (responseType === "text") {
        // Log downloads redirect to signed storage URLs, which must not see the token.
        const location = response.headers.get("location");
        if (response.status >= 300 && response.status < 400 && location) {
          const redirected = await fetchImpl(location, { signal });
          return { status: redirected.status, body: await redirected.text() };
        }
        return { status: response.status, body: await response.text() };
      }
      const text = await response.text();
      let parsed: unknown = {};
      if (text !== "") {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { message: "non-json response" };
        }
      }
      return { status: response.status, body: parsed };
    },
  };
}

export function repoApiPath(owner: string, repo: string, suffix: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${suffix}`;
}
