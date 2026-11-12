import { expect, test } from "bun:test";
import { countLinearRequest, linearRequestsByCaller, linearRequestsByItem } from "../src/db";
import { tempStore } from "./pglite";

test("each task's Linear requests are kept per caller in the database", async () => {
  const { db, close } = await tempStore();
  try {
    await countLinearRequest(db, "item-1", "outbox");
    await countLinearRequest(db, "item-1", "outbox");
    await countLinearRequest(db, "item-1", "task-access");
    await countLinearRequest(db, "item-2", "outbox");
    expect(await linearRequestsByItem(db)).toEqual(
      new Map([
        ["item-1", 3],
        ["item-2", 1],
      ]),
    );
    expect(await linearRequestsByCaller(db, "item-1")).toEqual({
      outbox: 2,
      "task-access": 1,
    });
    expect(await linearRequestsByCaller(db, "item-3")).toEqual({});
  } finally {
    await close();
  }
});
