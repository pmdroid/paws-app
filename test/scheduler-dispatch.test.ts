import { expect, test } from "bun:test";
import { ensureLinearSession, insertQueuedItem } from "../src/db";
import { dispatch, type SchedulerOptions } from "../src/scheduler";
import { tempDb } from "./helpers";

function sameDelegation(db: ReturnType<typeof tempDb>, ids: readonly string[]): void {
  for (const id of ids) db.run("UPDATE work_item SET delegation_id='shared' WHERE id=?", [id]);
}

test("dispatch asks readiness itself instead of trusting a handed-in ready list", () => {
  const db = tempDb();
  try {
    insertQueuedItem(db, { id: "blocker", now: 1 });
    insertQueuedItem(db, { id: "blocked", now: 2 });
    sameDelegation(db, ["blocker", "blocked"]);
    db.run(
      "INSERT INTO task_block(blocker_linear_issue_id,blocked_linear_issue_id) VALUES('lin-item-blocker','lin-item-blocked')",
    );
    expect(dispatch(db, { now: 1000 })).toEqual(["blocker"]);
    db.run("UPDATE work_item SET state='merged' WHERE id='blocker'");
    expect(dispatch(db, { now: 1001 })).toEqual(["blocked"]);
  } finally {
    db.close();
  }
});

test("maxInFlight 1 keeps the no-workspace path serial", () => {
  const db = tempDb();
  try {
    insertQueuedItem(db, { id: "first", now: 1 });
    insertQueuedItem(db, { id: "second", now: 2 });
    const serial = { maxInFlight: 1 };
    expect(dispatch(db, { now: 1000, ...serial })).toEqual(["first"]);
    expect(dispatch(db, { now: 1001, ...serial })).toEqual([]);
    db.run("UPDATE work_item SET state='running' WHERE id='first'");
    db.run("UPDATE job SET status='done' WHERE json_extract(payload,'$.itemId')='first'");
    expect(dispatch(db, { now: 1002, ...serial })).toEqual([]);
    db.run("UPDATE work_item SET state='merged' WHERE id='first'");
    expect(dispatch(db, { now: 1003, ...serial })).toEqual(["second"]);
  } finally {
    db.close();
  }
});

test("dispatch runs only after the transition's transaction has committed", () => {
  const db = tempDb();
  try {
    insertQueuedItem(db, { id: "item", now: 1 });
    expect(() => db.transaction(() => dispatch(db, { now: 1000 })).immediate()).toThrow(
      "Dispatch runs after the transition commits",
    );
  } finally {
    db.close();
  }
});

test("dispatch yields an idle merge session to a ready sibling", () => {
  const db = tempDb();
  try {
    insertQueuedItem(db, { id: "merging", now: 1, sessionKey: "session" });
    insertQueuedItem(db, { id: "next", now: 2, sessionKey: "session" });
    sameDelegation(db, ["merging", "next"]);
    db.run("UPDATE work_item SET state='merge_queue' WHERE id='merging'");
    ensureLinearSession(db, { sessionId: "session", issueId: "lin-item-merging", now: 1 });
    db.run("UPDATE linear_session SET active_item_id='merging' WHERE session_id='session'");
    dispatch(db, { now: 1000 });
    expect(
      db
        .query<{ active: string | null }, []>(
          "SELECT active_item_id AS active FROM linear_session WHERE session_id='session'",
        )
        .get()?.active,
    ).toBeNull();
  } finally {
    db.close();
  }
});

test("dispatch reports the ready items it left waiting", () => {
  const db = tempDb();
  try {
    insertQueuedItem(db, { id: "first", now: 1 });
    insertQueuedItem(db, { id: "second", now: 2 });
    const waiting: string[] = [];
    const options: SchedulerOptions & { onWaiting: (ids: readonly string[]) => void } = {
      now: 1000,
      ownerCap: 1,
      onWaiting: (ids) => waiting.push(...ids),
    };
    expect(dispatch(db, options)).toEqual(["first"]);
    expect(waiting).toEqual(["second"]);
  } finally {
    db.close();
  }
});
