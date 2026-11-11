import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  insertQueuedItem,
  insertRun,
  migrate,
  openDatabase,
  resolveDashboardAlias,
  sqliteDb,
} from ".";

const open: Database[] = [];

afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function database(): Database {
  const db = openDatabase(":memory:");
  migrate(db);
  open.push(db);
  return db;
}

function item(db: Database, id: string, identifier: string, session: string, now: number) {
  insertQueuedItem(db, { id, sessionKey: session, now });
  db.run("UPDATE work_item SET linear_identifier = ? WHERE id = ?", [identifier, id]);
}

test("every engine run of an issue, including a finished one, resolves to that issue", async () => {
  const db = database();
  item(db, "item-1", "PAS-1", "session-a", 0);
  const runs = [];
  for (const at of [0, 1, 2])
    runs.push((await insertRun(sqliteDb(db), { itemId: "item-1", now: at })).id);
  db.run("UPDATE work_item SET state = 'merged' WHERE id = 'item-1'");
  for (const run of runs)
    expect(await resolveDashboardAlias(sqliteDb(db), "runs", run)).toBe("PAS-1");
  expect(await resolveDashboardAlias(sqliteDb(db), "runs", "unknown")).toBeNull();
  expect(await resolveDashboardAlias(sqliteDb(db), "runs", "PAS-1")).toBeNull();
});

test("a shared session opens the sub-issue delegated first", async () => {
  const db = database();
  item(db, "item-b", "PAS-3", "shared", 20);
  item(db, "item-a", "PAS-2", "shared", 10);
  item(db, "item-c", "PAS-4", "shared", 10);
  expect(await resolveDashboardAlias(sqliteDb(db), "sessions", "shared")).toBe("PAS-2");
  expect(await resolveDashboardAlias(sqliteDb(db), "sessions", "unknown")).toBeNull();
});

test("a verdict id is the issue id or one of its runs", async () => {
  const db = database();
  item(db, "item-1", "PAS-1", "session-a", 0);
  item(db, "item-2", "  ", "session-a", 1);
  const run = (await insertRun(sqliteDb(db), { itemId: "item-1", now: 0 })).id;
  expect(await resolveDashboardAlias(sqliteDb(db), "verdicts", "PAS-1")).toBe("PAS-1");
  expect(await resolveDashboardAlias(sqliteDb(db), "verdicts", run)).toBe("PAS-1");
  expect(await resolveDashboardAlias(sqliteDb(db), "verdicts", "item-2")).toBe("item-2");
  expect(await resolveDashboardAlias(sqliteDb(db), "verdicts", "item-1")).toBeNull();
  expect(await resolveDashboardAlias(sqliteDb(db), "verdicts", "PAS-404")).toBeNull();
});

test("a reader resolves only items in their sessions, alike for hidden and unknown ids", async () => {
  const db = database();
  item(db, "mine", "PAS-1", "session-mine", 0);
  item(db, "theirs", "PAS-2", "session-other", 0);
  insertQueuedItem(db, { id: "no-session", sessionKey: "" });
  db.run("UPDATE work_item SET session_key = NULL WHERE id = 'no-session'");
  const theirs = (await insertRun(sqliteDb(db), { itemId: "theirs", now: 0 })).id;
  const scope = ["session-mine"];
  expect(await resolveDashboardAlias(sqliteDb(db), "sessions", "session-mine", scope)).toBe(
    "PAS-1",
  );
  expect(await resolveDashboardAlias(sqliteDb(db), "sessions", "session-other", scope)).toBeNull();
  expect(await resolveDashboardAlias(sqliteDb(db), "runs", theirs, scope)).toBeNull();
  expect(await resolveDashboardAlias(sqliteDb(db), "verdicts", "PAS-2", scope)).toBeNull();
  expect(await resolveDashboardAlias(sqliteDb(db), "verdicts", "no-session", scope)).toBeNull();
  expect(await resolveDashboardAlias(sqliteDb(db), "verdicts", "no-session", [])).toBeNull();
  expect(await resolveDashboardAlias(sqliteDb(db), "runs", theirs)).toBe("PAS-2");
});
