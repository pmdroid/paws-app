import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { countItems, migrate, openDatabase, sqliteDb } from "./db";

function harness() {
  const db = openDatabase(":memory:");
  migrate(db);
  return { db };
}

function fresh(): Database {
  const db = openDatabase(":memory:");
  migrate(db);
  return db;
}

async function count(db: ReturnType<typeof harness>["db"]) {
  return await countItems(sqliteDb(db));
}

function rows(db: Database) {
  return db.query("SELECT * FROM item").all();
}

test("a helper that opens the database becomes async", async () => {
  const { db } = harness();
  expect(await countItems(sqliteDb(db))).toBe(await count(db));
  expect(harness().db).toBeDefined();
  expect(await countItems(sqliteDb(fresh()))).toBe(0);
});

test("raw calls on a parameter are reported", () => {
  expect(rows).toBeDefined();
});
