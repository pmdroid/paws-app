import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { isMergeWork, JOB_KIND } from "../src/core";
import {
  cancelOpenJobs,
  countCiFixes,
  countRebaseReturns,
  enqueueJob,
  listJobs,
  listRebaseReturns,
  mergeLaneSql,
  migrate,
  migrations,
  openDatabase,
  recordCiRound,
  recordRebaseReturn,
} from "../src/db";
import { tempDb } from "./helpers";

const samples: [string, string][] = [
  ["github.merge", ""],
  ["github.merge.close", ""],
  ["github.mergeable", ""],
  ["run.resume", "merge"],
  ["run.resume", "merge:acme/app"],
  ["run.resume", "merged"],
  ["run.resume", ""],
  ["item.start", "default"],
];

test("isMergeWork counts a per-repository merge lane", () => {
  expect(isMergeWork("run.resume", "merge:acme/app")).toBe(true);
  expect(isMergeWork("run.resume", "merged")).toBe(false);
});

test("the merge-work SQL classifies every job as isMergeWork does", () => {
  const db = openDatabase(":memory:");
  try {
    db.run("CREATE TABLE sample (queue TEXT NOT NULL, lane TEXT NOT NULL)");
    for (const [queue, lane] of samples) db.run("INSERT INTO sample VALUES (?, ?)", [queue, lane]);
    const rows = db
      .query<{ queue: string; lane: string; merge: number }, []>(
        `SELECT queue, lane, ${mergeLaneSql("s")} AS merge FROM sample s`,
      )
      .all();
    expect(rows.map((row) => [row.queue, row.lane, row.merge === 1])).toEqual(
      samples.map(([queue, lane]) => [queue, lane, isMergeWork(queue, lane)]),
    );
  } finally {
    db.close();
  }
});

test("cancelling the merge lane cancels a per-repository merge lane job", () => {
  const db = tempDb();
  try {
    enqueueJob(db, { queue: "run.resume", lane: "merge:acme/app", payload: {}, now: 1 });
    expect(cancelOpenJobs(db, { reason: "stop", mergeLane: true, now: 2 })).toBe(1);
  } finally {
    db.close();
  }
});

function insertItem(db: Database, id: string): void {
  db.run(
    "INSERT INTO work_item(id,delegation_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at,session_key) VALUES(?,?,?,?,?,'merge_queue',?,0,1000,?)",
    [id, id, id, id, id, `paws/${id}`, id],
  );
}

function userTurn(db: Database, itemId: string, now: number): number {
  return enqueueJob(db, {
    queue: JOB_KIND.resume,
    jobKey: `linear-turn:${itemId}:${now}`,
    payload: { itemId },
    now,
  });
}

test("rebase returns are counted from rebase_return rows after the latest user turn", () => {
  const db = tempDb();
  try {
    insertItem(db, "item");
    const before = enqueueJob(db, { queue: JOB_KIND.resume, payload: { itemId: "item" }, now: 1 });
    recordRebaseReturn(db, { itemId: "item", jobId: before, candidate: "a1", reason: "merge" });
    const turn = userTurn(db, "item", 2);
    expect(countRebaseReturns(db, "item", turn)).toBe(0);
    recordRebaseReturn(db, { itemId: "item", jobId: turn, candidate: null, reason: "linear" });
    const after = enqueueJob(db, { queue: JOB_KIND.resume, payload: { itemId: "item" }, now: 3 });
    recordRebaseReturn(db, {
      itemId: "item",
      jobId: after,
      candidate: "b2",
      reason: "github_queue",
    });
    expect(countRebaseReturns(db, "item", turn)).toBe(2);
    expect(countRebaseReturns(db, "item", 0)).toBe(3);
  } finally {
    db.close();
  }
});

