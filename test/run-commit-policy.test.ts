import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, type GitCommitPolicy } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  beginImplementRun,
  getWorkItem,
  insertQueuedItem,
  migrate,
  openDatabase,
  type WorkItemRecord,
} from "../src/db";
import { createFakeTracker } from "../src/linear";
import { Orchestrator } from "../src/loop";

const BOT = { appId: "5306145", login: "paws-helper[bot]", id: 342190309 };
const BOT_ONLY: GitCommitPolicy = { bot: BOT, credit: null };
const WITH_CREDIT: GitCommitPolicy = {
  bot: BOT,
  credit: {
    id: 434505,
    login: "pmdroid",
    name: "Pascal Matthiesen",
    email: "434505+pmdroid@users.noreply.github.com",
  },
};

test("a task keeps the commit policy it started with when credit changes mid-flight", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-run-commit-policy-"));
  const db = openDatabase(join(root, "paws.db"));
  migrate(db);
  const clock = new FakeClock(1_000);
  let current = BOT_ONLY;
  let resolutions = 0;
  const orchestrator = new Orchestrator({
    db,
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    clock,
    pawsRoot: root,
    tracker: createFakeTracker(),
    repositories: [
      {
        owner: "pmdroid",
        repo: "paws-app",
        remoteUrl: "https://github.com/pmdroid/paws-app.git",
      },
    ],
    async commitPolicyForItem() {
      resolutions += 1;
      return current;
    },
  });
  const policyFor = (item: WorkItemRecord) =>
    (
      orchestrator as unknown as {
        commitPolicy(item: WorkItemRecord): Promise<GitCommitPolicy | undefined>;
      }
    ).commitPolicy(item);
  try {
    insertQueuedItem(db, { id: "task", sessionKey: "session", now: 1_000 });
    beginImplementRun(db, "task", 1_000);
    expect(await policyFor(getWorkItem(db, "task")!)).toEqual(BOT_ONLY);
    current = WITH_CREDIT;
    expect(await policyFor(getWorkItem(db, "task")!)).toEqual(BOT_ONLY);
    expect(resolutions).toBe(1);
  } finally {
    await orchestrator.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
