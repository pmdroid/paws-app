import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { JOB_KIND } from "../src/core";
import {
  failWorkItemSteps,
  applyWorkItemEvent,
  beginImplementRun,
  completeAnswerTask,
  completeMergedItem,
  enqueueJob,
  enqueueOutboxOnce,
  enterMergeQueue,
  failWorkItem,
  getJob,
  getRun,
  getWorkItem,
  insertQueuedItem,
  insertRun,
  listOutbox,
  recordConfirmedRemoteMerge,
  saveTaskMode,
  setCurrentRun,
  type WorkItemRecord,
  syncSteps,
  openPawsStore,
  type Db,
  type PgDb,
  type Q,
} from "../src/db";
import { tempHome } from "./helpers";
import { copyMigratedPglite, tempStore } from "./pglite";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
});

async function store(): Promise<Db> {
  const { db, close } = await tempStore();
  closes.push(close);
  return db;
}

async function onDisk() {
  const pgliteDir = join(tempHome(), "pglite");
  await copyMigratedPglite(pgliteDir);
  return {
    open: async () => {
      const opened = await openPawsStore({ url: null, pgliteDir });
      return { db: opened.store, close: opened.close };
    },
  };
}

async function runningTask(db: Db) {
  const { item, run } = await beginImplementRun(
    db,
    (await insertQueuedItem(db, { id: "ENG-1" })).id,
    1,
  );
  const jobId = await enqueueJob(db, {
    queue: JOB_KIND.resume,
    payload: { itemId: item.id },
    now: 1,
  });
  return { item, run, jobId };
}

async function breakOutbox(db: Db): Promise<void> {
  const { orm } = db as PgDb;
  await orm.execute(
    sql`CREATE FUNCTION injected_fault() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected fault'; END $$ LANGUAGE plpgsql`,
  );
  await orm.execute(
    sql`CREATE TRIGGER injected_fault BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION injected_fault()`,
  );
}

test("a fault after the failed state is written rolls the whole failure back", async () => {
  const db = await store();
  const { item, run, jobId } = await runningTask(db);
  await breakOutbox(db);
  await expect(failWorkItem(db, item, "run_error", "The agent crashed.", 2)).rejects.toMatchObject({
    cause: { message: expect.stringContaining("injected fault") },
  });
  expect(await getWorkItem(db, item.id)).toMatchObject({
    state: "running",
    cancelRequested: false,
  });
  expect((await getRun(db, run.id))?.status).toBe("active");
  expect((await getJob(db, jobId))?.status).toBe("pending");
});

test("a failure inside a caller's transaction rolls back with the caller", async () => {
  const db = await store();
  const { item, run, jobId } = await runningTask(db);
  await expect(
    db.transaction(function* (q) {
      yield* failWorkItemSteps(q, item, "run_error", "The agent crashed.", 2);
      throw new Error("caller failed");
    }),
  ).rejects.toThrow("caller failed");
  expect((await getWorkItem(db, item.id))?.state).toBe("running");
  expect((await getRun(db, run.id))?.status).toBe("active");
  expect((await getJob(db, jobId))?.status).toBe("pending");
  expect(await listOutbox(db, "session")).toEqual([]);
});

test("a delayed failure cannot fail the run that superseded it", async () => {
  const db = await store();
  const { item, run } = await runningTask(db);
  await applyWorkItemEvent(db, item.id, "restart");
  await applyWorkItemEvent(db, item.id, "dispatched");
  const next = await insertRun(db, { itemId: item.id, now: 3 });
  await setCurrentRun(db, item.id, next.id);
  expect(await failWorkItem(db, item, "run_error", "The old agent crashed.", 4)).toBe(false);
  expect(await getWorkItem(db, item.id)).toMatchObject({
    state: "running",
    currentRunId: next.id,
  });
  expect((await getRun(db, run.id))?.status).toBe("active");
  expect((await getRun(db, next.id))?.status).toBe("active");
  expect(await listOutbox(db, "session")).toEqual([]);
});

