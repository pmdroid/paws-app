import { expect, test } from "bun:test";
import { FakeClock, JOB_KIND } from "../src/core";
import { JobLoop, OutboxDispatcher, ensureLinearSession, listJobs } from "../src/db";
import { createFakeTracker } from "../src/linear";
import { Orchestrator } from "../src/loop";
import { tempHome } from "./helpers";
import { seed } from "./dialects";
import { tempStore } from "./pglite";

test("orchestrator resumes the session item through session_key alone", async () => {
  const { db, close } = await tempStore();
  const clock = new FakeClock(5_000);
  const tracker = createFakeTracker([
    {
      linearIssueId: "issue",
      identifier: "ENG-1",
      title: "Work",
      description: null,
      subIssues: [],
    },
  ]);
  const orchestrator = new Orchestrator({
    store: db,
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    clock,
    pawsRoot: tempHome(),
    tracker,
  });
  try {
    await ensureLinearSession(db, {
      sessionId: "session",
      issueId: "issue",
      now: clock.now(),
    });
    await seed(db, (q) =>
      q.orm.insert(q.t.workItem).values(
        (
          [
            ["newer-terminal", "merged", 4_000],
            ["older-live", "queued", 2_000],
          ] as const
        ).map(([id, state, createdAt]) => ({
          id,
          delegationId: id,
          linearIssueId: `${id}-issue`,
          linearIdentifier: id,
          title: id,
          state,
          branchName: `paws/${id}`,
          position: 0,
          createdAt,
          sessionKey: "session",
        })),
      ),
    );
    await orchestrator.onLinearEvent({
      dedupeKey: "turn-1",
      deliveryId: null,
      source: "poll",
      action: "prompted",
      sessionId: "session",
      issueId: "issue",
      activityId: "activity-1",
      actorId: "human",
      body: "continue",
      signal: null,
      updatedAtMs: clock.now(),
      payload: "{}",
    });
    expect(await db.run((q) => q.all(q.orm.select().from(q.t.workItem)))).toHaveLength(2);
    expect(
      (await listJobs(db))
        .filter((job) => job.queue === JOB_KIND.resume)
        .map((job) => (job.payload as { itemId?: string }).itemId),
    ).toEqual(["older-live"]);
  } finally {
    await orchestrator.shutdown();
    await close();
  }
});
