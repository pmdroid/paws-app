import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { run, type DecisionItem } from "../src/closeout-spec";

const source = resolve(import.meta.dir, "..");
let root = "";
let repo = "";
let base = "";

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

function commit(message: string): string {
  git("add", "-A");
  git("commit", "-qm", message);
  return git("rev-parse", "HEAD");
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "paws-proof-check-"));
  repo = join(root, "repo");
  symlinkSync(join(source, "node_modules"), join(root, "node_modules"));
  const files = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: source,
    encoding: "utf8",
  }).stdout.split("\0");
  for (const file of files) {
    if (!file || !existsSync(join(source, file))) continue;
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    cpSync(join(source, file), join(repo, file));
  }
  const policy = Bun.YAML.parse(readFileSync(join(source, ".agents/closeout.yaml"), "utf8")) as {
    items: { id: string }[];
  };
  const proof = policy.items.find((item) => item.id === "proof");
  writeFileSync(
    join(repo, ".agents/closeout.yaml"),
    JSON.stringify({ specVersion: "0.1", items: [proof] }),
  );
  git("init", "-qb", "main");
  base = commit("Base");
  git("clone", "-q", "--bare", ".", join(root, "origin.git"));
  git("remote", "add", "origin", join(root, "origin.git"));
  git("fetch", "-q", "origin");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

async function closeout(change: () => void): Promise<{ item?: DecisionItem; log: string }> {
  git("checkout", "-q", "--detach", base);
  change();
  const head = commit("Candidate");
  const evidenceDir = join(root, `evidence-${head}`);
  const decided = await run({
    repo,
    base,
    head,
    gate: "beforePR",
    task: "PAS-1212",
    candidate: { session: "candidate", model: "candidate-model", provider: "fixture" },
    evidenceDir,
    pawsHome: join(root, "paws"),
  });
  const logs = [...new Bun.Glob("logs/**/proof/*.log").scanSync({ cwd: evidenceDir })];
  return {
    item: decided.items.find((item) => item.id === "proof"),
    log: logs.length > 0 ? readFileSync(join(evidenceDir, logs[0]!), "utf8") : "",
  };
}

test("a change to src/db/commands.ts runs stop-keeps-issue-and-pr and keeps its bundle as evidence", async () => {
  const { item, log } = await closeout(() =>
    appendFileSync(join(repo, "src/db/commands.ts"), "\n// fixture\n"),
  );
  expect(item?.state).toBe("passed");
  expect(log).toMatch(/^Proof scenarios: .*stop-keeps-issue-and-pr$/m);
  expect(log).toContain("# Proof: stop-keeps-issue-and-pr — PASS");
  expect(log).toContain("- PASS the stop pauses the item\n");
}, 120_000);

test("a change outside the proof paths skips the check", async () => {
  const { item, log } = await closeout(() =>
    appendFileSync(join(repo, "docs/closeout.md"), "\nFixture.\n"),
  );
  expect(item?.state).toBe("skipped");
  expect(log).toBe("");
}, 60_000);

test("a covered change no scenario names passes and says so", async () => {
  const { item, log } = await closeout(() => {
    rmSync(join(repo, "test/proofs/happy-path.ts"));
    appendFileSync(join(repo, "src/scheduler/index.ts"), "\n// fixture\n");
  });
  expect(item?.state).toBe("passed");
  expect(log).toContain("No proof scenario covers these paths");
}, 60_000);

test("a failing scenario fails the check with the failed assertion at the end of its log", async () => {
  const { item, log } = await closeout(() => {
    appendFileSync(join(repo, "src/db/commands.ts"), "\n// fixture\n");
    writeFileSync(
      join(repo, "test/proofs/fixture-fails.ts"),
      [
        'import type { Proof } from "./harness";',
        "export default {",
        '  covers: ["src/db/commands.ts"],',
        '  summary: "A fixture scenario that fails.",',
        "  agent: () => [],",
        "  async run(proof) {",
        '    proof.expect("the widget count is 13", false, 12);',
        "  },",
        "} satisfies Proof;",
        "",
      ].join("\n"),
    );
  });
  expect(item?.state).toBe("failed");
  expect(log.slice(-4000)).toContain("FAIL fixture-fails\n  the widget count is 13: 12");
}, 120_000);
