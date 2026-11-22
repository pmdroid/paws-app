import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decision, run } from "../src/closeout-spec";

let root = "";
let repo = "";
let base = "";
let head = "";

function git(...args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "paws-since-run-"));
  repo = join(root, "repo");
  mkdirSync(join(repo, ".agents"), { recursive: true });
  writeFileSync(
    join(repo, ".agents/closeout.yaml"),
    JSON.stringify({
      specVersion: "0.1",
      items: [
        {
          id: "unit",
          kind: "command",
          gate: "beforePR",
          exec: ["false"],
          since: ["test", "-n", "{since}"],
          timeoutSeconds: 30,
        },
      ],
    }),
  );
  git("init", "-qb", "main");
  git("add", "-A");
  git("commit", "-qm", "Base");
  base = git("rev-parse", "HEAD");
  git("clone", "-q", "--bare", ".", join(root, "origin.git"));
  git("remote", "add", "origin", join(root, "origin.git"));
  git("fetch", "-q", "origin");
  git("checkout", "-q", "--detach", base);
  writeFileSync(join(repo, "a.txt"), "change\n");
  git("add", "-A");
  git("commit", "-qm", "Candidate");
  head = git("rev-parse", "HEAD");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const input = (evidenceDir: string) => ({
  repo,
  base,
  head,
  gate: "beforePR" as const,
  task: "PAS-2305",
  candidate: { session: "candidate", model: "candidate-model", provider: "fixture" },
  evidenceDir: join(root, evidenceDir),
  pawsHome: join(root, "paws"),
});

test("a since run executes the since argv with the failed head and its record passes", async () => {
  const ran = await run({ ...input("since"), since: { head: base, ids: ["unit"] } });
  expect(ran.items.find((item) => item.id === "unit")?.state).toBe("passed");
  const judged = await decision(input("since"));
  expect(judged.items.find((item) => item.id === "unit")?.state).toBe("passed");
}, 60_000);

test("without since the check runs its exec", async () => {
  const ran = await run(input("full"));
  expect(ran.items.find((item) => item.id === "unit")?.state).toBe("failed");
}, 60_000);
