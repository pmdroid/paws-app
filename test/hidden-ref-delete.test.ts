import { expect, test } from "bun:test";
import { checkpointRef } from "../src/core";
import { deleteHiddenRef, type GitHubClient } from "../src/github";

function client(status: number) {
  const requests: { method: string; path: string }[] = [];
  const fake: GitHubClient = {
    async request(input) {
      requests.push({ method: input.method, path: input.path });
      return { status, body: {} };
    },
  };
  return { fake, requests };
}

const tokenProvider = { mode: "token" as const, tokenFor: async () => "synthetic" };

test("a merged or cancelled item's hidden checkpoint ref is deleted, and a missing one is fine", async () => {
  const deleted = client(204);
  expect(
    await deleteHiddenRef({
      client: deleted.fake,
      owner: "acme",
      repo: "repo",
      ref: checkpointRef("paws/eng-1-hidden"),
      tokenProvider,
    }),
  ).toBe(true);
  expect(deleted.requests).toEqual([
    { method: "DELETE", path: "/repos/acme/repo/git/refs/paws/checkpoints/paws/eng-1-hidden" },
  ]);
  const missing = client(422);
  expect(
    await deleteHiddenRef({
      client: missing.fake,
      owner: "acme",
      repo: "repo",
      ref: checkpointRef("paws/eng-1-hidden"),
      tokenProvider,
    }),
  ).toBe(false);
});

test("only a hidden Paws ref can be deleted, never a branch", async () => {
  const refused = client(204);
  await expect(
    deleteHiddenRef({
      client: refused.fake,
      owner: "acme",
      repo: "repo",
      ref: "refs/heads/paws/eng-1-hidden",
      tokenProvider,
    }),
  ).rejects.toThrow("Only a hidden Paws ref can be deleted");
  expect(refused.requests).toEqual([]);
});
