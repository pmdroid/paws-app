import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  claimInboxEventSteps,
  claimNextInboxEventSteps,
  clearSyncCursorSteps,
  incrementSyncCounterSteps,
  releaseInboxClaimSteps,
  renewInboxClaimSteps,
  type Db,
} from "../src/db";
import { forEachDialect, jsonValue, type DialectDb } from "./dialects";

async function withDb(open: () => Promise<DialectDb>, body: (db: Db) => Promise<void>) {
  const { db, close } = await open();
  try {
    await body(db);
  } finally {
    await close();
  }
}

function insertEvent(
  db: Db,
  dedupeKey: string,
  receivedAt: number,
  extra: { sessionId?: string; action?: string; signal?: string; nextAttemptAt?: number } = {},
) {
  return db.run(function* (q) {
    yield* q.exec(
      q.orm.insert(q.t.inboxEvent).values({
        dedupeKey,
        source: "webhook",
        action: extra.action ?? "created",
        sessionId: extra.sessionId ?? "session",
        signal: extra.signal ?? null,
        nextAttemptAt: extra.nextAttemptAt ?? null,
        updatedAtMs: receivedAt,
        payload: jsonValue(q, { dedupeKey, nested: { n: 1 } }),
        receivedAt,
      }),
    );
  });
}

const claim = (owner: string, now: number) => ({ owner, now, leaseMs: 100 });
const next = (db: Db, owner: string, now: number) =>
  db.run((q) => claimNextInboxEventSteps(q, claim(owner, now)));

forEachDialect((open) => {
  test("the head of each session's lane is claimed, with its payload as JSON text", async () =>
    withDb(open, async (db) => {
      await insertEvent(db, "s1-second", 2);
      await insertEvent(db, "s1-first", 1);
      await insertEvent(db, "s2-first", 3, { sessionId: "other" });
      await insertEvent(db, "stop", 0, { sessionId: "stopped", signal: "stop" });
      await insertEvent(db, "other", 0, { sessionId: "ignored", action: "other" });
      await insertEvent(db, "later", 0, { sessionId: "later", nextAttemptAt: 50 });
      const first = await next(db, "a", 10);
      expect(first).toMatchObject({ dedupeKey: "s1-first", lockedBy: "a", lockedUntil: 110 });
      expect(JSON.parse(first!.payload)).toEqual({ dedupeKey: "s1-first", nested: { n: 1 } });
      expect((await next(db, "a", 10))?.dedupeKey).toBe("s2-first");
      expect(await next(db, "a", 10)).toBeNull();
      expect((await next(db, "b", 50))?.dedupeKey).toBe("later");
      await db.run(function* (q) {
        yield* q.exec(
          q.orm
            .update(q.t.inboxEvent)
            .set({ handled: 1 })
            .where(eq(q.t.inboxEvent.dedupeKey, "s1-first")),
        );
      });
      expect((await next(db, "b", 120))?.dedupeKey).toBe("s1-second");
    }));

  test("a claim by key is renewed and released only by its owner", async () =>
    withDb(open, async (db) => {
      await insertEvent(db, "event", 1);
      const byKey = (owner: string, now: number) =>
        db.run((q) => claimInboxEventSteps(q, "event", claim(owner, now)));
      expect((await byKey("a", 10))?.lockedBy).toBe("a");
      expect(await byKey("b", 50)).toBeNull();
      expect(await db.run((q) => renewInboxClaimSteps(q, "event", claim("b", 60)))).toBe(false);
      expect(await db.run((q) => renewInboxClaimSteps(q, "event", claim("a", 60)))).toBe(true);
      expect(await byKey("b", 150)).toBeNull();
      await db.run((q) => releaseInboxClaimSteps(q, "event", "b"));
      expect(await byKey("b", 150)).toBeNull();
      await db.run((q) => releaseInboxClaimSteps(q, "event", "a"));
      expect((await byKey("b", 150))?.lockedBy).toBe("b");
    }));

  test("a sync counter counts up from one and clears", async () =>
    withDb(open, async (db) => {
      const increment = () => db.run((q) => incrementSyncCounterSteps(q, "counter"));
      expect(await increment()).toBe(1);
      expect(await increment()).toBe(2);
      await db.run((q) => clearSyncCursorSteps(q, "counter"));
      expect(await increment()).toBe(1);
    }));
});
