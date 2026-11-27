import { expect, test } from "bun:test";
import { createRunnerReleaseLookup } from "./releases";
import type { GitHubClient } from "./types";

test("the earliest release whose tag contains the merge is found with one compare per release", async () => {
  const merge = "a".repeat(40);
  const paths: string[] = [];
  const inside = new Set(["v0.1.111", "v0.1.110"]);
  const releases = [{ tag_name: "v0.0.9" }, { tag_name: "v0.1.110" }, { tag_name: "v0.1.109" }];
  const client: GitHubClient = {
    async request({ path }) {
      paths.push(path);
      if (path.endsWith("/releases?per_page=30")) return { status: 200, body: releases };
      const tag = decodeURIComponent(path.split("...")[1]!.split("?")[0]!);
      return { status: 200, body: { status: inside.has(tag) ? "ahead" : "behind" } };
    },
  };
  const lookup = createRunnerReleaseLookup((name) =>
    name === "owner/repo"
      ? {
          client,
          owner: "owner",
          repo: "repo",
          tokenProvider: { mode: "token", tokenFor: async () => "token" },
        }
      : null,
  );
  expect(await lookup("owner/repo", merge)).toBe("v0.1.110");
  expect(paths.filter((path) => path.includes("/compare/"))).toHaveLength(3);
  releases.unshift({ tag_name: "v0.1.111" });
  expect(await lookup("owner/repo", merge)).toBe("v0.1.110");
  expect(paths.filter((path) => path.includes("/compare/"))).toHaveLength(4);
  expect(await lookup("other/repo", merge)).toBeNull();
});
