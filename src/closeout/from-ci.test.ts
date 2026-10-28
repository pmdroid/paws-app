import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { evidencePath, runCloseoutGate } from "./run";

const exec = promisify(execFile);
const RUN = "https://github.com/pmdroid/paws-app/actions/runs/77";

// `test` fails if it runs, so only a result from CI passes it.
const POLICY = [
  'specVersion: "0.1"',
  "retry:",
  "  maxFailedAttemptsPerItem: 3",
  "  scope: task",
  "items:",
  "  - id: test",
  "    kind: command",
  "    gate: beforePR",
  '    exec: ["bun", "-e", "process.exit(1)"]',
  "    timeoutSeconds: 30",
  '    ci: "test (*)"',
  "  - id: links",
  "    kind: command",
  "    gate: beforePR",
  '    exec: ["bun", "-e", "process.exit(0)"]',
  "    timeoutSeconds: 30",
  "  - id: review",
  "    kind: review",
  "    gate: beforePR",
  "    skill: .agents/skills/review/SKILL.md",
  "    independence:",
  "      differentSession: true",
  "      differentModel: true",
  "    failOn: P1",
  "",
].join("\n");

test("a check taken from CI is recorded with its run; the rest and the review run", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paws-from-ci-"));
  try {
    const repo = await seed(root);
    let reviews = 0;
    const input = {
      worktree: repo.dir,
      taskId: "PAS-876-task",
      base: repo.base,
      candidate: { session: "impl", model: "claude", provider: "anthropic" },
      home: repo.home,
      pawsHome: repo.pawsHome,
      maxFixAttempts: 0,
      reviewer: {
        async review() {
          reviews += 1;
          return { session: "codex", model: "codex", provider: "openai", findings: [] };
        },
      },
      fixer: {
        async applyFix(): Promise<never> {
          throw new Error("no fixes");
        },
      },
    };

    // A first run has no CI results: `test` runs and fails.
    const first = await runCloseoutGate(input);
    expect(first.outcome).toBe("exhausted");
    expect(first.decision?.items.find((item) => item.id === "test")).toMatchObject({
      state: "failed",
      message: "command exited 1",
    });

    await writeFile(path.join(repo.dir, "fix.txt"), "fix\n");
    const head = await commit(repo.dir, "fix");
    const recheck = await runCloseoutGate({
      ...input,
      fromCi: [
        {
          id: "test",
          run: RUN,
          checks: [
            { name: "test (0/2)", conclusion: "success", url: `${RUN}/job/1` },
            { name: "test (1/2)", conclusion: "success", url: `${RUN}/job/2` },
          ],
        },
        // An unmapped check stays a command run, whatever CI says.
        { id: "links", run: RUN, checks: [{ name: "links", conclusion: "success", url: null }] },
      ],
    });
    expect(recheck.outcome).toBe("accepted");
    expect(recheck.decision?.items).toEqual([
      {
        id: "test",
        kind: "command",
        state: "passed",
        attempt: 1,
        message: `from CI run ${RUN}: \`test (0/2)\` success, \`test (1/2)\` success`,
      },
      { id: "links", kind: "command", state: "passed", attempt: 1, message: "exited 0" },
      expect.objectContaining({ id: "review", state: "passed" }),
    ]);
    expect(recheck.summary).toContain(`from CI run ${RUN}`);
    expect(reviews).toBe(2);

    const records = await recordsAt(evidencePath(input.taskId, repo.pawsHome), head);
    expect(records.find((record) => record.itemId === "test")).toMatchObject({
      exec: { argv: ["bun", "-e", "process.exit(1)"], exitCode: 0, durationMs: 0 },
      artifacts: [],
      ci: { run: RUN, checks: [{ name: "test (0/2)" }, { name: "test (1/2)" }] },
    });
    expect(records.find((record) => record.itemId === "links")?.ci).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

async function seed(root: string) {
  const dir = path.join(root, "repo");
  const home = path.join(root, "home");
  const pawsHome = path.join(root, "paws");
  await mkdir(home);
  await mkdir(pawsHome);
  await exec("git", ["init", "--bare", "-b", "main", path.join(root, "origin.git")]);
  await exec("git", ["clone", path.join(root, "origin.git"), dir]);
  await mkdir(path.join(dir, ".agents/skills/review"), { recursive: true });
  await writeFile(path.join(dir, ".agents/closeout.yaml"), POLICY);
  await writeFile(path.join(dir, ".agents/skills/review/SKILL.md"), "# Review\n");
  const base = await commit(dir, "init");
  await exec("git", ["-C", dir, "push", "origin", "HEAD:main"]);
  await writeFile(path.join(dir, "change.txt"), "change\n");
  await commit(dir, "change");
  return { dir, home, pawsHome, base };
}

async function recordsAt(
  dir: string,
  head: string,
): Promise<Array<{ itemId: string; head: string; ci?: unknown }>> {
  const found: Array<{ itemId: string; head: string; ci?: unknown }> = [];
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const file = path.join(at, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.name.endsWith(".json")) {
        const record = JSON.parse(await readFile(file, "utf8"));
        if (record.head === head && record.recordType === "command") found.push(record);
      }
    }
  };
  await walk(path.join(dir, "evidence"));
  return found;
}

async function commit(dir: string, message: string): Promise<string> {
  await exec("git", ["-C", dir, "add", "."]);
  await exec("git", [
    "-C",
    dir,
    "-c",
    "user.email=paws-test@example.com",
    "-c",
    "user.name=Paws Test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    message,
  ]);
  return (await exec("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
}
