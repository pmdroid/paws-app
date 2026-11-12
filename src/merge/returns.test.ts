import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { JOB_KIND } from "../core";
import {
  applyWorkItemEventSteps,
  beginImplementRun,
  enqueueJob,
  enterMergeQueue,
  getWorkItem,
  getWorkItemSteps,
  insertQueuedItem,
  listFixRecords,
  listJobs,
  markCloseoutAccepted,
  recordRebaseReturnSteps,
  fixRounds,
  syncSteps,
  saveHumanRetryWindow,
  humanRetryBaseline,
} from "../db";
import { askSteps, findOpenQuestion, getQuestion } from "../questions";
import { askMergeHelp, rebaseReturns, returnToAgent } from "./returns";
import { tempStore } from "../../test/pglite";

async function queued() {
  const db = (await tempStore()).db;
  await insertQueuedItem(db, { id: "eng-1", now: 1, sessionKey: "s-1" });
  await beginImplementRun(db, "eng-1", 1);
  await enterMergeQueue(db, "eng-1", {
    phase: "merge_queue",
    baseSha: "b",
    wipCommit: "h",
  });
  return db;
}

async function sendBack(db: Awaited<ReturnType<typeof queued>>, limit = 3) {
  const announced: string[] = [];
  const sent = await returnToAgent(db, {
    itemId: "eng-1",
    reason: "rebase-conflict",
    admit: (_q, returns) => syncSteps(() => returns < limit),
    handoff: "rebase",
    now: 2,
    record: (q, jobId) =>
      recordRebaseReturnSteps(q, { itemId: "eng-1", jobId, candidate: "h", reason: "merge" }),
    announce: (_q, _, attempt, key) => syncSteps(() => announced.push(`${attempt}:${key}`)),
  });
  return { sent, announced };
}

