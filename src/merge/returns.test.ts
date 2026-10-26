import { describe, expect, test } from "bun:test";
import { JOB_KIND } from "../core";
import {
  applyWorkItemEvent,
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
import { ask as rawAsk, findOpenQuestion, getQuestion } from "../questions";
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
    expect(getWorkItem(db, "eng-1")?.state).toBe("queued");
    expect(getWorkItem(db, "eng-1")?.checkpoint?.phase).toBe("running");
    expect(listJobs(db).map((job) => [job.queue, job.jobKey, job.payload])).toEqual([
      [
        JOB_KIND.resume,
        "rebase-conflict:eng-1:0:0",
        {
          itemId: "eng-1",
          runId: getWorkItem(db, "eng-1")?.currentRunId,
          handoff: "rebase",
          reason: "conflict",
        },
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

  test("a guidance-answer restart resets the return budget", () => {
    const db = queued();
    sendBack(db, 1);
    expect(rebaseReturns(db, "eng-1")).toBe(1);
    enqueueJob(db, {
      queue: JOB_KIND.resume,
      jobKey: "resume:answer:guidance",
      payload: { itemId: "eng-1", reason: "answer" },
      now: 3,
    });
    expect(rebaseReturns(db, "eng-1")).toBe(0);
  });

  test("asking for help opens a question through the lifecycle and waits for input", () => {
    const db = queued();
    expect(
      askMergeHelp(db, {
        ask,
        itemId: "eng-1",
        body: "CI failed.",
        now: 2,
        session: (item) => item.sessionKey,
      }),
    ).toBe(true);
    expect(getWorkItem(db, "eng-1")?.state).toBe("awaiting_input");
    expect(findOpenQuestion(db, "s-1")?.body).toBe("CI failed.");
  });

  test("CI help asked while another task's question is open waits its turn", () => {
    const db = queued();
    insertQueuedItem(db, { id: "eng-2", now: 1, sessionKey: "s-1" });
    const open = ask(db, { itemId: "eng-2", runId: null, sessionId: "s-1" }, "agent", "Which?");
    expect(
      askMergeHelp(db, { ask, itemId: "eng-1", body: "CI failed.", now: 2, session: () => "s-1" }),
    ).toBe(true);
    expect(getWorkItem(db, "eng-1")?.state).toBe("awaiting_input");
    expect(findOpenQuestion(db, "s-1")?.id).toBe(open.question.id);
    const queuedHelp = db
      .query<{ id: string }, []>("SELECT id FROM question WHERE item_id = 'eng-1'")
      .get()!;
    expect(getQuestion(db, queuedHelp.id)).toMatchObject({ kind: "ci-help", status: "queued" });
  });

  test("asking again while a question is open, or without a session, asks nothing", () => {
    const db = queued();
    expect(askMergeHelp(db, { ask, itemId: "eng-1", body: "x", now: 2, session: () => null })).toBe(
      false,
    );
    expect(
      askMergeHelp(db, { ask, itemId: "eng-1", body: "x", now: 2, session: () => "s-1" }),
    ).toBe(true);
    expect(
      askMergeHelp(db, { ask, itemId: "eng-1", body: "y", now: 3, session: () => "s-1" }),
    ).toBe(false);
  });
});

const ask: typeof rawAsk = (db, asker, ...args) => {
  const result = rawAsk(db, asker, ...args);
  if (
    ["running", "verifying", "recovering", "merge_queue"].includes(
      getWorkItem(db, asker.itemId)?.state ?? "",
    )
  )
    applyWorkItemEvent(db, asker.itemId, "blocking_question");
  return result;
};
