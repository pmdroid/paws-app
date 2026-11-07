import { expect, test } from "bun:test";
import {
  countLinearRequestSteps,
  linearRequestsByCallerSteps,
  linearRequestsByItemSteps,
} from "../src/db";
import { forEachDialect } from "./dialects";

forEachDialect((open) => {
  test("Linear requests count per item and per caller", async () => {
    const { db, close } = await open();
    try {
      for (const [itemId, caller] of [
        ["a", "poll"],
        ["a", "context"],
        ["a", "poll"],
        ["b", "poll"],
      ])
        await db.transaction((q) => countLinearRequestSteps(q, itemId!, caller!));
      expect(await db.run(linearRequestsByItemSteps)).toEqual(
        new Map([
          ["a", 3],
          ["b", 1],
        ]),
      );
      expect(await db.run((q) => linearRequestsByCallerSteps(q, "a"))).toEqual({
        context: 1,
        poll: 2,
      });
      expect(await db.run((q) => linearRequestsByCallerSteps(q, "none"))).toEqual({});
    } finally {
      await close();
    }
  });
});
