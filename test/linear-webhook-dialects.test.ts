import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { LINEAR_WEBHOOK_SILENCE_MS, linearWebhookWarningSteps, type Db } from "../src/db";
import { forEachDialect, insertWorkItem, type DialectDb } from "./dialects";

async function withDb(open: () => Promise<DialectDb>, body: (db: Db) => Promise<void>) {
  const { db, close } = await open();
  try {
    await body(db);
  } finally {
    await close();
  }
}

function setCursor(db: Db, name: string, cursorMs: number) {
  return db.run(function* (q) {
    yield* q.exec(q.orm.insert(q.t.syncCursor).values({ name, cursorMs }));
  });
}

const warning = (db: Db, nowMs: number) => db.run((q) => linearWebhookWarningSteps(q, nowMs));

forEachDialect((open) => {
  test("a webhook is silent only while a session's item is active", async () =>
    withDb(open, async (db) => {
      expect(await warning(db, 0)).toBeNull();
      await setCursor(db, "linear:webhook", 100);
      const late = 100 + LINEAR_WEBHOOK_SILENCE_MS + 1;
      expect(await warning(db, 100 + LINEAR_WEBHOOK_SILENCE_MS)).toBeNull();
      expect(await warning(db, late)).toBeNull();
      await insertWorkItem(db, "item");
      await db.run(function* (q) {
        yield* q.exec(
          q.orm
            .update(q.t.workItem)
            .set({ sessionKey: "session", state: "merged" })
            .where(eq(q.t.workItem.id, "item")),
        );
      });
      expect(await warning(db, late)).toBeNull();
      await db.run(function* (q) {
        yield* q.exec(
          q.orm.update(q.t.workItem).set({ state: "running" }).where(eq(q.t.workItem.id, "item")),
        );
      });
      expect(await warning(db, late)).toEqual({
        reason: "silent",
        lastVerifiedMs: 100,
        missedMs: null,
      });
    }));

  test("events the catch-up poll found after the last delivery are a missed webhook", async () =>
    withDb(open, async (db) => {
      await setCursor(db, "linear:webhook", 100);
      await setCursor(db, "linear:webhook-missed", 200);
      expect(await warning(db, 300)).toEqual({
        reason: "missed",
        lastVerifiedMs: 100,
        missedMs: 200,
      });
    }));
});
