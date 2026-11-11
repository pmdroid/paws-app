import { expect, test } from "bun:test";
import { JOB_KIND } from "../core";
import {
  applyWorkItemEvent,
  enqueueJob,
  recordRebaseReturn,
  beginImplementRun,
  getRun,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  migrate,
  openDatabase,
  sqliteDb,
} from "../db";
import { restartForPushConflict } from "./push-conflict";

async function runningItem() {
  const db = openDatabase(":memory:");
  migrate(db);
  const item = insertQueuedItem(db, { id: "pas-886", sessionKey: "ses", now: 1_000 });
  const { run } = await beginImplementRun(sqliteDb(db), item.id, 1_000);
  return { db, itemId: item.id, runId: run.id };
}

test("a candidate that conflicts with its moved branch restarts with reason conflict and no question", async () => {
  const { db, itemId, runId } = await runningItem();
  expect(getWorkItem(db, itemId)?.state).toBe("running");

  expect(
    await restartForPushConflict(db, itemId, {
      branch: "paws/pas-886",
      files: ["src/a.ts", "src/b.ts"],
      now: 2_000,
    }),
  ).toBe(true);

  expect(getWorkItem(db, itemId)?.state).toBe("queued");
  expect(getRun(db, runId)?.status).toBe("ended");
  const resumes = (await listJobs(sqliteDb(db))).filter(
    (job) => job.queue === JOB_KIND.resume && job.status === "pending",
  );
  expect(resumes).toHaveLength(1);
  expect(resumes[0]!.payload).toMatchObject({ itemId, reason: "conflict" });
  const handoff = String((resumes[0]!.payload as { handoff: string }).handoff);
  expect(handoff).toContain("`paws/pas-886` moved on GitHub");
  expect(handoff).toContain("- `src/a.ts`\n- `src/b.ts`");
  expect(db.query("SELECT COUNT(*) AS count FROM question").get()).toEqual({ count: 0 });
});

test("an item that is no longer running is not restarted for a push conflict", async () => {
  const { db, itemId } = await runningItem();
  await applyWorkItemEvent(sqliteDb(db), itemId, "turn_ended");
  expect(
    await restartForPushConflict(db, itemId, { branch: "paws/pas-886", files: ["a"], now: 2_000 }),
  ).toBe(false);
  expect((await listJobs(sqliteDb(db))).filter((job) => job.queue === JOB_KIND.resume)).toEqual([]);
});

test("three genuine push conflicts spend the shared budget, then ask for guidance", async () => {
  const { db, itemId } = await runningItem();
  for (let attempt = 0; attempt < 3; attempt++) {
    expect(
      await restartForPushConflict(db, itemId, {
        branch: "paws/topic",
        files: ["a.ts"],
        now: 2_000 + attempt,
      }),
    ).toBe(true);
    await applyWorkItemEvent(sqliteDb(db), itemId, "dispatched");
  }
  expect(
    await restartForPushConflict(db, itemId, { branch: "paws/topic", files: ["b.ts"], now: 3_000 }),
  ).toBe(true);
  expect(getWorkItem(db, itemId)?.state).toBe("awaiting_input");
  expect(db.query("SELECT COUNT(*) AS n FROM rebase_return WHERE reason='push'").get()).toEqual({
    n: 3,
  });
  expect(db.query("SELECT body,reason FROM question").get()).toMatchObject({
    body: expect.stringContaining("after 3 attempts"),
    reason: "rebase_budget_spent",
  });
  expect(db.query("SELECT body FROM question").get()).toEqual({
    body: expect.stringContaining("Reply with guidance"),
  });
  expect((await listJobs(sqliteDb(db))).filter((j) => j.queue === JOB_KIND.resume)).toHaveLength(3);
  db.close();
});

test("push conflicts also respect the six-return rolling hour budget", async () => {
  const { db, itemId } = await runningItem();
  for (let n = 0; n < 6; n++) {
    const jobId = await enqueueJob(sqliteDb(db), {
      queue: JOB_KIND.resume,
      payload: { itemId, reason: "conflict" },
      now: 1_000 + n,
    });
    await recordRebaseReturn(sqliteDb(db), {
      itemId,
      jobId,
      candidate: null,
      reason: "merge",
      recordedAt: 1_000 + n,
    });
  }
  expect(
    await restartForPushConflict(db, itemId, { branch: "paws/topic", files: ["a.ts"], now: 2_000 }),
  ).toBe(true);
  expect(getWorkItem(db, itemId)?.state).toBe("awaiting_input");
  expect(db.query("SELECT body FROM question").get()).toEqual({
    body: expect.stringContaining("7 times within an hour"),
  });
  db.close();
});

test("a person's answer refills the consecutive push-conflict budget", async () => {
  const { db, itemId } = await runningItem();
  for (let n = 0; n < 3; n++) {
    await restartForPushConflict(db, itemId, {
      branch: "paws/topic",
      files: ["a.ts"],
      now: 2_000 + n,
    });
    await applyWorkItemEvent(sqliteDb(db), itemId, "dispatched");
  }
  await enqueueJob(sqliteDb(db), {
    queue: JOB_KIND.resume,
    payload: { itemId, reason: "answer" },
    now: 3_000,
  });
  expect(
    await restartForPushConflict(db, itemId, { branch: "paws/topic", files: ["a.ts"], now: 4_000 }),
  ).toBe(true);
  expect(getWorkItem(db, itemId)?.state).toBe("queued");
  expect(db.query("SELECT COUNT(*) AS n FROM question").get()).toEqual({ n: 0 });
  db.close();
});
