import { expect, test } from "bun:test";
import { enqueueOutbox, migrate, openDatabase } from "../db";
import { hostDiskFullThoughtKey } from "./disk-full";

const HOUR = 60 * 60_000;

test("an item gets at most one disk-full thought per hour", () => {
  const db = openDatabase(":memory:");
  try {
    migrate(db);
    const post = (itemId: string, now: number) => {
      const key = hostDiskFullThoughtKey(db, itemId, now);
      if (key !== null)
        enqueueOutbox(db, {
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
    expect(post("item-a", start)).toBe(true);
    expect(post("item-a", start + 1)).toBe(false);
    expect(post("item-a", start + HOUR - 1)).toBe(false);
    expect(post("item-b", start + 1)).toBe(true);
    expect(post("item-a", start + HOUR)).toBe(true);
    expect(post("item-a", start + HOUR + 1)).toBe(false);
  } finally {
    db.close();
  }
});
