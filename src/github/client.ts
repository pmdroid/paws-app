import { isTransient } from "../core";
import { GitHubHttpError, type GitHubClient, type GitHubResponse } from "./types";
import { journalCaught } from "../journal";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function createFetchGitHubClient(
  fetchImpl: FetchLike = fetch,
  baseUrl = "https://api.github.com",
): GitHubClient {
  return {
    async request({ method, path, token, body, signal, accept }): Promise<GitHubResponse> {
      signal?.throwIfAborted();
      if (accept === "text") return requestText(fetchImpl, `${baseUrl}${path}`, token, signal);
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
        } catch (caughtError1) {
          journalCaught(caughtError1, "client.request.parse", null);
          parsed = text;
        }
      }
      const retryAfterMs = retryAfterHeaderMs(response.headers.get("retry-after"));
      return checkedResponse(
        retryAfterMs === undefined
          ? { status: response.status, body: parsed }
          : { status: response.status, body: parsed, retryAfterMs },
      );
    },
  };
}

function retryAfterHeaderMs(header: string | null): number | undefined {
  const seconds = header?.trim() ?? "";
  return /^\d+$/.test(seconds) ? Number(seconds) * 1000 : undefined;
}

/**
 * A GET whose body is text. A redirect (Actions log downloads go to signed storage URLs) is
 * followed by hand so the token is not sent to the other host.
 */
async function requestText(
  fetchImpl: FetchLike,
  url: string,
  token: string,
  signal: AbortSignal | undefined,
): Promise<GitHubResponse> {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "paws",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "manual",
    signal,
  });
  const location = response.headers.get("location");
  if (response.status >= 300 && response.status < 400 && location) {
    await response.body?.cancel();
    const target = await fetchImpl(location, { method: "GET", signal });
    return checkedResponse({
      status: target.status,
      body: await target.text(),
      retryAfterMs: retryAfterHeaderMs(target.headers.get("retry-after")),
    });
  }
  return checkedResponse({
    status: response.status,
    body: await response.text(),
    retryAfterMs: retryAfterHeaderMs(response.headers.get("retry-after")),
  });
}

export function repoApiPath(owner: string, repo: string, suffix: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${suffix}`;
}

function checkedResponse(response: GitHubResponse): GitHubResponse {
  const error = new GitHubHttpError(response);
  if (isTransient(error)) throw error;
  return response;
}
