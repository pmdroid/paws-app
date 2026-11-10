import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { countItems } from "./db/items";
import { sqliteDb } from "./db/db";

test("counts items", async () => {
  const db = new Database(":memory:");
  expect(await countItems(sqliteDb(db), "abc")).toBe(3);
});
