import { describe, expect, test } from "bun:test";
import { overlappingPaths, packageRoot, readUpToDateRule } from "./overlap";
import type { GitHubClient, GitHubResponse } from "./types";

describe("overlap between main and a pull request", () => {
  test("without package roots only the same file overlaps", () => {
    expect(overlappingPaths(["apps/web/a.ts"], ["apps/web/b.ts", "README.md"])).toEqual([]);
    expect(overlappingPaths(["apps/web/a.ts", "README.md"], ["README.md"])).toEqual(["README.md"]);
  });

  test("with package roots a change anywhere in the same package overlaps", () => {
    const packages = ["apps/*", "packages/*", "tools"];
    expect(overlappingPaths(["apps/web/a.ts"], ["apps/web/src/b.ts"], packages)).toEqual([
      "apps/web",
    ]);
    expect(overlappingPaths(["apps/web/a.ts"], ["apps/admin/a.ts"], packages)).toEqual([]);
    expect(overlappingPaths(["tools/x/y.ts"], ["tools/z.ts"], packages)).toEqual(["tools"]);
    // A file outside every package still needs the same file.
    expect(overlappingPaths(["package.json"], ["package.json"], packages)).toEqual([
      "package.json",
    ]);
  });

  test("a package root holds the files below it", () => {
    expect(packageRoot("apps/web/a.ts", ["apps/*"])).toBe("apps/web");
    expect(packageRoot("apps/web", ["apps/*"])).toBeNull();
    expect(packageRoot("apps/web/a.ts", ["apps/*/"])).toBe("apps/web");
    expect(packageRoot("libs/a.ts", ["apps/*"])).toBeNull();
  });
});

describe("GitHub's up-to-date rule", () => {
  function client(routes: Record<string, GitHubResponse>): GitHubClient {
    return {
      async request(req) {
        const route = Object.keys(routes).find((suffix) => req.path.includes(suffix));
        return route ? routes[route]! : { status: 404, body: { message: "Not Found" } };
      },
    };
  }
  const read = (routes: Record<string, GitHubResponse>) =>
    readUpToDateRule({
      client: client(routes),
      token: "ghs_test",
      owner: "acme",
      repo: "platform",
      branch: "main",
      prNumber: 7,
    });
  const strictRule = (strict: boolean) => ({
    status: 200,
    body: [
      {
        type: "required_status_checks",
        parameters: { strict_required_status_checks_policy: strict, required_status_checks: [] },
      },
    ],
  });

  test("a ruleset requiring branches to be up to date", async () => {
    expect(await read({ "/rules/branches/main": strictRule(true) })).toBe(true);
    expect(await read({ "/rules/branches/main": strictRule(false) })).toBe(false);
  });

  test("branch protection, when the token can read it", async () => {
    expect(
      await read({
        "/rules/branches/main": { status: 200, body: [] },
        "/protection/required_status_checks": { status: 200, body: { strict: true } },
      }),
    ).toBe(true);
  });

  test("a pull request GitHub reports as behind", async () => {
    expect(
      await read({
        "/rules/branches/main": { status: 200, body: [] },
        "/pulls/7": { status: 200, body: { mergeable_state: "behind" } },
      }),
    ).toBe(true);
    expect(
      await read({
        "/rules/branches/main": { status: 200, body: [] },
        "/pulls/7": { status: 200, body: { mergeable_state: "clean" } },
      }),
    ).toBe(false);
  });

  test("nothing readable is unknown", async () => {
    expect(await read({})).toBeNull();
  });
});
