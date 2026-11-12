import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  insertQueuedItem,
  enqueueJob,
  claimNextJob,
  getJob,
  jobVersionCurrent,
  replaceLeasedJobPayload,
  refreshVerificationJobVersion,
  beginImplementRun,
  applyWorkItemEvent,
  type Db,
} from "./index";
import { seed } from "../../test/dialects";
import { tempStore } from "../../test/pglite";

type ItemChange = { state?: "merge_queue" | "running" | "verifying"; cancelRequested?: number };

function updateItem(db: Db, id: string, change: ItemChange, bump = false) {
  return seed(db, (q) =>
    q.orm
      .update(q.t.workItem)
      .set({ ...change, ...(bump ? { version: sql`${q.t.workItem.version} + 1` } : {}) })
      .where(eq(q.t.workItem.id, id)),
  );
}

test("clearing a leased job's wait bookkeeping preserves its item-version fence and claim", async () => {
  const { db, close } = await tempStore();
  try {
    const item = await insertQueuedItem(db, { now: 1_000 });
    const id = await enqueueJob(db, {
      queue: "run.reverify",
      payload: { itemId: item.id, verificationWaitSince: 10 },
      now: 1_000,
    });
    const job = (await claimNextJob(db, {
      queues: ["run.reverify"],
      now: 1_000,
      leaseMs: 5_000,
    }))!;
    expect(job.id).toBe(id);
    expect(await replaceLeasedJobPayload(db, job, { itemId: item.id }, 1_001)).toBe(true);
    expect(await getJob(db, id)).toMatchObject({
      status: "running",
      attempts: 1,
      payload: { itemId: item.id },
    });
    expect(await jobVersionCurrent(db, job)).toBe(true);
    await updateItem(db, item.id, {}, true);
    expect(await replaceLeasedJobPayload(db, job, { itemId: item.id, decide: true }, 1_002)).toBe(
      true,
    );
    expect(await jobVersionCurrent(db, job)).toBe(false);
    await seed(db, (q) =>
      q.orm.update(q.t.job).set({ lockedBy: "replacement" }).where(eq(q.t.job.id, id)),
    );
    expect(await replaceLeasedJobPayload(db, job, { itemId: item.id }, 1_003)).toBe(false);
    expect((await getJob(db, id))?.payload).toMatchObject({ decide: true });
  } finally {
    await close();
  }
});

test("a parked verification version refresh is limited to its original eligible run and lease", async () => {
  const { db, close } = await tempStore();
  try {
    const item = await insertQueuedItem(db, { now: 1000 });
    const { run } = await beginImplementRun(db, item.id, 1000);
    await applyWorkItemEvent(db, item.id, "turn_ended");
    const id = await enqueueJob(db, {
      queue: "run.reverify",
      payload: { itemId: item.id },
      now: 1000,
    });
    const job = (await claimNextJob(db, {
      queues: ["run.reverify"],
      now: 1000,
      leaseMs: 5000,
    }))!;
    await updateItem(db, item.id, { state: "merge_queue" }, true);
    expect(await jobVersionCurrent(db, job)).toBe(false);
    expect(await refreshVerificationJobVersion(db, job, run.id, 1001)).toBe(true);
    expect(await jobVersionCurrent(db, job)).toBe(true);
    await updateItem(db, item.id, {}, true);
    expect(await refreshVerificationJobVersion(db, job, "different-run", 1002)).toBe(false);
    await updateItem(db, item.id, { cancelRequested: 1 });
    expect(await refreshVerificationJobVersion(db, job, run.id, 1002)).toBe(false);
    await updateItem(db, item.id, { cancelRequested: 0, state: "running" });
    expect(await refreshVerificationJobVersion(db, job, run.id, 1002)).toBe(false);
    await updateItem(db, item.id, { state: "verifying" });
    expect(await refreshVerificationJobVersion(db, job, run.id, 6001)).toBe(false);
    expect((await getJob(db, id))?.attempts).toBe(1);
  } finally {
    await close();
  }
});
