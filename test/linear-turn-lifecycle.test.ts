import { expect, test } from "bun:test";
import { join } from "node:path";
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
  migrate,
  openDatabase,
  recordLinearTurn,
  sqliteDb,
} from "../src/db";
import { tempDb, tempHome } from "./helpers";

async function turn(db: ReturnType<typeof tempDb>, key: string, at = 1, sessionId = "session") {
  return await recordLinearTurn(sqliteDb(db), {
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
  const path = join(tempHome(), "turns.db");
  let db = openDatabase(path);
  migrate(db);
  try {
    await turn(db, "first");
    expect(await announceLinearTurn(sqliteDb(db), "session", "first", 2)).toBe(true);
    const original = listOutbox(db)[0]!;
    expect(original.generation).toBe(1);
    expect(original.delivery).toBe("critical");
    expect((original.payload as { id: string }).id).toMatch(/^[0-9a-f-]{36}$/);
    db.close();
    db = openDatabase(path);
    migrate(db);
    expect(await announceLinearTurn(sqliteDb(db), "session", "first", 3)).toBe(false);
    expect(getLinearSession(db, "session")?.generation).toBe(1);
    expect(listOutbox(db)).toEqual([original]);
    expect(
      await getLinearTurnGeneration(sqliteDb(db), "session", "duplicate-key", "activity:first"),
    ).toBe(1);
    expect(
      await getLinearTurnGeneration(sqliteDb(db), "other", "first", "activity:first"),
    ).toBeNull();
    await turn(db, "second", 4);
    expect(await announceLinearTurn(sqliteDb(db), "session", "second", 5)).toBe(true);
    expect(await getLinearTurnGeneration(sqliteDb(db), "session", "first", null)).toBe(1);
    expect(await getLinearTurnGeneration(sqliteDb(db), "session", "second", null)).toBe(2);
    expect(listOutbox(db)[0]?.status).toBe("dropped");
  } finally {
    db.close();
  }
});

test("Stop rejects delayed prior turns and a later turn starts a new generation", async () => {
  const db = tempDb();
  try {
    await turn(db, "first", 1);
    await announceLinearTurn(sqliteDb(db), "session", "first", 2);
    await advanceLinearSessionGeneration(sqliteDb(db), "session", { stop: true, now: 3 });
    await turn(db, "delayed", 2);
    expect(await announceLinearTurn(sqliteDb(db), "session", "delayed", 4)).toBe(false);
    expect(await listPendingLinearTurns(sqliteDb(db), "session")).toEqual([]);
    expect(getLinearSession(db, "session")?.stoppedAt).toBe(3);
    await turn(db, "later", 4);
    expect(await announceLinearTurn(sqliteDb(db), "session", "later", 5)).toBe(true);
    expect(getLinearSession(db, "session")?.stoppedAt).toBeNull();
    expect(await getLinearTurnGeneration(sqliteDb(db), "session", "later", null)).toBe(3);
    expect(
      (await listPendingLinearTurns(sqliteDb(db), "session")).map((entry) => entry.eventKey),
    ).toEqual(["later"]);
  } finally {
    db.close();
  }
});

test("discarding rejected replies is session-scoped, idempotent and preserves applied history", async () => {
  const db = tempDb();
  try {
    const item = insertQueuedItem(db, { id: "ENG-1", sessionKey: "session" });
    for (const key of ["applied", "rejected", "pending"]) await turn(db, key);
    bindLinearSessionTask(db, "session", item.delegationId);
    activateLinearItem(db, "session", item.id);
    await applyLinearTurns(sqliteDb(db), "session", ["applied"], item.id);
    await discardLinearTurns(sqliteDb(db), "other", ["pending"]);
    await discardLinearTurns(sqliteDb(db), "session", ["applied", "rejected"]);
    await discardLinearTurns(sqliteDb(db), "session", ["rejected"]);
    expect(
      (await listPendingLinearTurns(sqliteDb(db), "session")).map((entry) => entry.eventKey),
    ).toEqual(["pending"]);
    expect(listLinearTurnsForItem(db, item.id).map((entry) => entry.eventKey)).toEqual(["applied"]);
    expect(listLinearTurnsForItem(db, "other")).toEqual([]);
    expect(await announceLinearTurn(sqliteDb(db), "session", "rejected")).toBe(false);
  } finally {
    db.close();
  }
});

test("Stop receipts survive a newer generation and roll back with the enclosing transaction", async () => {
  const path = join(tempHome(), "stops.db");
  let db = openDatabase(path);
  migrate(db);
  try {
    await expect(
      sqliteDb(db).transaction(function* (q) {
        expect(
          yield* q.transaction((inner) => acceptLinearStopSteps(inner, "session", "stop", 1)),
        ).toBe(1);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(getLinearSession(db, "session")).toBeNull();
    expect(db.query("SELECT * FROM linear_stop_receipt").all()).toEqual([]);
    expect(await acceptLinearStop(sqliteDb(db), "session", "stop", 1)).toBe(1);
    expect(await acceptLinearStop(sqliteDb(db), "session", "another-stop", 2)).toBe(1);
    await advanceLinearSessionGeneration(sqliteDb(db), "session", { now: 3 });
    const current = getLinearSession(db, "session");
    db.close();
    db = openDatabase(path);
    migrate(db);
    expect(await acceptLinearStop(sqliteDb(db), "session", "stop", 1)).toBeNull();
    expect(getLinearSession(db, "session")).toEqual(current);
    expect(await acceptLinearStop(sqliteDb(db), "other", "stop", 4)).toBe(1);
    expect(await acceptLinearStop(sqliteDb(db), "session", "new-stop", 4)).toBe(3);
  } finally {
    db.close();
  }
});
