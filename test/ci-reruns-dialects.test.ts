import { expect, test } from "bun:test";
import { hasCiRerunSteps, listCiRerunsSteps, recordCiRerunSteps, type CiRerun } from "../src/db";
import { forEachDialect, insertWorkItem } from "./dialects";

const rerun = (head: string, at: number): CiRerun => ({
  itemId: "item",
  head,
  runIds: [7, 8],
  reason: "flaky",
  at,
});

forEachDialect((open) => {
  test("a CI rerun records once per head and lists oldest first", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "item");
      expect(await db.run((q) => hasCiRerunSteps(q, "item", "b"))).toBe(false);
      expect(await db.run((q) => recordCiRerunSteps(q, rerun("b", 20)))).toBe(true);
      expect(await db.run((q) => recordCiRerunSteps(q, { ...rerun("b", 30), runIds: [] }))).toBe(
        false,
      );
      expect(await db.run((q) => recordCiRerunSteps(q, rerun("a", 10)))).toBe(true);
      expect(await db.run((q) => hasCiRerunSteps(q, "item", "b"))).toBe(true);
      expect(await db.run((q) => listCiRerunsSteps(q, "item"))).toEqual([
        rerun("a", 10),
        rerun("b", 20),
      ]);
      expect(await db.run((q) => listCiRerunsSteps(q, "other"))).toEqual([]);
    } finally {
      await close();
    }
  });
});
