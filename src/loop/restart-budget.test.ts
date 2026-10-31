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
  joinMergeQueue,
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
      ).toMatchObject({ kind: "restarted" });
      applyWorkItemEvent(db, "budget", "dispatched");
    }
    for (let n = 0; n < 3; n++)
      expect(
        restart(db, getWorkItem(db, "budget")!, {
          reason: "ci",
          body: "Fix the failing test",
          now: 20,
        }),
      ).toEqual({ kind: "asked" });
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
    ).toMatchObject({ kind: "restarted" });
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
      expect(restart(db, current, { reason: "ci", body: "agent", now: 3 })).toEqual({
        kind: "skipped",
      });
      expect(getWorkItem(db, "budget")?.version).toBe(current.version);
      expect(
        restart(db, current, {
          source: "human",
          reason: "follow_up",
          body: "Please retry",
          now: 4,
        }),
      ).toMatchObject({ kind: "restarted" });
      expect(
        restart(db, getWorkItem(db, "budget")!, {
          source: "infrastructure",
          reason: "follow_up",
          body: "Retry runner setup",
          now: 5,
        }),
      ).toMatchObject({ kind: "restarted" });
      expect(
        restart(db, getWorkItem(db, "budget")!, { reason: "answer", body: "Guidance", now: 6 }),
      ).toMatchObject({ kind: "restarted" });
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
    restart(db, getWorkItem(db, "budget")!, {
      source: "human",
      reason: "follow_up",
      body: "Look again",
      now: 4,
    });
    applyWorkItemEvent(db, "budget", "dispatched");
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

test("a budget hold is re-adopted after an unrelated human follow-up", () => {
  const db = setup();
  try {
    db.run("UPDATE work_item SET restart_count=10 WHERE id='budget'");
    joinMergeQueue(db, { itemId: "budget", repository: "owner/repo", now: 2 });
    restart(db, getWorkItem(db, "budget")!, {
      reason: "ci",
      body: "First finding",
      now: 3,
      keepMergeQueuePlace: true,
    });
    expect(
      db.query("SELECT ready_at,kept FROM merge_queue_entry WHERE item_id='budget'").get(),
    ).toEqual({ ready_at: 2, kept: 1 });
    const question = findOpenQuestion(db, "session")!;
    restart(db, getWorkItem(db, "budget")!, {
      source: "human",
      reason: "follow_up",
      body: "Look again",
      now: 4,
    });
    applyWorkItemEvent(db, "budget", "dispatched");
    applyWorkItemEvent(db, "budget", "turn_ended");
    restart(db, getWorkItem(db, "budget")!, { reason: "findings", body: "New finding", now: 5 });
    expect(getWorkItem(db, "budget")).toMatchObject({ state: "awaiting_input", restartCount: 10 });
    expect(findOpenQuestion(db, "session")?.id).toBe(question.id);
    expect(listOutbox(db).filter((row) => row.op === "elicitation")).toHaveLength(1);
    expect(
      listJobs(db).filter((job) => job.status === "pending" || job.status === "running"),
    ).toHaveLength(0);
    const answered = answerQuestion(db, question.id, {
      answer: "Continue",
      answeredBy: "human",
      now: 6,
    })!;
    questionEffects(db, { now: 7 }).clarification!(answered);
    expect(JSON.stringify(listJobs(db).at(-1)?.payload)).toContain("New finding");
  } finally {
    db.close();
  }
});

test("deduplicated restart keys preserve the original job and do not charge the budget", () => {
  const db = setup();
  try {
    const handoff = { reason: "ci" as const, jobKey: "same-head", body: "Fix CI", now: 3 };
    const result = restart(db, getWorkItem(db, "budget")!, handoff);
    if (result.kind !== "restarted") throw new Error("Expected restart");
    const job = result.jobId;
    const before = getWorkItem(db, "budget")!;
    expect(restart(db, before, handoff)).toEqual({ kind: "skipped" });
    expect(getWorkItem(db, "budget")).toEqual(before);
    expect(listJobs(db).find((row) => row.id === job)?.status).toBe("pending");
    expect(getWorkItem(db, "budget")?.restartCount).toBe(1);
  } finally {
    db.close();
  }
});

test("sessionless execution ends with an explicit error when it cannot ask", () => {
  const db = setup();
  try {
    db.run("UPDATE work_item SET restart_count=10, session_key=NULL WHERE id='budget'");
    restart(db, getWorkItem(db, "budget")!, { reason: "ci", body: "Fix CI", now: 3 });
    expect(getWorkItem(db, "budget")?.state).toBe("failed");
    expect(
      listJobs(db).filter((row) => row.status === "pending" || row.status === "running"),
    ).toHaveLength(0);
    expect(
      listOutbox(db).some((row) => JSON.stringify(row.payload).includes("no Linear session")),
    ).toBe(true);
  } finally {
    db.close();
  }
});

test.each(["Stop.", "stop, it's done"])("%s uses the cancellation lifecycle", (answer) => {
  const db = setup();
  try {
    db.run("UPDATE work_item SET restart_count=10 WHERE id='budget'");
    restart(db, getWorkItem(db, "budget")!, { reason: "ci", body: "Fix CI", now: 3 });
    const question = findOpenQuestion(db, "session")!;
    const answered = answerQuestion(db, question.id, { answer, answeredBy: "human", now: 4 })!;
    questionEffects(db, { now: 5 }).clarification!(answered);
    expect(getWorkItem(db, "budget")?.state).toBe("cancelled");
  } finally {
    db.close();
  }
});

test.each(["Continue.", "yes, continue", "go on"])("%s grants ten more restarts", (answer) => {
  const db = setup();
  try {
    db.run("UPDATE work_item SET restart_count=10 WHERE id='budget'");
    restart(db, getWorkItem(db, "budget")!, { reason: "ci", body: "Fix CI", now: 3 });
    const question = findOpenQuestion(db, "session")!;
    const answered = answerQuestion(db, question.id, { answer, answeredBy: "human", now: 4 })!;
    questionEffects(db, { now: 5 }).clarification!(answered);
    expect(getWorkItem(db, "budget")).toMatchObject({ state: "queued", restartLimit: 20 });
  } finally {
    db.close();
  }
});
