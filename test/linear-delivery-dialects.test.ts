import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getOutboxSteps, prepareLinearActivitySteps, type Db, type OutboxRow } from "../src/db";
import { forEachDialect, jsonValue, type DialectDb } from "./dialects";

async function withDb(open: () => Promise<DialectDb>, body: (db: Db) => Promise<void>) {
  const { db, close } = await open();
  try {
    await body(db);
  } finally {
    await close();
  }
}

function insertActivity(db: Db, payload: unknown, op = "activity") {
  return db.run(function* (q) {
    const rows = yield* q.all(
      q.orm
        .insert(q.t.outbox)
        .values({
          target: "linear",
          op,
          orderingKey: "session",
          idempotencyKey: `key-${op}`,
          payload: jsonValue(q, payload),
          createdAt: 0,
        })
        .returning({ id: q.t.outbox.id }),
    );
    return (yield* getOutboxSteps(q, rows[0]!.id))!;
  });
}

const prepare = (db: Db, message: OutboxRow) =>
  db.run((q) => prepareLinearActivitySteps(q, message));

forEachDialect((open) => {
  test("a Linear activity gets a stable id before delivery", async () =>
    withDb(open, async (db) => {
      const message = await insertActivity(db, { body: "hello" });
      const prepared = await prepare(db, message);
      expect(prepared.payload).toEqual({ body: "hello", id: expect.any(String) });
      expect(await prepare(db, prepared)).toBe(prepared);
    }));

  test("other messages and payloads with an id are left alone", async () =>
    withDb(open, async (db) => {
      const withId = await insertActivity(db, { id: "fixed" });
      expect(await prepare(db, withId)).toBe(withId);
      const other = await insertActivity(db, { body: "x" }, "issue_update");
      expect(await prepare(db, other)).toBe(other);
    }));

  test("an activity that changed since it was read is refused", async () =>
    withDb(open, async (db) => {
      const message = await insertActivity(db, { body: "hello" });
      await db.run(function* (q) {
        yield* q.exec(
          q.orm.update(q.t.outbox).set({ attempts: 1 }).where(eq(q.t.outbox.id, message.id)),
        );
      });
      await expect(prepare(db, message)).rejects.toThrow(
        "The Linear activity changed before delivery",
      );
    }));
});
