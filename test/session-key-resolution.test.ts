import { expect, test } from "bun:test";
import { FakeClock, JOB_KIND } from "../src/core";
import { JobLoop, OutboxDispatcher, ensureLinearSession, listJobs } from "../src/db";
import { createFakeTracker } from "../src/linear";
import { Orchestrator } from "../src/loop";
import { tempDb, tempHome } from "./helpers";

test("orchestrator resumes the session item through session_key alone", async () => {
  const db = tempDb();
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
    db,
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    clock,
    pawsRoot: tempHome(),
    tracker,
  });
  try {
    ensureLinearSession(db, { sessionId: "session", issueId: "issue", now: clock.now() });
    for (const [id, state, createdAt] of [
      ["newer-terminal", "merged", 4_000],
      ["older-live", "queued", 2_000],
    ] as const) {
      db.run(
        "INSERT INTO epic(id,linear_issue_id,linear_identifier,title,state,created_at) VALUES(?,?,?,?,?,?)",
        [id, `${id}-issue`, id, id, "running", createdAt],
      );
      db.run(
        "INSERT INTO work_item(id,epic_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at,session_key) VALUES(?,?,?,?,?,?,?,?,?,?)",
        [id, id, `${id}-issue`, id, id, state, `paws/${id}`, 0, createdAt, "session"],
      );
    }
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
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM work_item").get()?.n).toBe(2);
    expect(
      listJobs(db)
        .filter((job) => job.queue === JOB_KIND.resume)
        .map((job) => (job.payload as { itemId?: string }).itemId),
    ).toEqual(["older-live"]);
  } finally {
    await orchestrator.shutdown();
    db.close();
  }
});
