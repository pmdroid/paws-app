import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
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
  openDatabase,
  recordConfirmedRemoteMerge,
  saveTaskMode,
  setCurrentRun,
  type WorkItemRecord,
  sqliteDb,
  syncSteps,
  type Q,
} from "../src/db";
import { migratedDatabase, tempDb, tempHome } from "./helpers";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

async function runningTask(db: Database) {
  const { item, run } = await beginImplementRun(
    sqliteDb(db),
    insertQueuedItem(db, { id: "ENG-1" }).id,
    1,
  );
  const jobId = await enqueueJob(sqliteDb(db), {
    queue: JOB_KIND.resume,
    payload: { itemId: item.id },
    now: 1,
  });
  return { item, run, jobId };
}

function breakOutbox(db: Database): void {
  db.run(
    "CREATE TEMP TRIGGER injected_fault BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'injected fault'); END",
  );
}

test("a fault after the failed state is written rolls the whole failure back", async () => {
  const db = tempDb();
  databases.push(db);
  const { item, run, jobId } = await runningTask(db);
  breakOutbox(db);
  await expect(
    failWorkItem(sqliteDb(db), item, "run_error", "The agent crashed.", 2),
  ).rejects.toThrow("injected fault");
  expect(await getWorkItem(sqliteDb(db), item.id)).toMatchObject({
    state: "running",
    cancelRequested: false,
  });
  expect((await getRun(sqliteDb(db), run.id))?.status).toBe("active");
  expect((await getJob(sqliteDb(db), jobId))?.status).toBe("pending");
});

test("a failure inside a caller's transaction rolls back with the caller", async () => {
  const db = tempDb();
  databases.push(db);
  const { item, run, jobId } = await runningTask(db);
  await expect(
    sqliteDb(db).transaction(function* (q) {
      yield* failWorkItemSteps(q, item, "run_error", "The agent crashed.", 2);
      throw new Error("caller failed");
    }),
  ).rejects.toThrow("caller failed");
  expect((await getWorkItem(sqliteDb(db), item.id))?.state).toBe("running");
  expect((await getRun(sqliteDb(db), run.id))?.status).toBe("active");
  expect((await getJob(sqliteDb(db), jobId))?.status).toBe("pending");
  expect(await listOutbox(sqliteDb(db), "session")).toEqual([]);
});

test("a delayed failure cannot fail the run that superseded it", async () => {
  const db = tempDb();
  databases.push(db);
  const { item, run } = await runningTask(db);
  await applyWorkItemEvent(sqliteDb(db), item.id, "restart");
  await applyWorkItemEvent(sqliteDb(db), item.id, "dispatched");
  const next = await insertRun(sqliteDb(db), { itemId: item.id, now: 3 });
  await setCurrentRun(sqliteDb(db), item.id, next.id);
  expect(await failWorkItem(sqliteDb(db), item, "run_error", "The old agent crashed.", 4)).toBe(
    false,
  );
  expect(await getWorkItem(sqliteDb(db), item.id)).toMatchObject({
    state: "running",
    currentRunId: next.id,
  });
  expect((await getRun(sqliteDb(db), run.id))?.status).toBe("active");
  expect((await getRun(sqliteDb(db), next.id))?.status).toBe("active");
  expect(await listOutbox(sqliteDb(db), "session")).toEqual([]);
});

test("a delayed failure leaves a cancelled task cancelled", async () => {
  const db = tempDb();
  databases.push(db);
  const { item } = await runningTask(db);
  await applyWorkItemEvent(sqliteDb(db), item.id, "cancel");
  expect(await failWorkItem(sqliteDb(db), item, "run_error", "The agent crashed.", 2)).toBe(false);
  expect((await getWorkItem(sqliteDb(db), item.id))?.state).toBe("cancelled");
  expect(await listOutbox(sqliteDb(db), "session")).toEqual([]);
});

