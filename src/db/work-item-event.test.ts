import { describe, expect, test } from "bun:test";
import {
  applyWorkItemEventSteps,
  sqliteDb,
  applyWorkItemEvent,
  getWorkItem,
  insertQueuedItem,
  listWorkItemEventRows,
  migrate,
  openDatabase,
  TransitionRejectedError,
} from "./index";

function harness() {
  const db = openDatabase(":memory:");
  migrate(db);
  const item = insertQueuedItem(db, { id: "eng-1", sessionKey: "ses", now: 1_000 });
  return { db, item };
}

describe("work_item_event", () => {
  test("each committed transition writes one row with the version it produced", async () => {
    const { db, item } = harness();
    const running = await applyWorkItemEvent(sqliteDb(db), item.id, "dispatched", { now: 2_000 });
    await applyWorkItemEvent(sqliteDb(db), item.id, "restart", {
      kind: "restart",
      reason: "findings",
      payloadDigest: "sha256:abc",
      actor: "paws",
      now: 3_000,
    });
    await applyWorkItemEvent(sqliteDb(db), item.id, "dispatched", { now: 4_000 });
    await applyWorkItemEvent(sqliteDb(db), item.id, "blocking_question", {
      kind: "ask",
      reason: "budget_spent",
      now: 5_000,
    });

    const rows = await listWorkItemEventRows(sqliteDb(db), item.id);
    expect(
      rows.map((row) => [row.fromState, row.event, row.toState, row.kind, row.reason]),
    ).toEqual([
      ["queued", "dispatched", "running", "transition", null],
      ["running", "restart", "queued", "restart", "findings"],
      ["queued", "dispatched", "running", "transition", null],
      ["running", "blocking_question", "awaiting_input", "ask", "budget_spent"],
    ]);
    expect(rows[0]).toMatchObject({ version: running.version, at: 2_000, actor: null });
    expect(rows[1]).toMatchObject({ payloadDigest: "sha256:abc", actor: "paws", at: 3_000 });
    expect(rows.at(-1)?.version).toBe(getWorkItem(db, item.id)?.version);
  });

  test("a rolled-back transition leaves no event row and no state change", async () => {
    const { db, item } = harness();
    await expect(
      sqliteDb(db).transaction(function* (q) {
        yield* applyWorkItemEventSteps(q, item.id, "dispatched");
        throw new Error("the caller's next write failed");
      }),
    ).rejects.toThrow("the caller's next write failed");

    expect(getWorkItem(db, item.id)).toMatchObject({ state: "queued", version: item.version });
    expect(await listWorkItemEventRows(sqliteDb(db), item.id)).toEqual([]);
  });

  test("a rejected event writes no row", async () => {
    const { db, item } = harness();
    await expect(applyWorkItemEvent(sqliteDb(db), item.id, "merge_accepted")).rejects.toThrow(
      TransitionRejectedError,
    );
    expect(await listWorkItemEventRows(sqliteDb(db), item.id)).toEqual([]);
  });

  test("a restart row must name a known reason and an ask row must name one", () => {
    const { db, item } = harness();
    const insert = (kind: string, reason: string | null) =>
      db.run(
        `INSERT INTO work_item_event (item_id, version, at, from_state, to_state, event, kind, reason)
         VALUES (?, 99, 0, 'running', 'queued', 'restart', ?, ?)`,
        [item.id, kind, reason],
      );
    expect(() => insert("restart", "whim")).toThrow();
    expect(() => insert("ask", null)).toThrow();
    expect(() => insert("other", null)).toThrow();
  });

  test("the history keeps the newest rows when limited", async () => {
    const { db, item } = harness();
    await applyWorkItemEvent(sqliteDb(db), item.id, "dispatched", { now: 1 });
    await applyWorkItemEvent(sqliteDb(db), item.id, "pause", { now: 2 });
    await applyWorkItemEvent(sqliteDb(db), item.id, "resume", { now: 3 });
    expect((await listWorkItemEventRows(sqliteDb(db), item.id, 2)).map((row) => row.event)).toEqual(
      ["pause", "resume"],
    );
  });
});
