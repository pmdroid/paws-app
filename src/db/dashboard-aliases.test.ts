import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { insertQueuedItem, insertRun, resolveDashboardAlias, type Db } from ".";
import { seed } from "../../test/dialects";
import { tempStore } from "../../test/pglite";

const open: { close(): Promise<void> }[] = [];

afterEach(async () => {
  for (const store of open.splice(0)) await store.close();
});

async function database() {
  const store = await tempStore();
  open.push(store);
  return store.db;
}

function update(
  db: Db,
  id: string,
  set: { linearIdentifier?: string; state?: "merged"; sessionKey?: null },
) {
  return seed(db, (q) => q.orm.update(q.t.workItem).set(set).where(eq(q.t.workItem.id, id)));
}

async function item(db: Db, id: string, identifier: string, session: string, now: number) {
  await insertQueuedItem(db, { id, sessionKey: session, now });
  await update(db, id, { linearIdentifier: identifier });
}

test("every engine run of an issue, including a finished one, resolves to that issue", async () => {
  const db = await database();
  await item(db, "item-1", "PAS-1", "session-a", 0);
  const runs = [];
  for (const at of [0, 1, 2]) runs.push((await insertRun(db, { itemId: "item-1", now: at })).id);
  await update(db, "item-1", { state: "merged" });
  for (const run of runs) expect(await resolveDashboardAlias(db, "runs", run)).toBe("PAS-1");
  expect(await resolveDashboardAlias(db, "runs", "unknown")).toBeNull();
  expect(await resolveDashboardAlias(db, "runs", "PAS-1")).toBeNull();
});

test("a shared session opens the sub-issue delegated first", async () => {
  const db = await database();
  await item(db, "item-b", "PAS-3", "shared", 20);
  await item(db, "item-a", "PAS-2", "shared", 10);
  await item(db, "item-c", "PAS-4", "shared", 10);
  expect(await resolveDashboardAlias(db, "sessions", "shared")).toBe("PAS-2");
  expect(await resolveDashboardAlias(db, "sessions", "unknown")).toBeNull();
});

test("a verdict id is the issue id or one of its runs", async () => {
  const db = await database();
  await item(db, "item-1", "PAS-1", "session-a", 0);
  await item(db, "item-2", "  ", "session-a", 1);
  const run = (await insertRun(db, { itemId: "item-1", now: 0 })).id;
  expect(await resolveDashboardAlias(db, "verdicts", "PAS-1")).toBe("PAS-1");
  expect(await resolveDashboardAlias(db, "verdicts", run)).toBe("PAS-1");
  expect(await resolveDashboardAlias(db, "verdicts", "item-2")).toBe("item-2");
  expect(await resolveDashboardAlias(db, "verdicts", "item-1")).toBeNull();
  expect(await resolveDashboardAlias(db, "verdicts", "PAS-404")).toBeNull();
});

test("a reader resolves only items in their sessions, alike for hidden and unknown ids", async () => {
  const db = await database();
  await item(db, "mine", "PAS-1", "session-mine", 0);
  await item(db, "theirs", "PAS-2", "session-other", 0);
  await insertQueuedItem(db, { id: "no-session", sessionKey: "" });
  await update(db, "no-session", { sessionKey: null });
  const theirs = (await insertRun(db, { itemId: "theirs", now: 0 })).id;
  const scope = ["session-mine"];
  expect(await resolveDashboardAlias(db, "sessions", "session-mine", scope)).toBe("PAS-1");
  expect(await resolveDashboardAlias(db, "sessions", "session-other", scope)).toBeNull();
  expect(await resolveDashboardAlias(db, "runs", theirs, scope)).toBeNull();
  expect(await resolveDashboardAlias(db, "verdicts", "PAS-2", scope)).toBeNull();
  expect(await resolveDashboardAlias(db, "verdicts", "no-session", scope)).toBeNull();
  expect(await resolveDashboardAlias(db, "verdicts", "no-session", [])).toBeNull();
  expect(await resolveDashboardAlias(db, "runs", theirs)).toBe("PAS-2");
});
