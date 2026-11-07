import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  applyLinearIssueProjectSteps,
  getWorkItemLinearProjectIdSteps,
  saveWorkItemLinearProjectSteps,
  type Db,
} from "../src/db";
import { forEachDialect, insertWorkItem, type DialectDb } from "./dialects";

async function withDb(open: () => Promise<DialectDb>, body: (db: Db) => Promise<void>) {
  const { db, close } = await open();
  try {
    await body(db);
  } finally {
    await close();
  }
}

function project(db: Db, itemId: string) {
  return db.run(function* (q) {
    const { workItem } = q.t;
    return yield* q.one(
      q.orm
        .select({ id: workItem.linearProjectId, name: workItem.linearProjectName })
        .from(workItem)
        .where(eq(workItem.id, itemId)),
    );
  });
}

forEachDialect((open) => {
  test("a missing project name keeps the stored one only for the same project", async () =>
    withDb(open, async (db) => {
      await insertWorkItem(db, "item");
      const save = (value: { id: string; name: string | null } | null) =>
        db.run((q) => saveWorkItemLinearProjectSteps(q, "item", value));
      expect(await db.run((q) => getWorkItemLinearProjectIdSteps(q, "item"))).toBeNull();
      await save({ id: " p1 ", name: " Alpha " });
      expect(await project(db, "item")).toEqual({ id: "p1", name: "Alpha" });
      await save({ id: "p1", name: null });
      expect(await project(db, "item")).toEqual({ id: "p1", name: "Alpha" });
      await save({ id: "p2", name: "" });
      expect(await project(db, "item")).toEqual({ id: "p2", name: null });
      await save({ id: " ", name: "Ignored" });
      expect(await project(db, "item")).toEqual({ id: null, name: null });
      expect(await db.run((q) => getWorkItemLinearProjectIdSteps(q, "missing"))).toBeNull();
    }));

  test("an issue's project moves every item of that issue and counts them", async () =>
    withDb(open, async (db) => {
      await insertWorkItem(db, "a");
      await insertWorkItem(db, "b");
      expect(
        await db.run((q) => applyLinearIssueProjectSteps(q, "issue-a", { id: "p", name: "P" })),
      ).toBe(1);
      expect(await db.run((q) => getWorkItemLinearProjectIdSteps(q, "a"))).toBe("p");
      expect(await db.run((q) => getWorkItemLinearProjectIdSteps(q, "b"))).toBeNull();
      expect(await db.run((q) => applyLinearIssueProjectSteps(q, "none", null))).toBe(0);
    }));
});
