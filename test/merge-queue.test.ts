import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mergeQueueLine, type WorkItemState } from "../src/core";
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
  type Db,
} from "../src/db";
import { seed } from "./dialects";
import { tempStore } from "./pglite";

function setState(db: Db, id: string, state: WorkItemState) {
  return seed(db, (q) => q.orm.update(q.t.workItem).set({ state }).where(eq(q.t.workItem.id, id)));
}

async function ready(db: Db, id: string, repository: string, now: number) {
  await insertQueuedItem(db, { id, now });
  await setState(db, id, "merge_queue");
  await joinMergeQueue(db, { itemId: id, repository, now });
}

test("each repository has its own queue, in the order tasks became ready", async () => {
  const db = (await tempStore()).db;
  await ready(db, "b", "acme/platform", 2);
  await ready(db, "a", "acme/platform", 1);
  await ready(db, "web", "acme/web", 3);
  await ready(db, "c", "acme/platform", 3);
  expect(
    (await listMergeQueues(db)).map(({ itemId, repository, position, total, aheadItemId }) => ({
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

test("joining again keeps the place; leaving and joining again goes to the end", async () => {
  const db = (await tempStore()).db;
  await ready(db, "a", "acme/platform", 1);
  await ready(db, "b", "acme/platform", 2);
  await joinMergeQueue(db, { itemId: "a", repository: "acme/platform", now: 5 });
  expect((await mergeQueuePosition(db, "a"))?.position).toBe(1);
  await leaveMergeQueue(db, "a");
  expect(await mergeQueuePosition(db, "a")).toBeNull();
  expect((await mergeQueuePosition(db, "b"))?.position).toBe(1);
  await joinMergeQueue(db, { itemId: "a", repository: "acme/platform", now: 6 });
  expect(await mergeQueuePosition(db, "a")).toMatchObject({
    position: 2,
    aheadItemId: "b",
  });
});

test("a task back with the agent or waiting for an answer holds no place", async () => {
  const db = (await tempStore()).db;
  await ready(db, "a", "acme/platform", 1);
  await ready(db, "b", "acme/platform", 2);
  await setState(db, "a", "running");
  expect((await mergeQueuePosition(db, "b"))?.position).toBe(1);
  await setState(db, "a", "awaiting_input");
  expect((await mergeQueuePosition(db, "b"))?.position).toBe(1);
  // The first task runs Closeout again after main moved and keeps its place.
  await setState(db, "a", "verifying");
  expect((await mergeQueuePosition(db, "b"))?.position).toBe(2);
});

test("the notified position is kept with the entry", async () => {
  const db = (await tempStore()).db;
  await ready(db, "a", "acme/platform", 1);
  await markMergeQueueNotified(db, "a", 2);
  expect((await mergeQueuePosition(db, "a"))?.notifiedPosition).toBe(2);
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
  const { db, close } = await tempStore();
  try {
    const accepted = async (id: string) => {
      await insertQueuedItem(db, { id, now: 1 });
      await applyWorkItemEvent(db, id, "dispatched");
      await applyWorkItemEvent(db, id, "turn_ended");
    };
    await accepted("conflict");
    await applyWorkItemEvent(db, "conflict", "closeout_accepted");
    await joinMergeQueue(db, { itemId: "conflict", repository: "acme/app", now: 2 });
    expect(await inMergeQueue(db, "conflict")).toBe(true);
    await restart(db, (await getWorkItem(db, "conflict"))!, {
      reason: "conflict",
      body: "Rebase",
      now: 3,
    });
    expect(await inMergeQueue(db, "conflict")).toBe(false);
    await applyWorkItemEvent(db, "conflict", "dispatched");
    expect(await restartedFromMergeQueue(db, "conflict")).toBe(true);

    await accepted("reverify");
    await applyWorkItemEvent(db, "reverify", "closeout_accepted");
    await applyWorkItemEvent(db, "reverify", "reverify_requested");
    await restart(db, (await getWorkItem(db, "reverify"))!, {
      reason: "findings",
      body: "Fix",
      now: 4,
    });
    expect(await restartedFromMergeQueue(db, "reverify")).toBe(true);

    await accepted("first");
    await restart(db, (await getWorkItem(db, "first"))!, {
      reason: "findings",
      body: "Fix",
      now: 5,
    });
    expect(await restartedFromMergeQueue(db, "first")).toBe(false);
  } finally {
    await close();
  }
});

test("mixed-case bindings join one ordered queue and keep their places", async () => {
  const db = (await tempStore()).db;
  await ready(db, "first", "Acme/APP", 1);
  await ready(db, "second", "acme/app", 2);
  await joinMergeQueue(db, { itemId: "first", repository: "ACME/App", now: 3 });
  expect((await listMergeQueues(db)).map((e) => [e.itemId, e.repository, e.position])).toEqual([
    ["first", "acme/app", 1],
    ["second", "acme/app", 2],
  ]);
});
