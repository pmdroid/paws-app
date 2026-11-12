import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { isMergeWork, JOB_KIND } from "../src/core";
import {
  cancelOpenJobs,
  countCiFixes,
  countRebaseReturns,
  enqueueJob,
  insertQueuedItem,
  listRebaseReturns,
  mergeLaneSql,
  recordCiRound,
  recordRebaseReturn,
  type Db,
} from "../src/db";
import { seed } from "./dialects";
import { tempStore } from "./pglite";

const samples = [
  "github.merge",
  "github.merge.close",
  "github.mergeable",
  "run.resume",
  "item.start",
];

test("the merge-work SQL classifies every job as isMergeWork does", async () => {
  const { db, close } = await tempStore();
  try {
    for (const queue of samples) await enqueueJob(db, { queue, payload: {}, now: 1 });
    const rows = await db.run((q) =>
      q.all(
        q.orm
          .select({ queue: q.t.job.queue, merge: sql<boolean>`${sql.raw(mergeLaneSql("job"))}` })
          .from(q.t.job)
          .orderBy(q.t.job.id),
      ),
    );
    expect(rows.map((row) => [row.queue, row.merge])).toEqual(
      samples.map((queue) => [queue, isMergeWork(queue)]),
    );
    expect(samples.filter((queue) => isMergeWork(queue))).toEqual([
      "github.merge",
      "github.merge.close",
    ]);
  } finally {
    await close();
  }
});

test("cancelling the merge lane cancels a merge job", async () => {
  const { db, close } = await tempStore();
  try {
    await enqueueJob(db, { queue: JOB_KIND.merge, payload: {}, now: 1 });
    expect(await cancelOpenJobs(db, { reason: "stop", mergeLane: true, now: 2 })).toBe(1);
  } finally {
    await close();
  }
});

async function insertMergeQueueItem(db: Db, id: string): Promise<void> {
  await insertQueuedItem(db, { id });
  await seed(db, (q) =>
    q.orm.update(q.t.workItem).set({ state: "merge_queue" }).where(eq(q.t.workItem.id, id)),
  );
}

async function userTurn(db: Db, itemId: string, now: number): Promise<number> {
  return await enqueueJob(db, {
    queue: JOB_KIND.resume,
    jobKey: `linear-turn:${itemId}:${now}`,
    payload: { itemId },
    now,
  });
}

test("rebase returns are counted from rebase_return rows after the latest user turn", async () => {
  const { db, close } = await tempStore();
  try {
    await insertMergeQueueItem(db, "item");
    const before = await enqueueJob(db, {
      queue: JOB_KIND.resume,
      payload: { itemId: "item" },
      now: 1,
    });
    await recordRebaseReturn(db, {
      itemId: "item",
      jobId: before,
      candidate: "a1",
      reason: "merge",
    });
    const turn = await userTurn(db, "item", 2);
    expect(await countRebaseReturns(db, "item", turn)).toBe(0);
    await recordRebaseReturn(db, {
      itemId: "item",
      jobId: turn,
      candidate: null,
      reason: "linear",
    });
    const after = await enqueueJob(db, {
      queue: JOB_KIND.resume,
      payload: { itemId: "item" },
      now: 3,
    });
    await recordRebaseReturn(db, {
      itemId: "item",
      jobId: after,
      candidate: "b2",
      reason: "github_queue",
    });
    expect(await countRebaseReturns(db, "item", turn)).toBe(2);
    expect(await countRebaseReturns(db, "item", 0)).toBe(3);
  } finally {
    await close();
  }
});

test("a rebase return keeps the main commit, files and time it conflicted on", async () => {
  const { db, close } = await tempStore();
  try {
    await insertMergeQueueItem(db, "item");
    const first = await enqueueJob(db, {
      queue: JOB_KIND.resume,
      payload: { itemId: "item" },
      now: 1,
    });
    await recordRebaseReturn(db, {
      itemId: "item",
      jobId: first,
      candidate: null,
      reason: "merge",
      base: "abc1234",
      files: ["src/index.ts"],
      recordedAt: 10,
    });
    const second = await enqueueJob(db, {
      queue: JOB_KIND.resume,
      payload: { itemId: "item" },
      now: 2,
    });
    await recordRebaseReturn(db, {
      itemId: "item",
      jobId: second,
      candidate: null,
      reason: "linear",
    });
    expect(await listRebaseReturns(db, "item", 0)).toEqual([
      { jobId: first, reason: "merge", base: "abc1234", files: ["src/index.ts"], recordedAt: 10 },
      { jobId: second, reason: "linear", base: null, files: null, recordedAt: null },
    ]);
    expect(await listRebaseReturns(db, "item", second)).toHaveLength(1);
  } finally {
    await close();
  }
});

test("CI fixes are counted from the CI rounds recorded after the latest user turn", async () => {
  const { db, close } = await tempStore();
  try {
    await insertMergeQueueItem(db, "item");
    const round = async (head: string, fix: number | null, recordedAt: number) =>
      await recordCiRound(db, {
        itemId: "item",
        head,
        runId: null,
        next: fix === null ? "asked" : "agent",
        fix,
        fixLimit: 3,
        checks: [],
        recordedAt,
      });
    await round("h1", 1, 10);
    await round("h2", 2, 20);
    expect(await countCiFixes(db, "item", 0)).toBe(2);
    await round("h2", 3, 30);
    expect(await countCiFixes(db, "item", 0)).toBe(3);
    const turn = await enqueueJob(db, {
      queue: JOB_KIND.resume,
      jobKey: "linear-turn:item:40",
      payload: { itemId: "item" },
      now: 40,
    });
    expect(await countCiFixes(db, "item", turn)).toBe(0);
    await round("h3", 1, 50);
    await round("h4", null, 60);
    expect(await countCiFixes(db, "item", turn)).toBe(1);
  } finally {
    await close();
  }
});
