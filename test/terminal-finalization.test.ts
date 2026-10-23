import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { JOB_KIND } from "../src/core";
import {
  applyWorkItemEvent,
  beginImplementRun,
  enqueueJob,
  failWorkItem,
  getJob,
  getRun,
  getWorkItem,
  immediate,
  insertQueuedItem,
  insertRun,
  listOutbox,
  openDatabase,
  setCurrentRun,
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
  failWorkItem(db, item, "run_error", "The old agent crashed.", 4);
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
  failWorkItem(db, item, "run_error", "The agent crashed.", 2);
  expect(getWorkItem(db, item.id)?.state).toBe("cancelled");
  expect(listOutbox(db, "session")).toEqual([]);
});

test("a committed failure survives a restart and is not repeated", () => {
  const file = join(tempHome(), "paws.db");
  const db = migratedDatabase(file);
  const { item, run, jobId } = runningTask(db);
  failWorkItem(db, item, "run_error", "The agent crashed.", 2);
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
  failWorkItem(restored, failed, "run_error", "The agent crashed.", 3);
  expect(listOutbox(restored, "session")).toHaveLength(1);
});
