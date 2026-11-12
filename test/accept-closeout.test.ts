import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { count, eq, sql } from "drizzle-orm";
import {
  getWorkItem,
  getJob,
  recordConfirmedRemoteMerge,
  jobVersionCurrent,
  insertQueuedItem,
  insertRun,
  joinMergeQueue,
  listJobs,
  openPglite,
  postgresDb,
  setCurrentRun,
  type Db,
} from "../src/db";
import { acceptCloseout } from "../src/loop";
import { seed } from "./dialects";
import { tempStore } from "./pglite";

const openStores: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of openStores.splice(0)) await close();
});

async function openStore() {
  const { db, close } = await tempStore();
  openStores.push(close);
  return db;
}

const base = "b".repeat(40);
const head = "a".repeat(40);

function setItem(db: Db, set: Record<string, unknown>) {
  return seed(db, (q) => q.orm.update(q.t.workItem).set(set).where(eq(q.t.workItem.id, "item")));
}

function setJob(db: Db, id: number, set: Record<string, unknown>) {
  return seed(db, (q) => q.orm.update(q.t.job).set(set).where(eq(q.t.job.id, id)));
}

async function verifying(db: Db, state = "verifying") {
  await insertQueuedItem(db, { id: "item", now: 1 });
  await setItem(db, { state });
  await joinMergeQueue(db, { itemId: "item", repository: "acme/platform", now: 1 });
  const run = await insertRun(db, {
    itemId: "item",
    kind: "recheck",
    status: "active",
    now: 1,
  });
  await setCurrentRun(db, "item", run.id);
  const item = (await getWorkItem(db, "item"))!;
  return { version: item.version, runId: run.id };
}

