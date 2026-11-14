import { expect, test } from "bun:test";
import { countLinearRequestSteps, linearRequestsByItemSteps } from "../src/db";
import { forEachDialect } from "./dialects";

forEachDialect((open) => {
  test("Linear requests count per item", async () => {
    const { db, close } = await open();
    try {
      for (const itemId of ["a", "a", "a", "b"])
        await db.transaction((q) => countLinearRequestSteps(q, itemId));
      expect(await db.run(linearRequestsByItemSteps)).toEqual(
        new Map([
          ["a", 3],
          ["b", 1],
        ]),
      );
    } finally {
      await close();
    }
  });
});
