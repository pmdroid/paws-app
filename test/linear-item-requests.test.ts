import { expect, test } from "bun:test";
import {
  countLinearRequest,
  linearRequestsByCaller,
  linearRequestsByItem,
  migrate,
  openDatabase,
} from "../src/db";

test("each task's Linear requests are kept per caller in the database", () => {
  const db = openDatabase(":memory:");
  try {
    migrate(db);
    countLinearRequest(db, "item-1", "outbox");
    countLinearRequest(db, "item-1", "outbox");
    countLinearRequest(db, "item-1", "task-access");
    countLinearRequest(db, "item-2", "outbox");
    expect(linearRequestsByItem(db)).toEqual(
      new Map([
        ["item-1", 3],
        ["item-2", 1],
      ]),
    );
    expect(linearRequestsByCaller(db, "item-1")).toEqual({ outbox: 2, "task-access": 1 });
    expect(linearRequestsByCaller(db, "item-3")).toEqual({});
  } finally {
    db.close();
  }
});
