import { expect, test } from "bun:test";
import { count, sql } from "drizzle-orm";
import {
  applyWorkItemEvent,
  getConfirmedRemoteMerge,
  getWorkItem,
  insertQueuedItem,
  recordConfirmedRemoteMerge,
  type ConfirmedRemoteMerge,
} from "../src/db";
import { seed } from "./dialects";
import { tempHome, withHomeStore } from "./helpers";
import { tempStore } from "./pglite";

function fact(itemId = "item"): ConfirmedRemoteMerge {
  return {
    itemId,
    repositoryOwner: "owner",
    repositoryName: "repo",
    pullNumber: 42,
    pullUrl: "https://github.com/owner/repo/pull/42",
    mergeSha: "a".repeat(40),
    confirmedAt: 200,
  };
}

test.each(["cancelled", "merged"] as const)(
  "a confirmed remote merge survives reopening without changing %s task history",
  async (state) => {
    const home = tempHome();
    const { id, before } = await withHomeStore(home, async (db) => {
      const item = await insertQueuedItem(db, { id: "item" });
      if (state === "cancelled") await applyWorkItemEvent(db, item.id, "cancel");
      else {
        await applyWorkItemEvent(db, item.id, "dispatched");
        await applyWorkItemEvent(db, item.id, "turn_ended");
        await applyWorkItemEvent(db, item.id, "closeout_accepted");
        await applyWorkItemEvent(db, item.id, "merge_accepted");
      }
      const stored = await getWorkItem(db, item.id);
      await recordConfirmedRemoteMerge(db, fact());
      return { id: item.id, before: stored };
    });
    await withHomeStore(home, async (db) => {
      expect(await getConfirmedRemoteMerge(db, id)).toEqual(fact());
      expect(await getWorkItem(db, id)).toEqual(before);
      expect((await getWorkItem(db, id))?.state).toBe(state);
      const jobs = await db.run((q) => q.one(q.orm.select({ n: count() }).from(q.t.job)));
      const outbox = await db.run((q) => q.one(q.orm.select({ n: count() }).from(q.t.outbox)));
      expect(jobs?.n).toBe(0);
      expect(outbox?.n).toBe(0);
    });
  },
);

test("replayed confirmation preserves its original observation and rejects conflicting PR history", async () => {
  const { db, close } = await tempStore();
  try {
    await insertQueuedItem(db, { id: "item" });
    await recordConfirmedRemoteMerge(db, fact());
    expect(await recordConfirmedRemoteMerge(db, { ...fact(), confirmedAt: 300 })).toEqual(fact());
    await expect(recordConfirmedRemoteMerge(db, { ...fact(), pullNumber: 43 })).rejects.toThrow(
      "conflicts",
    );
    await expect(
      recordConfirmedRemoteMerge(db, { ...fact(), mergeSha: "b".repeat(40) }),
    ).rejects.toThrow("conflicts");
    expect(await getConfirmedRemoteMerge(db, "item")).toEqual(fact());
    expect((await getWorkItem(db, "item"))?.state).toBe("queued");
  } finally {
    await close();
  }
});

test("confirmed success without a reported merge SHA retains the PR identity without inventing a SHA", async () => {
  const { db, close } = await tempStore();
  try {
    await insertQueuedItem(db, { id: "item" });
    expect(await recordConfirmedRemoteMerge(db, { ...fact(), mergeSha: null })).toEqual({
      ...fact(),
      mergeSha: null,
    });
    expect((await getConfirmedRemoteMerge(db, "item"))?.mergeSha).toBeNull();
  } finally {
    await close();
  }
});

test("a failed fact write leaves terminal task history and earlier confirmed merges untouched", async () => {
  const { db, close } = await tempStore();
  try {
    await insertQueuedItem(db, { id: "item" });
    await insertQueuedItem(db, { id: "second" });
    await recordConfirmedRemoteMerge(db, fact());
    await applyWorkItemEvent(db, "second", "cancel");
    await seed(
      db,
      (q) =>
        q.orm.execute(
          sql`CREATE FUNCTION deny_fact() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'storage failure'; END $$ LANGUAGE plpgsql`,
        ),
      (q) =>
        q.orm.execute(
          sql`CREATE TRIGGER deny_fact BEFORE INSERT ON remote_merge_fact FOR EACH ROW WHEN (NEW.item_id = 'second') EXECUTE FUNCTION deny_fact()`,
        ),
    );
    const error = (await recordConfirmedRemoteMerge(db, fact("second")).catch(
      (e: unknown) => e,
    )) as Error;
    expect(String(error.cause)).toContain("storage failure");
    expect((await getWorkItem(db, "second"))?.state).toBe("cancelled");
    expect(await getConfirmedRemoteMerge(db, "second")).toBeNull();
    expect(await getConfirmedRemoteMerge(db, "item")).toEqual(fact());
  } finally {
    await close();
  }
});
