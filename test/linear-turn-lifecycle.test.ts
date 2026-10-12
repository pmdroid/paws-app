import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  activateLinearItem,
  acceptLinearStop,
  immediate,
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
} from "../src/db";
import { tempDb, tempHome } from "./helpers";

function turn(db: ReturnType<typeof tempDb>, key: string, at = 1, sessionId = "session") {
  return recordLinearTurn(db, {
    eventKey: key,
    activityId: `activity:${key}`,
    sessionId,
    actorId: "human",
    body: key,
    payload: "{}",
    createdAtMs: at,
  });
}

test("a turn announcement and activity UUID survive restart without advancing twice", () => {
  const path = join(tempHome(), "turns.db");
  let db = openDatabase(path);
  migrate(db);
  try {
    turn(db, "first");
    expect(announceLinearTurn(db, "session", "first", 2)).toBe(true);
    const original = listOutbox(db)[0]!;
    expect(original.generation).toBe(1);
    expect(original.delivery).toBe("critical");
    expect((original.payload as { id: string }).id).toMatch(/^[0-9a-f-]{36}$/);
    db.close();
    db = openDatabase(path);
    migrate(db);
    expect(announceLinearTurn(db, "session", "first", 3)).toBe(false);
    expect(getLinearSession(db, "session")?.generation).toBe(1);
    expect(listOutbox(db)).toEqual([original]);
    expect(getLinearTurnGeneration(db, "session", "duplicate-key", "activity:first")).toBe(1);
    expect(getLinearTurnGeneration(db, "other", "first", "activity:first")).toBeNull();
    turn(db, "second", 4);
    expect(announceLinearTurn(db, "session", "second", 5)).toBe(true);
    expect(getLinearTurnGeneration(db, "session", "first", null)).toBe(1);
    expect(getLinearTurnGeneration(db, "session", "second", null)).toBe(2);
    expect(listOutbox(db)[0]?.status).toBe("dropped");
  } finally {
    db.close();
  }
});

test("Stop rejects delayed prior turns and a later turn starts a new generation", () => {
  const db = tempDb();
  try {
    turn(db, "first", 1);
    announceLinearTurn(db, "session", "first", 2);
    advanceLinearSessionGeneration(db, "session", { stop: true, now: 3 });
    turn(db, "delayed", 2);
    expect(announceLinearTurn(db, "session", "delayed", 4)).toBe(false);
    expect(listPendingLinearTurns(db, "session")).toEqual([]);
    expect(getLinearSession(db, "session")?.stoppedAt).toBe(3);
    turn(db, "later", 4);
    expect(announceLinearTurn(db, "session", "later", 5)).toBe(true);
    expect(getLinearSession(db, "session")?.stoppedAt).toBeNull();
    expect(getLinearTurnGeneration(db, "session", "later", null)).toBe(3);
    expect(listPendingLinearTurns(db, "session").map((entry) => entry.eventKey)).toEqual(["later"]);
  } finally {
    db.close();
  }
});

test("discarding rejected replies is session-scoped, idempotent and preserves applied history", () => {
  const db = tempDb();
  try {
    const item = insertQueuedItem(db, { id: "ENG-1", sessionKey: "session" });
    for (const key of ["applied", "rejected", "pending"]) turn(db, key);
    bindLinearSessionTask(db, "session", item.epicId);
    activateLinearItem(db, "session", item.id);
    applyLinearTurns(db, "session", ["applied"], item.id);
    discardLinearTurns(db, "other", ["pending"]);
    discardLinearTurns(db, "session", ["applied", "rejected"]);
    discardLinearTurns(db, "session", ["rejected"]);
    expect(listPendingLinearTurns(db, "session").map((entry) => entry.eventKey)).toEqual([
      "pending",
    ]);
    expect(listLinearTurnsForItem(db, item.id).map((entry) => entry.eventKey)).toEqual(["applied"]);
    expect(listLinearTurnsForItem(db, "other")).toEqual([]);
    expect(announceLinearTurn(db, "session", "rejected")).toBe(false);
  } finally {
    db.close();
  }
});

test("Stop receipts survive a newer generation and roll back with the enclosing transaction", () => {
  const path = join(tempHome(), "stops.db");
  let db = openDatabase(path);
  migrate(db);
  try {
    expect(() =>
      immediate(db, () => {
        expect(acceptLinearStop(db, "session", "stop", 1)).toBe(1);
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(getLinearSession(db, "session")).toBeNull();
    expect(db.query("SELECT * FROM linear_stop_receipt").all()).toEqual([]);
    expect(acceptLinearStop(db, "session", "stop", 1)).toBe(1);
    expect(acceptLinearStop(db, "session", "another-stop", 2)).toBe(1);
    advanceLinearSessionGeneration(db, "session", { now: 3 });
    const current = getLinearSession(db, "session");
    db.close();
    db = openDatabase(path);
    migrate(db);
    expect(acceptLinearStop(db, "session", "stop", 1)).toBeNull();
    expect(getLinearSession(db, "session")).toEqual(current);
    expect(acceptLinearStop(db, "other", "stop", 4)).toBe(1);
    expect(acceptLinearStop(db, "session", "new-stop", 4)).toBe(3);
  } finally {
    db.close();
  }
});
