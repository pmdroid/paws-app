import { expect, test } from "bun:test";
import { deleteConflictBranch, type GitHubClient } from "../src/github";

function client(status: number) {
  const calls: { method: string; path: string; token: string }[] = [];
  const fake: GitHubClient = {
    async request(input) {
      calls.push({ method: input.method, path: input.path, token: input.token });
      return { status, body: {} };
    },
  };
  return { fake, calls };
}

const tokenProvider = { mode: "app" as const, tokenFor: async () => "push-token" };

test("an ended item's conflict branch is deleted, and one already gone is fine", async () => {
  const deleted = client(204);
  expect(
    await deleteConflictBranch({
      client: deleted.fake,
      owner: "pmdroid",
      repo: "paws-app",
      branch: "paws/pas-860",
      tokenProvider,
    }),
  ).toBe(true);
  expect(deleted.calls).toEqual([
    {
      method: "DELETE",
      path: "/repos/pmdroid/paws-app/git/refs/heads/paws/pas-860-conflict",
      token: "push-token",
    },
  ]);
  const gone = client(422);
  expect(
    await deleteConflictBranch({
      client: gone.fake,
      owner: "pmdroid",
      repo: "paws-app",
      branch: "paws/pas-860",
      tokenProvider,
    }),
  ).toBe(false);
});

test("only a Paws branch's conflict branch can be deleted", async () => {
  const { fake, calls } = client(204);
  await expect(
    deleteConflictBranch({ client: fake, owner: "o", repo: "r", branch: "main", tokenProvider }),
  ).rejects.toThrow("Only a Paws conflict branch");
  expect(calls).toEqual([]);
});
