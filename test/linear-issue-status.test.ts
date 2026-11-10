import { expect, test } from "bun:test";
import {
  applyLinearCommand,
  beginImplementRun,
  claimOutboxHeads,
  completeAnswerTask,
  completeOutbox,
  insertQueuedItem,
  isOutboxCurrent,
  listOutbox,
  requireLinearTaskDelegation,
  saveTaskMode,
  sqliteDb,
} from "../src/db";
import { createFakeTracker, createLinearTracker, type LinearClient } from "../src/linear";
import { deliverLinearOutbox } from "../src/loop";
import { tempDb } from "./helpers";

const statusRows = (db: ReturnType<typeof tempDb>) =>
  listOutbox(db).filter((row) => row.target === "linear" && row.op === "status");

for (const [type, source] of [
  ["stop", "linear"],
  ["cancel", "dashboard"],
] as const)
  test(`a ${source} ${type} leaves the issue status to people`, async () => {
    const db = tempDb();
    try {
      const item = insertQueuedItem(db, { id: "ENG-1", sessionKey: "session" });
      beginImplementRun(db, item.id, 1);
      const command = { type, source, itemId: item.id, requestedAt: 5 };
      expect(applyLinearCommand(db, command, 5).applied).toBe(true);
      expect(statusRows(db)).toEqual([]);
      // Deliver everything the stop queued, as the outbox worker does.
      const tracker = createFakeTracker();
      for (let round = 0; round < 10; round += 1)
        for (const head of await claimOutboxHeads(sqliteDb(db), { now: 10 + round })) {
          expect(isOutboxCurrent(db, head)).toBe(true);
          if (head.op === "status") await deliverLinearOutbox(head, tracker, async () => {});
          await completeOutbox(sqliteDb(db), head, 10 + round);
        }
      expect(tracker.statuses).toEqual([]);
    } finally {
      db.close();
    }
  });

test("a cancel from the issue closing in Linear enqueues no status", () => {
  const db = tempDb();
  try {
    const item = insertQueuedItem(db, { id: "ENG-1", sessionKey: "session" });
    beginImplementRun(db, item.id, 1);
    const command = { type: "cancel", source: "linear", itemId: item.id, requestedAt: 5 } as const;
    expect(applyLinearCommand(db, command, 5, "Closed: the issue was closed.").applied).toBe(true);
    expect(statusRows(db)).toEqual([]);
  } finally {
    db.close();
  }
});

test("an issue delegated without a human actor gets no status change", () => {
  const db = tempDb();
  try {
    const item = insertQueuedItem(db, { id: "ENG-1", sessionKey: "session" });
    requireLinearTaskDelegation(db, {
      itemId: item.id,
      issueId: item.linearIssueId,
      teamId: "team",
      appUserId: "app",
    });
    beginImplementRun(db, item.id, 1);
    const command = {
      type: "cancel",
      source: "dashboard",
      itemId: item.id,
      requestedAt: 5,
    } as const;
    expect(applyLinearCommand(db, command, 5).applied).toBe(true);
    expect(statusRows(db)).toEqual([]);
  } finally {
    db.close();
  }
});

test("an answer task completing leaves the issue status alone", () => {
  const db = tempDb();
  try {
    const item = insertQueuedItem(db, { id: "ENG-1", sessionKey: "session" });
    beginImplementRun(db, item.id, 1);
    saveTaskMode(db, item.id, "answer");
    completeAnswerTask(db, item.id, "The answer.", 3);
    expect(statusRows(db)).toEqual([]);
  } finally {
    db.close();
  }
});

test("the fake tracker skips a canceled status for an issue someone already moved", async () => {
  const tracker = createFakeTracker();
  tracker.issueStateTypes.set("moved", "backlog");
  await tracker.setStatus({ linearIssueId: "moved", stateType: "canceled" });
  expect(tracker.statuses).toEqual([]);
  await tracker.setStatus({ linearIssueId: "moved", stateType: "completed" });
  expect(tracker.statuses).toEqual([{ linearIssueId: "moved", stateType: "completed" }]);
});

function statesClient(current: string, calls: string[]): LinearClient {
  return {
    async query(query) {
      calls.push(query);
      if (query.includes("IssueStates"))
        return {
          issue: {
            state: { type: current },
            team: {
              states: {
                nodes: [
                  { id: "st_done", name: "Done", type: "completed" },
                  { id: "st_canceled", name: "Canceled", type: "canceled" },
                ],
              },
            },
          },
        };
      return { issueUpdate: { success: true } };
    },
  };
}

test("canceled moves only a started issue; completed stays unconditional", async () => {
  for (const current of ["unstarted", "backlog", "completed", "canceled"]) {
    const calls: string[] = [];
    await createLinearTracker(statesClient(current, calls)).setStatus({
      linearIssueId: "a",
      stateType: "canceled",
    });
    expect(calls.some((query) => query.includes("issueUpdate"))).toBe(false);
  }
  const started: string[] = [];
  await createLinearTracker(statesClient("started", started)).setStatus({
    linearIssueId: "a",
    stateType: "canceled",
  });
  expect(started.some((query) => query.includes("issueUpdate"))).toBe(true);
  const done: string[] = [];
  await createLinearTracker(statesClient("backlog", done)).setStatus({
    linearIssueId: "a",
    stateType: "completed",
  });
  expect(done.some((query) => query.includes("issueUpdate"))).toBe(true);
});
