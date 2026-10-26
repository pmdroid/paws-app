import { expect, test } from "bun:test";
import { isTransient, transientRetryDelayMs } from "../core";
import { createFetchGitHubClient } from "./client";
import { GitHubHttpError } from "./types";

const request = { method: "GET" as const, path: "/test", token: "fake-token" };

test.each([
  [429, { message: "Too many requests" }],
  [500, { message: "Server error" }],
  [502, "Bad gateway"],
  [503, "Service unavailable"],
  [504, {}],
  [599, {}],
  [403, { message: "You have exceeded a secondary rate limit." }],
  [403, { message: "API rate limit exceeded" }],
  [403, "You have exceeded a secondary rate limit."],
  [200, { errors: [{ type: "RATELIMITED", message: "Please wait" }] }],
])("GitHub %d with %j throws a typed transient error", async (status, body) => {
  const client = createFetchGitHubClient(
    async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "retry-after": "45" },
      }),
  );
  const error = await client.request(request).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(GitHubHttpError);
  expect(error).toMatchObject({ status, body, retryAfterMs: 45_000 });
  expect(isTransient(error)).toBe(true);
  expect(transientRetryDelayMs(1, error)).toBe(45_000);
});

test.each([400, 401, 403, 404, 409, 422])(
  "GitHub %d stays available to caller-specific handling",
  async (status) => {
    const body = { message: "Request refused" };
    const client = createFetchGitHubClient(
      async () => new Response(JSON.stringify(body), { status }),
    );
    expect(await client.request(request)).toEqual({ status, body });
  },
);

test.each([false, true])(
  "text downloads retain transient errors and retry-after, redirect: %s",
  async (redirect) => {
    const calls: { url: string; authorization: string | null }[] = [];
    const client = createFetchGitHubClient(async (url, init) => {
      calls.push({
        url: String(url),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      if (redirect && calls.length === 1)
        return new Response(null, {
          status: 302,
          headers: { location: "https://logs.example/test" },
        });
      return new Response("Service unavailable", { status: 503, headers: { "retry-after": "60" } });
    });
    const error = await client
      .request({ ...request, accept: "text" })
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(GitHubHttpError);
    expect(error).toMatchObject({ status: 503, retryAfterMs: 60_000 });
    expect(isTransient(error)).toBe(true);
    if (redirect)
      expect(calls[1]).toEqual({ url: "https://logs.example/test", authorization: null });
  },
);

test("successful log text mentioning rate limits stays readable", async () => {
  const body = "Test: handles a secondary rate limit. Passed.";
  const client = createFetchGitHubClient(async () => new Response(body));
  expect(await client.request({ ...request, accept: "text" })).toMatchObject({ status: 200, body });
});
