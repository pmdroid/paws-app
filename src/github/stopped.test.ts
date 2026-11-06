import { expect, test } from "bun:test";
import { closeStoppedPull } from "./stopped";
import type { GitHubClient } from "./types";

const repo = { full_name: "acme/app" };

function fakePullRequests(options: { failClose?: number } = {}) {
  const pull = {
    number: 42,
    state: "open",
    head: { ref: "paws/acme-12", repo },
    base: { ref: "main", repo },
  };
  const comments: { body: string; html_url: string }[] = [];
  let failures = options.failClose ?? 0;
  const client: GitHubClient = {
    request: async ({ method, path, body }) => {
      if (method === "GET" && path.includes("/pulls?"))
        return { status: 200, body: pull.state === "open" ? [pull] : [] };
      if (method === "GET" && path.includes("/issues/42/comments"))
        return { status: 200, body: comments };
      if (method === "POST" && path.endsWith("/issues/42/comments")) {
        comments.push({
          body: (body as { body: string }).body,
          html_url: `https://github.com/acme/app/pull/42#c${comments.length}`,
        });
        return { status: 201, body: {} };
      }
      if (method === "PATCH" && path.endsWith("/pulls/42")) {
        if (failures-- > 0) return { status: 502, body: {} };
        pull.state = "closed";
        return { status: 200, body: { number: 42, state: "closed" } };
      }
      throw new Error(`Unexpected ${method} ${path}`);
    },
  };
  return { client, pull, comments };
}

const input = (client: GitHubClient) => ({
  client,
  owner: "acme",
  repo: "app",
  branch: "paws/acme-12",
  tokenProvider: { mode: "token" as const, tokenFor: async () => "token" },
  comment: "Closed because ACME-12 was canceled in Linear. The branch `paws/acme-12` is kept.",
});

test("a stopped pull request closes with its comment posted once across retries", async () => {
  const github = fakePullRequests({ failClose: 1 });
  await expect(closeStoppedPull(input(github.client))).rejects.toThrow();
  expect(github.pull.state).toBe("open");
  expect(await closeStoppedPull(input(github.client))).toBe(true);
  expect(await closeStoppedPull(input(github.client))).toBe(false);
  expect(github.pull.state).toBe("closed");
  expect(github.comments.map((comment) => comment.body)).toEqual([
    "Closed because ACME-12 was canceled in Linear. The branch `paws/acme-12` is kept.\n\n<!-- paws:closed:42 -->",
  ]);
});

test("without a comment the pull request closes with no comment", async () => {
  const github = fakePullRequests();
  const { comment: _comment, ...bare } = input(github.client);
  expect(await closeStoppedPull(bare)).toBe(true);
  expect(github.pull.state).toBe("closed");
  expect(github.comments).toEqual([]);
});
