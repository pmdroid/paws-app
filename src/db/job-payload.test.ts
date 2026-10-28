import { expect, test } from "bun:test";
import {
  openDatabase,
  migrate,
  insertQueuedItem,
  enqueueJob,
  claimNextJob,
  getJob,
  jobVersionCurrent,
  replaceLeasedJobPayload,
} from "./index";

test("clearing a leased job's wait bookkeeping preserves its item-version fence and claim", () => {
  const db = openDatabase(":memory:");
  try {
    migrate(db);
    const item = insertQueuedItem(db, { now: 1_000 });
    const id = enqueueJob(db, {
      queue: "run.reverify",
      payload: { itemId: item.id, verificationWaitSince: 10 },
      now: 1_000,
    });
    const job = claimNextJob(db, { queues: ["run.reverify"], now: 1_000, leaseMs: 5_000 })!;
    expect(job.id).toBe(id);
    expect(replaceLeasedJobPayload(db, job, { itemId: item.id }, 1_001)).toBe(true);
    expect(getJob(db, id)).toMatchObject({
      status: "running",
      attempts: 1,
      payload: { itemId: item.id },
    });
    expect(jobVersionCurrent(db, job)).toBe(true);
    db.run("UPDATE work_item SET version=version+1 WHERE id=?", [item.id]);
    expect(replaceLeasedJobPayload(db, job, { itemId: item.id, decide: true }, 1_002)).toBe(true);
    expect(jobVersionCurrent(db, job)).toBe(false);
    db.run("UPDATE job SET locked_by='replacement' WHERE id=?", [id]);
    expect(replaceLeasedJobPayload(db, job, { itemId: item.id }, 1_003)).toBe(false);
    expect(getJob(db, id)?.payload).toMatchObject({ decide: true });
  } finally {
    db.close();
  }
});
