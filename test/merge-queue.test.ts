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
  sqliteDb,
} from "../src/db";
import { tempDb } from "./helpers";

async function ready(db: ReturnType<typeof tempDb>, id: string, repository: string, now: number) {
  insertQueuedItem(db, { id, now });
  db.run("UPDATE work_item SET state='merge_queue' WHERE id=?", [id]);
  await joinMergeQueue(sqliteDb(db), { itemId: id, repository, now });
}

test("each repository has its own queue, in the order tasks became ready", async () => {
  const db = tempDb();
  await ready(db, "b", "acme/platform", 2);
  await ready(db, "a", "acme/platform", 1);
  await ready(db, "web", "acme/web", 3);
  await ready(db, "c", "acme/platform", 3);
  expect(
    (await listMergeQueues(sqliteDb(db))).map(
      ({ itemId, repository, position, total, aheadItemId }) => ({
        itemId,
        repository,
        position,
        total,
        aheadItemId,
      }),
    ),
  ).toEqual([
    { itemId: "a", repository: "acme/platform", position: 1, total: 3, aheadItemId: null },
    { itemId: "b", repository: "acme/platform", position: 2, total: 3, aheadItemId: "a" },
    { itemId: "c", repository: "acme/platform", position: 3, total: 3, aheadItemId: "b" },
    { itemId: "web", repository: "acme/web", position: 1, total: 1, aheadItemId: null },
  ]);
});

test("joining again keeps the place; leaving and joining again goes to the end", async () => {
  const db = tempDb();
  await ready(db, "a", "acme/platform", 1);
  await ready(db, "b", "acme/platform", 2);
  await joinMergeQueue(sqliteDb(db), { itemId: "a", repository: "acme/platform", now: 5 });
  expect((await mergeQueuePosition(sqliteDb(db), "a"))?.position).toBe(1);
  await leaveMergeQueue(sqliteDb(db), "a");
  expect(await mergeQueuePosition(sqliteDb(db), "a")).toBeNull();
  expect((await mergeQueuePosition(sqliteDb(db), "b"))?.position).toBe(1);
  await joinMergeQueue(sqliteDb(db), { itemId: "a", repository: "acme/platform", now: 6 });
  expect(await mergeQueuePosition(sqliteDb(db), "a")).toMatchObject({
    position: 2,
    aheadItemId: "b",
  });
});

test("a task back with the agent or waiting for an answer holds no place", async () => {
  const db = tempDb();
  await ready(db, "a", "acme/platform", 1);
  await ready(db, "b", "acme/platform", 2);
  db.run("UPDATE work_item SET state='running' WHERE id='a'");
  expect((await mergeQueuePosition(sqliteDb(db), "b"))?.position).toBe(1);
  db.run("UPDATE work_item SET state='awaiting_input' WHERE id='a'");
  expect((await mergeQueuePosition(sqliteDb(db), "b"))?.position).toBe(1);
  // The first task runs Closeout again after main moved and keeps its place.
  db.run("UPDATE work_item SET state='verifying' WHERE id='a'");
  expect((await mergeQueuePosition(sqliteDb(db), "b"))?.position).toBe(2);
});

test("the notified position is kept with the entry", async () => {
  const db = tempDb();
  await ready(db, "a", "acme/platform", 1);
  await markMergeQueueNotified(sqliteDb(db), "a", 2);
  expect((await mergeQueuePosition(sqliteDb(db), "a"))?.notifiedPosition).toBe(2);
});

test("the position reads like the run page", () => {
  expect(mergeQueueLine({ position: 2, repository: "acme/platform" })).toBe(
    "Second in the acme/platform queue",
  );
  expect(mergeQueueLine({ position: 12, repository: "acme/platform" })).toBe(
    "12th in the acme/platform queue",
  );
});

test("a fix sent back from the merge queue or its re-verify counts as merge-queue work", async () => {
  const db = tempDb();
  try {
    const accepted = async (id: string) => {
      insertQueuedItem(db, { id, now: 1 });
      await applyWorkItemEvent(sqliteDb(db), id, "dispatched");
      await applyWorkItemEvent(sqliteDb(db), id, "turn_ended");
    };
    await accepted("conflict");
    await applyWorkItemEvent(sqliteDb(db), "conflict", "closeout_accepted");
    await joinMergeQueue(sqliteDb(db), { itemId: "conflict", repository: "acme/app", now: 2 });
    expect(await inMergeQueue(sqliteDb(db), "conflict")).toBe(true);
    restart(db, (await getWorkItem(sqliteDb(db), "conflict"))!, {
      reason: "conflict",
      body: "Rebase",
      now: 3,
    });
    expect(await inMergeQueue(sqliteDb(db), "conflict")).toBe(false);
    await applyWorkItemEvent(sqliteDb(db), "conflict", "dispatched");
    expect(await restartedFromMergeQueue(sqliteDb(db), "conflict")).toBe(true);

    await accepted("reverify");
    await applyWorkItemEvent(sqliteDb(db), "reverify", "closeout_accepted");
    await applyWorkItemEvent(sqliteDb(db), "reverify", "reverify_requested");
    restart(db, (await getWorkItem(sqliteDb(db), "reverify"))!, {
      reason: "findings",
      body: "Fix",
      now: 4,
    });
    expect(await restartedFromMergeQueue(sqliteDb(db), "reverify")).toBe(true);

    await accepted("first");
    restart(db, (await getWorkItem(sqliteDb(db), "first"))!, {
      reason: "findings",
      body: "Fix",
      now: 5,
    });
    expect(await restartedFromMergeQueue(sqliteDb(db), "first")).toBe(false);
  } finally {
    db.close();
  }
});

test("mixed-case bindings join one ordered queue and keep their places", async () => {
  const db = tempDb();
  await ready(db, "first", "Acme/APP", 1);
  await ready(db, "second", "acme/app", 2);
  await joinMergeQueue(sqliteDb(db), { itemId: "first", repository: "ACME/App", now: 3 });
  expect(
    (await listMergeQueues(sqliteDb(db))).map((e) => [e.itemId, e.repository, e.position]),
  ).toEqual([
    ["first", "acme/app", 1],
    ["second", "acme/app", 2],
  ]);
});
