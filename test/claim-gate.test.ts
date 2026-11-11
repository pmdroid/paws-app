import assert from "node:assert/strict";
import { test } from "bun:test";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { JOB_KIND } from "../src/core";
import {
  applyWorkItemEvent,
  bindWorkItemRepository,
  claimNextJob,
  enqueueJob,
  getJob,
  insertQueuedItem,
  insertRun,
  openDatabase,
  setJournalSink,
  type Job,
  sqliteDb,
} from "../src/db";
import { dispatch } from "../src/scheduler";
import { workspaceAdmission, workspaceDispatch } from "./fake-workspace";
import { migratedDatabase, tempDb, tempHome } from "./helpers";

const repository = { owner: "owner", repo: "repo", remoteUrl: "https://example.invalid/repo.git" };

async function disagreements(run: () => unknown): Promise<string[]> {
  const lines: string[] = [];
  const restore = setJournalSink((line) => lines.push(line));
  try {
    await run();
  } finally {
    restore();
  }
  return lines.filter((line) => line.startsWith("claim gate disagreement"));
}

async function queued(db: Database, id: string, now = 0): Promise<void> {
  await insertQueuedItem(db, { id, now });
  await bindWorkItemRepository(sqliteDb(db), id, repository);
}

async function inFlight(
  db: Database,
  id: string,
  event: "turn_ended" | "lease_expired",
): Promise<number> {
  await queued(db, id);
  await applyWorkItemEvent(sqliteDb(db), id, "dispatched");
  await applyWorkItemEvent(sqliteDb(db), id, event);
  return await enqueueJob(sqliteDb(db), {
    queue: event === "turn_ended" ? JOB_KIND.reverify : JOB_KIND.resume,
    payload: { itemId: id },
    now: 0,
  });
}

function itemOf(job: Job | null): string | null {
  return (job?.payload as { itemId?: string } | undefined)?.itemId ?? null;
}

test("an unreserved start stays pending without a legacy claim decision", async () => {
  const db = tempDb();
  try {
    await queued(db, "solo");
    const id = await enqueueJob(sqliteDb(db), {
      queue: JOB_KIND.start,
      payload: { itemId: "solo" },
      now: 0,
    });
    let claimed: Job | null = null;
    const lines = await disagreements(async () => {
      claimed = await claimNextJob(sqliteDb(db), { now: 1000 });
    });
    assert.equal(claimed, null);
    assert.equal((await getJob(sqliteDb(db), id))?.status, "pending");
    assert.deepEqual(lines, []);
  } finally {
    db.close();
  }
});

test("a reserved start is claimed without the legacy gate", async () => {
  const db = tempDb();
  try {
    await queued(db, "legacy");
    await applyWorkItemEvent(sqliteDb(db), "legacy", "dispatched");
    await insertRun(sqliteDb(db), { itemId: "legacy", now: 0, status: "active" });
    await queued(db, "next", 1);
    assert.deepEqual(await workspaceDispatch(db, { now: 1000 }), ["next"]);
    const start = db
      .query<{ id: number }, []>(
        "SELECT job_id AS id FROM scheduler_admission WHERE item_id='next'",
      )
      .get()!.id;
    const lines = await disagreements(async () => {
      assert.equal((await claimNextJob(sqliteDb(db), { now: 1000 }))?.id, start);
    });
    assert.deepEqual(lines, []);
  } finally {
    db.close();
  }
});

test("a queued Reservation survives a restart and both rules claim its start", async () => {
  const path = join(tempHome(), "paws.db");
  const db = migratedDatabase(path);
  await queued(db, "a");
  await queued(db, "b", 1);
  assert.deepEqual(await workspaceDispatch(db, { now: 1000 }), ["a", "b"]);
  db.close();
  const reopened = openDatabase(path);
  try {
    let claimed: (string | null)[] = [];
    const lines = await disagreements(async () => {
      assert.deepEqual(await workspaceDispatch(reopened, { now: 2000 }), []);
      claimed = [
        await claimNextJob(sqliteDb(reopened), { now: 2000 }),
        await claimNextJob(sqliteDb(reopened), { now: 2000 }),
      ].map(itemOf);
    });
    assert.deepEqual(claimed, ["a", "b"]);
    assert.deepEqual(lines, []);
  } finally {
    reopened.close();
  }
});

