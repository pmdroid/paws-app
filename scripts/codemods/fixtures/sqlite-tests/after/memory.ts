import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { countItems } from "./db";
import { tempStore } from "./test/pglite";

async function harness() {
  const db = (await tempStore()).db;
  return { db };
}

async function count(db: Awaited<ReturnType<typeof harness>>["db"]) {
  return await countItems(db);
}

function rows(db: Database) {
  return db.query("SELECT * FROM item").all();
}

test("a helper that opens the database becomes async", async () => {
  const { db } = await harness();
  expect(await countItems(db)).toBe(await count(db));
  expect((await harness()).db).toBeDefined();
});

test("raw calls on a parameter are reported", () => {
  expect(rows).toBeDefined();
});
