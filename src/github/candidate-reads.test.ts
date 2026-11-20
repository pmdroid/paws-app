import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import {
  gitHubCommitPatchIds,
  readGitHubCandidateRange,
  sameGitHubCandidatePatch,
  validateGitHubCandidateAttribution,
} from "./candidate-reads";
import type { GitHubClient } from "./types";

const base = "a".repeat(40);
const before = "b".repeat(40);
const after = "c".repeat(40);
const bot = { appId: "1", id: 123, login: "paws[bot]" };
const identity = { name: "paws[bot]", email: "123+paws[bot]@users.noreply.github.com" };
const policy = { bot, credit: null };

function fixture(bodies: unknown[]) {
  const calls: string[] = [];
  const client: GitHubClient = {
    async request(input) {
      calls.push(input.accept ? `${input.path} ${input.accept}` : input.path);
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
  const bad = fixture([comparison({ name: "Other", email: "other@example.com" })]);
  await expect(
    validateGitHubCandidateAttribution(bad.repository, base, before, { bot, credit: null }),
  ).rejects.toThrow("attribution rejected");
});

test("API attribution skips adopted commits by patch-id, even after a rebase moved their hunks", async () => {
  const person = { name: "Rita", email: "rita@example.com" };
  const diff = (line: number, mode = "") =>
    `diff --git a/notes b/notes\n${mode}index 1111111..2222222 100644\n--- a/notes\n+++ b/notes\n@@ -${line},2 +${line},2 @@\n shelf\n-a\n+b\n`;
  const commit = (body: string, parents = [base]) => [
    { parents: parents.map((sha) => ({ sha })) },
    body,
  ];
  const adopted = fixture(commit(diff(1)));
  const ids = await gitHubCommitPatchIds(adopted.repository, [before]);
  expect(ids).toHaveLength(1);
  expect(adopted.calls).toEqual([
    `/repos/acme/widgets/commits/${before}?per_page=1`,
    `/repos/acme/widgets/commits/${before} diff`,
  ]);
  const range = (...authors: (typeof identity)[]) => ({
    status: "ahead",
    total_commits: authors.length,
    commits: authors.map((author, index) => ({
      sha: [after, before][index],
      commit: { author, committer: author, message: "Work" },
    })),
  });
  const rebased = fixture([range(person, identity), ...commit(diff(9)), ...commit(diff(1), [])]);
  await validateGitHubCandidateAttribution(rebased.repository, base, after, policy, undefined, ids);
  const rejected = async (bodies: unknown[], skip = ids) =>
    expect(
      validateGitHubCandidateAttribution(
        fixture(bodies).repository,
        base,
        after,
        policy,
        undefined,
        skip,
      ),
    ).rejects.toThrow("attribution rejected");
  await rejected([range(person), ...commit(diff(1).replace("+b", "+c"))]);
  await rejected([range(person), ...commit(diff(1, "old mode 100644\nnew mode 100755\n"))]);
  await rejected([range(person), ...commit(diff(1), [base, before])]);
  await rejected([range(person), { parents: [{ sha: base }] }, ""]);
  await rejected([range(identity, person)], []);
});

test("API attribution fails closed on incomplete commit pagination", async () => {
  const fake = fixture([{ status: "ahead", total_commits: 1, commits: [] }]);
  await expect(
    validateGitHubCandidateAttribution(fake.repository, base, before, { bot, credit: null }),
  ).rejects.toThrow("incomplete candidate range");
});

test("API patch comparison allows offset changes only when changed file contents match", async () => {
  const files = (patch: string) => ({
    files: [{ filename: "widgets", status: "modified", patch }],
  });
  const same = fixture([
    files("@@ -1,3 +1,3 @@\n shelf\n-old\n+new\n end"),
    files("@@ -3,3 +3,3 @@\n shelf\n-old\n+new\n end"),
    { tree: [{ type: "blob", path: "widgets", mode: "100644", sha: before }] },
    { tree: [{ type: "blob", path: "widgets", mode: "100644", sha: before }] },
  ]);
  expect(await sameGitHubCandidatePatch(same.repository, before, after, base)).toBe(true);
  const changed = fixture([files("-old\n+new"), files("-old\n+different")]);
  expect(await sameGitHubCandidatePatch(changed.repository, before, after, base)).toBe(false);
  const binary = fixture([{ files: [{ filename: "image.png" }] }, files("+new")]);
  expect(await sameGitHubCandidatePatch(binary.repository, before, after, base)).toBe(false);
});

test("stored candidate summaries come from compare without a mirror", async () => {
  const fake = fixture([{ merge_base_commit: { sha: base }, ahead_by: 2 }]);
  expect(await readGitHubCandidateRange(fake.repository, before)).toEqual({
    head: before,
    base,
    commits: 2,
  });
  expect(fake.calls).toEqual([`/repos/acme/widgets/compare/main...${before}?per_page=1`]);
  const invalid = fixture([{ merge_base_commit: { sha: base } }]);
  await expect(readGitHubCandidateRange(invalid.repository, before)).rejects.toThrow(
    "incomplete candidate range",
  );
});

test("identical repeated contexts cannot carry approval to a different occurrence", async () => {
  const files = (line: number) => ({
    files: [
      {
        filename: "widgets",
        status: "modified",
        patch: `@@ -${line},3 +${line},3 @@\n shelf\n-old\n+new\n end`,
      },
    ],
  });
  const block = "shelf\nold\nend\n";
  const blob = (content: string) =>
    createHash("sha1")
      .update(`blob ${Buffer.byteLength(content)}\0${content}`)
      .digest("hex");
  const first = blob(block.replace("old", "new") + block);
  const second = blob(block + block.replace("old", "new"));
  const fake = fixture([
    files(1),
    files(8),
    { tree: [{ type: "blob", path: "widgets", mode: "100644", sha: first }] },
    { tree: [{ type: "blob", path: "widgets", mode: "100644", sha: second }] },
  ]);
  expect(await sameGitHubCandidatePatch(fake.repository, before, after, base)).toBe(false);
});
