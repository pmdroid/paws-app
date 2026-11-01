import { expect, test } from "bun:test";
import { FakeClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  beginImplementRun,
  applyWorkItemEvent,
  bindLinearSessionTask,
  ensureLinearSession,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  listOutbox,
  saveCloseoutRecovery,
  recoverOnStartup,
  requeueOrphanedWork,
} from "../src/db";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { Orchestrator, ask, questionEffects } from "../src/loop";
import { answer, findOpenQuestion } from "../src/questions";
import { workspaceAdmission } from "./fake-workspace";
import { tempDb, tempHome } from "./helpers";

function fixture() {
  const db = tempDb();
  const clock = new FakeClock(1000);
  const tracker = createFakeTracker([
    {
      linearIssueId: "issue",
      identifier: "ENG-1",
      title: "Task",
      description: null,
      subIssues: [],
    },
  ]);
  const item = insertQueuedItem(db, {
    id: "item",
    sessionKey: "session",
    now: clock.now(),
  });
  db.run("UPDATE work_item SET linear_issue_id='issue' WHERE id=?", [item.id]);
  ensureLinearSession(db, {
    sessionId: "session",
    issueId: "issue",
    creatorId: "human",
    now: clock.now(),
  });
  bindLinearSessionTask(db, "session", item.delegationId, { actorId: "human" });
  beginImplementRun(db, item.id, clock.now());
  recoverOnStartup(db, clock.now());
  recoverOnStartup(db, clock.now());
  const orchestrator = new Orchestrator({
    db,
    clock,
    tracker,
    pawsRoot: tempHome(),
    admission: workspaceAdmission(db),
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
  });
  return { db, clock, item, orchestrator };
}

test("an authorized Linear follow-up releases a stopped undelivered decision and retains the message", async () => {
  const { db, clock, item, orchestrator } = fixture();
  try {
    db.run("UPDATE work_item SET cancel_requested=1 WHERE id=?", [item.id]);
    db.run("UPDATE job SET status='cancelled' WHERE queue='item.ask'");
    const event: AcceptedLinearEvent = {
      dedupeKey: "followup",
      deliveryId: null,
      source: "webhook",
      action: "prompted",
      sessionId: "session",
      issueId: "issue",
      activityId: "followup",
      actorId: "human",
      body: "Continue with the new requirement",
      signal: null,
      updatedAtMs: clock.now(),
      payload: JSON.stringify({ agentSession: { creatorId: "human" } }),
    };
    await orchestrator.onLinearEvent(event);
    expect(getWorkItem(db, item.id)).toMatchObject({ state: "queued", cancelRequested: false });
    const resumes = listJobs(db).filter(
      (job) => job.queue === "run.resume" && job.status === "pending",
    );
    expect(resumes).toHaveLength(1);
    expect(resumes[0]?.payload).toMatchObject({
      handoff: "Continue with the new requirement",
      reason: "follow_up",
    });
    expect(db.query("SELECT * FROM restart_decision").all()).toEqual([]);
    await orchestrator.onLinearEvent(event);
    expect(
      listJobs(db).filter((job) => job.queue === "run.resume" && job.status === "pending"),
    ).toHaveLength(1);
  } finally {
    await orchestrator.shutdown();
    db.close();
  }
});

test.each(["agent", "closeout-help"] as const)(
  "criteria edits reach the agent after the restart answer and a queued %s answer",
  async (kind) => {
    const { db, clock, item, orchestrator } = fixture();
    try {
      const current = getWorkItem(db, item.id)!;
      const first = ask(
        db,
        { itemId: item.id, runId: current.currentRunId, sessionId: "session" },
        "agent",
        "Restart?",
        { reason: "restart", now: clock.now() },
      );
      const other = ask(
        db,
        { itemId: item.id, runId: current.currentRunId, sessionId: "session" },
        kind,
        "Which implementation?",
        { now: clock.now() + 1 },
      );
      if (kind === "closeout-help")
        saveCloseoutRecovery(db, {
          questionId: other.question.id,
          taskId: "task",
          itemId: item.id,
          base: "base",
          head: "",
          policyDigest: "policy",
          failedChecks: [],
          retryBaseline: [],
          summary: "Implementation guidance",
        });
      orchestrator.applyDelegationChanges({
        delegationId: item.delegationId,
        sessionId: "session",
        addedItemIds: [],
        removedItemIds: [],
        specChangedItemIds: [item.id],
        canceledItemIds: [],
        parentCanceled: false,
      });
      expect(findOpenQuestion(db, "session")?.id).toBe(first.question.id);
      expect(
        listJobs(db).filter((job) => job.queue === "run.resume" && job.status === "pending"),
      ).toHaveLength(0);
      expect(
        listOutbox(db).some((row) =>
          (row.payload as { body?: string }).body?.includes("after the pending restart decision"),
        ),
      ).toBe(true);
      clock.advance(45 * 60_000);
      requeueOrphanedWork(db, clock.now());
      recoverOnStartup(db, clock.now());
      expect(
        answer(
          db,
          {
            sessionId: "session",
            deliveryId: "answer",
            body: "Start again",
            answeredBy: "human",
            now: clock.now(),
          },
          questionEffects(db, { now: clock.now() }),
        ).status,
      ).toBe("answered");
      expect(
        listJobs(db).filter((job) => job.queue === "run.resume" && job.status === "pending"),
      ).toHaveLength(0);
      expect(
        answer(
          db,
          {
            sessionId: "session",
            deliveryId: "other-answer",
            body: "Use the smaller implementation",
            answeredBy: "human",
            now: clock.now(),
          },
          questionEffects(db, { now: clock.now() }),
        ).status,
      ).toBe("answered");
      const resumes = listJobs(db).filter(
        (job) => job.queue === "run.resume" && job.status === "pending",
      );
      expect(resumes).toHaveLength(1);
      expect((resumes[0]!.payload as { handoff: string }).handoff).toContain(
        "The task criteria changed in Linear",
      );
      expect((resumes[0]!.payload as { handoff: string }).handoff).toContain("Start again");
      expect(getWorkItem(db, item.id)?.recoveryAttempts).toBe(1);
    } finally {
      await orchestrator.shutdown();
      db.close();
    }
  },
);

test("an authorized Resume releases a paused decision and carries criteria saved while paused", async () => {
  const { db, item, orchestrator } = fixture();
  try {
    applyWorkItemEvent(db, item.id, "recovered");
    expect(await orchestrator.pauseItem(item.id)).toBe(true);
    orchestrator.applyDelegationChanges({
      delegationId: item.delegationId,
      sessionId: "session",
      addedItemIds: [],
      removedItemIds: [],
      specChangedItemIds: [item.id],
      canceledItemIds: [],
      parentCanceled: false,
    });
    expect(await orchestrator.resumeItem(item.id, () => false)).toBe(false);
    expect(getWorkItem(db, item.id)?.state).toBe("paused");
    expect(db.query("SELECT * FROM restart_decision").all()).toHaveLength(1);
    expect(await orchestrator.resumeItem(item.id)).toBe(true);
    expect(getWorkItem(db, item.id)?.state).toBe("queued");
    expect(db.query("SELECT * FROM restart_decision").all()).toEqual([]);
    const resumes = listJobs(db).filter(
      (job) => job.queue === "run.resume" && job.status === "pending",
    );
    expect(resumes).toHaveLength(1);
    expect((resumes[0]!.payload as { handoff: string }).handoff).toContain(
      "The task criteria changed in Linear",
    );
  } finally {
    await orchestrator.shutdown();
    db.close();
  }
});
