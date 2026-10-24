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
} from "../src/db";
import { createAdmission, dispatch } from "../src/scheduler";
import { migratedDatabase, tempDb, tempHome } from "./helpers";

const repository = { owner: "owner", repo: "repo", remoteUrl: "https://example.invalid/repo.git" };

function disagreements(run: () => void): string[] {
  const lines: string[] = [];
  const restore = setJournalSink((line) => lines.push(line));
  try {
    run();
  } finally {
    restore();
  }
  return lines.filter((line) => line.startsWith("claim gate disagreement"));
}

function queued(db: Database, id: string, now = 0): void {
  insertQueuedItem(db, { id, now });
  bindWorkItemRepository(db, id, repository);
}

function inFlight(db: Database, id: string, event: "turn_ended" | "lease_expired"): number {
  queued(db, id);
  applyWorkItemEvent(db, id, "dispatched");
  applyWorkItemEvent(db, id, event);
  return enqueueJob(db, {
    queue: event === "turn_ended" ? JOB_KIND.reverify : JOB_KIND.resume,
    payload: { itemId: id },
    now: 0,
  });
}

function itemOf(job: Job | null): string | null {
  return (job?.payload as { itemId?: string } | undefined)?.itemId ?? null;
}

test("an unreserved start the legacy rule claims is journaled with its item, job and reason", () => {
  const db = tempDb();
  try {
    queued(db, "solo");
    const id = enqueueJob(db, { queue: JOB_KIND.start, payload: { itemId: "solo" }, now: 0 });
    let claimed: Job | null = null;
    const lines = disagreements(() => {
      claimed = claimNextJob(db, { now: 1000 });
    });
    assert.equal(claimed!.id, id);
    assert.deepEqual(lines, [
      `claim gate disagreement job=${id} item.start item=solo legacy=claim reservation=hold reason=no reservation`,
    ]);
  } finally {
    db.close();
  }
});

test("a reserved start the legacy rule holds behind unreserved work is journaled once", () => {
  const db = tempDb();
  try {
    queued(db, "legacy");
    applyWorkItemEvent(db, "legacy", "dispatched");
    insertRun(db, { itemId: "legacy", now: 0, status: "active" });
    queued(db, "next", 1);
    assert.deepEqual(dispatch(db, { now: 1000 }), ["next"]);
    const start = db
      .query<{ id: number }, []>(
        "SELECT job_id AS id FROM scheduler_admission WHERE item_id='next'",
      )
      .get()!.id;
    const lines = disagreements(() => {
      assert.equal(claimNextJob(db, { now: 1000 }), null);
      assert.equal(claimNextJob(db, { now: 1001 }), null);
    });
    assert.deepEqual(lines, [
      `claim gate disagreement job=${start} item.start item=next legacy=hold reservation=claim reason=unreserved work in flight`,
    ]);
  } finally {
    db.close();
  }
});

test("a queued Reservation survives a restart and both rules claim its start", () => {
  const path = join(tempHome(), "paws.db");
  const db = migratedDatabase(path);
  queued(db, "a");
  queued(db, "b", 1);
  assert.deepEqual(dispatch(db, { now: 1000 }), ["a", "b"]);
  db.close();
  const reopened = openDatabase(path);
  try {
    let claimed: (string | null)[] = [];
    const lines = disagreements(() => {
      assert.deepEqual(dispatch(reopened, { now: 2000 }), []);
      claimed = [claimNextJob(reopened, { now: 2000 }), claimNextJob(reopened, { now: 2000 })].map(
        itemOf,
      );
    });
    assert.deepEqual(claimed, ["a", "b"]);
    assert.deepEqual(lines, []);
  } finally {
    reopened.close();
  }
});

test("work in flight without a Reservation after a restart is reconstructed before its claim", () => {
  const path = join(tempHome(), "paws.db");
  const db = migratedDatabase(path);
  inFlight(db, "a", "turn_ended");
  inFlight(db, "b", "lease_expired");
  db.close();
  const reopened = openDatabase(path);
  try {
    let claimed: (string | null)[] = [];
    const lines = disagreements(() => {
      dispatch(reopened, { now: 1000 });
      claimed = [claimNextJob(reopened, { now: 1000 }), claimNextJob(reopened, { now: 1000 })].map(
        itemOf,
      );
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

test("resume and reverify claim against their Reservation and never twice for one item", () => {
  const db = tempDb();
  try {
    inFlight(db, "verify", "turn_ended");
    inFlight(db, "recover", "lease_expired");
    let claimed: (string | null)[] = [];
    const lines = disagreements(() => {
      dispatch(db, { now: 1000 });
      claimed = [claimNextJob(db, { now: 1000 }), claimNextJob(db, { now: 1000 })].map(itemOf);
      enqueueJob(db, { queue: JOB_KIND.resume, payload: { itemId: "recover" }, now: 1000 });
      assert.equal(claimNextJob(db, { now: 1000 }), null);
    });
    assert.deepEqual(claimed.sort(), ["recover", "verify"]);
    assert.deepEqual(lines, []);
  } finally {
    db.close();
  }
});

test("a Project pause between dispatch and claim retracts the stale Reservation", () => {
  const db = tempDb();
  try {
    queued(db, "paused");
    const lines = disagreements(() => {
      assert.deepEqual(dispatch(db, { now: 1000 }), ["paused"]);
      const paused = createAdmission({ db, authority: () => false });
      assert.deepEqual(dispatch(db, { now: 1001, admission: paused }), []);
      assert.equal(claimNextJob(db, { now: 1001 }), null);
    });
    assert.equal(db.query("SELECT 1 FROM scheduler_admission").get(), null);
    assert.equal(getJob(db, 1)!.status, "cancelled");
    assert.deepEqual(lines, []);
  } finally {
    db.close();
  }
});

test("an access change between dispatch and claim retracts only that Item's Reservation", () => {
  const db = tempDb();
  try {
    queued(db, "revoked");
    queued(db, "kept", 1);
    const revoked = db
      .query<{ id: string }, []>("SELECT delegation_id AS id FROM work_item WHERE id='revoked'")
      .get()!.id;
    let claimed: (string | null)[] = [];
    const lines = disagreements(() => {
      assert.deepEqual(dispatch(db, { now: 1000 }), ["revoked", "kept"]);
      const access = createAdmission({ db, authority: (id) => id !== revoked });
      assert.deepEqual(dispatch(db, { now: 1001, admission: access }), []);
      claimed = [claimNextJob(db, { now: 1001 }), claimNextJob(db, { now: 1001 })].map(itemOf);
    });
    assert.deepEqual(claimed, ["kept", null]);
    assert.deepEqual(lines, []);
  } finally {
    db.close();
  }
});
