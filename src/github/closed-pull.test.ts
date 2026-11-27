import { expect, test } from "bun:test";
import { openPullRequest } from "./pulls";
import { ClosedPullAtHeadError, type GitHubClient } from "./types";

function github(closed: { number: number; merged_at: string | null; head: { sha: string } }[]) {
  const posts: unknown[] = [];
  const client: GitHubClient = {
    request: async ({ method, path, body }) => {
      if (method === "GET" && path.includes("state=closed")) return { status: 200, body: closed };
      if (method === "POST" && path.endsWith("/pulls")) {
        posts.push(body);
        return { status: 201, body: { number: 9, html_url: "https://github.com/acme/app/pull/9" } };
      }
      throw new Error(`Unexpected ${method} ${path}`);
    },
  };
  return { client, posts };
}

const open = (client: GitHubClient) =>
  openPullRequest({
    issue: "ACME-12",
    owner: "acme",
    repo: "app",
    evidence: "Closeout: accepted",
    head: "abc123",
    client,
    tokenProvider: { mode: "token", tokenFor: async () => "token" },
  });

test("a pull request a person closed unmerged at the same head is not opened again", async () => {
  const fake = github([{ number: 18, merged_at: null, head: { sha: "abc123" } }]);
  const refused = await open(fake.client).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(ClosedPullAtHeadError);
  expect((refused as ClosedPullAtHeadError).pullNumber).toBe(18);
  expect(fake.posts).toHaveLength(0);
});

test("a closed pull request at another head, or a merged one, opens as before", async () => {
  const fake = github([
    { number: 18, merged_at: null, head: { sha: "old999" } },
    { number: 19, merged_at: "2026-11-27T17:00:00Z", head: { sha: "abc123" } },
  ]);
  expect((await open(fake.client)).number).toBe(9);
  expect(fake.posts).toHaveLength(1);
});
