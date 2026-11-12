import { expect, test } from "bun:test";
import { countItems } from "./db";
import { tempStore } from "./test/pglite";

test("counts items", async () => {
  const { db, close } = await tempStore();
  try {
    db.run("INSERT INTO item VALUES ('a')");
    expect(await countItems(db)).toBe(0);
  } finally {
    await close();
  }
});

test("a second store gets its own close", async () => {
  const { db: other, close: closeOther } = await tempStore();
  expect(await countItems(other)).toBe(0);
  await closeOther();
});