describe("merge returns", () => {
  test("a CI return opens a fix round naming the failing check, and acceptance closes it fixed", async () => {
    const db = await queued();
    expect(
      await returnToAgent(db, {
        itemId: "eng-1",
        reason: "ci-failed",
        admit: () => syncSteps(() => true),
        handoff: "fix ci",
        now: 2,
        record: () => syncSteps(() => {}),
        announce: () => syncSteps(() => {}),
        failedChecks: [{ name: "test", url: "https://ci.example/runs/1", logTail: "boom" }],
      }),
    ).toBe(true);
    const url = "https://ci.example/runs/1";
    expect(await listFixRecords(db)).toMatchObject([
      { reason: "ci", round: 1, triggers: { checks: [{ name: "test", url }] }, headBefore: "h" },
    ]);
    await markCloseoutAccepted(db, "eng-1", "h2", 10);
    expect(await listFixRecords(db)).toMatchObject([
      { outcome: "fixed", headAfter: "h2", endedAt: 10, durationMs: 8 },
    ]);
  });

  test("a return sends the item back to the agent with a resume job and counts it", async () => {
    const db = await queued();
    const { sent, announced } = await sendBack(db);
    expect(sent).toBe(true);
    expect((await getWorkItem(db, "eng-1"))?.state).toBe("queued");
    expect((await getWorkItem(db, "eng-1"))?.checkpoint?.phase).toBe("running");
    expect((await listJobs(db)).map((job) => [job.queue, job.jobKey, job.payload])).toEqual([
      [
        JOB_KIND.resume,
        "rebase-conflict:eng-1:0:0",
        {
          itemId: "eng-1",
          runId: (await getWorkItem(db, "eng-1"))?.currentRunId,
          handoff: "rebase",
          reason: "conflict",
        },
      ],
    ]);
    expect(announced).toEqual(["1:eng-1:rebase-conflict:0:0"]);
    expect(await rebaseReturns(db, "eng-1")).toBe(1);
    expect(await fixRounds(db, "eng-1")).toBe(0);
  });

  test("a spent budget or an item that left the merge queue is not sent back", async () => {
    const db = await queued();
    expect((await sendBack(db, 0)).sent).toBe(false);
    expect((await sendBack(db)).sent).toBe(true);
    expect((await sendBack(db)).sent).toBe(false);
    expect(await listJobs(db)).toHaveLength(1);
  });

  test("a Linear user turn resets the budget", async () => {
    const db = await queued();
    await sendBack(db, 1);
    await enqueueJob(db, {
      queue: JOB_KIND.resume,
      jobKey: "linear-turn:s-1:1",
      payload: { itemId: "eng-1" },
      now: 3,
    });
    expect(await rebaseReturns(db, "eng-1")).toBe(0);
  });

  test("a guidance-answer restart resets the return budget", async () => {
    const db = await queued();
    await sendBack(db, 1);
    expect(await rebaseReturns(db, "eng-1")).toBe(1);
    await enqueueJob(db, {
      queue: JOB_KIND.resume,
      jobKey: "resume:answer:guidance",
      payload: { itemId: "eng-1", reason: "answer" },
      now: 3,
    });
    expect(await rebaseReturns(db, "eng-1")).toBe(0);
  });

  test("findings, CI and review share one budget until a person replies", async () => {
    const db = await queued();
    for (const reason of ["findings", "ci", "review"]) {
      await enqueueJob(db, {
        queue: JOB_KIND.resume,
        payload: { itemId: "eng-1", reason },
        now: 2,
      });
    }
    expect(await fixRounds(db, "eng-1")).toBe(3);
    await enqueueJob(db, {
      queue: JOB_KIND.resume,
      payload: { itemId: "eng-1", reason: "conflict" },
      now: 3,
    });
    expect(await fixRounds(db, "eng-1")).toBe(3);
    const reply = await enqueueJob(db, {
      queue: JOB_KIND.resume,
      jobKey: "linear-turn:s-1:2",
      payload: { itemId: "eng-1" },
      now: 4,
    });
    await saveHumanRetryWindow(db, "eng-1", reply, ["failed-evidence"]);
    await saveHumanRetryWindow(db, "eng-1", reply, ["redispatched-evidence"]);
    expect(await humanRetryBaseline(db, "eng-1")).toEqual(["failed-evidence"]);
    expect(await fixRounds(db, "eng-1")).toBe(0);
    await enqueueJob(db, {
      queue: JOB_KIND.resume,
      payload: { itemId: "eng-1", reason: "ci" },
      now: 5,
    });
    expect(await fixRounds(db, "eng-1")).toBe(1);
  });

  test("asking for help opens a question through the lifecycle and waits for input", async () => {
    const db = await queued();
    expect(
      await askMergeHelp(db, {
        ask,
        itemId: "eng-1",
        body: "CI failed.",
        now: 2,
        session: (item) => item.sessionKey,
      }),
    ).toBe(true);
    expect((await getWorkItem(db, "eng-1"))?.state).toBe("awaiting_input");
    expect((await findOpenQuestion(db, "s-1"))?.body).toBe("CI failed.");
  });

  test("CI help asked while another task's question is open waits its turn", async () => {
    const db = await queued();
    await insertQueuedItem(db, { id: "eng-2", now: 1, sessionKey: "s-1" });
    const open = await db.transaction((q) =>
      askSteps(q, { itemId: "eng-2", runId: null, sessionId: "s-1" }, "agent", "Which?"),
    );
    expect(
      await askMergeHelp(db, {
        ask,
        itemId: "eng-1",
        body: "CI failed.",
        now: 2,
        session: () => "s-1",
      }),
    ).toBe(true);
    expect((await getWorkItem(db, "eng-1"))?.state).toBe("awaiting_input");
    expect((await findOpenQuestion(db, "s-1"))?.id).toBe(open.question.id);
    const [queuedHelp] = await db.run((q) =>
      q.all(
        q.orm
          .select({ id: q.t.question.id })
          .from(q.t.question)
          .where(eq(q.t.question.itemId, "eng-1")),
      ),
    );
    expect(await getQuestion(db, queuedHelp!.id)).toMatchObject({
      kind: "ci-help",
      status: "queued",
    });
  });

  test("asking again while a question is open, or without a session, asks nothing", async () => {
    const db = await queued();
    expect(
      await askMergeHelp(db, {
        ask,
        itemId: "eng-1",
        body: "x",
        now: 2,
        session: () => null,
      }),
    ).toBe(false);
    expect(
      await askMergeHelp(db, {
        ask,
        itemId: "eng-1",
        body: "x",
        now: 2,
        session: () => "s-1",
      }),
    ).toBe(true);
    expect(
      await askMergeHelp(db, {
        ask,
        itemId: "eng-1",
        body: "y",
        now: 3,
        session: () => "s-1",
      }),
    ).toBe(false);
  });
});

const ask: typeof askSteps = function* (q, asker, ...args) {
  const result = yield* askSteps(q, asker, ...args);
  if (
    ["running", "verifying", "recovering", "merge_queue"].includes(
      (yield* getWorkItemSteps(q, asker.itemId))?.state ?? "",
    )
  )
    yield* applyWorkItemEventSteps(q, asker.itemId, "blocking_question");
  return result;
};
