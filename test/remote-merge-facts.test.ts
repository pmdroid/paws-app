import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  applyWorkItemEvent,
  getConfirmedRemoteMerge,
  getWorkItem,
  insertQueuedItem,
  migrate,
  openDatabase,
  recordConfirmedRemoteMerge,
  type ConfirmedRemoteMerge,
} from "../src/db";
import { tempDb, tempHome } from "./helpers";

function fact(itemId = "item"): ConfirmedRemoteMerge {
  return {
    itemId,
    repositoryOwner: "owner",
    repositoryName: "repo",
    pullNumber: 42,
    pullUrl: "https://github.com/owner/repo/pull/42",
    mergeSha: "a".repeat(40),
    confirmedAt: 200,
  };
}

test.each(["cancelled", "merged"] as const)(
  "a confirmed remote merge survives reopening without changing %s task history",
  (state) => {
    const path = join(tempHome(), "paws.db");
    let db = openDatabase(path);
    try {
      migrate(db);
      const item = insertQueuedItem(db, { id: "item" });
      if (state === "cancelled") applyWorkItemEvent(db, item.id, "cancel");
      else {
        applyWorkItemEvent(db, item.id, "dispatched");
        applyWorkItemEvent(db, item.id, "turn_ended");
        applyWorkItemEvent(db, item.id, "closeout_accepted");
        applyWorkItemEvent(db, item.id, "merge_accepted");
      }
      const before = getWorkItem(db, item.id);
      recordConfirmedRemoteMerge(db, fact());
      db.close();
      db = openDatabase(path);
      migrate(db);
      expect(getConfirmedRemoteMerge(db, item.id)).toEqual(fact());
      expect(getWorkItem(db, item.id)).toEqual(before);
      expect(getWorkItem(db, item.id)?.state).toBe(state);
      expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM job").get()?.n).toBe(0);
      expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM outbox").get()?.n).toBe(0);
    } finally {
      db.close();
    }
  },
);

test("replayed confirmation preserves its original observation and rejects conflicting PR history", () => {
  const db = tempDb();
  try {
    insertQueuedItem(db, { id: "item" });
    recordConfirmedRemoteMerge(db, fact());
    expect(recordConfirmedRemoteMerge(db, { ...fact(), confirmedAt: 300 })).toEqual(fact());
    expect(() => recordConfirmedRemoteMerge(db, { ...fact(), pullNumber: 43 })).toThrow(
      "conflicts",
    );
    expect(() => recordConfirmedRemoteMerge(db, { ...fact(), mergeSha: "b".repeat(40) })).toThrow(
      "conflicts",
    );
    expect(getConfirmedRemoteMerge(db, "item")).toEqual(fact());
    expect(getWorkItem(db, "item")?.state).toBe("queued");
  } finally {
    db.close();
  }
});

test("confirmed success without a reported merge SHA retains the PR identity without inventing a SHA", () => {
  const db = tempDb();
  try {
    insertQueuedItem(db, { id: "item" });
    expect(recordConfirmedRemoteMerge(db, { ...fact(), mergeSha: null })).toEqual({
      ...fact(),
      mergeSha: null,
    });
    expect(getConfirmedRemoteMerge(db, "item")?.mergeSha).toBeNull();
  } finally {
    db.close();
  }
});

test("a failed fact write leaves terminal task history and earlier confirmed merges untouched", () => {
  const db = tempDb();
  try {
    insertQueuedItem(db, { id: "item" });
    insertQueuedItem(db, { id: "second" });
    recordConfirmedRemoteMerge(db, fact());
    applyWorkItemEvent(db, "second", "cancel");
    db.exec(`CREATE TRIGGER deny_fact BEFORE INSERT ON remote_merge_fact
             WHEN NEW.item_id = 'second' BEGIN SELECT RAISE(ABORT, 'storage failure'); END`);
    expect(() => recordConfirmedRemoteMerge(db, fact("second"))).toThrow("storage failure");
    expect(getWorkItem(db, "second")?.state).toBe("cancelled");
    expect(getConfirmedRemoteMerge(db, "second")).toBeNull();
    expect(getConfirmedRemoteMerge(db, "item")).toEqual(fact());
  } finally {
    db.close();
  }
});