test("a delayed failure leaves a cancelled task cancelled", async () => {
  const db = await store();
  const { item } = await runningTask(db);
  await applyWorkItemEvent(db, item.id, "cancel");
  expect(await failWorkItem(db, item, "run_error", "The agent crashed.", 2)).toBe(false);
  expect((await getWorkItem(db, item.id))?.state).toBe("cancelled");
  expect(await listOutbox(db, "session")).toEqual([]);
});

test("a committed failure survives a restart and is not repeated", async () => {
  const disk = await onDisk();
  const first = await disk.open();
  const db = first.db;
  const { item, run, jobId } = await runningTask(db);
  expect(await failWorkItem(db, item, "run_error", "The agent crashed.", 2)).toBe(true);
  await first.close();
  const reopened = await disk.open();
  closes.push(reopened.close);
  const restored = reopened.db;
  const failed = (await getWorkItem(restored, item.id))!;
  expect(failed).toMatchObject({ state: "failed", cancelRequested: true });
  expect((await getRun(restored, run.id))?.status).toBe("lost");
  expect((await getJob(restored, jobId))?.status).toBe("cancelled");
  expect((await listOutbox(restored, "session")).map((row) => row.payload)).toEqual([
    { sessionId: "session", kind: "error", body: "The agent crashed." },
  ]);
  expect(await failWorkItem(restored, failed, "run_error", "The agent crashed.", 3)).toBe(false);
  expect(await listOutbox(restored, "session")).toHaveLength(1);
});

async function mergingTask(db: Db) {
  const { item, run } = await runningTask(db);
  await enterMergeQueue(db, item.id, { phase: "merge_queue" });
  const jobId = await enqueueJob(db, {
    queue: JOB_KIND.reverify,
    payload: { itemId: item.id },
    now: 2,
  });
  await recordConfirmedRemoteMerge(db, {
    itemId: item.id,
    repositoryOwner: "acme",
    repositoryName: "app",
    pullNumber: 7,
    pullUrl: null,
    mergeSha: "abc",
    confirmedAt: 3,
  });
  return { item: (await getWorkItem(db, item.id))!, run, jobId };
}

function announceMerge() {
  const announced: string[] = [];
  return {
    announced,
    announce: (_q: Q, item: WorkItemRecord) =>
      syncSteps(() => {
        announced.push(item.id);
      }),
  };
}

test("a confirmed merge commits its state, run, jobs and notice together and only once", async () => {
  const disk = await onDisk();
  const first = await disk.open();
  const db = first.db;
  const { item, run, jobId } = await mergingTask(db);
  const { announced, announce } = announceMerge();
  expect((await completeMergedItem(db, { itemId: item.id, now: 4, announce }))?.state).toBe(
    "merged",
  );
  await first.close();
  const reopened = await disk.open();
  closes.push(reopened.close);
  const restored = reopened.db;
  expect((await getWorkItem(restored, item.id))?.state).toBe("merged");
  expect((await getRun(restored, run.id))?.status).toBe("ended");
  expect((await getJob(restored, jobId))?.status).toBe("cancelled");
  expect(await listOutbox(restored, "session")).toHaveLength(1);
  expect((await listOutbox(restored, "session"))[0]).toMatchObject({
    delivery: "ordered",
    idempotencyKey: `merged:${item.id}:0`,
    payload: { kind: "response", body: "Merged #7 into main at abc. ENG-1 is Done." },
  });
  expect(await completeMergedItem(restored, { itemId: item.id, now: 5, announce })).toBeNull();
  expect(announced).toEqual([item.id]);
  expect(await listOutbox(restored, "session")).toHaveLength(1);
});

test("a fault in the merge notice leaves the task in the merge queue", async () => {
  const db = await store();
  const { item, run, jobId } = await mergingTask(db);
  await breakOutbox(db);
  const { announce } = announceMerge();
  await expect(completeMergedItem(db, { itemId: item.id, now: 4, announce })).rejects.toMatchObject(
    {
      cause: { message: expect.stringContaining("injected fault") },
    },
  );
  expect((await getWorkItem(db, item.id))?.state).toBe("merge_queue");
  expect((await getRun(db, run.id))?.status).toBe("active");
  expect((await getJob(db, jobId))?.status).toBe("pending");
});

