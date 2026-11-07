import { expect, test } from "bun:test";
import { carriedAcceptForSteps, recordCarriedAcceptSteps } from "../src/db";
import { forEachDialect } from "./dialects";

forEachDialect((open) => {
  test("a carried acceptance records per rebased head and replaces on a second rebase", async () => {
    const { db, close } = await open();
    try {
      const carried = { itemId: "item", head: "rebased", acceptedHead: "a1", base: "m1", now: 1 };
      expect(await db.run((q) => carriedAcceptForSteps(q, "item", "rebased"))).toBeNull();
      await db.run((q) => recordCarriedAcceptSteps(q, carried));
      await db.run((q) => recordCarriedAcceptSteps(q, { ...carried, acceptedHead: "a2", now: 2 }));
      expect(await db.run((q) => carriedAcceptForSteps(q, "item", "rebased"))).toBe("a2");
      expect(await db.run((q) => carriedAcceptForSteps(q, "item", "other"))).toBeNull();
    } finally {
      await close();
    }
  });
});
