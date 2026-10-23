import { expect, test } from "bun:test";
import { systemClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  enqueueOutbox,
  listOutbox,
  migrate,
  openDatabase,
} from "../src/db";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator } from "../src/loop";
import { tempHome } from "./helpers";

function prompted(sessionId: string): AcceptedLinearEvent {
  return {
    dedupeKey: `session:${sessionId}:prompted`,
    deliveryId: null,
    source: "poll",
    action: "prompted",
    sessionId,
    issueId: "issue",
    activityId: null,
    body: null,
    signal: null,
    updatedAtMs: 10,
    payload: "{}",
  };
}

function fixture(outboxWaitMs?: number) {
  const db = openDatabase(":memory:");
  migrate(db);
  const tracker = createFakeTracker([]);
  const entered = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  const post = tracker.postProgress.bind(tracker);
  tracker.postProgress = async (update, options) => {
    if (update.sessionId === "slow") {
      entered.resolve();
      await held.promise;
    }
    await post(update, options);
  };
  const outbox = new OutboxDispatcher(db, systemClock);
  const orchestrator = attachOrchestrator({
    db,
    tracker,
    pawsRoot: tempHome(),
    jobs: new JobLoop(db, systemClock),
    outbox,
    ...(outboxWaitMs === undefined ? {} : { outboxWaitMs }),
  });
  const report = (sessionId: string) =>
    orchestrator.sessionProgressReporter(prompted(sessionId))({
      sessionId,
      kind: "thought",
      body: `Working on ${sessionId}.`,
    });
  const status = (sessionId: string) =>
    listOutbox(db).find((row) => row.orderingKey === sessionId)?.status;
  return { db, tracker, outbox, orchestrator, entered, held, report, status };
}

test("a held Linear delivery for one session does not hold another session's progress", async () => {
  const f = fixture();
  try {
    const slow = f.report("slow");
    await f.entered.promise;
    const fast = f.report("fast").then(() => "delivered");
    expect(await Promise.race([fast, Bun.sleep(1000).then(() => "blocked")])).toBe("delivered");
    expect(f.tracker.progress.map((update) => update.sessionId)).toEqual(["fast"]);
    expect(f.status("fast")).toBe("sent");
    expect(f.status("slow")).toBe("pending");
    f.held.resolve();
    await slow;
    expect(f.status("slow")).toBe("sent");
  } finally {
    f.held.resolve();
    await f.outbox.idle();
    await f.orchestrator.shutdown();
    f.db.close();
  }
});

test("a transport that ignores abort cannot hold its own workflow step past the wait bound", async () => {
  const f = fixture(20);
  try {
    const slow = f.report("slow").then(() => "returned");
    await f.entered.promise;
    expect(await Promise.race([slow, Bun.sleep(1000).then(() => "blocked")])).toBe("returned");
    expect(f.status("slow")).toBe("pending");
    f.held.resolve();
    await f.outbox.idle();
    expect(f.status("slow")).toBe("sent");
  } finally {
    f.held.resolve();
    await f.outbox.idle();
    await f.orchestrator.shutdown();
    f.db.close();
  }
});

test("the dispatcher settles one session while another session's transport stays open", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const dispatcher = new OutboxDispatcher(db, systemClock);
  const held = Promise.withResolvers<void>();
  dispatcher.setHandler(async (row) => {
    if (row.orderingKey === "A") await held.promise;
  });
  for (const key of ["A", "B"])
    enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: key,
      idempotencyKey: key,
      payload: { sessionId: key, kind: "thought", body: key },
    });
  const status = (key: string) => listOutbox(db).find((row) => row.orderingKey === key)?.status;
  try {
    expect(dispatcher.tick()).toHaveLength(2);
    await dispatcher.idle((row) => row.orderingKey === "B");
    expect(status("B")).toBe("sent");
    expect(status("A")).toBe("pending");
    held.resolve();
    await dispatcher.idle();
    expect(status("A")).toBe("sent");
  } finally {
    held.resolve();
    await dispatcher.idle();
    db.close();
  }
});
