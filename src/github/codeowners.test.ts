import { expect, test } from "bun:test";
import { ownsAnyPath, parseCodeowners } from "./codeowners";
import { openPullRequest } from "./pulls";
import type { GitHubClient } from "./types";

const HEAD = "f".repeat(40);

function open(codeowners: string | null, reviewer?: string) {
  const creates: { token: string; body: string }[] = [];
  const client: GitHubClient = {
    async request(req) {
      if (req.path.includes("/contents/.github/CODEOWNERS"))
        return codeowners === null
          ? { status: 404, body: {} }
          : { status: 200, body: { encoding: "base64", content: btoa(codeowners) } };
      if (req.path.includes("/contents/")) return { status: 404, body: {} };
      if (req.path.includes("/compare/"))
        return {
          status: 200,
          body: { merge_base_commit: { sha: "a".repeat(40) }, files: [{ filename: "src/a.ts" }] },
        };
      if (req.method === "POST" && req.path.endsWith("/pulls"))
        creates.push({ token: req.token, body: (req.body as { body: string }).body });
      return { status: 201, body: { number: 4 } };
    },
  };
  const opened = openPullRequest({
    issue: "ENG-1",
    owner: "pmdroid",
    repo: "demo",
    evidence: "Closeout: accepted\n\nCredit: [@Owner](https://github.com/Owner)",
    head: HEAD,
    ...(reviewer ? { reviewer } : {}),
    member: { login: "Owner", token: "ghu_member" },
    tokenProvider: { mode: "token", tokenFor: async () => "ghs_app" },
    client,
  });
  return { opened, creates };
}

test.each([
  ["a requested reviewer who owns no path", null, "owner", "ghu_member", ""],
  ["a code owner of a changed path", "* @team\nsrc/ @owner", undefined, "ghs_app", "owns a"],
  [
    "an owner of unchanged paths only",
    "src/ @owner\nsrc/a.ts @org/team",
    undefined,
    "ghu_member",
    "",
  ],
  ["a member whose CODEOWNERS fails to parse", "!src/ @owner", undefined, "ghu_member", ""],
] as const)("%s gets the expected authorship", async (_, codeowners, reviewer, token, why) => {
  const { opened, creates } = open(codeowners, reviewer);
  const pull = await opened;
  expect(creates.map((create) => create.token)).toEqual([token]);
  const line =
    token === "ghs_app" ? `Opened by the Paws GitHub App: @Owner ${why}` : "Opened by @Owner,";
  expect(creates[0]!.body).toContain(`Credit: [@Owner](https://github.com/Owner)\n${line}`);
  expect(pull.evidence).toContain(line);
});

test("CODEOWNERS matching follows GitHub's last-match-wins rule and ignores teams", () => {
  const rules = parseCodeowners("# owners\n*.md @owner\ndocs/* @owner\n/docs/x.md @other\n");
  expect(ownsAnyPath(rules, "OWNER", ["readme.md"])).toBe(true);
  expect(ownsAnyPath(rules, "owner", ["docs/x.md"])).toBe(false);
  expect(ownsAnyPath(rules, "owner", ["docs/deep/y.ts"])).toBe(false);
  expect(ownsAnyPath(parseCodeowners("** @org/owner"), "owner", ["a"])).toBe(false);
});
