import { afterEach, expect, test } from "bun:test";
import { count, eq } from "drizzle-orm";
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
  type Db,
} from "../db";
import { restartForPushConflict } from "./push-conflict";
import { tempStore } from "../../test/pglite";

const open: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

const questionCount = (db: Db) =>
  db.run((q) => q.one(q.orm.select({ n: count() }).from(q.t.question)));

const questions = (db: Db) =>
  db.run((q) =>
    q.all(
      q.orm.select({ body: q.t.question.body, reason: q.t.question.reason }).from(q.t.question),
    ),
  );

async function runningItem() {
  const { db, close } = await tempStore();
  open.push(close);
  const item = await insertQueuedItem(db, { id: "pas-886", sessionKey: "ses", now: 1_000 });
  const { run } = await beginImplementRun(db, item.id, 1_000);
  return { db, itemId: item.id, runId: run.id };
}

test("a candidate that conflicts with its moved branch restarts with reason conflict and no question", async () => {
  const { db, itemId, runId } = await runningItem();
  expect((await getWorkItem(db, itemId))?.state).toBe("running");

  expect(
    await restartForPushConflict(db, itemId, {
      branch: "paws/pas-886",
      files: ["src/a.ts", "src/b.ts"],
      now: 2_000,
    }),
  ).toBe(true);

  expect((await getWorkItem(db, itemId))?.state).toBe("queued");
  expect((await getRun(db, runId))?.status).toBe("ended");
  const resumes = (await listJobs(db)).filter(
    (job) => job.queue === JOB_KIND.resume && job.status === "pending",
  );
  expect(resumes).toHaveLength(1);
  expect(resumes[0]!.payload).toMatchObject({ itemId, reason: "conflict" });
  const handoff = String((resumes[0]!.payload as { handoff: string }).handoff);
  expect(handoff).toContain("`paws/pas-886` moved on GitHub");
  expect(handoff).toContain("- `src/a.ts`\n- `src/b.ts`");
  expect(await questionCount(db)).toEqual({ n: 0 });
});

test("an item that is no longer running is not restarted for a push conflict", async () => {
  const { db, itemId } = await runningItem();
  await applyWorkItemEvent(db, itemId, "turn_ended");
  expect(
    await restartForPushConflict(db, itemId, {
      branch: "paws/pas-886",
      files: ["a"],
      now: 2_000,
    }),
  ).toBe(false);
  expect((await listJobs(db)).filter((job) => job.queue === JOB_KIND.resume)).toEqual([]);
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
    await applyWorkItemEvent(db, itemId, "dispatched");
  }
  expect(
    await restartForPushConflict(db, itemId, {
      branch: "paws/topic",
      files: ["b.ts"],
      now: 3_000,
    }),
  ).toBe(true);
  expect((await getWorkItem(db, itemId))?.state).toBe("awaiting_input");
  expect(
    await db.run((q) =>
      q.one(
        q.orm
          .select({ n: count() })
          .from(q.t.rebaseReturn)
          .where(eq(q.t.rebaseReturn.reason, "push")),
      ),
    ),
  ).toEqual({ n: 3 });
  expect(await questions(db)).toEqual([
    {
      body: expect.stringContaining("after 3 attempts"),
      reason: "rebase_budget_spent",
    },
  ]);
  expect((await questions(db))[0]!.body).toContain("Reply with guidance");
  expect((await listJobs(db)).filter((j) => j.queue === JOB_KIND.resume)).toHaveLength(3);
});

test("push conflicts also respect the six-return rolling hour budget", async () => {
  const { db, itemId } = await runningItem();
  for (let n = 0; n < 6; n++) {
    const jobId = await enqueueJob(db, {
      queue: JOB_KIND.resume,
      payload: { itemId, reason: "conflict" },
      now: 1_000 + n,
    });
    await recordRebaseReturn(db, {
      itemId,
      jobId,
      candidate: null,
      reason: "merge",
      recordedAt: 1_000 + n,
    });
  }
  expect(
    await restartForPushConflict(db, itemId, {
      branch: "paws/topic",
      files: ["a.ts"],
      now: 2_000,
    }),
  ).toBe(true);
  expect((await getWorkItem(db, itemId))?.state).toBe("awaiting_input");
  expect((await questions(db))[0]!.body).toContain("7 times within an hour");
});

test("a person's answer refills the consecutive push-conflict budget", async () => {
  const { db, itemId } = await runningItem();
  for (let n = 0; n < 3; n++) {
    await restartForPushConflict(db, itemId, {
      branch: "paws/topic",
      files: ["a.ts"],
      now: 2_000 + n,
    });
    await applyWorkItemEvent(db, itemId, "dispatched");
  }
  await enqueueJob(db, {
    queue: JOB_KIND.resume,
    payload: { itemId, reason: "answer" },
    now: 3_000,
  });
  expect(
    await restartForPushConflict(db, itemId, {
      branch: "paws/topic",
      files: ["a.ts"],
      now: 4_000,
    }),
  ).toBe(true);
  expect((await getWorkItem(db, itemId))?.state).toBe("queued");
  expect(await questionCount(db)).toEqual({ n: 0 });
});
