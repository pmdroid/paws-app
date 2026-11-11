import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import {
  getWorkItem,
  getJob,
  recordConfirmedRemoteMerge,
  jobVersionCurrent,
  insertQueuedItem,
  insertRun,
  joinMergeQueue,
  listJobs,
  openDatabase,
  setCurrentRun,
  sqliteDb,
} from "../src/db";
import { acceptCloseout } from "../src/loop";
import { migratedDatabase, tempDb } from "./helpers";

const base = "b".repeat(40);
const head = "a".repeat(40);

async function verifying(db: Database, state = "verifying") {
  insertQueuedItem(db, { id: "item", now: 1 });
  db.run("UPDATE work_item SET state = ? WHERE id = 'item'", [state]);
  await joinMergeQueue(sqliteDb(db), { itemId: "item", repository: "acme/platform", now: 1 });
  const run = await insertRun(sqliteDb(db), {
    itemId: "item",
    kind: "recheck",
    status: "active",
    now: 1,
  });
  await setCurrentRun(sqliteDb(db), "item", run.id);
  const item = (await getWorkItem(sqliteDb(db), "item"))!;
  return { version: item.version, runId: run.id };
}

async function accept(
  db: Database,
  expected: { version: number; runId: string | null },
  extra = {},
) {
  return await acceptCloseout(db, {
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

test("initial verification commits acceptance, checkpoint, a fresh queue place and the merge job", async () => {
  const db = tempDb();
  const expected = await verifying(db);
  expect(await accept(db, expected)).not.toBeNull();
  const item = (await getWorkItem(sqliteDb(db), "item"))!;
  expect(item.state).toBe("merge_queue");
  expect(item.checkpoint).toEqual({ phase: "merge_queue", baseSha: base, wipCommit: head });
  expect(queueEntries(db)).toBe(0);
  expect((await listJobs(sqliteDb(db))).map((job) => [job.status, job.payload])).toEqual([
    ["pending", { itemId: "item", summary: "accepted", head }],
  ]);
});

test("re-verification from the merge queue keeps its place and keys the job to the reverify job", async () => {
  const db = tempDb();
  const expected = await verifying(db, "merge_queue");
  expect(await accept(db, expected, { reverifyJobId: 7 })).not.toBeNull();
  expect((await getWorkItem(sqliteDb(db), "item"))?.state).toBe("merge_queue");
  expect((await getWorkItem(sqliteDb(db), "item"))?.checkpoint?.wipCommit).toBe(head);
  expect(queueEntries(db)).toBe(1);
  expect((await listJobs(sqliteDb(db))).map((job) => job.jobKey)).toEqual([
    `merge:item:${head}:reverify:7`,
  ]);
});

test("replaying the same accepted candidate leaves one merge job", async () => {
  const db = tempDb();
  const expected = await verifying(db);
  await accept(db, expected);
  expect(await accept(db, expected)).toBeNull();
  expect(await listJobs(sqliteDb(db))).toHaveLength(1);
  const queued = tempDb();
  const fromQueue = await verifying(queued, "merge_queue");
  await accept(queued, fromQueue, { reverifyJobId: 7 });
  await accept(queued, fromQueue, { reverifyJobId: 7 });
  expect(await listJobs(sqliteDb(queued))).toHaveLength(1);
});

test.each([
  ["cancellation", (db: Database) => db.run("UPDATE work_item SET cancel_requested = 1")],
  [
    "a changed item version",
    (db: Database) => db.run("UPDATE work_item SET version = version + 1"),
  ],
  [
    "a superseding run",
    async (db: Database) =>
      await setCurrentRun(
        sqliteDb(db),
        "item",
        (await insertRun(sqliteDb(db), { itemId: "item", status: "active", now: 2 })).id,
      ),
  ],
  [
    "a state the acceptance no longer applies to",
    (db: Database) => db.run("UPDATE work_item SET state = 'awaiting_input'"),
  ],
])("%s prevents an obsolete acceptance from committing", async (_, change) => {
  const db = tempDb();
  const expected = await verifying(db);
  await change(db);
  const before = await getWorkItem(sqliteDb(db), "item");
  expect(await accept(db, expected)).toBeNull();
  expect(await getWorkItem(sqliteDb(db), "item")).toEqual(before);
  expect(queueEntries(db)).toBe(1);
  expect(await listJobs(sqliteDb(db))).toHaveLength(0);
});

test("a failure while writing the merge job rolls back the state, checkpoint and queue place", async () => {
  const db = tempDb();
  const expected = await verifying(db);
  const before = await getWorkItem(sqliteDb(db), "item");
  db.run("CREATE TRIGGER fail_job BEFORE INSERT ON job BEGIN SELECT RAISE(ABORT, 'injected'); END");
  await expect(accept(db, expected)).rejects.toThrow("injected");
  expect(await getWorkItem(sqliteDb(db), "item")).toEqual(before);
  expect(queueEntries(db)).toBe(1);
  expect(await listJobs(sqliteDb(db))).toHaveLength(0);
});

test("a reopened database finds the accepted candidate's merge job", async () => {
  const dir = mkdtempSync(join(tmpdir(), "paws-accept-"));
  try {
    const path = join(dir, "paws.db");
    const db = migratedDatabase(path);
    await accept(db, await verifying(db));
    db.close();
    const reopened = openDatabase(path);
    expect((await getWorkItem(sqliteDb(reopened), "item"))?.state).toBe("merge_queue");
    expect((await getWorkItem(sqliteDb(reopened), "item"))?.checkpoint?.wipCommit).toBe(head);
    expect((await listJobs(sqliteDb(reopened))).map((job) => job.status)).toEqual(["pending"]);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each(["merged", "completed", "cancelled", "failed"])(
  "a %s item cannot revive a done merge job",
  async (state) => {
    const db = tempDb();
    const expected = await verifying(db);
    const id = (await accept(db, expected))!;
    db.run("UPDATE job SET status='done' WHERE id=?", [id]);
    db.run("UPDATE work_item SET state=? WHERE id='item'", [state]);
    const item = (await getWorkItem(sqliteDb(db), "item"))!;
    expect(await accept(db, { version: item.version, runId: item.currentRunId })).toBeNull();
    expect((await getJob(sqliteDb(db), id))?.status).toBe("done");
    db.close();
  },
);

test("re-acceptance revives a done merge job with the current item fence", async () => {
  const db = tempDb();
  const id = (await accept(db, await verifying(db)))!;
  db.run("UPDATE job SET status='done', attempts=3 WHERE id=?", [id]);
  db.run("UPDATE work_item SET state='verifying', version=version+1 WHERE id='item'");
  const item = (await getWorkItem(sqliteDb(db), "item"))!;
  expect(await accept(db, { version: item.version, runId: item.currentRunId })).toBe(id);
  expect(await getJob(sqliteDb(db), id)).toMatchObject({ status: "pending", attempts: 0 });
  expect(await jobVersionCurrent(sqliteDb(db), (await getJob(sqliteDb(db), id))!)).toBe(true);
  db.run("UPDATE job SET status='done' WHERE id=?", [id]);
  db.run("UPDATE work_item SET cancel_requested=1 WHERE id='item'");
  const cancelled = (await getWorkItem(sqliteDb(db), "item"))!;
  expect(
    await accept(db, { version: cancelled.version, runId: cancelled.currentRunId }),
  ).toBeNull();
  expect((await getJob(sqliteDb(db), id))?.status).toBe("done");
  db.close();
});

test("a confirmed merge cannot be revived while the merged item edge is still pending", async () => {
  const db = tempDb();
  const id = (await accept(db, await verifying(db)))!;
  db.run("UPDATE job SET status='done' WHERE id=?", [id]);
  await recordConfirmedRemoteMerge(sqliteDb(db), {
    itemId: "item",
    repositoryOwner: "acme",
    repositoryName: "platform",
    pullNumber: 1,
    pullUrl: null,
    mergeSha: "merged",
    confirmedAt: 11,
  });
  const item = (await getWorkItem(sqliteDb(db), "item"))!;
  expect(item.state).toBe("merge_queue");
  expect(await accept(db, { version: item.version, runId: item.currentRunId })).toBeNull();
  expect((await getJob(sqliteDb(db), id))?.status).toBe("done");
  db.close();
});
