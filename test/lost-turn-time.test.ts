import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  accrueAwake,
  applyWorkItemEvent,
  getWorkItem,
  insertQueuedItem,
  refundLostTurnAsync,
  sqliteDb,
} from "../src/db";
import { tempDb } from "./helpers";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const MINUTE = 60_000;

test("a turn declared lost gives back its implementation time after the last checkpoint", async () => {
  const db = tempDb();
  databases.push(db);
  const { id } = insertQueuedItem(db, { sessionKey: "session" });
  await applyWorkItemEvent(sqliteDb(db), id, "dispatched");
  await accrueAwake(sqliteDb(db), id, 0, 1, undefined, true);
  await accrueAwake(sqliteDb(db), id, 60 * MINUTE, 2, undefined, true);
  expect((await getWorkItem(sqliteDb(db), id))!.implementMs).toBe(60 * MINUTE);

  expect(await refundLostTurnAsync(sqliteDb(db), id, 60 * MINUTE, 3, 40 * MINUTE)).toBe(
    40 * MINUTE,
  );
  const item = (await getWorkItem(sqliteDb(db), id))!;
  expect(item.implementMs).toBe(20 * MINUTE);
  expect(item.agentMs).toBe(20 * MINUTE);
  expect(item.awakeMs).toBe(20 * MINUTE);

  expect(await refundLostTurnAsync(sqliteDb(db), id, 60 * MINUTE, 4, 90 * MINUTE)).toBe(
    20 * MINUTE,
  );
  expect((await getWorkItem(sqliteDb(db), id))!.implementMs).toBe(0);
});
