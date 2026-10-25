import { expect, test } from "bun:test";
import { mergedPullHeads } from "./merged-pulls";
import type { GitHubClient } from "./types";

const repo = { full_name: "acme/demo" };

test("returns head shas of merged pull requests from the exact Paws branch", async () => {
  const paths: string[] = [];
  const client: GitHubClient = {
    request: async (request) => {
      paths.push(request.path);
      return {
        status: 200,

        body: [
          pull({ sha: "merged" }),
          pull({ sha: "closed", merged_at: null }),
          pull({
            sha: "fork",
            head: { ref: "paws/ENG-1", sha: "fork", repo: { full_name: "x/demo" } },
          }),
          pull({ sha: "other", head: { ref: "paws/ENG-2", sha: "other", repo } }),
          pull({ sha: "release", base: { ref: "release", repo } }),
        ],
      };
    },
  };

  const heads = await mergedPullHeads({
    client,
    owner: "acme",
    repo: "demo",
    branch: "paws/ENG-1",
    tokenProvider: { mode: "token", tokenFor: async () => "token" },
  });

  expect(heads).toEqual(["merged"]);
  expect(paths).toEqual([
    "/repos/acme/demo/pulls?state=closed&head=acme%3Apaws%2FENG-1&base=main&per_page=100",
  ]);
});

test("rejects a failed pull request listing", async () => {
  const client: GitHubClient = { request: async () => ({ status: 502, body: null }) };
  await expect(
    mergedPullHeads({
      client,
      owner: "acme",
      repo: "demo",
      branch: "paws/ENG-1",
      tokenProvider: { mode: "token", tokenFor: async () => "token" },
    }),
  ).rejects.toThrow("Could not list");
});

function pull(overrides: Record<string, unknown> & { sha: string }) {
  return {
    merged_at: "2026-10-01T00:00:00Z",
    head: { ref: "paws/ENG-1", sha: overrides.sha, repo },
    base: { ref: "main", repo },
    ...overrides,
  };
}