test("a rebase return keeps the main commit, files and time it conflicted on", () => {
  const db = tempDb();
  try {
    insertItem(db, "item");
    const first = enqueueJob(db, { queue: JOB_KIND.resume, payload: { itemId: "item" }, now: 1 });
    recordRebaseReturn(db, {
      itemId: "item",
      jobId: first,
      candidate: null,
      reason: "merge",
      base: "abc1234",
      files: ["src/index.ts"],
      recordedAt: 10,
    });
    const second = enqueueJob(db, { queue: JOB_KIND.resume, payload: { itemId: "item" }, now: 2 });
    recordRebaseReturn(db, { itemId: "item", jobId: second, candidate: null, reason: "linear" });
    expect(listRebaseReturns(db, "item", 0)).toEqual([
      { jobId: first, reason: "merge", base: "abc1234", files: ["src/index.ts"], recordedAt: 10 },
      { jobId: second, reason: "linear", base: null, files: null, recordedAt: null },
    ]);
    expect(listRebaseReturns(db, "item", second)).toHaveLength(1);
  } finally {
    db.close();
  }
});

test("CI fixes are counted from the CI rounds recorded after the latest user turn", () => {
  const db = tempDb();
  try {
    insertItem(db, "item");
    const round = (head: string, fix: number | null, recordedAt: number) =>
      recordCiRound(db, {
        itemId: "item",
        head,
        runId: null,
        next: fix === null ? "asked" : "agent",
        fix,
        fixLimit: 3,
        checks: [],
        recordedAt,
      });
    round("h1", 1, 10);
    round("h2", 2, 20);
    expect(countCiFixes(db, "item", 0)).toBe(2);
    round("h2", 3, 30);
    expect(countCiFixes(db, "item", 0)).toBe(3);
    const turn = userTurn(db, "item", 40);
    expect(countCiFixes(db, "item", turn)).toBe(0);
    round("h3", 1, 50);
    round("h4", null, 60);
    expect(countCiFixes(db, "item", turn)).toBe(1);
  } finally {
    db.close();
  }
});

test("the rebase_return migration backfills rebase-conflict returns so budgets survive a deploy", () => {
  const db = openDatabase(":memory:");
  try {
    db.run(
      "CREATE TABLE schema_migration (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT",
    );
    const cutoff = migrations.findIndex((migration) => migration.id === "112_rebase_return");
    expect(cutoff).toBeGreaterThan(0);
    for (const migration of migrations.slice(0, cutoff)) {
      db.run(migration.sql);
      db.run("INSERT INTO schema_migration (id, applied_at) VALUES (?, 0)", [migration.id]);
    }
    insertItem(db, "item");
    const merge = enqueueJob(db, {
      queue: JOB_KIND.resume,
      jobKey: "rebase-conflict:item:0:0",
      payload: { itemId: "item", reason: "rebase-conflict" },
      now: 1,
    });
    const linear = enqueueJob(db, {
      queue: JOB_KIND.resume,
      jobKey: "linear-turn:session:1",
      payload: { itemId: "item", reason: "rebase-conflict" },
      now: 2,
    });
    enqueueJob(db, {
      queue: JOB_KIND.resume,
      payload: { itemId: "item", reason: "ci-failed" },
      now: 3,
    });
    enqueueJob(db, {
      queue: JOB_KIND.resume,
      payload: { itemId: "gone", reason: "rebase-conflict" },
      now: 4,
    });
    migrate(db);
    expect(
      db
        .query<{ job_id: number; item_id: string; candidate: string | null; reason: string }, []>(
          "SELECT job_id, item_id, candidate, reason FROM rebase_return ORDER BY job_id",
        )
        .all(),
    ).toEqual([
      { job_id: merge, item_id: "item", candidate: null, reason: "merge" },
      { job_id: linear, item_id: "item", candidate: null, reason: "linear" },
    ]);
    expect(countRebaseReturns(db, "item", 0)).toBe(2);
    expect(listJobs(db)).toHaveLength(4);
  } finally {
    db.close();
  }
});