test("work in flight without a Reservation after a restart is reconstructed before its claim", async () => {
  const path = join(tempHome(), "paws.db");
  const db = migratedDatabase(path);
  await inFlight(db, "a", "turn_ended");
  await inFlight(db, "b", "lease_expired");
  db.close();
  const reopened = openDatabase(path);
  try {
    let claimed: (string | null)[] = [];
    const lines = await disagreements(async () => {
      await workspaceDispatch(reopened, { now: 1000 });
      claimed = [
        await claimNextJob(sqliteDb(reopened), { now: 1000 }),
        await claimNextJob(sqliteDb(reopened), { now: 1000 }),
      ].map(itemOf);
    });
    assert.deepEqual(claimed.sort(), ["a", "b"]);
    assert.equal(
      reopened.query("SELECT item_id FROM scheduler_admission ORDER BY item_id").all().length,
      2,
    );
    assert.deepEqual(lines, []);
  } finally {
    reopened.close();
  }
});

test("resume and reverify claim against their Reservation and never twice for one item", async () => {
  const db = tempDb();
  try {
    await inFlight(db, "verify", "turn_ended");
    await inFlight(db, "recover", "lease_expired");
    let claimed: (string | null)[] = [];
    const lines = await disagreements(async () => {
      await workspaceDispatch(db, { now: 1000 });
      claimed = [
        await claimNextJob(sqliteDb(db), { now: 1000 }),
        await claimNextJob(sqliteDb(db), { now: 1000 }),
      ].map(itemOf);
      await enqueueJob(sqliteDb(db), {
        queue: JOB_KIND.resume,
        payload: { itemId: "recover" },
        now: 1000,
      });
      assert.equal(await claimNextJob(sqliteDb(db), { now: 1000 }), null);
    });
    assert.deepEqual(claimed.sort(), ["recover", "verify"]);
    assert.deepEqual(lines, []);
  } finally {
    db.close();
  }
});

test("a Project pause between dispatch and claim retracts the stale Reservation", async () => {
  const db = tempDb();
  try {
    await queued(db, "paused");
    const lines = await disagreements(async () => {
      assert.deepEqual(await workspaceDispatch(db, { now: 1000 }), ["paused"]);
      const paused = workspaceAdmission(db, { authority: () => false });
      assert.deepEqual(await dispatch(sqliteDb(db), { now: 1001, admission: paused }), []);
      assert.equal(await claimNextJob(sqliteDb(db), { now: 1001 }), null);
    });
    assert.equal(db.query("SELECT 1 FROM scheduler_admission").get(), null);
    assert.equal((await getJob(sqliteDb(db), 1))!.status, "cancelled");
    assert.deepEqual(lines, []);
  } finally {
    db.close();
  }
});

test("an access change between dispatch and claim retracts only that Item's Reservation", async () => {
  const db = tempDb();
  try {
    await queued(db, "revoked");
    await queued(db, "kept", 1);
    const revoked = db
      .query<{ id: string }, []>("SELECT delegation_id AS id FROM work_item WHERE id='revoked'")
      .get()!.id;
    let claimed: (string | null)[] = [];
    const lines = await disagreements(async () => {
      assert.deepEqual(await workspaceDispatch(db, { now: 1000 }), ["revoked", "kept"]);
      const access = workspaceAdmission(db, { authority: (id) => id !== revoked });
      assert.deepEqual(await dispatch(sqliteDb(db), { now: 1001, admission: access }), []);
      claimed = [
        await claimNextJob(sqliteDb(db), { now: 1001 }),
        await claimNextJob(sqliteDb(db), { now: 1001 }),
      ].map(itemOf);
    });
    assert.deepEqual(claimed, ["kept", null]);
    assert.deepEqual(lines, []);
  } finally {
    db.close();
  }
});
