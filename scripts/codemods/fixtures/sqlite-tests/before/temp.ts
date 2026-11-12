import { expect, test } from "bun:test";
import { countItems, sqliteDb } from "./db";
import { tempDb } from "./test/helpers";

test("counts items", async () => {
  const db = tempDb();
  try {
    db.run("INSERT INTO item VALUES ('a')");
    expect(await countItems(sqliteDb(db))).toBe(0);
  } finally {
    db.close();
  }
});

test("a second store gets its own close", async () => {
  const other = tempDb();
  expect(await countItems(sqliteDb(other))).toBe(0);
  other.close();
});
