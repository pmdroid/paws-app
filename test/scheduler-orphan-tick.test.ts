import { expect, test } from "bun:test";
import { FakeClock, JOB_KIND } from "../src/core";
import {
  JobLoop,
  enqueueJob,
  ensureLinearSession,
  insertQueuedItem,
  migrations,
  openDatabase,
} from "../src/db";
import { registerScheduler } from "../src/scheduler";
import { tempDb } from "./helpers";
import { workspaceDispatch } from "./fake-workspace";

const GRACE_MS = 5 * 60_000;

test("one scheduler tick requeues an orphan and admits its resume in the same pass", async () => {
  const db = tempDb();
  const clock = new FakeClock(1_000_000);
  try {
    ensureLinearSession(db, { sessionId: "orphan-session", issueId: "orphan-parent", now: 1 });
    insertQueuedItem(db, { id: "orphan", now: 1, sessionKey: "orphan-session" });
    db.run("UPDATE work_item SET state='running' WHERE id='orphan'");
    const finished = enqueueJob(db, {
      queue: JOB_KIND.start,
      payload: { itemId: "orphan" },
      now: 1,
    });
    db.run("UPDATE job SET status='done',finished_at=? WHERE id=?", [
      clock.now() - GRACE_MS - 1,
      finished,
    ]);
    insertQueuedItem(db, { id: "next", now: 2 });
    const jobs = new JobLoop(db, clock);
    const ticks: string[][] = [];
    registerScheduler(
      jobs,
      () => void ticks.push(workspaceDispatch(db, { now: clock.now() })),
      clock.now(),
    );

    const tick = await jobs.tick(["scheduler.tick"]);
    expect(tick?.queue).toBe("scheduler.tick");
    const resume = db
      .query<{ id: number; payload: string }, []>(
        `SELECT id,payload FROM job WHERE queue='${JOB_KIND.resume}' AND status='pending'`,
      )
      .all();
    expect(resume).toHaveLength(1);
    expect(JSON.parse(resume[0]!.payload)).toMatchObject({
      itemId: "orphan",
      freshSession: true,
      reason: "orphaned",
    });
    expect(
      db
        .query<{ itemId: string; jobId: number }, []>(
          "SELECT item_id AS itemId,job_id AS jobId FROM scheduler_admission ORDER BY item_id",
        )
        .all()
        .find((row) => row.itemId === "orphan"),
    ).toEqual({ itemId: "orphan", jobId: resume[0]!.id });
    expect(ticks).toEqual([["next"]]);
    expect(
      db
        .query<{ body: string }, []>(
          "SELECT json_extract(payload,'$.body') AS body FROM outbox WHERE idempotency_key LIKE 'orphan:orphan:%'",
        )
        .all(),
    ).toEqual([{ body: "Nothing was moving orphan forward, so Paws picked it up again." }]);

    const claimed: string[] = [];
    jobs.register(JOB_KIND.resume, (job) => {
      claimed.push((job.payload as { itemId: string }).itemId);
    });
    expect((await jobs.tick([JOB_KIND.resume]))?.queue).toBe(JOB_KIND.resume);
    expect(claimed).toEqual(["orphan"]);
  } finally {
    db.close();
  }
});

test("the migration deletes the retired execution.reconcile recurring job", () => {
  const db = openDatabase(":memory:");
  try {
    db.run(
      "CREATE TABLE schema_migration (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT",
    );
    const cutoff = migrations.findIndex(
      (migration) => migration.id === "122_drop_execution_reconcile_job",
    );
    expect(cutoff).toBeGreaterThan(0);
    for (const migration of migrations.slice(0, cutoff)) {
      if (migration.foreignKeys === false) db.run("PRAGMA foreign_keys = OFF");
      db.transaction(() => db.run(migration.sql)).immediate();
      db.run("PRAGMA foreign_keys = ON");
    }
    for (const queue of ["execution.reconcile", "scheduler.tick"])
      enqueueJob(db, { queue, jobKey: queue, recurringEveryMs: 30_000, now: 1 });
    db.transaction(() => db.run(migrations[cutoff]!.sql)).immediate();
    expect(db.query("SELECT queue FROM job ORDER BY queue").all()).toEqual([
      { queue: "scheduler.tick" },
    ]);
  } finally {
    db.close();
  }
});
