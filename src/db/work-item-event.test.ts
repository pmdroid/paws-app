import { describe, expect, test } from "bun:test";
import {
  applyWorkItemEvent,
  getWorkItem,
  insertQueuedItem,
  listWorkItemEventRows,
  migrate,
  openDatabase,
  TransitionRejectedError,
} from "./index";
import { immediate } from "./tx";

function harness() {
  const db = openDatabase(":memory:");
  migrate(db);
  const item = insertQueuedItem(db, { id: "eng-1", sessionKey: "ses", now: 1_000 });
  return { db, item };
}

describe("work_item_event", () => {
  test("each committed transition writes one row with the version it produced", () => {
    const { db, item } = harness();
    const running = applyWorkItemEvent(db, item.id, "dispatched", { now: 2_000 });
    applyWorkItemEvent(db, item.id, "restart", {
      kind: "restart",
      reason: "findings",
      payloadDigest: "sha256:abc",
      actor: "paws",
      now: 3_000,
    });
    applyWorkItemEvent(db, item.id, "dispatched", { now: 4_000 });
    applyWorkItemEvent(db, item.id, "blocking_question", {
      kind: "ask",
      reason: "budget_spent",
      now: 5_000,
    });

    const rows = listWorkItemEventRows(db, item.id);
    expect(rows.map((row) => [row.fromState, row.event, row.toState, row.kind, row.reason])).toEqual(
      [
        ["queued", "dispatched", "running", "transition", null],
        ["running", "restart", "queued", "restart", "findings"],
        ["queued", "dispatched", "running", "transition", null],
        ["running", "blocking_question", "awaiting_input", "ask", "budget_spent"],
      ],
    );
    expect(rows[0]).toMatchObject({ version: running.version, at: 2_000, actor: null });
    expect(rows[1]).toMatchObject({ payloadDigest: "sha256:abc", actor: "paws", at: 3_000 });
    expect(rows.at(-1)?.version).toBe(getWorkItem(db, item.id)?.version);
  });

  test("a rolled-back transition leaves no event row and no state change", () => {
    const { db, item } = harness();
    expect(() =>
      immediate(db, () => {
        applyWorkItemEvent(db, item.id, "dispatched");
        throw new Error("the caller's next write failed");
      }),
    ).toThrow("the caller's next write failed");

    expect(getWorkItem(db, item.id)).toMatchObject({ state: "queued", version: item.version });
    expect(listWorkItemEventRows(db, item.id)).toEqual([]);
  });

  test("a rejected event writes no row", () => {
    const { db, item } = harness();
    expect(() => applyWorkItemEvent(db, item.id, "merge_accepted")).toThrow(
      TransitionRejectedError,
    );
    expect(listWorkItemEventRows(db, item.id)).toEqual([]);
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

  test("the history keeps the newest rows when limited", () => {
    const { db, item } = harness();
    applyWorkItemEvent(db, item.id, "dispatched", { now: 1 });
    applyWorkItemEvent(db, item.id, "pause", { now: 2 });
    applyWorkItemEvent(db, item.id, "resume", { now: 3 });
    expect(listWorkItemEventRows(db, item.id, 2).map((row) => row.event)).toEqual([
      "pause",
      "resume",
    ]);
  });
});
