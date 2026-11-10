import { expect, test } from "bun:test";
import {
  countLinearRequest,
  linearRequestsByCaller,
  linearRequestsByItem,
  migrate,
  openDatabase,
  sqliteDb,
} from "../src/db";

test("each task's Linear requests are kept per caller in the database", async () => {
  const db = openDatabase(":memory:");
  try {
    migrate(db);
    await countLinearRequest(sqliteDb(db), "item-1", "outbox");
    await countLinearRequest(sqliteDb(db), "item-1", "outbox");
    await countLinearRequest(sqliteDb(db), "item-1", "task-access");
    await countLinearRequest(sqliteDb(db), "item-2", "outbox");
    expect(await linearRequestsByItem(sqliteDb(db))).toEqual(
      new Map([
        ["item-1", 3],
        ["item-2", 1],
      ]),
    );
    expect(await linearRequestsByCaller(sqliteDb(db), "item-1")).toEqual({
      outbox: 2,
      "task-access": 1,
    });
    expect(await linearRequestsByCaller(sqliteDb(db), "item-3")).toEqual({});
  } finally {
    db.close();
  }
});
