import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { JOB_KIND } from "../core";
import {
  applyWorkItemEvent,
  beginImplementRun,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  listOutbox,
  migrate,
  openDatabase,
} from "../db";
import { createFakeTracker } from "../linear";
import { answerQuestion, findOpenQuestion } from "../questions";
import { deliverLinearOutbox } from "./dispatch";
import { restart } from "./operations";
import { questionEffects } from "./question-effects";

function setup(path = ":memory:") {
  const db = openDatabase(path);
  migrate(db);
  insertQueuedItem(db, { id: "budget", sessionKey: "session", now: 1 });
  beginImplementRun(db, "budget", 2);
  return db;
}

test("ten agent restarts ask once; Continue carries the work and grants ten more once", async () => {
  const db = setup();
  try {
    for (let n = 0; n < 10; n++) {
      expect(
        restart(db, getWorkItem(db, "budget")!, {
          reason: "findings",
          body: "Fix the failing test",
          now: 3 + n,
        }),
      ).not.toBeNull();
      applyWorkItemEvent(db, "budget", "dispatched");
    }
    for (let n = 0; n < 3; n++)
      expect(
        restart(db, getWorkItem(db, "budget")!, {
          reason: "ci",
          body: "Fix the failing test",
          now: 20,
        }),
      ).toBeNull();
    expect(getWorkItem(db, "budget")).toMatchObject({
      state: "awaiting_input",
      restartCount: 10,
      restartLimit: 10,
    });
    expect(listJobs(db).filter((j) => j.queue === JOB_KIND.resume)).toHaveLength(10);
    expect(
      listJobs(db).filter((j) => j.status === "pending" || j.status === "running"),
    ).toHaveLength(0);
    const asks = listOutbox(db).filter((row) => row.op === "elicitation");
    expect(asks).toHaveLength(1);
    const tracker = createFakeTracker();
    await deliverLinearOutbox(asks[0]!, tracker, async () => {}, undefined, db);
    expect(tracker.questions).toHaveLength(1);
    const question = findOpenQuestion(db, "session")!;
    expect(question.body).toContain("Fix the failing test");
    const answer = answerQuestion(db, question.id, {
      answer: "Continue",
      answeredBy: "human",
      now: 21,
    })!;
    questionEffects(db, { now: 22 }).clarification!(answer);
    questionEffects(db, { now: 22 }).clarification!(answer);
    expect(getWorkItem(db, "budget")).toMatchObject({
      state: "queued",
      restartCount: 10,
      restartLimit: 20,
    });
    const resumed = listJobs(db)
      .filter((j) => j.queue === JOB_KIND.resume)
      .at(-1)!;
    expect(resumed.status).toBe("pending");
    expect(JSON.stringify(resumed.payload)).toContain("Fix the failing test");
    applyWorkItemEvent(db, "budget", "dispatched");
    expect(
      restart(db, getWorkItem(db, "budget")!, { reason: "ci", body: "Try again", now: 23 }),
    ).not.toBeNull();
    expect(getWorkItem(db, "budget")?.restartCount).toBe(11);
  } finally {
    db.close();
  }
});

test("human and infrastructure requests do not consume the budget or need new question edges", () => {
  const db = setup();
  try {
    db.run("UPDATE work_item SET restart_count=10 WHERE id='budget'");
    for (const state of ["queued", "paused", "failed"] as const) {
      db.run("UPDATE work_item SET state=? WHERE id='budget'", [state]);
      const current = getWorkItem(db, "budget")!;
      expect(restart(db, current, { reason: "ci", body: "agent", now: 3 })).toBeNull();
      expect(getWorkItem(db, "budget")?.version).toBe(current.version);
      expect(
        restart(db, current, {
          source: "human",
          reason: "follow_up",
          body: "Please retry",
          now: 4,
        }),
      ).not.toBeNull();
      expect(
        restart(db, getWorkItem(db, "budget")!, {
          source: "infrastructure",
          reason: "follow_up",
          body: "Retry runner setup",
          now: 5,
        }),
      ).not.toBeNull();
      expect(
        restart(db, getWorkItem(db, "budget")!, { reason: "answer", body: "Guidance", now: 6 }),
      ).not.toBeNull();
    }
    expect(getWorkItem(db, "budget")?.restartCount).toBe(10);
    expect(findOpenQuestion(db, "session")).toBeNull();
  } finally {
    db.close();
  }
});

test("item counters persist across database reopens", () => {
  const dir = mkdtempSync(join(tmpdir(), "paws-budget-"));
  const path = join(dir, "paws.sqlite");
  try {
    const db = setup(path);
    restart(db, getWorkItem(db, "budget")!, { reason: "ci", body: "Fix CI", now: 3 });
    db.close();
    const reopened = openDatabase(path);
    try {
      expect(getWorkItem(reopened, "budget")).toMatchObject({ restartCount: 1, restartLimit: 10 });
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Stop uses the normal cancellation lifecycle", () => {
  const db = setup();
  try {
    db.run("UPDATE work_item SET restart_count=10 WHERE id='budget'");
    restart(db, getWorkItem(db, "budget")!, { reason: "ci", body: "Fix CI", now: 3 });
    const question = findOpenQuestion(db, "session")!;
    const answer = answerQuestion(db, question.id, {
      answer: "Stop",
      answeredBy: "human",
      now: 4,
    })!;
    questionEffects(db, { now: 5 }).clarification!(answer);
    expect(getWorkItem(db, "budget")).toMatchObject({ state: "cancelled", cancelRequested: true });
    expect(findOpenQuestion(db, "session")).toBeNull();
    expect(listOutbox(db).some((row) => JSON.stringify(row.payload).includes("Stopped."))).toBe(
      true,
    );
  } finally {
    db.close();
  }
});
