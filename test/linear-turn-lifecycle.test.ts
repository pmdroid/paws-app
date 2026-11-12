import { expect, test } from "bun:test";
import {
  activateLinearItem,
  acceptLinearStop,
  acceptLinearStopSteps,
  advanceLinearSessionGeneration,
  announceLinearTurn,
  applyLinearTurns,
  bindLinearSessionTask,
  discardLinearTurns,
  getLinearSession,
  getLinearTurnGeneration,
  insertQueuedItem,
  listLinearTurnsForItem,
  listOutbox,
  listPendingLinearTurns,
  recordLinearTurn,
  type Db,
} from "../src/db";
import { tempHome, withHomeStore } from "./helpers";
import { tempStore } from "./pglite";

async function turn(db: Db, key: string, at = 1, sessionId = "session") {
  return await recordLinearTurn(db, {
    eventKey: key,
    activityId: `activity:${key}`,
    sessionId,
    actorId: "human",
    body: key,
    payload: "{}",
    createdAtMs: at,
  });
}

test("a turn announcement and activity UUID survive restart without advancing twice", async () => {
  const home = tempHome();
  const original = await withHomeStore(home, async (db) => {
    await turn(db, "first");
    expect(await announceLinearTurn(db, "session", "first", 2)).toBe(true);
    const original = (await listOutbox(db))[0]!;
    expect(original.generation).toBe(1);
    expect(original.delivery).toBe("critical");
    expect((original.payload as { id: string }).id).toMatch(/^[0-9a-f-]{36}$/);
    return original;
  });
  await withHomeStore(home, async (db) => {
    expect(await announceLinearTurn(db, "session", "first", 3)).toBe(false);
    expect((await getLinearSession(db, "session"))?.generation).toBe(1);
    expect(await listOutbox(db)).toEqual([original]);
    expect(await getLinearTurnGeneration(db, "session", "duplicate-key", "activity:first")).toBe(1);
    expect(await getLinearTurnGeneration(db, "other", "first", "activity:first")).toBeNull();
    await turn(db, "second", 4);
    expect(await announceLinearTurn(db, "session", "second", 5)).toBe(true);
    expect(await getLinearTurnGeneration(db, "session", "first", null)).toBe(1);
    expect(await getLinearTurnGeneration(db, "session", "second", null)).toBe(2);
    expect((await listOutbox(db))[0]?.status).toBe("dropped");
  });
});

test("Stop rejects delayed prior turns and a later turn starts a new generation", async () => {
  const { db, close } = await tempStore();
  try {
    await turn(db, "first", 1);
    await announceLinearTurn(db, "session", "first", 2);
    await advanceLinearSessionGeneration(db, "session", { stop: true, now: 3 });
    await turn(db, "delayed", 2);
    expect(await announceLinearTurn(db, "session", "delayed", 4)).toBe(false);
    expect(await listPendingLinearTurns(db, "session")).toEqual([]);
    expect((await getLinearSession(db, "session"))?.stoppedAt).toBe(3);
    await turn(db, "later", 4);
    expect(await announceLinearTurn(db, "session", "later", 5)).toBe(true);
    expect((await getLinearSession(db, "session"))?.stoppedAt).toBeNull();
    expect(await getLinearTurnGeneration(db, "session", "later", null)).toBe(3);
    expect((await listPendingLinearTurns(db, "session")).map((entry) => entry.eventKey)).toEqual([
      "later",
    ]);
  } finally {
    await close();
  }
});

test("discarding rejected replies is session-scoped, idempotent and preserves applied history", async () => {
  const { db, close } = await tempStore();
  try {
    const item = await insertQueuedItem(db, { id: "ENG-1", sessionKey: "session" });
    for (const key of ["applied", "rejected", "pending"]) await turn(db, key);
    await bindLinearSessionTask(db, "session", item.delegationId);
    await activateLinearItem(db, "session", item.id);
    await applyLinearTurns(db, "session", ["applied"], item.id);
    await discardLinearTurns(db, "other", ["pending"]);
    await discardLinearTurns(db, "session", ["applied", "rejected"]);
    await discardLinearTurns(db, "session", ["rejected"]);
    expect((await listPendingLinearTurns(db, "session")).map((entry) => entry.eventKey)).toEqual([
      "pending",
    ]);
    expect((await listLinearTurnsForItem(db, item.id)).map((entry) => entry.eventKey)).toEqual([
      "applied",
    ]);
    expect(await listLinearTurnsForItem(db, "other")).toEqual([]);
    expect(await announceLinearTurn(db, "session", "rejected")).toBe(false);
  } finally {
    await close();
  }
});

test("Stop receipts survive a newer generation and roll back with the enclosing transaction", async () => {
  const home = tempHome();
  const current = await withHomeStore(home, async (db) => {
    await expect(
      db.transaction(function* (q) {
        expect(
          yield* q.transaction((inner) => acceptLinearStopSteps(inner, "session", "stop", 1)),
        ).toBe(1);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await getLinearSession(db, "session")).toBeNull();
    expect(await db.run((q) => q.all(q.orm.select().from(q.t.linearStopReceipt)))).toEqual([]);
    expect(await acceptLinearStop(db, "session", "stop", 1)).toBe(1);
    expect(await acceptLinearStop(db, "session", "another-stop", 2)).toBe(1);
    await advanceLinearSessionGeneration(db, "session", { now: 3 });
    return await getLinearSession(db, "session");
  });
  await withHomeStore(home, async (db) => {
    expect(await acceptLinearStop(db, "session", "stop", 1)).toBeNull();
    expect(await getLinearSession(db, "session")).toEqual(current);
    expect(await acceptLinearStop(db, "other", "stop", 4)).toBe(1);
    expect(await acceptLinearStop(db, "session", "new-stop", 4)).toBe(3);
  });
});
