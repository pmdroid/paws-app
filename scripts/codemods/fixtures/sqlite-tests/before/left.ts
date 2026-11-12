import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { countItems, openDatabase, sqliteDb } from "./db";
import { tempDb } from "./test/helpers";

let db: Database;
beforeEach(() => {
  db = tempDb();
});
afterEach(() => db.close());

test("an assigned database and a file database stay", async () => {
  const file = openDatabase("/tmp/paws.db");
  expect(await countItems(sqliteDb(db))).toBe(0);
  file.close();
});
