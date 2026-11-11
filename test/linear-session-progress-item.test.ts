import { expect, test } from "bun:test";
import { FakeClock } from "../src/core";
import { JobLoop, OutboxDispatcher, insertQueuedItem, sqliteDb } from "../src/db";
import { createFakeTracker, currentLinearCaller } from "../src/linear";
import { Orchestrator, createLinearSessionProgress } from "../src/loop";
import { tempDb, tempHome } from "./helpers";

test("a session progress row sent by a plain outbox tick counts under its task", async () => {
  const db = tempDb();
  const clock = new FakeClock(1_000);
  const tracker = createFakeTracker();
  const credited: (string | undefined)[] = [];
  const updateSession = tracker.updateSession.bind(tracker);
  tracker.updateSession = (update, options) => {
    credited.push(currentLinearCaller().itemId);
    return updateSession(update, options);
  };
  const outbox = new OutboxDispatcher(db, clock);
  const orchestrator = new Orchestrator({
    store: sqliteDb(db),
    jobs: new JobLoop(db, clock),
    outbox,
    clock,
    pawsRoot: tempHome(),
    tracker,
  });
  try {
    const item = insertQueuedItem(db, { id: "task", now: 1_000, sessionKey: "session" });
    const progress = await createLinearSessionProgress(
      sqliteDb(db),
      "session",
      item.linearIdentifier,
      () => clock.now(),
      "code",
      item.id,
    );
    await progress.phase("verifying");
    await progress.link("Pull request", "https://github.com/acme/app/pull/1");
    while ((await outbox.tick()).length > 0) await outbox.idle();
    expect(credited.length).toBeGreaterThan(0);
    expect([...new Set(credited)]).toEqual(["task"]);
  } finally {
    await orchestrator.shutdown();
    db.close();
  }
});
