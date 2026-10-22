import assert from "node:assert/strict";
import { test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  applyWorkItemEvent,
  consumeWorkspaceBootstrap,
  insertQueuedItem,
  listQueuePositions,
  putWorkspaceUser,
} from "../src/db";
import { dispatchReadyItems } from "../src/scheduler";
import { createLiveStatusProvider } from "../src/web";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../src/workspace";
import { tempDb } from "./helpers";

function runner(db: Database, capacity: number): void {
  const userId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "org",
    name: "Fixture",
    userId,
    tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "org", 0)),
    now: 0,
  });
  db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES('runner',?,?,'runner','active',0,1000)",
    [workspace.id, userId],
  );
  db.run("INSERT INTO runner_capacity(runner_id,capacity) VALUES('runner',?)", [capacity]);
}

const line = (db: Database) =>
  listQueuePositions(db).map(({ itemId, position, busySlots, totalSlots }) => [
    itemId,
    position,
    `${busySlots}/${totalSlots}`,
  ]);

test("a waiting item moves up the line as items ahead start or leave", () => {
  const db = tempDb();
  try {
    runner(db, 2);
    insertQueuedItem(db, { id: "busy", now: 0 });
    applyWorkItemEvent(db, "busy", "dispatched");
    const ready = ["a", "b", "c", "d"];
    for (const [index, id] of ready.entries()) insertQueuedItem(db, { id, now: index + 1 });

    assert.deepEqual(dispatchReadyItems(db, { now: 1000, legacyReadyItemIds: ready }), ["a"]);
    assert.deepEqual(line(db), [
      ["b", 1, "2/2"],
      ["c", 2, "2/2"],
      ["d", 3, "2/2"],
    ]);

    // c leaves the line: it is cancelled before it starts.
    db.run("UPDATE work_item SET cancel_requested=1 WHERE id='c'");
    assert.deepEqual(dispatchReadyItems(db, { now: 1001, legacyReadyItemIds: ready }), []);
    assert.deepEqual(line(db), [
      ["b", 1, "2/2"],
      ["d", 2, "2/2"],
    ]);

    // busy frees its slot, so b starts and d is next.
    applyWorkItemEvent(db, "busy", "blocking_question");
    assert.deepEqual(dispatchReadyItems(db, { now: 1002, legacyReadyItemIds: ready }), ["b"]);
    assert.deepEqual(line(db), [["d", 1, "2/2"]]);

    // a leaves running work, so d starts and the line is empty.
    applyWorkItemEvent(db, "a", "dispatched");
    applyWorkItemEvent(db, "a", "blocking_question");
    assert.deepEqual(dispatchReadyItems(db, { now: 1003, legacyReadyItemIds: ready }), ["d"]);
    assert.deepEqual(line(db), []);
  } finally {
    db.close();
  }
});

test("without a paired runner nothing waits for a slot, so there is no line", () => {
  const db = tempDb();
  try {
    insertQueuedItem(db, { id: "a", now: 1 });
    insertQueuedItem(db, { id: "b", now: 2 });
    assert.deepEqual(dispatchReadyItems(db, { now: 1000, legacyReadyItemIds: ["a", "b"] }), [
      "a",
      "b",
    ]);
    assert.deepEqual(line(db), []);
  } finally {
    db.close();
  }
});

test("the status API shows the position only while the item is still queued", () => {
  const db = tempDb();
  try {
    runner(db, 1);
    insertQueuedItem(db, { id: "busy", now: 0 });
    applyWorkItemEvent(db, "busy", "dispatched");
    insertQueuedItem(db, { id: "a", now: 1 });
    insertQueuedItem(db, { id: "b", now: 2 });
    dispatchReadyItems(db, { now: 1000, legacyReadyItemIds: ["a", "b"] });
    const queues = () =>
      createLiveStatusProvider(db)
        .snapshot()
        .items.filter((item) => item.state === "queued")
        .map((item) => item.queue ?? null);
    assert.deepEqual(queues(), [
      { position: 2, busySlots: 1, totalSlots: 1 },
      { position: 1, busySlots: 1, totalSlots: 1 },
    ]);

    // A stale row from before the item started is not shown.
    applyWorkItemEvent(db, "a", "dispatched");
    assert.deepEqual(queues(), [{ position: 2, busySlots: 1, totalSlots: 1 }]);
  } finally {
    db.close();
  }
});
