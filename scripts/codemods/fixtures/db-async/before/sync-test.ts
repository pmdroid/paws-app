import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { countItems } from "./db/items";

test("counts items", () => {
  const db = new Database(":memory:");
  expect(countItems(db, "abc")).toBe(3);
});
