import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { immediate, orm, schema } from "../src/db";
import { tempDb } from "./helpers";

describe("orm", () => {
  test("returns one handle per database", () => {
    const db = tempDb();
    expect(orm(db)).toBe(orm(db));
    expect(orm(tempDb())).not.toBe(orm(db));
  });

  test("sees uncommitted rows inside immediate()", () => {
    const db = tempDb();
    const probe = () =>
      orm(db)
        .select({ name: schema.syncCursor.name })
        .from(schema.syncCursor)
        .where(eq(schema.syncCursor.name, "orm_probe"))
        .all();
    expect(() =>
      immediate(db, () => {
        db.run("INSERT INTO sync_cursor (name, cursor_ms) VALUES ('orm_probe', 1)");
        expect(probe()).toEqual([{ name: "orm_probe" }]);
        throw new Error("roll back");
      }),
    ).toThrow("roll back");
    expect(probe()).toEqual([]);
  });
});
