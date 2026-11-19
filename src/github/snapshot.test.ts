import { expect, test } from "bun:test";
import { createGitHubSnapshotReader } from "./snapshot";
import type { GitHubClient } from "./types";

const SHA = "A".repeat(40);

test("the snapshot reader resolves a ref to a commit and reads its tree and blobs read-only", async () => {
  const paths: string[] = [];
  const bodies: Record<string, unknown> = {
    "/repos/acme/app": { default_branch: "main", private: true, visibility: "private" },
    "/repos/acme/app/commits/main": { sha: SHA },
    "/repos/acme/app/commits/feature/x": { sha: SHA },
    [`/repos/acme/app/git/trees/${SHA.toLowerCase()}?recursive=1`]: {
      tree: [
        { type: "blob", path: "a.ts", sha: "1", size: 3 },
        { type: "tree", path: "src", sha: "2" },
      ],
    },
    "/repos/acme/app/git/blobs/1": { encoding: "base64", content: btoa("abc") },
  };
  const client: GitHubClient = {
    async request(input) {
      expect(input.method).toBe("GET");
      paths.push(input.path);
      const body = bodies[input.path];
      return { status: body ? 200 : 404, body: body ?? null, headers: {} } as never;
    },
  };
  const reader = createGitHubSnapshotReader({
    locate: (name) =>
      name === "acme/app"
        ? { client, owner: "acme", repo: "app", tokenProvider: { tokenFor: async () => "t" } }
        : null,
  });
  const signal = new AbortController().signal;
  const snapshot = (await reader.resolve("acme/app", null, signal))!;
  expect(snapshot).toEqual({
    repository: "acme/app",
    ref: "main",
    commit: SHA.toLowerCase(),
    visibility: "private",
  });
  expect((await reader.resolve("acme/app", "feature/x", signal))?.ref).toBe("feature/x");
  expect(await reader.resolve("acme/app", "../main", signal)).toBeNull();
  expect(await reader.resolve("acme/app", "gone", signal)).toBeNull();
  expect(await reader.resolve("acme/other", null, signal)).toBeNull();
  const files = await reader.files(snapshot, signal);
  expect(files).toEqual([{ path: "a.ts", object: "1", size: 3 }]);
  expect(new TextDecoder().decode(await reader.read(snapshot, files[0]!, signal))).toBe("abc");
  expect(paths.every((path) => path.startsWith("/repos/acme/app"))).toBe(true);
});
