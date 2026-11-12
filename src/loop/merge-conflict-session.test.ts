import { expect, test } from "bun:test";
import { FakeClock } from "../core";
import { OutboxDispatcher, enqueueOutboxOnce, getWorkItem, insertQueuedItem } from "../db";
import { createFakeTracker } from "../linear";
import { postMergeConflictSteps } from "../merge";
import { deliverLinearOutbox } from "./dispatch";
import { tempStore } from "../../test/pglite";

const NOTICE = { sessionId: "ses_1", pullNumber: 988, head: "1bf8429" };

async function fixture() {
  const { db, close } = await tempStore();
  const clock = new FakeClock(1_000);
  await insertQueuedItem(db, { id: "ACME-7", sessionKey: "ses_1", now: clock.now() });
  const tracker = createFakeTracker();
  const delivery = new OutboxDispatcher(db, clock);
  delivery.setHandler((row) => deliverLinearOutbox(row, tracker, async () => {}, undefined, db));
  const enqueue = (key: string, kind: string, body: string) =>
    enqueueOutboxOnce(db, {
      target: "linear",
      op: "activity",
      orderingKey: "ses_1",
      idempotencyKey: key,
      ...(key.startsWith("pull-request-ready:") ? { delivery: "ordered" as const } : {}),
      payload: { id: crypto.randomUUID(), sessionId: "ses_1", kind, body },
      now: clock.now(),
    });
  const deliver = async () => {
    for (let round = 0; round < 10; round++) {
      if ((await delivery.tick()).length === 0) return;
      await delivery.idle();
      clock.advance(60_000);
    }
  };
  const announce = async () => {
    const item = (await getWorkItem(db, "ACME-7"))!;
    return db.transaction((q) => postMergeConflictSteps(q, item, NOTICE, clock.now()));
  };
  return { close, tracker, enqueue, deliver, announce };
}

test("a conflict after the pull request response wakes the session once per head", async () => {
  const f = await fixture();
  try {
    await f.enqueue("pull-request-ready:ACME-7:0", "response", "Opened #988.");
    await f.deliver();

    await f.announce();
    await f.announce();
    await f.deliver();

    expect(f.tracker.progress.slice(1)).toEqual([
      expect.objectContaining({
        kind: "thought",
        body: "Main moved and #988 now conflicts with it. Rebasing onto main.",
      }),
    ]);
  } finally {
    await f.close();
  }
});

test("the gate still drops other progress after the pull request response", async () => {
  const f = await fixture();
  try {
    await f.enqueue("pull-request-ready:ACME-7:0", "response", "Opened #988.");
    await f.deliver();

    await f.enqueue("note:ACME-7:1", "thought", "Reading the failing test.");
    await f.enqueue("merge-review-other:ACME-7:1", "action", "Ran the tests.");
    await f.announce();
    await f.deliver();

    expect(f.tracker.progress.map((update) => update.body)).toEqual([
      "Opened #988.",
      "Main moved and #988 now conflicts with it. Rebasing onto main.",
    ]);
  } finally {
    await f.close();
  }
});