test("a committed failure survives a restart and is not repeated", async () => {
  const file = join(tempHome(), "paws.db");
  const db = migratedDatabase(file);
  const { item, run, jobId } = await runningTask(db);
  expect(await failWorkItem(sqliteDb(db), item, "run_error", "The agent crashed.", 2)).toBe(true);
  db.close();
  const restored = openDatabase(file);
  databases.push(restored);
  const failed = (await getWorkItem(sqliteDb(restored), item.id))!;
  expect(failed).toMatchObject({ state: "failed", cancelRequested: true });
  expect((await getRun(sqliteDb(restored), run.id))?.status).toBe("lost");
  expect((await getJob(sqliteDb(restored), jobId))?.status).toBe("cancelled");
  expect((await listOutbox(sqliteDb(restored), "session")).map((row) => row.payload)).toEqual([
    { sessionId: "session", kind: "error", body: "The agent crashed." },
  ]);
  expect(await failWorkItem(sqliteDb(restored), failed, "run_error", "The agent crashed.", 3)).toBe(
    false,
  );
  expect(await listOutbox(sqliteDb(restored), "session")).toHaveLength(1);
});

async function mergingTask(db: Database) {
  const { item, run } = await runningTask(db);
  await enterMergeQueue(sqliteDb(db), item.id, { phase: "merge_queue" });
  const jobId = await enqueueJob(sqliteDb(db), {
    queue: JOB_KIND.reverify,
    payload: { itemId: item.id },
    now: 2,
  });
  await recordConfirmedRemoteMerge(sqliteDb(db), {
    itemId: item.id,
    repositoryOwner: "acme",
    repositoryName: "app",
    pullNumber: 7,
    pullUrl: null,
    mergeSha: "abc",
    confirmedAt: 3,
  });
  return { item: (await getWorkItem(sqliteDb(db), item.id))!, run, jobId };
}

function announceMerge(_db: Database) {
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
  const file = join(tempHome(), "paws.db");
  const db = migratedDatabase(file);
  const { item, run, jobId } = await mergingTask(db);
  const { announced, announce } = announceMerge(db);
  expect(
    (await completeMergedItem(sqliteDb(db), { itemId: item.id, now: 4, announce }))?.state,
  ).toBe("merged");
  db.close();
  const restored = openDatabase(file);
  databases.push(restored);
  expect((await getWorkItem(sqliteDb(restored), item.id))?.state).toBe("merged");
  expect((await getRun(sqliteDb(restored), run.id))?.status).toBe("ended");
  expect((await getJob(sqliteDb(restored), jobId))?.status).toBe("cancelled");
  expect(await listOutbox(sqliteDb(restored), "session")).toHaveLength(1);
  expect((await listOutbox(sqliteDb(restored), "session"))[0]).toMatchObject({
    delivery: "ordered",
    idempotencyKey: `merged:${item.id}:0`,
    payload: { kind: "response", body: "Merged #7 into main at abc. ENG-1 is Done." },
  });
  expect(
    await completeMergedItem(sqliteDb(restored), { itemId: item.id, now: 5, announce }),
  ).toBeNull();
  expect(announced).toEqual([item.id]);
  expect(await listOutbox(sqliteDb(restored), "session")).toHaveLength(1);
});

test("a fault in the merge notice leaves the task in the merge queue", async () => {
  const db = tempDb();
  databases.push(db);
  const { item, run, jobId } = await mergingTask(db);
  breakOutbox(db);
  const { announce } = announceMerge(db);
  await expect(
    completeMergedItem(sqliteDb(db), { itemId: item.id, now: 4, announce }),
  ).rejects.toThrow("injected fault");
  expect((await getWorkItem(sqliteDb(db), item.id))?.state).toBe("merge_queue");
  expect((await getRun(sqliteDb(db), run.id))?.status).toBe("active");
  expect((await getJob(sqliteDb(db), jobId))?.status).toBe("pending");
});

