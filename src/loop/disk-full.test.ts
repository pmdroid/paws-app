import { expect, test } from "bun:test";
import { enqueueOutbox, migrate, openDatabase, sqliteDb } from "../db";
import { hostDiskFullThoughtKeySteps } from "./disk-full";

const HOUR = 60 * 60_000;

test("an item gets at most one disk-full thought per hour", async () => {
  const db = openDatabase(":memory:");
  try {
    migrate(db);
    const post = async (itemId: string, now: number) => {
      const key = await sqliteDb(db).run((q) => hostDiskFullThoughtKeySteps(q, itemId, now));
      if (key !== null)
        await enqueueOutbox(sqliteDb(db), {
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
    db.close();
  }
});
