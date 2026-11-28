import { afterEach, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { insertQueuedItem, listItemHolds, type Db } from "../src/db";
import { createAdmission, dispatch } from "../src/scheduler";
import { workspaceDispatchPg } from "./fake-workspace";
import { tempStore } from "./pglite";
import { queriesDuring } from "./query-log";

const NOW = 10_000;
const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function admitted(count: number): Promise<Db> {
  const { db, close } = await tempStore();
  open.push(close);
  for (let index = 0; index < count; index += 1)
    await insertQueuedItem(db, { id: `item-${index}`, now: index });
  await insertQueuedItem(db, { id: "later", now: count });
  await insertQueuedItem(db, { id: "first", now: count + 1 });
  await db.run(function* (q) {
    const { workItem, taskBlock } = q.t;
    const pair = inArray(workItem.id, ["later", "first"]);
    yield* q.exec(q.orm.update(workItem).set({ delegationId: "epic-pair" }).where(pair));
    yield* q.exec(
      q.orm
        .insert(taskBlock)
        .values({ blockerLinearIssueId: "lin-item-first", blockedLinearIssueId: "lin-item-later" }),
    );
  });
  await workspaceDispatchPg(db, { now: NOW });
  return db;
}

async function pass(db: Db, now: number) {
  const started = performance.now();
  const statements = await queriesDuring(db, () =>
    dispatch(db, { admission: createAdmission({ db }), now }),
  );
  return { statements: statements.length, ms: performance.now() - started };
}

test("a repeat admission pass reads readiness inputs in a fixed number of statements", async () => {
  const counts: Record<number, { statements: number; ms: number }> = {};
  for (const size of [10, 100, 300]) {
    const db = await admitted(size);
    await pass(db, NOW + 1);
    counts[size] = await pass(db, NOW + 2);
    expect(await listItemHolds(db)).toEqual([
      { itemId: "later", reason: "blocked", blockers: ["first"] },
    ]);
  }
  console.log(JSON.stringify(counts));
  expect(counts[300]!.statements).toBe(counts[10]!.statements);
}, 120_000);
