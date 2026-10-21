import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runCloseoutGate, snapshotRetryBaseline, type FixRunner } from "../closeout";
import {
  insertQueuedItem,
  listCloseoutRounds,
  migrate,
  openDatabase,
  startCloseoutRound,
} from "../db";
import { recoveryOptions } from "./closeout-recovery";

const exec = promisify(execFile);
const TASK = "PAS-390-task";

const POLICY = [
  'specVersion: "0.1"',
  "retry:",
  "  maxFailedAttemptsPerItem: 3",
  "  scope: task",
  "items:",
  "  - id: test",
  "    kind: command",
  "    gate: beforePR",
  `    exec: ["bun", "-e", "if (!require('node:fs').existsSync('ok.txt')) process.exit(1)"]`,
  "    timeoutSeconds: 30",
  "",
].join("\n");

test("a re-check of a rebased head gets the full attempt budget again", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paws-closeout-round-"));
  const dir = path.join(root, "repo");
  const home = path.join(root, "home");
  const pawsHome = path.join(root, "paws");
  const db = openDatabase(":memory:");
  try {
    migrate(db);
    insertQueuedItem(db, { id: "item-390" });
    await mkdir(home);
    await mkdir(pawsHome);
    await exec("git", ["init", "--bare", "-b", "main", path.join(root, "origin.git")]);
    await exec("git", ["clone", path.join(root, "origin.git"), dir]);
    await mkdir(path.join(dir, ".agents"));
    await writeFile(path.join(dir, ".agents/closeout.yaml"), POLICY);
    await commit(dir, "init");
    await exec("git", ["-C", dir, "push", "origin", "HEAD:main"]);
    const base = await head(dir);
    const input = {
      worktree: dir,
      taskId: TASK,
      base,
      candidate: { session: "impl-session", model: "claude", provider: "anthropic" },
      home,
      pawsHome,
      reviewer: {
        async review(): Promise<never> {
          throw new Error("no review in this policy");
        },
      },
      fixer: unhelpfulFixer(dir),
    };

    const first = await runCloseoutGate({ ...input, maxFixAttempts: 1 });
    expect(first.outcome).toBe("exhausted");
    expect(first.evaluations).toBe(2);

    await writeFile(path.join(dir, "main.txt"), "from main\n");
    const rebased = await commit(dir, "rebased onto main");
    expect(await runCloseoutGate({ ...input, maxFixAttempts: 5 })).toMatchObject({
      outcome: "exhausted",
      evaluations: 1,
    });

    const baseline = await snapshotRetryBaseline(TASK, pawsHome);
    expect(
      startCloseoutRound(db, {
        itemId: "item-390",
        head: rebased,
        retryBaseline: baseline,
        startedAt: 1,
      }),
    ).toBe(true);
    expect(
      startCloseoutRound(db, {
        itemId: "item-390",
        head: rebased,
        retryBaseline: [],
        startedAt: 2,
      }),
    ).toBe(false);
    expect(listCloseoutRounds(db, "item-390")).toEqual([
      { itemId: "item-390", head: rebased, retryBaseline: baseline, startedAt: 1 },
    ]);

    const recheck = await runCloseoutGate({
      ...input,
      ...recoveryOptions(db, "item-390"),
      maxFixAttempts: 5,
    });
    expect(recheck.outcome).toBe("exhausted");
    expect(recheck.evaluations).toBe(3);
    const kept = await snapshotRetryBaseline(TASK, pawsHome);
    expect(kept).toEqual(expect.arrayContaining(baseline));
    expect(kept.length).toBe(baseline.length + 3);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

function unhelpfulFixer(dir: string): FixRunner {
  return {
    async applyFix(request) {
      await writeFile(path.join(dir, "note.txt"), `${request.fixAttempt}\n`);
      return { ok: true, head: await commit(dir, `fix ${request.fixAttempt}`) };
    },
  };
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
  return head(dir);
}

async function head(dir: string): Promise<string> {
  return (await exec("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
}
