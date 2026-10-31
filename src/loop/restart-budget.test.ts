import { expect, test } from "bun:test";
import { FakeClock, JOB_KIND } from "../core";
import {
  beginImplementRun,
  getWorkItem,
  insertQueuedItem,
  lifetimeRestarts,
  listJobs,
  listOutbox,
  migrate,
  openDatabase,
  restart as rawRestart,
} from "../db";
import { createFakeTracker } from "../linear";
import { answerQuestion, findOpenQuestion } from "../questions";
import { deliverLinearOutbox } from "./dispatch";
import { restart } from "./operations";
import { questionEffects } from "./question-effects";

test("ten lifetime restarts survive human turns, then ask once and stop", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const clock = new FakeClock(1_000);
  const tracker = createFakeTracker();
  try {
    const item = insertQueuedItem(db, {
      id: "restart-budget",
      sessionKey: "session",
      now: clock.now(),
    });
    beginImplementRun(db, item.id, clock.now());
    for (let round = 0; round < 10; round++) {
      const current = getWorkItem(db, item.id)!;
      expect(
        restart(db, current, {
          reason: round % 2 ? "answer" : "findings",
          body: "Try again",
          now: clock.now(),
        }),
      ).not.toBeNull();
    }
    expect(lifetimeRestarts(db, item.id)).toBe(10);
    const stale = getWorkItem(db, item.id)!;
    for (let replay = 0; replay < 3; replay++)
      expect(
        restart(db, getWorkItem(db, item.id)!, {
          reason: "follow_up",
          body: "Retry",
          now: clock.now(),
        }),
      ).toBeNull();
    expect(restart(db, stale, { reason: "review", body: "Stale", now: clock.now() })).toBeNull();
    expect(getWorkItem(db, item.id)?.state).toBe("awaiting_input");
    expect(lifetimeRestarts(db, item.id)).toBe(10);
    expect(listJobs(db).filter((job) => job.queue === JOB_KIND.resume)).toHaveLength(10);
    expect(
      listJobs(db).filter((job) => job.status === "pending" || job.status === "running"),
    ).toHaveLength(0);
    const question = findOpenQuestion(db, "session")!;
    expect(question.reason).toBe("restart_budget");
    const asks = listOutbox(db).filter((row) => row.op === "elicitation");
    expect(asks).toHaveLength(1);
    await deliverLinearOutbox(asks[0]!, tracker, async () => {}, undefined, db);
    expect(tracker.questions).toHaveLength(1);
    expect(tracker.questions[0]?.body).toContain("10 of 10 lifetime restarts");
    const answered = answerQuestion(db, question.id, {
      answer: "Continue",
      answeredBy: "human",
      now: clock.now(),
    })!;
    questionEffects(db, { now: clock.now() }).clarification!(answered);
    expect(lifetimeRestarts(db, item.id)).toBe(10);
    expect(listOutbox(db).filter((row) => row.op === "elicitation")).toHaveLength(1);
    // Even callers of the lower-level DB operation cannot bypass the cap.
    expect(
      rawRestart(db, getWorkItem(db, item.id)!, { reason: "ci", body: "Fix CI", now: clock.now() }),
    ).toBeNull();
  } finally {
    db.close();
  }
});
