import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { insertQueuedItem, insertRun, migrate, openDatabase, resolveDashboardAlias } from ".";

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

test("every engine run of an issue, including a finished one, resolves to that issue", () => {
  const db = database();
  item(db, "item-1", "PAS-1", "session-a", 0);
  const runs = [0, 1, 2].map((at) => insertRun(db, { itemId: "item-1", now: at }).id);
  db.run("UPDATE work_item SET state = 'merged' WHERE id = 'item-1'");
  for (const run of runs) expect(resolveDashboardAlias(db, "runs", run)).toBe("PAS-1");
  expect(resolveDashboardAlias(db, "runs", "unknown")).toBeNull();
  expect(resolveDashboardAlias(db, "runs", "PAS-1")).toBeNull();
});

test("a shared session opens the sub-issue delegated first", () => {
  const db = database();
  item(db, "item-b", "PAS-3", "shared", 20);
  item(db, "item-a", "PAS-2", "shared", 10);
  item(db, "item-c", "PAS-4", "shared", 10);
  expect(resolveDashboardAlias(db, "sessions", "shared")).toBe("PAS-2");
  expect(resolveDashboardAlias(db, "sessions", "unknown")).toBeNull();
});

test("a verdict id is the issue id or one of its runs", () => {
  const db = database();
  item(db, "item-1", "PAS-1", "session-a", 0);
  item(db, "item-2", "  ", "session-a", 1);
  const run = insertRun(db, { itemId: "item-1", now: 0 }).id;
  expect(resolveDashboardAlias(db, "verdicts", "PAS-1")).toBe("PAS-1");
  expect(resolveDashboardAlias(db, "verdicts", run)).toBe("PAS-1");
  expect(resolveDashboardAlias(db, "verdicts", "item-2")).toBe("item-2");
  expect(resolveDashboardAlias(db, "verdicts", "item-1")).toBeNull();
  expect(resolveDashboardAlias(db, "verdicts", "PAS-404")).toBeNull();
});

test("a reader resolves only items in their sessions, alike for hidden and unknown ids", () => {
  const db = database();
  item(db, "mine", "PAS-1", "session-mine", 0);
  item(db, "theirs", "PAS-2", "session-other", 0);
  insertQueuedItem(db, { id: "no-session", sessionKey: "" });
  db.run("UPDATE work_item SET session_key = NULL WHERE id = 'no-session'");
  const theirs = insertRun(db, { itemId: "theirs", now: 0 }).id;
  const scope = ["session-mine"];
  expect(resolveDashboardAlias(db, "sessions", "session-mine", scope)).toBe("PAS-1");
  expect(resolveDashboardAlias(db, "sessions", "session-other", scope)).toBeNull();
  expect(resolveDashboardAlias(db, "runs", theirs, scope)).toBeNull();
  expect(resolveDashboardAlias(db, "verdicts", "PAS-2", scope)).toBeNull();
  expect(resolveDashboardAlias(db, "verdicts", "no-session", scope)).toBeNull();
  expect(resolveDashboardAlias(db, "verdicts", "no-session", [])).toBeNull();
  expect(resolveDashboardAlias(db, "runs", theirs)).toBe("PAS-2");
});
