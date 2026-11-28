import { expect, test } from "bun:test";
import { FakeClock } from "../src/core";
import { JobLoop, OutboxDispatcher, ensureLinearSession } from "../src/db";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { Orchestrator } from "../src/loop";
import { tempHome } from "./helpers";
import { seed } from "./pglite-fixtures";
import { tempStore } from "./pglite";
import { waitFor } from "./wait-for";

test("an intake for an issue with a queued item requests admission without waiting for it", async () => {
  const { db, close } = await tempStore();
  const clock = new FakeClock(5_000);
  let passes = 0;
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => (open = resolve));
  const orchestrator = new Orchestrator({
    store: db,
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    clock,
    pawsRoot: tempHome(),
    tracker: createFakeTracker([]),
    scheduling: async () => {
      passes += 1;
      await gate;
      return {};
    },
  });
  try {
    await ensureLinearSession(db, { sessionId: "session", issueId: "issue", now: clock.now() });
    await seed(db, (q) =>
      q.orm.insert(q.t.workItem).values({
        id: "queued",
        delegationId: "queued",
        linearIssueId: "issue",
        linearIdentifier: "ENG-1",
        title: "Work",
        state: "queued",
        branchName: "paws/queued",
        position: 0,
        createdAt: 2_000,
        sessionKey: "session",
      }),
    );
    const prompted = (n: number): AcceptedLinearEvent => ({
      dedupeKey: `turn-${n}`,
      deliveryId: null,
      source: "poll",
      action: "prompted",
      sessionId: "session",
      issueId: "issue",
      activityId: `activity-${n}`,
      actorId: "human",
      body: `continue ${n}`,
      signal: null,
      updatedAtMs: clock.now(),
      payload: "{}",
    });
    await orchestrator.onLinearEvent(prompted(1), { awaitAdmission: false });
    await orchestrator.onLinearEvent(prompted(2), { awaitAdmission: false });
    orchestrator.requestExecution();
    expect(passes).toBe(1);
    open();
    await waitFor(() => passes === 2);
  } finally {
    open();
    await orchestrator.shutdown();
    await close();
  }
});
