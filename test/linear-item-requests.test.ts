import { expect, test } from "bun:test";
import { countLinearRequest, linearRequestsByItem } from "../src/db";
import { tempStore } from "./pglite";

test("each task's Linear requests are counted in the database", async () => {
  const { db, close } = await tempStore();
  try {
    await countLinearRequest(db, "item-1");
    await countLinearRequest(db, "item-1");
    await countLinearRequest(db, "item-1");
    await countLinearRequest(db, "item-2");
    expect(await linearRequestsByItem(db)).toEqual(
      new Map([
        ["item-1", 3],
        ["item-2", 1],
      ]),
    );
  } finally {
    await close();
  }
});
