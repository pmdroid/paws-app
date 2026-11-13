import { afterEach, expect, test } from "bun:test";
import { getItemCandidate, recordItemCandidate } from "../src/db";
import { pushBranch, readBranchTip, type GitHubClient } from "../src/github";
import { forEachDialect, insertWorkItem, type DialectDb } from "./dialects";

const opened: DialectDb[] = [];
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close();
});

const MAIN = "a".repeat(40);
const CANDIDATE = "b".repeat(40);
const tokenProvider = { mode: "app" as const, tokenFor: async () => "ghs_test" };

function fakeRefs(branches: Record<string, string>) {
  const calls: string[] = [];
  const client: GitHubClient = {
    async request({ method, path, body }) {
      calls.push(`${method} ${path}`);
      const route = path.replace("/repos/acme/app", "");
      const read = /^\/git\/ref\/heads\/(.+)$/.exec(route);
      if (method === "GET" && read) {
        const sha = branches[read[1]!];
        return sha
          ? { status: 200, body: { object: { sha: sha.toUpperCase(), type: "commit" } } }
          : { status: 404, body: { message: "Not Found" } };
      }
      const { ref, sha } = body as { ref?: string; sha: string };
      if (method === "POST" && route === "/git/refs" && ref) {
        branches[ref.replace("refs/heads/", "")] = sha;
        return { status: 201, body: {} };
      }
      const moved = /^\/git\/refs\/heads\/(.+)$/.exec(route);
      if (method === "PATCH" && moved) {
        branches[moved[1]!] = sha;
        return { status: 200, body: {} };
      }
      return { status: 404, body: { message: "Not Found" } };
    },
  };
  return { client, calls, branches };
}

const noGit = async () => {
  throw new Error("git must not run");
};

function publish(client: GitHubClient, candidate: string) {
  return pushBranch({
    worktree: "/paws/repos/acme/app.git",
    candidate,
    client,
    issue: "ACME-1",
    branchKey: "acme-1",
    owner: "acme",
    repo: "app",
    gitExec: noGit,
    tokenProvider,
  });
}

test("the branch tip comes from the refs API and an absent branch reads as null", async () => {
  const { client, calls } = fakeRefs({ main: MAIN });
  const read = (branch: string) =>
    readBranchTip({ client, owner: "acme", repo: "app", branch, tokenProvider });
  expect(await read("main")).toBe(MAIN);
  expect(await read("paws/acme-1")).toBeNull();
  expect(calls).toEqual([
    "GET /repos/acme/app/git/ref/heads/main",
    "GET /repos/acme/app/git/ref/heads/paws/acme-1",
  ]);
});

test("a stored candidate publishes through the refs API without git", async () => {
  const github = fakeRefs({ main: MAIN });
  expect(await publish(github.client, CANDIDATE)).toEqual({
    branch: "paws/acme-1",
    head: CANDIDATE,
  });
  expect(github.branches["paws/acme-1"]).toBe(CANDIDATE);
  expect(github.calls.at(-1)).toBe("POST /repos/acme/app/git/refs");

  const moved = "c".repeat(40);
  await publish(github.client, moved);
  expect(github.branches["paws/acme-1"]).toBe(moved);
  expect(github.calls.at(-1)).toBe("PATCH /repos/acme/app/git/refs/heads/paws/acme-1");

  github.calls.length = 0;
  await publish(github.client, moved);
  expect(github.calls).toEqual(["GET /repos/acme/app/git/ref/heads/paws/acme-1"]);
});

test("a refused branch move fails the publication", async () => {
  const client: GitHubClient = {
    async request({ method }) {
      return method === "GET"
        ? { status: 404, body: { message: "Not Found" } }
        : { status: 422, body: { message: "Object does not exist" } };
    },
  };
  await expect(publish(client, CANDIDATE)).rejects.toThrow(/push failed: moving paws\/acme-1/);
});

forEachDialect((open) => {
  test("candidate commits round-trip through the database", async () => {
    const handle = await open();
    opened.push(handle);
    await insertWorkItem(handle.db, "item");
    const github = fakeRefs({ main: MAIN });
    const start = await readBranchTip({
      client: github.client,
      owner: "acme",
      repo: "app",
      branch: "main",
      tokenProvider,
    });
    await recordItemCandidate(handle.db, {
      itemId: "item",
      sha: start!,
      branch: "paws/acme-1",
      recordedAt: 1,
    });
    expect(await getItemCandidate(handle.db, "item")).toEqual({
      itemId: "item",
      sha: MAIN,
      branch: "paws/acme-1",
      recordedAt: 1,
    });
    await recordItemCandidate(handle.db, {
      itemId: "item",
      sha: CANDIDATE,
      branch: "paws/acme-1",
      recordedAt: 2,
    });
    const stored = await getItemCandidate(handle.db, "item");
    expect(stored?.sha).toBe(CANDIDATE);
    await publish(github.client, stored!.sha);
    expect(github.branches["paws/acme-1"]).toBe(CANDIDATE);
  });
});
