import { expect, test } from "bun:test";
import { enqueueOutbox } from "../db";
import { hostDiskFullThoughtKeySteps } from "./disk-full";
import { tempStore } from "../../test/pglite";

const HOUR = 60 * 60_000;

test("an item gets at most one disk-full thought per hour", async () => {
  const { db, close } = await tempStore();
  try {
    const post = async (itemId: string, now: number) => {
      const key = await db.run((q) => hostDiskFullThoughtKeySteps(q, itemId, now));
      if (key !== null)
        await enqueueOutbox(db, {
          target: "linear",
          op: "activity",
          orderingKey: `ses-${itemId}`,
          idempotencyKey: key,
          payload: {},
          now,
        });
      return key !== null;
    };
    const start = 10 * HOUR;
    expect(await post("item-a", start)).toBe(true);
    expect(await post("item-a", start + 1)).toBe(false);
    expect(await post("item-a", start + HOUR - 1)).toBe(false);
    expect(await post("item-b", start + 1)).toBe(true);
    expect(await post("item-a", start + HOUR)).toBe(true);
    expect(await post("item-a", start + HOUR + 1)).toBe(false);
  } finally {
    await close();
  }
});
