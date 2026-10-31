import { expect, test } from "bun:test";
import { systemClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  beginImplementRun,
  failWorkItem,
  getLinearSession,
  getWorkItem,
  listJobs,
  humanRetryBaseline,
} from "../src/db";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator } from "../src/loop";
import { workspaceAdmission } from "./fake-workspace";
import { tempDb, tempHome } from "./helpers";

function event(body: string | null): AcceptedLinearEvent {
  return {
    dedupeKey: body ? "reply" : "created",
    deliveryId: null,
    source: "webhook",
    action: body ? "prompted" : "created",
    sessionId: "session",
    issueId: "issue",
    activityId: body ? "reply" : null,
    actorId: "human",
    body,
    signal: null,
    updatedAtMs: Date.now(),
    payload: JSON.stringify({ agentSession: { creatorId: "human" } }),
  };
}

test("a Linear follow-up retries a run that fails during the evidence snapshot await", async () => {
  const db = tempDb();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const orchestrator = attachOrchestrator({
    db,
    jobs: new JobLoop(db, systemClock),
    outbox: new OutboxDispatcher(db, systemClock),
    admission: workspaceAdmission(db),
    pawsRoot: tempHome(),
    tracker: createFakeTracker([
      {
        linearIssueId: "issue",
        identifier: "PAS-923",
        title: "Fix",
        description: null,
        subIssues: [],
      },
    ]),
    authorizeLinearIntake: () => true,
    caps: { maxTurns: 20, maxAwakeMs: 10000 },
    snapshotRetryBaseline: async () => {
      entered.resolve();
      await release.promise;
      return ["baseline"];
    },
  });
  let followUp: Promise<unknown> | undefined;
  try {
    await orchestrator.onLinearEvent(event(null));
    const id = getLinearSession(db, "session")!.activeItemId!;
    beginImplementRun(db, id, Date.now());
    db.run(
      "UPDATE work_item SET awake_ms=500, agent_ms=500, turn_count=4, recovery_attempts=1 WHERE id=?",
      [id],
    );
    followUp = orchestrator.onLinearEvent(event("Retry with this guidance"));
    await entered.promise;
    expect(getWorkItem(db, id)?.state).toBe("running");
    failWorkItem(db, getWorkItem(db, id)!, "auth", "Authentication failed", Date.now());
    release.resolve();
    await followUp;
    expect(getWorkItem(db, id)).toMatchObject({
      state: "queued",
      cancelRequested: false,
      turnCount: 0,
      recoveryAttempts: 0,
      awakeMs: 0,
      agentMs: 0,
      maxTurns: 20,
      maxAwakeMs: 10000,
    });
    const resume = listJobs(db).find((job) => job.jobKey?.startsWith("linear-turn:"));
    expect(resume?.payload).toMatchObject({ handoff: "Retry with this guidance" });
    expect(humanRetryBaseline(db, id)).toEqual(["baseline"]);
  } finally {
    release.resolve();
    await followUp;
    await orchestrator.shutdown();
    db.close();
  }
});
