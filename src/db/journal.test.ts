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

function claim(db: ReturnType<typeof database>, queue: string) {
  const job = claimNextJob(db, { workerId: "w", now: 1_000, queues: [queue] });
  if (job === null) throw new Error(`no ${queue} job`);
  return job;
}

describe("journal", () => {
  test("writes one line per work item transition", () => {
    const db = database();
    insertQueuedItem(db, { id: "PAS-1" });
    beginImplementRun(db, "PAS-1", 1_000);
    enterMergeQueue(db, "PAS-1", { phase: "merge_queue" });
    applyWorkItemEvent(db, "PAS-1", "merge_accepted");
    expect(lines).toEqual([
      "transition PAS-1 queued --dispatched--> running v1",
      "transition PAS-1 running --turn_ended--> verifying v2",
      "transition PAS-1 verifying --closeout_accepted--> merge_queue v3",
      "transition PAS-1 merge_queue --merge_accepted--> merged v4",
    ]);
  });

  test("writes the reason when a work item fails", () => {
    const db = database();
    insertQueuedItem(db, { id: "PAS-2", sessionKey: "s" });
    beginImplementRun(db, "PAS-2", 1_000);
    const item = getWorkItem(db, "PAS-2");
    if (item === null) throw new Error("missing item");
    lines = [];
    failWorkItem(db, item, "start_timeout", "secret prompt text", 2_000);
    expect(lines).toContain("item PAS-2 failed: start_timeout");
    expect(lines.join("\n")).not.toContain("secret prompt text");
  });

  test("writes one line when a work item hits its time cap", () => {
    const db = database();
    insertQueuedItem(db, { id: "PAS-3", sessionKey: "s", maxAwakeMs: 1_000 });
    beginImplementRun(db, "PAS-3", 1_000);
    accrueAwake(db, "PAS-3", 0, 1_000);
    lines = [];
    accrueAwake(db, "PAS-3", 1_000, 2_000);
    expect(lines.filter((line) => line.startsWith("item "))).toEqual([
      "item PAS-3 failed: cap:time",
    ]);
  });

  test("writes done, dead and cancelled outcomes for item jobs", () => {
    const db = database();
    enqueueJob(db, { queue: JOB_KIND.resume, payload: { itemId: "a" }, now: 0 });
    completeJob(db, claim(db, JOB_KIND.resume), 1_000);
    enqueueJob(db, {
      queue: JOB_KIND.merge,
      payload: { itemId: "b" },
      maxAttempts: 1,
      now: 0,
    });
    failJob(db, claim(db, JOB_KIND.merge), new Error("merge\nconflict"), { now: 1_000 });
    enqueueJob(db, { queue: JOB_KIND.resume, payload: { itemId: "c" }, now: 0 });
    cancelOpenJobs(db, { itemId: "c", reason: "stopped", now: 1_000 });
    expect(lines.filter((line) => line.startsWith("job "))).toEqual([
      "job 1 run.resume done item=a attempts=1/10",
      "job 2 github.merge dead item=b attempts=1/1 error=merge conflict",
      "job 3 run.resume cancelled item=c attempts=0/10 error=stopped",
    ]);
  });

  test("leaves other queues and retried jobs out", () => {
    const db = database();
    enqueueJob(db, { queue: JOB_KIND.catchup, now: 0 });
    completeJob(db, claim(db, JOB_KIND.catchup), 1_000);
    enqueueJob(db, { queue: JOB_KIND.resume, payload: { itemId: "a" }, now: 0 });
    failJob(db, claim(db, JOB_KIND.resume), new Error("busy"), { now: 1_000 });
    expect(lines.filter((line) => line.startsWith("job "))).toEqual([]);
  });
});
