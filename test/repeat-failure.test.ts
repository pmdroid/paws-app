import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  accrueAwake,
  applyWorkItemEvent,
  configureWorkItem,
  failWorkItem,
  getWorkItem,
  insertQueuedItem,
  sqliteDb,
} from "../src/db";
import { tempDb } from "./helpers";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function errorBodies(db: Database): string[] {
  return db
    .query<{ body: string }, []>(
      "SELECT json_extract(payload,'$.body') AS body FROM outbox WHERE json_extract(payload,'$.kind')='error' ORDER BY id",
    )
    .all()
    .map((row) => row.body);
}

test("a retried task that fails again with the same reason posts a second error", () => {
  const db = tempDb();
  databases.push(db);
  const { id } = insertQueuedItem(db, { sessionKey: "session" });
  applyWorkItemEvent(db, id, "dispatched");
  failWorkItem(db, getWorkItem(db, id)!, "run_error", "first failure", 1);
  applyWorkItemEvent(db, id, "restart");
  applyWorkItemEvent(db, id, "dispatched");
  failWorkItem(db, getWorkItem(db, id)!, "run_error", "second failure", 2);
  expect(errorBodies(db)).toEqual(["first failure", "second failure"]);
});

test("a retried task that hits the same cap again posts a second error", async () => {
  const db = tempDb();
  databases.push(db);
  const { id } = insertQueuedItem(db, { maxAwakeMs: 10 });
  db.run("UPDATE work_item SET session_key = NULL WHERE id = ?", [id]);
  applyWorkItemEvent(db, id, "dispatched");
  await accrueAwake(sqliteDb(db), id, 0, 1, undefined, true);
  expect((await accrueAwake(sqliteDb(db), id, 10, 2, undefined, true)).capped).toBe(true);
  applyWorkItemEvent(db, id, "restart");
  await configureWorkItem(sqliteDb(db), id, { maxAwakeMs: 20 });
  applyWorkItemEvent(db, id, "dispatched");
  await accrueAwake(sqliteDb(db), id, 100, 3, undefined, true);
  expect((await accrueAwake(sqliteDb(db), id, 110, 4, undefined, true)).capped).toBe(true);
  expect(errorBodies(db)).toHaveLength(2);
});
