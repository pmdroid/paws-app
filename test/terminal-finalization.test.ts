import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { JOB_KIND } from "../src/core";
import {
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
  immediate,
  insertQueuedItem,
  insertRun,
  listOutbox,
  openDatabase,
  recordConfirmedRemoteMerge,
  saveTaskMode,
  setCurrentRun,
  type WorkItemRecord,
} from "../src/db";
import { migratedDatabase, tempDb, tempHome } from "./helpers";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function runningTask(db: Database) {
  const { item, run } = beginImplementRun(db, insertQueuedItem(db, { id: "ENG-1" }).id, 1);
  const jobId = enqueueJob(db, { queue: JOB_KIND.resume, payload: { itemId: item.id }, now: 1 });
  return { item, run, jobId };
}

function breakOutbox(db: Database): void {
  db.run(
    "CREATE TEMP TRIGGER injected_fault BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'injected fault'); END",
  );
}

test("a fault after the failed state is written rolls the whole failure back", () => {
  const db = tempDb();
  databases.push(db);
  const { item, run, jobId } = runningTask(db);
  breakOutbox(db);
  expect(() => failWorkItem(db, item, "run_error", "The agent crashed.", 2)).toThrow(
    "injected fault",
  );
  expect(getWorkItem(db, item.id)).toMatchObject({ state: "running", cancelRequested: false });
  expect(getRun(db, run.id)?.status).toBe("active");
  expect(getJob(db, jobId)?.status).toBe("pending");
});

test("a failure inside a caller's transaction rolls back with the caller", () => {
  const db = tempDb();
  databases.push(db);
  const { item, run, jobId } = runningTask(db);
  expect(() =>
    immediate(db, () => {
      failWorkItem(db, item, "run_error", "The agent crashed.", 2);
      throw new Error("caller failed");
    }),
  ).toThrow("caller failed");
  expect(getWorkItem(db, item.id)?.state).toBe("running");
  expect(getRun(db, run.id)?.status).toBe("active");
  expect(getJob(db, jobId)?.status).toBe("pending");
  expect(listOutbox(db, "session")).toEqual([]);
});

test("a delayed failure cannot fail the run that superseded it", () => {
  const db = tempDb();
  databases.push(db);
  const { item, run } = runningTask(db);
  applyWorkItemEvent(db, item.id, "restart");
  applyWorkItemEvent(db, item.id, "dispatched");
  const next = insertRun(db, { itemId: item.id, now: 3 });
  setCurrentRun(db, item.id, next.id);
  expect(failWorkItem(db, item, "run_error", "The old agent crashed.", 4)).toBe(false);
  expect(getWorkItem(db, item.id)).toMatchObject({ state: "running", currentRunId: next.id });
  expect(getRun(db, run.id)?.status).toBe("active");
  expect(getRun(db, next.id)?.status).toBe("active");
  expect(listOutbox(db, "session")).toEqual([]);
});

test("a delayed failure leaves a cancelled task cancelled", () => {
  const db = tempDb();
  databases.push(db);
  const { item } = runningTask(db);
  applyWorkItemEvent(db, item.id, "cancel");
  expect(failWorkItem(db, item, "run_error", "The agent crashed.", 2)).toBe(false);
  expect(getWorkItem(db, item.id)?.state).toBe("cancelled");
  expect(listOutbox(db, "session")).toEqual([]);
});

test("a committed failure survives a restart and is not repeated", () => {
  const file = join(tempHome(), "paws.db");
  const db = migratedDatabase(file);
  const { item, run, jobId } = runningTask(db);
  expect(failWorkItem(db, item, "run_error", "The agent crashed.", 2)).toBe(true);
  db.close();
  const restored = openDatabase(file);
  databases.push(restored);
  const failed = getWorkItem(restored, item.id)!;
  expect(failed).toMatchObject({ state: "failed", cancelRequested: true });
  expect(getRun(restored, run.id)?.status).toBe("lost");
  expect(getJob(restored, jobId)?.status).toBe("cancelled");
  expect(listOutbox(restored, "session").map((row) => row.payload)).toEqual([
    { sessionId: "session", kind: "error", body: "The agent crashed." },
  ]);
  expect(failWorkItem(restored, failed, "run_error", "The agent crashed.", 3)).toBe(false);
  expect(listOutbox(restored, "session")).toHaveLength(1);
});

function mergingTask(db: Database) {
  const { item, run } = runningTask(db);
  enterMergeQueue(db, item.id, { phase: "merge_queue" });
  const jobId = enqueueJob(db, { queue: JOB_KIND.reverify, payload: { itemId: item.id }, now: 2 });
  recordConfirmedRemoteMerge(db, {
    itemId: item.id,
    repositoryOwner: "acme",
    repositoryName: "app",
    pullNumber: 7,
    pullUrl: null,
    mergeSha: "abc",
    confirmedAt: 3,
  });
  return { item: getWorkItem(db, item.id)!, run, jobId };
}

