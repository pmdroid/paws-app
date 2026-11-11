import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { countItems } from "./db/items";

test.each(["abc", "de"])("counts %s", (kind) => {
  const db = new Database(":memory:");
  expect(countItems(db, kind)).toBe(kind.length);
});
