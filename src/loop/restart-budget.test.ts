import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  lifetimeRestartBudget,
  enterMergeQueue,
  applyWorkItemEvent,
  ensureLinearSession,
} from "../db";
import { createFakeTracker } from "../linear";
import { answerQuestion, findOpenQuestion } from "../questions";
import { deliverLinearOutbox } from "./dispatch";
import { restart } from "./operations";
import { returnToAgent } from "../merge";
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
    questionEffects(db, { now: clock.now() }).clarification!(answered);
    expect(lifetimeRestarts(db, item.id)).toBe(11);
    expect(lifetimeRestartBudget(db, item.id)).toEqual({ used: 11, limit: 20 });
    expect(getWorkItem(db, item.id)?.state).toBe("queued");
    expect(listOutbox(db).filter((row) => row.op === "elicitation")).toHaveLength(1);
  } finally {
    db.close();
  }
});

function spent(count = 10) {
  const db = openDatabase(":memory:");
  migrate(db);
  const item = insertQueuedItem(db, { id: "budget", sessionKey: "session", now: 1 });
  beginImplementRun(db, item.id, 1);
  for (let i = 0; i < count; i++)
    rawRestart(db, getWorkItem(db, item.id)!, { reason: "findings", body: "fix", now: 2 });
  return { db, id: item.id };
}

for (const state of ["paused", "failed", "merge_queue"] as const)
  test(`an answered budget question is never reused from ${state}`, () => {
    const { db, id } = spent();
    try {
      restart(db, getWorkItem(db, id)!, { reason: "ci", body: "fix", now: 3 });
      const old = findOpenQuestion(db, "session")!;
      answerQuestion(db, old.id, { answer: "Please explain", answeredBy: "human", now: 4 });
      db.run("UPDATE work_item SET state=? WHERE id=?", [state, id]);
      restart(db, getWorkItem(db, id)!, { reason: "review", body: "fix", now: 5 });
      expect(getWorkItem(db, id)?.state).toBe("awaiting_input");
      expect(findOpenQuestion(db, "session")?.id).not.toBe(old.id);
      expect(findOpenQuestion(db, "session")?.reason).toBe("restart_budget");
    } finally {
      db.close();
    }
  });

for (const state of ["running", "merge_queue"] as const)
  test(`a sessionless ${state} item fails admission atomically`, () => {
    const { db, id } = spent();
    try {
      db.run("UPDATE work_item SET state=?,session_key=NULL WHERE id=?", [state, id]);
      const before = getWorkItem(db, id)!;
      const jobs = listJobs(db);
      expect(() => restart(db, before, { reason: "ci", body: "fix", now: 3 })).toThrow(
        "no Linear session",
      );
      expect(getWorkItem(db, id)).toEqual(before);
      expect(listJobs(db)).toEqual(jobs);
    } finally {
      db.close();
    }
  });

test("a merge return at the cap asks without announcing or retaining a queue place", () => {
  const { db, id } = spent();
  try {
    applyWorkItemEvent(db, id, "dispatched");
    enterMergeQueue(db, id, { phase: "merge_queue", baseSha: "base", wipCommit: "head" });
    const announced: string[] = [];
    const recorded: number[] = [];
    const result = returnToAgent(db, {
      itemId: id,
      restart,
      reason: "rebase-conflict",
      admit: () => true,
      handoff: "rebase",
      now: 3,
      keepPlace: true,
      announce: (_, __, key) => announced.push(key),
      record: (job) => recorded.push(job),
    });
    expect(result).toBe("asked");
    expect(announced).toEqual([]);
    expect(recorded).toEqual([]);
    expect(getWorkItem(db, id)?.state).toBe("awaiting_input");
    expect(findOpenQuestion(db, "session")?.reason).toBe("restart_budget");
    expect(db.query("SELECT 1 FROM merge_queue_entry WHERE item_id=?").get(id)).toBeNull();
  } finally {
    db.close();
  }
});