function announceMerge(db: Database) {
  const announced: string[] = [];
  return {
    announced,
    announce: (item: WorkItemRecord) => {
      announced.push(item.id);
      enqueueOutboxOnce(db, {
        target: "linear",
        op: "activity",
        orderingKey: "session",
        idempotencyKey: `${item.id}:merged`,
        payload: { sessionId: "session", kind: "thought", body: "Merged." },
        now: 4,
      });
    },
  };
}

test("a confirmed merge commits its state, run, jobs and notice together and only once", () => {
  const file = join(tempHome(), "paws.db");
  const db = migratedDatabase(file);
  const { item, run, jobId } = mergingTask(db);
  const { announced, announce } = announceMerge(db);
  expect(completeMergedItem(db, { itemId: item.id, now: 4, announce })?.state).toBe("merged");
  db.close();
  const restored = openDatabase(file);
  databases.push(restored);
  expect(getWorkItem(restored, item.id)?.state).toBe("merged");
  expect(getRun(restored, run.id)?.status).toBe("ended");
  expect(getJob(restored, jobId)?.status).toBe("cancelled");
  expect(listOutbox(restored, "session")).toHaveLength(1);
  expect(completeMergedItem(restored, { itemId: item.id, now: 5, announce })).toBeNull();
  expect(announced).toEqual([item.id]);
  expect(listOutbox(restored, "session")).toHaveLength(1);
});

test("a fault in the merge notice leaves the task in the merge queue", () => {
  const db = tempDb();
  databases.push(db);
  const { item, run, jobId } = mergingTask(db);
  breakOutbox(db);
  const { announce } = announceMerge(db);
  expect(() => completeMergedItem(db, { itemId: item.id, now: 4, announce })).toThrow(
    "injected fault",
  );
  expect(getWorkItem(db, item.id)?.state).toBe("merge_queue");
  expect(getRun(db, run.id)?.status).toBe("active");
  expect(getJob(db, jobId)?.status).toBe("pending");
});

test("a merge result for a cancelled, superseded or unconfirmed task changes nothing", () => {
  const db = tempDb();
  databases.push(db);
  const { item } = mergingTask(db);
  const { announced, announce } = announceMerge(db);
  applyWorkItemEvent(db, item.id, "restart");
  applyWorkItemEvent(db, item.id, "dispatched");
  expect(completeMergedItem(db, { itemId: item.id, now: 4, announce })).toBeNull();
  applyWorkItemEvent(db, item.id, "cancel");
  expect(completeMergedItem(db, { itemId: item.id, now: 4, announce })).toBeNull();
  const other = insertQueuedItem(db, { id: "ENG-2" });
  beginImplementRun(db, other.id, 5);
  enterMergeQueue(db, other.id, { phase: "merge_queue" });
  expect(completeMergedItem(db, { itemId: other.id, now: 6, announce })).toBeNull();
  expect(getWorkItem(db, item.id)?.state).toBe("cancelled");
  expect(getWorkItem(db, other.id)?.state).toBe("merge_queue");
  expect(announced).toEqual([]);
});

test("an answer from a superseded run cannot complete the task", () => {
  const db = tempDb();
  databases.push(db);
  const { item, run, jobId } = runningTask(db);
  saveTaskMode(db, item.id, "answer");
  const next = insertRun(db, { itemId: item.id, now: 2 });
  setCurrentRun(db, item.id, next.id);
  expect(() => completeAnswerTask(db, item.id, "Stale answer.", 3, { runId: run.id })).toThrow(
    "no longer running",
  );
  expect(getWorkItem(db, item.id)?.state).toBe("running");
  let announced = 0;
  completeAnswerTask(db, item.id, "The total is 42.", 4, {
    runId: next.id,
    announce: () => announced++,
  });
  expect(getWorkItem(db, item.id)?.state).toBe("completed");
  expect(getRun(db, next.id)?.status).toBe("ended");
  expect(getJob(db, jobId)?.status).toBe("cancelled");
  expect(announced).toBe(1);
});

test("a fault in the answer's session update rolls the completion back", () => {
  const db = tempDb();
  databases.push(db);
  const { item, run } = runningTask(db);
  saveTaskMode(db, item.id, "answer");
  expect(() =>
    completeAnswerTask(db, item.id, "The total is 42.", 2, {
      runId: run.id,
      announce: () => {
        throw new Error("session update failed");
      },
    }),
  ).toThrow("session update failed");
  expect(getWorkItem(db, item.id)?.state).toBe("running");
  expect(getRun(db, run.id)?.status).toBe("active");
  expect(listOutbox(db, "session")).toEqual([]);
});
