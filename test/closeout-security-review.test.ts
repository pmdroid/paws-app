import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createCloseoutSession,
  decision,
  workspacePolicyFiles,
  type ResolvedReview,
} from "../src/closeout-spec";
import { createFakeGitReader, loadPolicy } from "../src/closeout-spec/policy";

const REPOSITORY = join(import.meta.dir, "..");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("security review in this repository's Closeout policy", () => {
  test("is a separate review with its own skill on high-risk paths", () => {
    const loaded = loadPolicy({
      repo: REPOSITORY,
      git: createFakeGitReader(),
      policyRoot: REPOSITORY,
    });
    if (!loaded.ok || loaded.policy.source === "none") throw new Error("expected a policy");
    const items = loaded.policy.items;
    const security = items.find((item) => item.id === "security-review") as ResolvedReview;
    const general = items.find((item) => item.id === "independent-review") as ResolvedReview;
    expect(security).toMatchObject({
      kind: "review",
      gate: "beforePR",
      skill: ".agents/skills/security-paws/SKILL.md",
      independence: { differentSession: true, differentModel: true },
      failOn: "P1",
      scope: "diff",
    });
    expect(security.skill).not.toBe(general.skill);
    expect(security.paths).toContain("src/auth/**");
    expect(security.paths).not.toContain("docs/**");
    expect(readFileSync(join(REPOSITORY, security.skill), "utf8")).toContain("name: security-paws");
  });

  test("a candidate touching src/auth runs it", async () => {
    const candidate = fixture("src/auth/session.ts", "export const rotated = true;\n");
    expect(await candidate.required()).toContain("security-review");
    expect(await candidate.state()).toBe("missing");
  });

  test("a docs-only candidate skips it", async () => {
    const candidate = fixture("docs/closeout.md", "# How Closeout runs\n");
    expect(await candidate.required()).not.toContain("security-review");
    expect(await candidate.required()).toContain("independent-review");
    expect(await candidate.state()).toBe("skipped");
  });
});

function fixture(path: string, content: string) {
  const root = mkdtempSync(join(tmpdir(), "paws-security-review-"));
  roots.push(root);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  writeFileSync(join(root, "README.md"), "seed\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "seed"]);
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  const base = headOf(root);
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", `change ${path}`]);
  return {
    async required(): Promise<string[]> {
      const session = createCloseoutSession(root, {
        policy: async () => workspacePolicyFiles(REPOSITORY),
      });
      const report = JSON.parse(await session.report()) as { required: { id: string }[] };
      return report.required.map((item) => item.id);
    },
    async state(): Promise<string | undefined> {
      const document = await decision({
        repo: root,
        base,
        head: headOf(root),
        gate: "beforePR",
        task: "task",
        policyRoot: REPOSITORY,
        evidenceDir: join(root, ".git", "closeout"),
      });
      return document.items.find((item) => item.id === "security-review")?.state;
    },
  };
}

function headOf(root: string): string {
  return spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}