test("a legacy item already over budget can grant ten more once, then asks again at its new limit", () => {
  const { db, id } = spent(46);
  try {
    restart(db, getWorkItem(db, id)!, { reason: "ci", body: "fix", now: 3 });
    const question = findOpenQuestion(db, "session")!;
    const answered = answerQuestion(db, question.id, {
      answer: "Continue",
      answeredBy: "human",
      now: 4,
    })!;
    questionEffects(db, { now: 4 }).clarification!(answered);
    expect(lifetimeRestartBudget(db, id)).toEqual({ used: 47, limit: 56 });
    for (let i = 0; i < 15; i++)
      restart(db, getWorkItem(db, id)!, { reason: "ci", body: "fix", now: 5 });
    expect(lifetimeRestartBudget(db, id)).toEqual({ used: 56, limit: 56 });
    expect(findOpenQuestion(db, "session")?.id).not.toBe(question.id);
    expect(listOutbox(db).filter((row) => row.op === "elicitation")).toHaveLength(2);
  } finally {
    db.close();
  }
});

test("Stop answers end the task instead of leaving an answered question hold", () => {
  const { db, id } = spent();
  try {
    restart(db, getWorkItem(db, id)!, { reason: "ci", body: "fix", now: 3 });
    const question = findOpenQuestion(db, "session")!;
    const answered = answerQuestion(db, question.id, {
      answer: "Stop",
      answeredBy: "human",
      now: 4,
    })!;
    questionEffects(db, { now: 4 }).clarification!(answered);
    expect(getWorkItem(db, id)?.state).toBe("cancelled");
    expect(listJobs(db).filter((job) => job.status === "pending")).toEqual([]);
  } finally {
    db.close();
  }
});

test("a sibling without a session asks through its delegation's existing live session", () => {
  const { db, id } = spent();
  try {
    const delegationId = getWorkItem(db, id)!.delegationId;
    const sibling = insertQueuedItem(db, { id: "sibling", sessionKey: "session", now: 1 });
    db.run("UPDATE work_item SET delegation_id=? WHERE id=?", [delegationId, sibling.id]);
    ensureLinearSession(db, { sessionId: "session", issueId: "linear", now: 1 });
    db.run("UPDATE work_item SET session_key=NULL WHERE id=?", [id]);
    expect(restart(db, getWorkItem(db, id)!, { reason: "ci", body: "fix", now: 3 })).toBeNull();
    expect(getWorkItem(db, id)).toMatchObject({ state: "awaiting_input", sessionKey: "session" });
    expect(findOpenQuestion(db, "session")?.itemId).toBe(id);
  } finally {
    db.close();
  }
});

test("pending cancellation keeps the pre-budget restart behavior", () => {
  const db = openDatabase(":memory:");
  migrate(db);
  try {
    insertQueuedItem(db, { id: "cancel-pending", sessionKey: "session" });
    beginImplementRun(db, "cancel-pending", 1);
    db.run("UPDATE work_item SET cancel_requested=1 WHERE id='cancel-pending'");
    expect(
      restart(db, getWorkItem(db, "cancel-pending")!, {
        reason: "answer",
        body: "human retry",
        now: 2,
      }),
    ).not.toBeNull();
  } finally {
    db.close();
  }
});

test("an approved restart grant survives reopening SQLite", () => {
  const directory = mkdtempSync(join(tmpdir(), "paws-restart-grant-"));
  let db = openDatabase(join(directory, "paws.db"));
  try {
    migrate(db);
    insertQueuedItem(db, { id: "persisted", sessionKey: "session" });
    beginImplementRun(db, "persisted", 1);
    for (let i = 0; i < 10; i++)
      rawRestart(db, getWorkItem(db, "persisted")!, { reason: "ci", body: "fix", now: 2 });
    restart(db, getWorkItem(db, "persisted")!, { reason: "ci", body: "fix", now: 3 });
    const question = findOpenQuestion(db, "session")!;
    const answered = answerQuestion(db, question.id, {
      answer: "Continue",
      answeredBy: "human",
      now: 4,
    })!;
    questionEffects(db, { now: 4 }).clarification!(answered);
    db.close();
    db = openDatabase(join(directory, "paws.db"));
    migrate(db);
    expect(lifetimeRestartBudget(db, "persisted")).toEqual({ used: 11, limit: 20 });
    questionEffects(db, { now: 5 }).clarification!(answered);
    expect(lifetimeRestartBudget(db, "persisted")).toEqual({ used: 11, limit: 20 });
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
