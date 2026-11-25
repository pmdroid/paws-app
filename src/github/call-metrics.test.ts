import { expect, test } from "bun:test";
import { createMetricsRecorder } from "../metrics";
import { githubOperation } from "./call-metrics";
import { createFetchGitHubClient } from "./client";
import { checkRepositoryReadAccess } from "./repository-access";

const request = { method: "PUT" as const, path: "/repos/o/r/pulls/7/merge", token: "fake-token" };

function rows(metrics: ReturnType<typeof createMetricsRecorder>) {
  return metrics
    .drain(Number.POSITIVE_INFINITY)
    .map(({ name, labels, count, gauge }) => ({ name, labels, count, gauge }));
}

test("operation names drop owners, numbers, shas and ref names", () => {
  expect(githubOperation("/repos/o/r/pulls/7/merge")).toBe("pulls.merge");
  expect(githubOperation("/graphql")).toBe("graphql");
  expect(githubOperation("/repos/o/r/git/refs/heads/paws/x")).toBe("git.refs");
  expect(githubOperation("/repos/o/r/commits/abc123/check-runs?per_page=100")).toBe(
    "commits.check-runs",
  );
  expect(githubOperation("/repos/o/r")).toBe("repos");
});

test("a GitHub call records its duration, status class and remaining budget", async () => {
  const metrics = createMetricsRecorder();
  const client = createFetchGitHubClient(
    async () => Response.json({ merged: true }, { headers: { "x-ratelimit-remaining": "4321" } }),
    "https://api.github.com",
    metrics,
  );
  expect(await client.request(request)).toMatchObject({ status: 200, body: { merged: true } });
  expect(rows(metrics)).toEqual([
    { name: "github.rate_remaining", labels: {}, count: 1, gauge: 4321 },
    {
      name: "github.call",
      labels: { caller: "pulls.merge", status_class: "2xx" },
      count: 1,
      gauge: null,
    },
  ]);
});

test("a GitHub 403 secondary rate limit increments github.rate_limited", async () => {
  const metrics = createMetricsRecorder();
  const client = createFetchGitHubClient(
    async () =>
      Response.json({ message: "You have exceeded a secondary rate limit." }, { status: 403 }),
    "https://api.github.com",
    metrics,
  );
  await expect(client.request(request)).rejects.toMatchObject({ status: 403 });
  expect(rows(metrics)).toEqual([
    {
      name: "github.call",
      labels: { caller: "pulls.merge", status_class: "4xx" },
      count: 1,
      gauge: null,
    },
    { name: "github.rate_limited", labels: { caller: "pulls.merge" }, count: 1, gauge: null },
  ]);
});

test("a plain 404 and a network failure are calls, not rate limits", async () => {
  const metrics = createMetricsRecorder();
  let fail = false;
  const client = createFetchGitHubClient(
    async () => {
      if (fail) throw new TypeError("fetch failed");
      return Response.json({ message: "Not Found" }, { status: 404 });
    },
    "https://api.github.com",
    metrics,
  );
  expect(await client.request({ ...request, path: "/graphql" })).toMatchObject({ status: 404 });
  fail = true;
  await expect(client.request({ ...request, path: "/graphql" })).rejects.toThrow("fetch failed");
  expect(rows(metrics).map((row) => [row.name, row.labels])).toEqual([
    ["github.call", { caller: "graphql", status_class: "4xx" }],
    ["github.call", { caller: "graphql", status_class: "network" }],
  ]);
});

test("a repository access check records its call", async () => {
  const metrics = createMetricsRecorder();
  const allowed = await checkRepositoryReadAccess({
    owner: "o",
    repo: "r",
    token: "fake-token",
    app: true,
    signal: new AbortController().signal,
    metrics,
    fetch: async () =>
      new Response("{}", { status: 429, headers: { "x-ratelimit-remaining": "0" } }),
  }).catch(() => "refused");
  expect(allowed).toBe("refused");
  expect(rows(metrics)).toEqual([
    { name: "github.rate_remaining", labels: {}, count: 1, gauge: 0 },
    {
      name: "github.call",
      labels: { caller: "repos", status_class: "4xx" },
      count: 1,
      gauge: null,
    },
    { name: "github.rate_limited", labels: { caller: "repos" }, count: 1, gauge: null },
  ]);
});