test("a merge result for a cancelled, superseded or unconfirmed task changes nothing", async () => {
  const db = tempDb();
  databases.push(db);
  const { item } = await mergingTask(db);
  const { announced, announce } = announceMerge(db);
  await applyWorkItemEvent(sqliteDb(db), item.id, "restart");
  await applyWorkItemEvent(sqliteDb(db), item.id, "dispatched");
  expect(await completeMergedItem(sqliteDb(db), { itemId: item.id, now: 4, announce })).toBeNull();
  await applyWorkItemEvent(sqliteDb(db), item.id, "cancel");
  expect(await completeMergedItem(sqliteDb(db), { itemId: item.id, now: 4, announce })).toBeNull();
  const other = insertQueuedItem(db, { id: "ENG-2" });
  await beginImplementRun(sqliteDb(db), other.id, 5);
  await enterMergeQueue(sqliteDb(db), other.id, { phase: "merge_queue" });
  expect(await completeMergedItem(sqliteDb(db), { itemId: other.id, now: 6, announce })).toBeNull();
  expect((await getWorkItem(sqliteDb(db), item.id))?.state).toBe("cancelled");
  expect((await getWorkItem(sqliteDb(db), other.id))?.state).toBe("merge_queue");
  expect(announced).toEqual([]);
});

test("an answer from a superseded run cannot complete the task", async () => {
  const db = tempDb();
  databases.push(db);
  const { item, run, jobId } = await runningTask(db);
  await saveTaskMode(sqliteDb(db), item.id, "answer");
  const next = await insertRun(sqliteDb(db), { itemId: item.id, now: 2 });
  await setCurrentRun(sqliteDb(db), item.id, next.id);
  await expect(
    completeAnswerTask(sqliteDb(db), item.id, "Stale answer.", 3, { runId: run.id }),
  ).rejects.toThrow("no longer running");
  expect((await getWorkItem(sqliteDb(db), item.id))?.state).toBe("running");
  let announced = 0;
  await completeAnswerTask(sqliteDb(db), item.id, "The total is 42.", 4, {
    runId: next.id,
    announce: () =>
      syncSteps(() => {
        announced++;
      }),
  });
  expect((await getWorkItem(sqliteDb(db), item.id))?.state).toBe("completed");
  expect((await getRun(sqliteDb(db), next.id))?.status).toBe("ended");
  expect((await getJob(sqliteDb(db), jobId))?.status).toBe("cancelled");
  expect(announced).toBe(1);
});

test("a fault in the answer's session update rolls the completion back", async () => {
  const db = tempDb();
  databases.push(db);
  const { item, run } = await runningTask(db);
  await saveTaskMode(sqliteDb(db), item.id, "answer");
  await expect(
    completeAnswerTask(sqliteDb(db), item.id, "The total is 42.", 2, {
      runId: run.id,
      announce: () => {
        throw new Error("session update failed");
      },
    }),
  ).rejects.toThrow("session update failed");
  expect((await getWorkItem(sqliteDb(db), item.id))?.state).toBe("running");
  expect((await getRun(sqliteDb(db), run.id))?.status).toBe("active");
  expect(await listOutbox(sqliteDb(db), "session")).toEqual([]);
});

test("a terminal failure after PR publication commits one ordered closed response", async () => {
  const db = tempDb();
  databases.push(db);
  const { item } = await runningTask(db);
  enqueueOutboxOnce(db, {
    target: "linear",
    op: "activity",
    orderingKey: "session",
    delivery: "ordered",
    idempotencyKey: `pull-request-ready:${item.id}:0`,
    payload: { sessionId: "session", kind: "response", body: "Opened PR #7" },
  });
  expect(await failWorkItem(sqliteDb(db), item, "merge", "GitHub is unavailable.", 2)).toBe(true);
  expect(await failWorkItem(sqliteDb(db), item, "merge", "GitHub is unavailable.", 3)).toBe(false);
  expect(
    (await listOutbox(sqliteDb(db), "session")).filter((row) =>
      row.idempotencyKey.startsWith("closed:"),
    ),
  ).toMatchObject([
    {
      idempotencyKey: `closed:${item.id}:0`,
      delivery: "ordered",
      payload: { kind: "response", body: "Closed: GitHub is unavailable." },
    },
  ]);
});
