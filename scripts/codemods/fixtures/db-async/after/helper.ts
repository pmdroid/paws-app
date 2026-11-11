import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { countItems } from "./db/items";
import { sqliteDb } from "./db/db";

test("counts through a helper declared later", async () => {
  const { count } = await fixture();
  expect(count).toBe(3);
});

async function fixture() {
  const db = new Database(":memory:");
  return { count: await countItems(sqliteDb(db), "abc") };
}