async function accept(db: Db, expected: { version: number; runId: string | null }, extra = {}) {
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

async function queueEntries(db: Db): Promise<number> {
  const [row] = await db.run((q) => q.all(q.orm.select({ n: count() }).from(q.t.mergeQueueEntry)));
  return row!.n;
}

test("initial verification commits acceptance, checkpoint, a fresh queue place and the merge job", async () => {
  const db = await openStore();
  const expected = await verifying(db);
  expect(await accept(db, expected)).not.toBeNull();
  const item = (await getWorkItem(db, "item"))!;
  expect(item.state).toBe("merge_queue");
  expect(item.checkpoint).toEqual({ phase: "merge_queue", baseSha: base, wipCommit: head });
  expect(await queueEntries(db)).toBe(0);
  expect((await listJobs(db)).map((job) => [job.status, job.payload])).toEqual([
    ["pending", { itemId: "item", summary: "accepted", head }],
  ]);
});

test("re-verification from the merge queue keeps its place and keys the job to the reverify job", async () => {
  const db = await openStore();
  const expected = await verifying(db, "merge_queue");
  expect(await accept(db, expected, { reverifyJobId: 7 })).not.toBeNull();
  expect((await getWorkItem(db, "item"))?.state).toBe("merge_queue");
  expect((await getWorkItem(db, "item"))?.checkpoint?.wipCommit).toBe(head);
  expect(await queueEntries(db)).toBe(1);
  expect((await listJobs(db)).map((job) => job.jobKey)).toEqual([`merge:item:${head}:reverify:7`]);
});

test("replaying the same accepted candidate leaves one merge job", async () => {
  const db = await openStore();
  const expected = await verifying(db);
  await accept(db, expected);
  expect(await accept(db, expected)).toBeNull();
  expect(await listJobs(db)).toHaveLength(1);
  const queued = await openStore();
  const fromQueue = await verifying(queued, "merge_queue");
  await accept(queued, fromQueue, { reverifyJobId: 7 });
  await accept(queued, fromQueue, { reverifyJobId: 7 });
  expect(await listJobs(queued)).toHaveLength(1);
});

test.each([
  ["cancellation", (db: Db) => setItem(db, { cancelRequested: 1 })],
  ["a changed item version", (db: Db) => setItem(db, { version: sql`version + 1` })],
  [
    "a superseding run",
    async (db: Db) =>
      await setCurrentRun(
        db,
        "item",
        (await insertRun(db, { itemId: "item", status: "active", now: 2 })).id,
      ),
  ],
  [
    "a state the acceptance no longer applies to",
    (db: Db) => setItem(db, { state: "awaiting_input" }),
  ],
])("%s prevents an obsolete acceptance from committing", async (_, change) => {
  const db = await openStore();
  const expected = await verifying(db);
  await change(db);
  const before = await getWorkItem(db, "item");
  expect(await accept(db, expected)).toBeNull();
  expect(await getWorkItem(db, "item")).toEqual(before);
  expect(await queueEntries(db)).toBe(1);
  expect(await listJobs(db)).toHaveLength(0);
});

test("a failure while writing the merge job rolls back the state, checkpoint and queue place", async () => {
  const db = await openStore();
  const expected = await verifying(db);
  const before = await getWorkItem(db, "item");
  await seed(
    db,
    (q) =>
      q.orm.execute(
        sql`CREATE FUNCTION fail_job() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$ LANGUAGE plpgsql`,
      ),
    (q) =>
      q.orm.execute(
        sql`CREATE TRIGGER fail_job BEFORE INSERT ON job FOR EACH ROW EXECUTE FUNCTION fail_job()`,
      ),
  );
  const error = (await accept(db, expected).catch((e: unknown) => e)) as Error;
  expect(String(error.cause)).toContain("injected");
  expect(await getWorkItem(db, "item")).toEqual(before);
  expect(await queueEntries(db)).toBe(1);
  expect(await listJobs(db)).toHaveLength(0);
});

test("a reopened database finds the accepted candidate's merge job", async () => {
  const dir = mkdtempSync(join(tmpdir(), "paws-accept-"));
  try {
    const pg = await openPglite(dir);
    const db = postgresDb(pg);
    await accept(db, await verifying(db));
    await pg.$client.close();
    const reopenedPg = await openPglite(dir);
    const reopened = postgresDb(reopenedPg);
    expect((await getWorkItem(reopened, "item"))?.state).toBe("merge_queue");
    expect((await getWorkItem(reopened, "item"))?.checkpoint?.wipCommit).toBe(head);
    expect((await listJobs(reopened)).map((job) => job.status)).toEqual(["pending"]);
    await reopenedPg.$client.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each(["merged", "completed", "cancelled", "failed"])(
  "a %s item cannot revive a done merge job",
  async (state) => {
    const db = await openStore();
    const expected = await verifying(db);
    const id = (await accept(db, expected))!;
    await setJob(db, id, { status: "done" });
    await setItem(db, { state });
    const item = (await getWorkItem(db, "item"))!;
    expect(await accept(db, { version: item.version, runId: item.currentRunId })).toBeNull();
    expect((await getJob(db, id))?.status).toBe("done");
  },
);

test("re-acceptance revives a done merge job with the current item fence", async () => {
  const db = await openStore();
  const id = (await accept(db, await verifying(db)))!;
  await setJob(db, id, { status: "done", attempts: 3 });
  await setItem(db, { state: "verifying", version: sql`version + 1` });
  const item = (await getWorkItem(db, "item"))!;
  expect(await accept(db, { version: item.version, runId: item.currentRunId })).toBe(id);
  expect(await getJob(db, id)).toMatchObject({ status: "pending", attempts: 0 });
  expect(await jobVersionCurrent(db, (await getJob(db, id))!)).toBe(true);
  await setJob(db, id, { status: "done" });
  await setItem(db, { cancelRequested: 1 });
  const cancelled = (await getWorkItem(db, "item"))!;
  expect(
    await accept(db, { version: cancelled.version, runId: cancelled.currentRunId }),
  ).toBeNull();
  expect((await getJob(db, id))?.status).toBe("done");
});

test("a confirmed merge cannot be revived while the merged item edge is still pending", async () => {
  const db = await openStore();
  const id = (await accept(db, await verifying(db)))!;
  await setJob(db, id, { status: "done" });
  await recordConfirmedRemoteMerge(db, {
    itemId: "item",
    repositoryOwner: "acme",
    repositoryName: "platform",
    pullNumber: 1,
    pullUrl: null,
    mergeSha: "merged",
    confirmedAt: 11,
  });
  const item = (await getWorkItem(db, "item"))!;
  expect(item.state).toBe("merge_queue");
  expect(await accept(db, { version: item.version, runId: item.currentRunId })).toBeNull();
  expect((await getJob(db, id))?.status).toBe("done");
});
