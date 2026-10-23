import { describe, expect, test } from "bun:test";
import { JOB_KIND } from "../core";
import {
  beginImplementRun,
  enqueueJob,
  enterMergeQueue,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  migrate,
  openDatabase,
  recordRebaseReturn,
} from "../db";
import { findOpenQuestion } from "../questions";
import { askMergeHelp, ciFixes, rebaseReturns, returnToAgent } from "./returns";

function queued() {
  const db = openDatabase(":memory:");
  migrate(db);
  insertQueuedItem(db, { id: "eng-1", now: 1, sessionKey: "s-1" });
  beginImplementRun(db, "eng-1", 1);
  enterMergeQueue(db, "eng-1", { phase: "merge_queue", baseSha: "b", wipCommit: "h" });
  return db;
}

function sendBack(db: ReturnType<typeof queued>, limit = 3) {
  const announced: string[] = [];
  const sent = returnToAgent(db, {
    itemId: "eng-1",
    reason: "rebase-conflict",
    admit: (returns) => returns < limit,
    handoff: "rebase",
    now: 2,
    record: (jobId) =>
      recordRebaseReturn(db, { itemId: "eng-1", jobId, candidate: "h", reason: "merge" }),
    announce: (_, attempt, key) => announced.push(`${attempt}:${key}`),
  });
  return { sent, announced };
}

describe("merge returns", () => {
  test("a return sends the item back to the agent with a resume job and counts it", () => {
    const db = queued();
    const { sent, announced } = sendBack(db);
    expect(sent).toBe(true);
    expect(getWorkItem(db, "eng-1")?.state).toBe("running");
    expect(getWorkItem(db, "eng-1")?.checkpoint?.phase).toBe("running");
    expect(listJobs(db).map((job) => [job.queue, job.jobKey, job.payload])).toEqual([
      [
        JOB_KIND.resume,
        "rebase-conflict:eng-1:0:0",
        { itemId: "eng-1", handoff: "rebase", reason: "rebase-conflict" },
      ],
    ]);
    expect(announced).toEqual(["1:eng-1:rebase-conflict:0:0"]);
    expect(rebaseReturns(db, "eng-1")).toBe(1);
    expect(ciFixes(db, "eng-1")).toBe(0);
  });

  test("a spent budget or an item that left the merge queue is not sent back", () => {
    const db = queued();
    expect(sendBack(db, 0).sent).toBe(false);
    expect(sendBack(db).sent).toBe(true);
    expect(sendBack(db).sent).toBe(false);
    expect(listJobs(db)).toHaveLength(1);
  });

  test("a Linear user turn resets the budget", () => {
    const db = queued();
    sendBack(db, 1);
    enqueueJob(db, {
      queue: JOB_KIND.resume,
      jobKey: "linear-turn:s-1:1",
      payload: { itemId: "eng-1" },
      now: 3,
    });
    expect(rebaseReturns(db, "eng-1")).toBe(0);
  });

  test("asking for help opens a question through the lifecycle and waits for input", () => {
    const db = queued();
    expect(
      askMergeHelp(db, {
        itemId: "eng-1",
        body: "CI failed.",
        now: 2,
        session: (item) => item.sessionKey,
      }),
    ).toBe(true);
    expect(getWorkItem(db, "eng-1")?.state).toBe("awaiting_input");
    expect(findOpenQuestion(db, "s-1")?.body).toBe("CI failed.");
  });

  test("asking again while a question is open, or without a session, asks nothing", () => {
    const db = queued();
    expect(askMergeHelp(db, { itemId: "eng-1", body: "x", now: 2, session: () => null })).toBe(
      false,
    );
    expect(askMergeHelp(db, { itemId: "eng-1", body: "x", now: 2, session: () => "s-1" })).toBe(
      true,
    );
    expect(askMergeHelp(db, { itemId: "eng-1", body: "y", now: 3, session: () => "s-1" })).toBe(
      false,
    );
  });
});
