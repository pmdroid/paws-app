import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  blockerCheckedAtSteps,
  getItemCandidateSteps,
  itemWaitSinceSteps,
  keepItemWaitsSteps,
  listItemHoldsSteps,
  listOverlapHoldAgesSteps,
  recordBlockerChecksSteps,
  recordItemCandidateSteps,
  saveItemHoldsSteps,
  type Db,
} from "../src/db";
import { forEachDialect, insertWorkItem, type DialectDb } from "./dialects";

const opened: DialectDb[] = [];
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close();
});

async function connect(open: () => Promise<DialectDb>, ...items: string[]): Promise<Db> {
  const handle = await open();
  opened.push(handle);
  for (const id of items) await insertWorkItem(handle.db, id);
  return handle.db;
}

forEachDialect((open) => {
  test("an item's candidate is recorded and replaced", async () => {
    const db = await connect(open, "a");
    expect(await db.run((q) => getItemCandidateSteps(q, "a"))).toBeNull();
    const first = { itemId: "a", sha: "s1", branch: "b1", recordedAt: 1 };
    await db.run((q) => recordItemCandidateSteps(q, first));
    expect(await db.run((q) => getItemCandidateSteps(q, "a"))).toEqual(first);
    const second = { itemId: "a", sha: "s2", branch: "b2", recordedAt: 2 };
    await db.run((q) => recordItemCandidateSteps(q, second));
    expect(await db.run((q) => getItemCandidateSteps(q, "a"))).toEqual(second);
  });

  test("holds report what changed and keep their files", async () => {
    const db = await connect(open, "a", "b");
    const blocked = { itemId: "a", reason: "blocked" as const, blockers: ["PAS-1"] };
    const overlap = { itemId: "b", reason: "overlap" as const, blockers: ["a"], files: ["x.ts"] };
    expect(await db.run((q) => saveItemHoldsSteps(q, [blocked, overlap]))).toEqual([
      { itemId: "a", held: blocked },
      { itemId: "b", held: overlap },
    ]);
    expect(await db.run((q) => listItemHoldsSteps(q))).toEqual([blocked, overlap]);
    expect(await db.run((q) => saveItemHoldsSteps(q, [blocked, overlap]))).toEqual([]);
    expect(await db.run((q) => saveItemHoldsSteps(q, [overlap]))).toEqual([
      { itemId: "a", held: null },
    ]);
    expect(await db.run((q) => listItemHoldsSteps(q))).toEqual([overlap]);
  });

  test("an overlap hold age outlives the hold until the item is cancelled", async () => {
    const db = await connect(open, "a", "b");
    const overlap = { itemId: "a", reason: "overlap" as const, blockers: ["b"], files: ["x.ts"] };
    await db.run((q) => saveItemHoldsSteps(q, [overlap], 100));
    await db.run((q) => saveItemHoldsSteps(q, [{ ...overlap, blockers: ["c"] }], 200));
    expect(await db.run((q) => listOverlapHoldAgesSteps(q))).toEqual(new Map([["a", 100]]));
    expect(await db.run((q) => saveItemHoldsSteps(q, [], 300))).toEqual([
      { itemId: "a", held: null },
    ]);
    expect(await db.run((q) => listItemHoldsSteps(q))).toEqual([]);
    expect(await db.run((q) => saveItemHoldsSteps(q, [], 400))).toEqual([]);
    await db.run((q) => saveItemHoldsSteps(q, [{ ...overlap, reason: "slot", blockers: [] }], 500));
    await db.run((q) => saveItemHoldsSteps(q, [overlap], 600));
    expect(await db.run((q) => listOverlapHoldAgesSteps(q))).toEqual(new Map([["a", 100]]));
    await db.run((q) => saveItemHoldsSteps(q, [], 700));
    await db.run((q) =>
      q.exec(
        q.orm.update(q.t.workItem).set({ state: "cancelled" }).where(eq(q.t.workItem.id, "a")),
      ),
    );
    await db.run((q) => saveItemHoldsSteps(q, [], 800));
    expect(await db.run((q) => listOverlapHoldAgesSteps(q))).toEqual(new Map());
  });

  test("a wait starts again only for a new version, and kept items keep theirs", async () => {
    const db = await connect(open, "a", "b");
    expect(await db.run((q) => itemWaitSinceSteps(q, "a", 1, 100))).toBe(100);
    expect(await db.run((q) => itemWaitSinceSteps(q, "a", 1, 200))).toBe(100);
    expect(await db.run((q) => itemWaitSinceSteps(q, "a", 2, 300))).toBe(300);
    expect(await db.run((q) => itemWaitSinceSteps(q, "b", 1, 400))).toBe(400);
    await db.run((q) => keepItemWaitsSteps(q, ["b"]));
    expect(await db.run((q) => itemWaitSinceSteps(q, "a", 2, 500))).toBe(500);
    expect(await db.run((q) => itemWaitSinceSteps(q, "b", 1, 500))).toBe(400);
    await db.run((q) => keepItemWaitsSteps(q, []));
    expect(await db.run((q) => itemWaitSinceSteps(q, "b", 1, 600))).toBe(600);
  });

  test("a blocker check keeps its latest time", async () => {
    const db = await connect(open, "a", "b");
    expect(await db.run((q) => blockerCheckedAtSteps(q, "a"))).toBeNull();
    await db.transaction((q) => recordBlockerChecksSteps(q, ["a", "b"], 10));
    await db.transaction((q) => recordBlockerChecksSteps(q, ["a"], 5));
    expect(await db.run((q) => blockerCheckedAtSteps(q, "a"))).toBe(10);
    await db.transaction((q) => recordBlockerChecksSteps(q, ["b"], 20));
    expect(await db.run((q) => blockerCheckedAtSteps(q, "b"))).toBe(20);
  });
});
