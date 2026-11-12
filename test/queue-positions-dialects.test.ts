import { afterEach, expect, test } from "bun:test";
import { listQueuePositions, saveQueuePositions } from "../src/db";
import { forEachDialect, insertWorkItem, type DialectDb } from "./dialects";

const opened: DialectDb[] = [];
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close();
});

forEachDialect((open) => {
  test("concurrent queue position rewrites with overlapping items both complete", async () => {
    const handle = await open();
    opened.push(handle);
    const { db } = handle;
    for (const id of ["a", "b", "c", "d"]) await insertWorkItem(db, id);
    const slots = { busy: 1, total: 2 };
    const first = ["a", "b", "c"];
    const second = ["c", "b", "d"];
    await Promise.all([
      saveQueuePositions(db, first, slots, 1),
      saveQueuePositions(db, second, slots, 2),
    ]);
    const saved = (await listQueuePositions(db)).map((entry) => entry.itemId);
    expect([first, second]).toContainEqual(saved);
  });
});
