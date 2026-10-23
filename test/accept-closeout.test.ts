import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import {
  getWorkItem,
  insertQueuedItem,
  insertRun,
  joinMergeQueue,
  listJobs,
  openDatabase,
  setCurrentRun,
} from "../src/db";
import { acceptCloseout } from "../src/loop";
import { migratedDatabase, tempDb } from "./helpers";

const base = "b".repeat(40);
const head = "a".repeat(40);

function verifying(db: Database, state = "verifying") {
  insertQueuedItem(db, { id: "item", now: 1 });
  db.run("UPDATE work_item SET state = ? WHERE id = 'item'", [state]);
  joinMergeQueue(db, { itemId: "item", repository: "acme/platform", now: 1 });
  const run = insertRun(db, { itemId: "item", kind: "recheck", status: "active", now: 1 });
  setCurrentRun(db, "item", run.id);
  const item = getWorkItem(db, "item")!;
  return { version: item.version, runId: run.id };
}

function accept(db: Database, expected: { version: number; runId: string | null }, extra = {}) {
  return acceptCloseout(db, {
    itemId: "item",
    expected,
    base,
    head,
    summary: "accepted",
    now: 10,
    ...extra,
  });
}

function queueEntries(db: Database): number {
  return db.query<{ n: number }, []>("SELECT count(*) AS n FROM merge_queue_entry").get()!.n;
}

test("initial verification commits acceptance, checkpoint, a fresh queue place and the merge job", () => {
  const db = tempDb();
  const expected = verifying(db);
  expect(accept(db, expected)).not.toBeNull();
  const item = getWorkItem(db, "item")!;
  expect(item.state).toBe("merge_queue");
  expect(item.checkpoint).toEqual({ phase: "merge_queue", baseSha: base, wipCommit: head });
  expect(queueEntries(db)).toBe(0);
  expect(listJobs(db).map((job) => [job.status, job.payload])).toEqual([
    ["pending", { itemId: "item", summary: "accepted", head }],
  ]);
});

test("re-verification from the merge queue keeps its place and keys the job to the reverify job", () => {
  const db = tempDb();
  const expected = verifying(db, "merge_queue");
  expect(accept(db, expected, { reverifyJobId: 7 })).not.toBeNull();
  expect(getWorkItem(db, "item")?.state).toBe("merge_queue");
  expect(getWorkItem(db, "item")?.checkpoint?.wipCommit).toBe(head);
  expect(queueEntries(db)).toBe(1);
  expect(listJobs(db).map((job) => job.jobKey)).toEqual([`merge:item:${head}:reverify:7`]);
});

test("replaying the same accepted candidate leaves one merge job", () => {
  const db = tempDb();
  const expected = verifying(db);
  accept(db, expected);
  expect(accept(db, expected)).toBeNull();
  expect(listJobs(db)).toHaveLength(1);
  const queued = tempDb();
  const fromQueue = verifying(queued, "merge_queue");
  accept(queued, fromQueue, { reverifyJobId: 7 });
  accept(queued, fromQueue, { reverifyJobId: 7 });
  expect(listJobs(queued)).toHaveLength(1);
});

test.each([
  ["cancellation", (db: Database) => db.run("UPDATE work_item SET cancel_requested = 1")],
  [
    "a changed item version",
    (db: Database) => db.run("UPDATE work_item SET version = version + 1"),
  ],
  [
    "a superseding run",
    (db: Database) =>
      setCurrentRun(db, "item", insertRun(db, { itemId: "item", status: "active", now: 2 }).id),
  ],
  [
    "a state the acceptance no longer applies to",
    (db: Database) => db.run("UPDATE work_item SET state = 'awaiting_input'"),
  ],
])("%s prevents an obsolete acceptance from committing", (_, change) => {
  const db = tempDb();
  const expected = verifying(db);
  change(db);
  const before = getWorkItem(db, "item");
  expect(accept(db, expected)).toBeNull();
  expect(getWorkItem(db, "item")).toEqual(before);
  expect(queueEntries(db)).toBe(1);
  expect(listJobs(db)).toHaveLength(0);
});

test("a failure while writing the merge job rolls back the state, checkpoint and queue place", () => {
  const db = tempDb();
  const expected = verifying(db);
  const before = getWorkItem(db, "item");
  db.run("CREATE TRIGGER fail_job BEFORE INSERT ON job BEGIN SELECT RAISE(ABORT, 'injected'); END");
  expect(() => accept(db, expected)).toThrow("injected");
  expect(getWorkItem(db, "item")).toEqual(before);
  expect(queueEntries(db)).toBe(1);
  expect(listJobs(db)).toHaveLength(0);
});

test("a reopened database finds the accepted candidate's merge job", () => {
  const dir = mkdtempSync(join(tmpdir(), "paws-accept-"));
  try {
    const path = join(dir, "paws.db");
    const db = migratedDatabase(path);
    accept(db, verifying(db));
    db.close();
    const reopened = openDatabase(path);
    expect(getWorkItem(reopened, "item")?.state).toBe("merge_queue");
    expect(getWorkItem(reopened, "item")?.checkpoint?.wipCommit).toBe(head);
    expect(listJobs(reopened).map((job) => job.status)).toEqual(["pending"]);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
