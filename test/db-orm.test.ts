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
        .select({ id: schema.schemaMigration.id })
        .from(schema.schemaMigration)
        .where(eq(schema.schemaMigration.id, "orm_probe"))
        .all();
    expect(() =>
      immediate(db, () => {
        db.run("INSERT INTO schema_migration (id, applied_at) VALUES ('orm_probe', 1)");
        expect(probe()).toEqual([{ id: "orm_probe" }]);
        throw new Error("roll back");
      }),
    ).toThrow("roll back");
    expect(probe()).toEqual([]);
  });
});
