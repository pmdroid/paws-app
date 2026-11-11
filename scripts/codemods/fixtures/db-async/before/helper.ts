import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { countItems } from "./db/items";

test("counts through a helper declared later", () => {
  const { count } = fixture();
  expect(count).toBe(3);
});

function fixture() {
  const db = new Database(":memory:");
  return { count: countItems(db, "abc") };
}
