import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { count, sql } from "drizzle-orm";
import { openPglite, pgSchema, postgresDb, schema, sqliteDb, type Q } from "../src/db";
import { forEachDialect, insertWorkItem, insertWorkItemSteps } from "./dialects";
import { tempDb } from "./helpers";

function* itemCount(q: Q) {
  const row = yield* q.one(q.orm.select({ n: count() }).from(q.t.workItem));
  return row!.n;
}

forEachDialect((open) => {
  test("a transaction commits all of its writes, and rolls all of them back when its body throws", async () => {
    const { db, close } = await open();
    try {
      await db.transaction(function* (q) {
        yield* insertWorkItemSteps(q, "a");
        yield* insertWorkItemSteps(q, "b");
      });
      expect(await db.run(itemCount)).toBe(2);
      const failed = db.transaction(function* (q) {
        yield* insertWorkItemSteps(q, "c");
        yield* insertWorkItemSteps(q, "d");
        expect(yield* itemCount(q)).toBe(4);
        throw new Error("stop");
      });
      await expect(failed).rejects.toThrow("stop");
      expect(await db.run(itemCount)).toBe(2);
    } finally {
      await close();
    }
  });

  test("a nested transaction rolls back only its own writes, and a failed query reaches the body", async () => {
    const { db, close } = await open();
    try {
      const caught = await db.transaction(function* (q) {
        yield* insertWorkItemSteps(q, "outer");
        try {
          yield* q.transaction(function* (inner) {
            yield* insertWorkItemSteps(inner, "inner");
            yield* insertWorkItemSteps(inner, "outer");
          });
        } catch {
          return yield* itemCount(q);
        }
        return -1;
      });
      expect(caught).toBe(1);
      const ids = await db.run(function* (q) {
        return yield* q.all(q.orm.select({ id: q.t.workItem.id }).from(q.t.workItem));
      });
      expect(ids).toEqual([{ id: "outer" }]);
    } finally {
      await close();
    }
  });

  test("returning() counts the changed rows", async () => {
    const { db, close } = await open();
    try {
      for (const id of ["a", "b", "c"]) await insertWorkItem(db, id);
      const changed = await db.run(function* (q) {
        const { workItem } = q.t;
        const rows = yield* q.all(
          q.orm
            .update(workItem)
            .set({ state: "running" })
            .where(sql`${workItem.id} <> 'b'`)
            .returning({ id: workItem.id }),
        );
        return rows.length;
      });
      expect(changed).toBe(2);
    } finally {
      await close();
    }
  });
});

test("on SQLite db.run() settles before it returns", async () => {
  const database = tempDb();
  try {
    const db = sqliteDb(database);
    const done = insertWorkItem(db, "a");
    expect(Bun.peek.status(done)).toBe("fulfilled");
    expect(await db.run(itemCount)).toBe(1);
  } finally {
    database.close();
  }
});

test("the Postgres and SQLite schemas export the same table names", () => {
  expect(Object.keys(pgSchema).sort()).toEqual(Object.keys(schema).sort());
});

test("openPglite() migrates an empty directory once, and opening it again keeps its rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "paws-pglite-"));
  const migrations = sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
  try {
    const first = await openPglite(dir);
    const applied = (await first.execute<{ n: number }>(migrations)).rows[0]!.n;
    expect(applied).toBeGreaterThan(0);
    await insertWorkItem(postgresDb(first), "a");
    await first.$client.close();
    const second = await openPglite(dir);
    try {
      expect((await second.execute<{ n: number }>(migrations)).rows[0]!.n).toBe(applied);
      expect(await second.select().from(pgSchema.workItem)).toHaveLength(1);
    } finally {
      await second.$client.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
