import { expect, test } from "bun:test";
import { mergeQueueLine } from "../src/core";
import {
  applyWorkItemEvent,
  getWorkItem,
  inMergeQueue,
  insertQueuedItem,
  joinMergeQueue,
  leaveMergeQueue,
  listMergeQueues,
  markMergeQueueNotified,
  mergeQueuePosition,
  restart,
  restartedFromMergeQueue,
} from "../src/db";
import { tempDb } from "./helpers";

function ready(db: ReturnType<typeof tempDb>, id: string, repository: string, now: number) {
  insertQueuedItem(db, { id, now });
  db.run("UPDATE work_item SET state='merge_queue' WHERE id=?", [id]);
  joinMergeQueue(db, { itemId: id, repository, now });
}

test("each repository has its own queue, in the order tasks became ready", () => {
  const db = tempDb();
  ready(db, "b", "acme/platform", 2);
  ready(db, "a", "acme/platform", 1);
  ready(db, "web", "acme/web", 3);
  ready(db, "c", "acme/platform", 3);
  expect(
    listMergeQueues(db).map(({ itemId, repository, position, total, aheadItemId }) => ({
      itemId,
      repository,
      position,
      total,
      aheadItemId,
    })),
  ).toEqual([
    { itemId: "a", repository: "acme/platform", position: 1, total: 3, aheadItemId: null },
    { itemId: "b", repository: "acme/platform", position: 2, total: 3, aheadItemId: "a" },
    { itemId: "c", repository: "acme/platform", position: 3, total: 3, aheadItemId: "b" },
    { itemId: "web", repository: "acme/web", position: 1, total: 1, aheadItemId: null },
  ]);
});

test("joining again keeps the place; leaving and joining again goes to the end", () => {
  const db = tempDb();
  ready(db, "a", "acme/platform", 1);
  ready(db, "b", "acme/platform", 2);
  joinMergeQueue(db, { itemId: "a", repository: "acme/platform", now: 5 });
  expect(mergeQueuePosition(db, "a")?.position).toBe(1);
  leaveMergeQueue(db, "a");
  expect(mergeQueuePosition(db, "a")).toBeNull();
  expect(mergeQueuePosition(db, "b")?.position).toBe(1);
  joinMergeQueue(db, { itemId: "a", repository: "acme/platform", now: 6 });
  expect(mergeQueuePosition(db, "a")).toMatchObject({ position: 2, aheadItemId: "b" });
});

test("a task back with the agent or waiting for an answer holds no place", () => {
  const db = tempDb();
  ready(db, "a", "acme/platform", 1);
  ready(db, "b", "acme/platform", 2);
  db.run("UPDATE work_item SET state='running' WHERE id='a'");
  expect(mergeQueuePosition(db, "b")?.position).toBe(1);
  db.run("UPDATE work_item SET state='awaiting_input' WHERE id='a'");
  expect(mergeQueuePosition(db, "b")?.position).toBe(1);
  // The first task runs Closeout again after main moved and keeps its place.
  db.run("UPDATE work_item SET state='verifying' WHERE id='a'");
  expect(mergeQueuePosition(db, "b")?.position).toBe(2);
});

test("the notified position is kept with the entry", () => {
  const db = tempDb();
  ready(db, "a", "acme/platform", 1);
  markMergeQueueNotified(db, "a", 2);
  expect(mergeQueuePosition(db, "a")?.notifiedPosition).toBe(2);
});

test("the position reads like the run page", () => {
  expect(mergeQueueLine({ position: 2, repository: "acme/platform" })).toBe(
    "Second in the acme/platform queue",
  );
  expect(mergeQueueLine({ position: 12, repository: "acme/platform" })).toBe(
    "12th in the acme/platform queue",
  );
});

test("a fix sent back from the merge queue or its re-verify counts as merge-queue work", () => {
  const db = tempDb();
  try {
    const accepted = (id: string) => {
      insertQueuedItem(db, { id, now: 1 });
      applyWorkItemEvent(db, id, "dispatched");
      applyWorkItemEvent(db, id, "turn_ended");
    };
    accepted("conflict");
    applyWorkItemEvent(db, "conflict", "closeout_accepted");
    joinMergeQueue(db, { itemId: "conflict", repository: "acme/app", now: 2 });
    expect(inMergeQueue(db, "conflict")).toBe(true);
    restart(db, getWorkItem(db, "conflict")!, { reason: "conflict", body: "Rebase", now: 3 });
    expect(inMergeQueue(db, "conflict")).toBe(false);
    applyWorkItemEvent(db, "conflict", "dispatched");
    expect(restartedFromMergeQueue(db, "conflict")).toBe(true);

    accepted("reverify");
    applyWorkItemEvent(db, "reverify", "closeout_accepted");
    applyWorkItemEvent(db, "reverify", "reverify_requested");
    applyWorkItemEvent(db, "reverify", "commit_while_verifying");
    restart(db, getWorkItem(db, "reverify")!, { reason: "findings", body: "Fix", now: 4 });
    expect(restartedFromMergeQueue(db, "reverify")).toBe(true);

    accepted("first");
    restart(db, getWorkItem(db, "first")!, { reason: "findings", body: "Fix", now: 5 });
    expect(restartedFromMergeQueue(db, "first")).toBe(false);
  } finally {
    db.close();
  }
});

test("mixed-case bindings join one ordered queue and keep their places", () => {
  const db = tempDb();
  ready(db, "first", "Acme/APP", 1);
  ready(db, "second", "acme/app", 2);
  joinMergeQueue(db, { itemId: "first", repository: "ACME/App", now: 3 });
  expect(listMergeQueues(db).map((e) => [e.itemId, e.repository, e.position])).toEqual([
    ["first", "acme/app", 1],
    ["second", "acme/app", 2],
  ]);
});
