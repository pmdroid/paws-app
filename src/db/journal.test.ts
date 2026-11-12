import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { JOB_KIND } from "../core";
import {
  accrueAwake,
  applyWorkItemEvent,
  beginImplementRun,
  cancelOpenJobs,
  claimNextJob,
  completeJob,
  enqueueJob,
  enterMergeQueue,
  failJob,
  failWorkItem,
  getWorkItem,
  insertQueuedItem,
  setJournalSink,
  type Db,
} from "./index";
import { seed } from "../../test/dialects";
import { tempStore } from "../../test/pglite";

let lines: string[] = [];
let restore: () => void = () => {};

beforeEach(() => {
  lines = [];
  restore = setJournalSink((line) => lines.push(line));
});

afterEach(() => restore());

const stores: { close(): Promise<void> }[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

async function database() {
  const store = await tempStore();
  stores.push(store);
  return store.db;
}

async function claim(db: Db, queue: string) {
  const job = await claimNextJob(db, { workerId: "w", now: 1_000, queues: [queue] });
  if (job === null) throw new Error(`no ${queue} job`);
  return job;
}

describe("journal", () => {
  test("writes one line per work item transition", async () => {
    const db = await database();
    await insertQueuedItem(db, { id: "PAS-1" });
    await beginImplementRun(db, "PAS-1", 1_000);
    await enterMergeQueue(db, "PAS-1", { phase: "merge_queue" });
    await applyWorkItemEvent(db, "PAS-1", "merge_accepted");
    expect(lines).toEqual([
      "transition PAS-1 queued --dispatched--> running v1",
      "transition PAS-1 running --turn_ended--> verifying v2",
      "transition PAS-1 verifying --closeout_accepted--> merge_queue v3",
      "transition PAS-1 merge_queue --merge_accepted--> merged v4",
    ]);
  });

  test("writes the reason when a work item fails", async () => {
    const db = await database();
    await insertQueuedItem(db, { id: "PAS-2", sessionKey: "s" });
    await beginImplementRun(db, "PAS-2", 1_000);
    const item = await getWorkItem(db, "PAS-2");
    if (item === null) throw new Error("missing item");
    lines = [];
    await failWorkItem(db, item, "start_timeout", "secret prompt text", 2_000);
    expect(lines).toContain("item PAS-2 failed: start_timeout");
    expect(lines.join("\n")).not.toContain("secret prompt text");
  });

  test("writes one line when a work item hits its time cap", async () => {
    const db = await database();
    await insertQueuedItem(db, { id: "PAS-3", maxAwakeMs: 1_000 });
    await seed(db, (q) =>
      q.orm.update(q.t.workItem).set({ sessionKey: null }).where(eq(q.t.workItem.id, "PAS-3")),
    );
    await beginImplementRun(db, "PAS-3", 1_000);
    await accrueAwake(db, "PAS-3", 0, 1_000, undefined, true);
    lines = [];
    await accrueAwake(db, "PAS-3", 1_000, 2_000, undefined, true);
    expect(lines.filter((line) => line.startsWith("item "))).toEqual([
      "item PAS-3 failed: cap:time",
    ]);
  });

  test("writes done, dead and cancelled outcomes for item jobs", async () => {
    const db = await database();
    await enqueueJob(db, { queue: JOB_KIND.resume, payload: { itemId: "a" }, now: 0 });
    await completeJob(db, await claim(db, JOB_KIND.resume), 1_000);
    await enqueueJob(db, {
      queue: JOB_KIND.merge,
      payload: { itemId: "b" },
      maxAttempts: 1,
      now: 0,
    });
    await failJob(db, await claim(db, JOB_KIND.merge), new Error("merge\nconflict"), {
      now: 1_000,
    });
    await enqueueJob(db, { queue: JOB_KIND.resume, payload: { itemId: "c" }, now: 0 });
    await cancelOpenJobs(db, { itemId: "c", reason: "stopped", now: 1_000 });
    expect(lines.filter((line) => line.startsWith("job "))).toEqual([
      "job 1 run.resume done item=a attempts=1/10",
      "job 2 github.merge dead item=b attempts=1/1 error=merge conflict",
      "job 3 run.resume cancelled item=c attempts=0/10 error=stopped",
    ]);
  });

  test("leaves other queues and retried jobs out", async () => {
    const db = await database();
    await enqueueJob(db, { queue: JOB_KIND.catchup, now: 0 });
    await completeJob(db, await claim(db, JOB_KIND.catchup), 1_000);
    await enqueueJob(db, { queue: JOB_KIND.resume, payload: { itemId: "a" }, now: 0 });
    await failJob(db, await claim(db, JOB_KIND.resume), new Error("busy"), {
      now: 1_000,
    });
    expect(lines.filter((line) => line.startsWith("job "))).toEqual([]);
  });
});
