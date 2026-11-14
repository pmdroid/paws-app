import { expect, test } from "bun:test";
import { sameGitHubCandidatePatch, validateGitHubCandidateAttribution } from "./candidate-reads";
import type { GitHubClient } from "./types";

const base = "a".repeat(40);
const before = "b".repeat(40);
const after = "c".repeat(40);
const bot = { appId: "1", id: 123, login: "paws[bot]" };
const identity = { name: "paws[bot]", email: "123+paws[bot]@users.noreply.github.com" };

function fixture(bodies: unknown[]) {
  const calls: string[] = [];
  const client: GitHubClient = {
    async request(input) {
      calls.push(input.path);
      return { status: 200, body: bodies.shift() };
    },
  };
  return {
    calls,
    repository: {
      owner: "acme",
      repo: "widgets",
      client,
      tokenProvider: { mode: "token" as const, tokenFor: async () => "fake-token" },
    },
  };
}

test("API attribution validates every candidate commit and rejects foreign authors", async () => {
  const comparison = (author: typeof identity) => ({
    status: "ahead",
    total_commits: 1,
    commits: [{ commit: { author, committer: identity, message: "Fix widgets" } }],
  });
  const good = fixture([comparison(identity)]);
  await validateGitHubCandidateAttribution(good.repository, base, before, { bot, credit: null });
  expect(good.calls).toHaveLength(1);
  const bad = fixture([comparison({ name: "Other", email: "other@example.com" })]);
  await expect(
    validateGitHubCandidateAttribution(bad.repository, base, before, { bot, credit: null }),
  ).rejects.toThrow("attribution rejected");
});

test("API attribution fails closed on incomplete commit pagination", async () => {
  const fake = fixture([{ status: "ahead", total_commits: 1, commits: [] }]);
  await expect(
    validateGitHubCandidateAttribution(fake.repository, base, before, { bot, credit: null }),
  ).rejects.toThrow("incomplete candidate range");
});

test("API patch comparison carries approval across hunk offsets and rejects changed edits", async () => {
  const files = (patch: string) => ({
    files: [{ filename: "widgets", status: "modified", patch }],
  });
  const same = fixture([
    files("@@ -1 +1 @@\n-old\n+new"),
    files("@@ -3 +3 @@\n-old\n+new"),
    { tree: [{ type: "blob", path: "widgets", mode: "100644", sha: before }] },
    { tree: [{ type: "blob", path: "widgets", mode: "100644", sha: after }] },
  ]);
  expect(await sameGitHubCandidatePatch(same.repository, before, after, base)).toBe(true);
  const changed = fixture([files("-old\n+new"), files("-old\n+different")]);
  expect(await sameGitHubCandidatePatch(changed.repository, before, after, base)).toBe(false);
  const binary = fixture([{ files: [{ filename: "image.png" }] }, files("+new")]);
  expect(await sameGitHubCandidatePatch(binary.repository, before, after, base)).toBe(false);
});
