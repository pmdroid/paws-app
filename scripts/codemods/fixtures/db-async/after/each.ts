import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { countItems } from "./db/items";
import { sqliteDb } from "./db/db";

test.each(["abc", "de"])("counts %s", async (kind) => {
  const db = new Database(":memory:");
  expect(await countItems(sqliteDb(db), kind)).toBe(kind.length);
});
