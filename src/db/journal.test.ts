import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
  migrate,
  openDatabase,
  setJournalSink,
  sqliteDb,
} from "./index";

let lines: string[] = [];
let restore: () => void = () => {};

beforeEach(() => {
  lines = [];
  restore = setJournalSink((line) => lines.push(line));
});

afterEach(() => restore());

function database() {
  const db = openDatabase(":memory:");
  migrate(db);
  return db;
}

async function claim(db: ReturnType<typeof database>, queue: string) {
  const job = await claimNextJob(sqliteDb(db), { workerId: "w", now: 1_000, queues: [queue] });
  if (job === null) throw new Error(`no ${queue} job`);
  return job;
}

describe("journal", () => {
  test("writes one line per work item transition", async () => {
    const db = database();
    insertQueuedItem(db, { id: "PAS-1" });
    await beginImplementRun(sqliteDb(db), "PAS-1", 1_000);
    await enterMergeQueue(sqliteDb(db), "PAS-1", { phase: "merge_queue" });
    applyWorkItemEvent(db, "PAS-1", "merge_accepted");
    expect(lines).toEqual([
      "transition PAS-1 queued --dispatched--> running v1",
      "transition PAS-1 running --turn_ended--> verifying v2",
      "transition PAS-1 verifying --closeout_accepted--> merge_queue v3",
      "transition PAS-1 merge_queue --merge_accepted--> merged v4",
    ]);
  });

  test("writes the reason when a work item fails", async () => {
    const db = database();
    insertQueuedItem(db, { id: "PAS-2", sessionKey: "s" });
    await beginImplementRun(sqliteDb(db), "PAS-2", 1_000);
    const item = getWorkItem(db, "PAS-2");
    if (item === null) throw new Error("missing item");
    lines = [];
    failWorkItem(db, item, "start_timeout", "secret prompt text", 2_000);
    expect(lines).toContain("item PAS-2 failed: start_timeout");
    expect(lines.join("\n")).not.toContain("secret prompt text");
  });

  test("writes one line when a work item hits its time cap", async () => {
    const db = database();
    insertQueuedItem(db, { id: "PAS-3", maxAwakeMs: 1_000 });
    db.run("UPDATE work_item SET session_key = NULL WHERE id = 'PAS-3'");
    await beginImplementRun(sqliteDb(db), "PAS-3", 1_000);
    await accrueAwake(sqliteDb(db), "PAS-3", 0, 1_000, undefined, true);
    lines = [];
    await accrueAwake(sqliteDb(db), "PAS-3", 1_000, 2_000, undefined, true);
    expect(lines.filter((line) => line.startsWith("item "))).toEqual([
      "item PAS-3 failed: cap:time",
    ]);
  });

  test("writes done, dead and cancelled outcomes for item jobs", async () => {
    const db = database();
    await enqueueJob(sqliteDb(db), { queue: JOB_KIND.resume, payload: { itemId: "a" }, now: 0 });
    await completeJob(sqliteDb(db), await claim(db, JOB_KIND.resume), 1_000);
    await enqueueJob(sqliteDb(db), {
      queue: JOB_KIND.merge,
      payload: { itemId: "b" },
      maxAttempts: 1,
      now: 0,
    });
    await failJob(sqliteDb(db), await claim(db, JOB_KIND.merge), new Error("merge\nconflict"), {
      now: 1_000,
    });
    await enqueueJob(sqliteDb(db), { queue: JOB_KIND.resume, payload: { itemId: "c" }, now: 0 });
    await cancelOpenJobs(sqliteDb(db), { itemId: "c", reason: "stopped", now: 1_000 });
    expect(lines.filter((line) => line.startsWith("job "))).toEqual([
      "job 1 run.resume done item=a attempts=1/10",
      "job 2 github.merge dead item=b attempts=1/1 error=merge conflict",
      "job 3 run.resume cancelled item=c attempts=0/10 error=stopped",
    ]);
  });

  test("leaves other queues and retried jobs out", async () => {
    const db = database();
    await enqueueJob(sqliteDb(db), { queue: JOB_KIND.catchup, now: 0 });
    await completeJob(sqliteDb(db), await claim(db, JOB_KIND.catchup), 1_000);
    await enqueueJob(sqliteDb(db), { queue: JOB_KIND.resume, payload: { itemId: "a" }, now: 0 });
    await failJob(sqliteDb(db), await claim(db, JOB_KIND.resume), new Error("busy"), {
      now: 1_000,
    });
    expect(lines.filter((line) => line.startsWith("job "))).toEqual([]);
  });
});
