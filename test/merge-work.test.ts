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
  legacyMigrate,
  migrations,
  openDatabase,
  recordCiRound,
  recordRebaseReturn,
  sqliteDb,
  type NewJob,
} from "../src/db";
import { legacyTempDb } from "./helpers";

const samples = [
  "github.merge",
  "github.merge.close",
  "github.mergeable",
  "run.resume",
  "item.start",
];

test("the merge-work SQL classifies every job as isMergeWork does", () => {
  const db = openDatabase(":memory:");
  try {
    db.run("CREATE TABLE sample (queue TEXT NOT NULL)");
    for (const queue of samples) db.run("INSERT INTO sample VALUES (?)", [queue]);
    const rows = db
      .query<{ queue: string; merge: number }, []>(
        `SELECT queue, ${mergeLaneSql("s")} AS merge FROM sample s`,
      )
      .all();
    expect(rows.map((row) => [row.queue, row.merge === 1])).toEqual(
      samples.map((queue) => [queue, isMergeWork(queue)]),
    );
    expect(samples.filter((queue) => isMergeWork(queue))).toEqual([
      "github.merge",
      "github.merge.close",
    ]);
  } finally {
    db.close();
  }
});

test("cancelling the merge lane cancels a merge job", async () => {
  const db = legacyTempDb();
  try {
    await enqueueJob(sqliteDb(db), { queue: JOB_KIND.merge, payload: {}, now: 1 });
    expect(await cancelOpenJobs(sqliteDb(db), { reason: "stop", mergeLane: true, now: 2 })).toBe(1);
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

async function userTurn(db: Database, itemId: string, now: number): Promise<number> {
  return await enqueueJob(sqliteDb(db), {
    queue: JOB_KIND.resume,
    jobKey: `linear-turn:${itemId}:${now}`,
    payload: { itemId },
    now,
  });
}

test("rebase returns are counted from rebase_return rows after the latest user turn", async () => {
  const db = legacyTempDb();
  try {
    insertItem(db, "item");
    const before = await enqueueJob(sqliteDb(db), {
      queue: JOB_KIND.resume,
      payload: { itemId: "item" },
      now: 1,
    });
    await recordRebaseReturn(sqliteDb(db), {
      itemId: "item",
      jobId: before,
      candidate: "a1",
      reason: "merge",
    });
    const turn = await userTurn(db, "item", 2);
    expect(await countRebaseReturns(sqliteDb(db), "item", turn)).toBe(0);
    await recordRebaseReturn(sqliteDb(db), {
      itemId: "item",
      jobId: turn,
      candidate: null,
      reason: "linear",
    });
    const after = await enqueueJob(sqliteDb(db), {
      queue: JOB_KIND.resume,
      payload: { itemId: "item" },
      now: 3,
    });
    await recordRebaseReturn(sqliteDb(db), {
      itemId: "item",
      jobId: after,
      candidate: "b2",
      reason: "github_queue",
    });
    expect(await countRebaseReturns(sqliteDb(db), "item", turn)).toBe(2);
    expect(await countRebaseReturns(sqliteDb(db), "item", 0)).toBe(3);
  } finally {
    db.close();
  }
});

test("a rebase return keeps the main commit, files and time it conflicted on", async () => {
  const db = legacyTempDb();
  try {
    insertItem(db, "item");
    const first = await enqueueJob(sqliteDb(db), {
      queue: JOB_KIND.resume,
      payload: { itemId: "item" },
      now: 1,
    });
    await recordRebaseReturn(sqliteDb(db), {
      itemId: "item",
      jobId: first,
      candidate: null,
      reason: "merge",
      base: "abc1234",
      files: ["src/index.ts"],
      recordedAt: 10,
    });
    const second = await enqueueJob(sqliteDb(db), {
      queue: JOB_KIND.resume,
      payload: { itemId: "item" },
      now: 2,
    });
    await recordRebaseReturn(sqliteDb(db), {
      itemId: "item",
      jobId: second,
      candidate: null,
      reason: "linear",
    });
    expect(listRebaseReturns(db, "item", 0)).toEqual([
      { jobId: first, reason: "merge", base: "abc1234", files: ["src/index.ts"], recordedAt: 10 },
      { jobId: second, reason: "linear", base: null, files: null, recordedAt: null },
    ]);
    expect(listRebaseReturns(db, "item", second)).toHaveLength(1);
  } finally {
    db.close();
  }
});

test("CI fixes are counted from the CI rounds recorded after the latest user turn", async () => {
  const db = legacyTempDb();
  try {
    insertItem(db, "item");
    const round = async (head: string, fix: number | null, recordedAt: number) =>
      await recordCiRound(sqliteDb(db), {
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
    expect(await countCiFixes(sqliteDb(db), "item", 0)).toBe(2);
    await round("h2", 3, 30);
    expect(await countCiFixes(sqliteDb(db), "item", 0)).toBe(3);
    const turn = await userTurn(db, "item", 40);
    expect(await countCiFixes(sqliteDb(db), "item", turn)).toBe(0);
    await round("h3", 1, 50);
    await round("h4", null, 60);
    expect(await countCiFixes(sqliteDb(db), "item", turn)).toBe(1);
  } finally {
    db.close();
  }
});

test("the rebase_return migration backfills rebase-conflict returns so budgets survive a deploy", async () => {
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
    const legacyJob = (legacy: Database, input: NewJob) =>
      legacy
        .query<{ id: number }, [string, string | null, string, number]>(
          "INSERT INTO job(queue,job_key,payload,priority,run_at,max_attempts,created_at) VALUES(?,?,?,5,?,10,0) RETURNING id",
        )
        .get(input.queue, input.jobKey ?? null, JSON.stringify(input.payload), input.now ?? 0)!.id;
    const merge = legacyJob(db, {
      queue: JOB_KIND.resume,
      jobKey: "rebase-conflict:item:0:0",
      payload: { itemId: "item", reason: "rebase-conflict" },
      now: 1,
    });
    const linear = legacyJob(db, {
      queue: JOB_KIND.resume,
      jobKey: "linear-turn:session:1",
      payload: { itemId: "item", reason: "rebase-conflict" },
      now: 2,
    });
    legacyJob(db, {
      queue: JOB_KIND.resume,
      payload: { itemId: "item", reason: "ci-failed" },
      now: 3,
    });
    legacyJob(db, {
      queue: JOB_KIND.resume,
      payload: { itemId: "gone", reason: "rebase-conflict" },
      now: 4,
    });
    legacyMigrate(db);
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
    expect(await countRebaseReturns(sqliteDb(db), "item", 0)).toBe(2);
    expect(await listJobs(sqliteDb(db))).toHaveLength(4);
  } finally {
    db.close();
  }
});