test("a merge result for a cancelled, superseded or unconfirmed task changes nothing", async () => {
  const db = await store();
  const { item } = await mergingTask(db);
  const { announced, announce } = announceMerge();
  await applyWorkItemEvent(db, item.id, "restart");
  await applyWorkItemEvent(db, item.id, "dispatched");
  expect(await completeMergedItem(db, { itemId: item.id, now: 4, announce })).toBeNull();
  await applyWorkItemEvent(db, item.id, "cancel");
  expect(await completeMergedItem(db, { itemId: item.id, now: 4, announce })).toBeNull();
  const other = await insertQueuedItem(db, { id: "ENG-2" });
  await beginImplementRun(db, other.id, 5);
  await enterMergeQueue(db, other.id, { phase: "merge_queue" });
  expect(await completeMergedItem(db, { itemId: other.id, now: 6, announce })).toBeNull();
  expect((await getWorkItem(db, item.id))?.state).toBe("cancelled");
  expect((await getWorkItem(db, other.id))?.state).toBe("merge_queue");
  expect(announced).toEqual([]);
});

test("an answer from a superseded run cannot complete the task", async () => {
  const db = await store();
  const { item, run, jobId } = await runningTask(db);
  await saveTaskMode(db, item.id, "answer");
  const next = await insertRun(db, { itemId: item.id, now: 2 });
  await setCurrentRun(db, item.id, next.id);
  await expect(
    completeAnswerTask(db, item.id, "Stale answer.", 3, { runId: run.id }),
  ).rejects.toThrow("no longer running");
  expect((await getWorkItem(db, item.id))?.state).toBe("running");
  let announced = 0;
  await completeAnswerTask(db, item.id, "The total is 42.", 4, {
    runId: next.id,
    announce: () =>
      syncSteps(() => {
        announced++;
      }),
  });
  expect((await getWorkItem(db, item.id))?.state).toBe("completed");
  expect((await getRun(db, next.id))?.status).toBe("ended");
  expect((await getJob(db, jobId))?.status).toBe("cancelled");
  expect(announced).toBe(1);
});

test("a fault in the answer's session update rolls the completion back", async () => {
  const db = await store();
  const { item, run } = await runningTask(db);
  await saveTaskMode(db, item.id, "answer");
  await expect(
    completeAnswerTask(db, item.id, "The total is 42.", 2, {
      runId: run.id,
      announce: () => {
        throw new Error("session update failed");
      },
    }),
  ).rejects.toThrow("session update failed");
  expect((await getWorkItem(db, item.id))?.state).toBe("running");
  expect((await getRun(db, run.id))?.status).toBe("active");
  expect(await listOutbox(db, "session")).toEqual([]);
});

test("a terminal failure after PR publication commits one ordered closed response", async () => {
  const db = await store();
  const { item } = await runningTask(db);
  await enqueueOutboxOnce(db, {
    target: "linear",
    op: "activity",
    orderingKey: "session",
    delivery: "ordered",
    idempotencyKey: `pull-request-ready:${item.id}:0`,
    payload: { sessionId: "session", kind: "response", body: "Opened PR #7" },
  });
  expect(await failWorkItem(db, item, "merge", "GitHub is unavailable.", 2)).toBe(true);
  expect(await failWorkItem(db, item, "merge", "GitHub is unavailable.", 3)).toBe(false);
  expect(
    (await listOutbox(db, "session")).filter((row) => row.idempotencyKey.startsWith("closed:")),
  ).toMatchObject([
    {
      idempotencyKey: `closed:${item.id}:0`,
      delivery: "ordered",
      payload: { kind: "response", body: "Closed: GitHub is unavailable." },
    },
  ]);
});
