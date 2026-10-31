import { expect, test } from "bun:test";
import { systemClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  beginImplementRun,
  failWorkItem,
  applyWorkItemEvent,
  listOutbox,
  getLinearSession,
  getWorkItem,
  listJobs,
  humanRetryBaseline,
} from "../src/db";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator, restart, ask } from "../src/loop";
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

test.each(["failure", "cancel", "review", "question"] as const)(
  "a Linear follow-up handles concurrent %s during its evidence await",
  async (change) => {
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
      if (change === "failure")
        failWorkItem(db, getWorkItem(db, id)!, "auth", "Authentication failed", Date.now());
      else if (change === "cancel") applyWorkItemEvent(db, id, "cancel");
      else if (change === "review")
        restart(db, getWorkItem(db, id)!, {
          reason: "review",
          body: "Fix review finding",
          now: Date.now(),
        });
      else
        ask(
          db,
          { itemId: id, runId: getWorkItem(db, id)!.currentRunId, sessionId: "session" },
          "agent",
          "Choose a direction",
          { now: Date.now() },
        );
      release.resolve();
      await followUp;
      if (change === "failure") {
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
      } else if (change === "cancel") {
        expect(getWorkItem(db, id)?.state).toBe("cancelled");
        expect(
          listJobs(db).filter((job) => job.status === "pending" && job.queue === "run.resume"),
        ).toHaveLength(0);
        expect(
          listOutbox(db).some((row) =>
            (row.payload as { body?: string }).body?.includes("was not restarted"),
          ),
        ).toBe(true);
      } else if (change === "review") {
        const resume = listJobs(db).find(
          (job) => job.status === "pending" && job.queue === "run.resume",
        )!;
        expect((resume.payload as { handoff: string }).handoff).toContain("Fix review finding");
        expect((resume.payload as { handoff: string }).handoff).toContain(
          "Retry with this guidance",
        );
      } else {
        expect(getWorkItem(db, id)?.state).toBe("awaiting_input");
        expect(listJobs(db).some((job) => job.lastError === "restart_deferred")).toBe(true);
      }
    } finally {
      release.resolve();
      await followUp;
      await orchestrator.shutdown();
      db.close();
    }
  },
);
