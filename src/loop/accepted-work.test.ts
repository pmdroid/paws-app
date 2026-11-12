import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { JOB_KIND } from "../core";
import {
  applyWorkItemEvent,
  beginImplementRun,
  enqueueJob,
  finishCloseoutProgress,
  getRun,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  markCloseoutAccepted,
  restart,
  saveCheckpoint,
} from "../db";
import { acceptedResumeNeedsTurn, mergeAcceptedWork, settleRejectedPush } from "./accepted-work";
import { seed } from "../../test/dialects";
import { tempStore } from "../../test/pglite";

const ACCEPTED = "672c580b";

/** An item Closeout accepted at ACCEPTED, sent back to the agent from the merge queue. */
async function acceptedItem() {
  const db = (await tempStore()).db;
  const item = await insertQueuedItem(db, { id: "pas-814", sessionKey: "ses", now: 1_000 });
  const { run } = await beginImplementRun(db, item.id, 1_000);
  await applyWorkItemEvent(db, item.id, "turn_ended");
  await applyWorkItemEvent(db, item.id, "closeout_accepted");
  await markCloseoutAccepted(db, item.id, ACCEPTED);
  await saveCheckpoint(db, item.id, {
    phase: "merge_queue",
    baseSha: "base",
    wipCommit: ACCEPTED,
  });
  await applyWorkItemEvent(db, item.id, "restart", { kind: "restart", reason: "review" });
  await applyWorkItemEvent(db, item.id, "dispatched");
  return { db, itemId: item.id, runId: run.id };
}

async function implementTurns(db: Awaited<ReturnType<typeof acceptedItem>>["db"]) {
  return (await listJobs(db)).filter(
    (job) =>
      (job.queue === JOB_KIND.resume || job.queue === JOB_KIND.start) &&
      (job.status === "pending" || job.status === "running"),
  );
}

async function mergeJobs(db: Awaited<ReturnType<typeof acceptedItem>>["db"]) {
  return (await listJobs(db)).filter(
    (job) => job.queue === JOB_KIND.merge && job.status === "pending",
  );
}

test("an accepted head that is the pull request head goes to the merge queue without an implement turn", async () => {
  const { db, itemId, runId } = await acceptedItem();
  const resume = await enqueueJob(db, {
    queue: JOB_KIND.resume,
    payload: { itemId, reason: "transient_failure" },
    now: 2_000,
  });
  expect(
    acceptedResumeNeedsTurn({
      acceptedHead: ACCEPTED,
      pullHead: ACCEPTED,
      reason: "transient_failure",
    }),
  ).toBe(false);

  expect(await mergeAcceptedWork(db, itemId, { now: 3_000 })).toBe(true);

  const item = (await getWorkItem(db, itemId))!;
  expect(item).toMatchObject({ state: "merge_queue", currentRunId: runId });
  expect(item.checkpoint).toMatchObject({ phase: "merge_queue", wipCommit: ACCEPTED });
  expect((await getRun(db, runId))?.status).toBe("ended");
  expect((await listJobs(db)).find((job) => job.id === resume)?.status).toBe("cancelled");
  expect(await implementTurns(db)).toEqual([]);
  expect((await mergeJobs(db)).map((job) => job.payload)).toEqual([
    { itemId, summary: "Closeout accepted.", head: ACCEPTED },
  ]);
});

test("new input or a different pull request head still gets an implement turn", () => {
  for (const reason of ["answer", "ci", "review", "conflict", "findings", "follow_up"])
    expect(acceptedResumeNeedsTurn({ acceptedHead: ACCEPTED, pullHead: ACCEPTED, reason })).toBe(
      true,
    );
  expect(acceptedResumeNeedsTurn({ acceptedHead: ACCEPTED, pullHead: "other", reason: null })).toBe(
    true,
  );
  expect(acceptedResumeNeedsTurn({ acceptedHead: ACCEPTED, pullHead: null, reason: null })).toBe(
    true,
  );
  expect(acceptedResumeNeedsTurn({ acceptedHead: null, pullHead: ACCEPTED, reason: null })).toBe(
    true,
  );
  expect(
    acceptedResumeNeedsTurn({ acceptedHead: ACCEPTED, pullHead: ACCEPTED, reason: null }),
  ).toBe(false);
});

test("a rejected push whose remote is the accepted head goes to the merge queue without a question", async () => {
  const { db, itemId } = await acceptedItem();
  expect((await getWorkItem(db, itemId))?.state).toBe("running");

  expect(
    await settleRejectedPush(db, itemId, {
      remoteHead: ACCEPTED,
      containsAccepted: true,
      now: 2_000,
    }),
  ).toBe(true);

  expect((await getWorkItem(db, itemId))?.state).toBe("merge_queue");
  expect(await db.run((q) => q.all(q.orm.select().from(q.t.question)))).toEqual([]);
  expect((await listJobs(db)).some((job) => job.queue === "item.ask")).toBe(false);
  expect((await mergeJobs(db)).map((job) => (job.payload as { head: string }).head)).toEqual([
    ACCEPTED,
  ]);
});

test("a rejected push whose remote contains the accepted head goes to the merge queue", async () => {
  const { db, itemId } = await acceptedItem();
  expect(
    await settleRejectedPush(db, itemId, {
      remoteHead: "ahead",
      containsAccepted: true,
      now: 2_000,
    }),
  ).toBe(true);
  expect((await getWorkItem(db, itemId))?.state).toBe("merge_queue");
});

test("a rejected push whose remote diverged from the accepted head is left to conflict handling", async () => {
  const { db, itemId } = await acceptedItem();
  expect(
    await settleRejectedPush(db, itemId, {
      remoteHead: "diverged",
      containsAccepted: false,
      now: 2_000,
    }),
  ).toBe(false);
  expect(
    await settleRejectedPush(db, itemId, {
      remoteHead: null,
      containsAccepted: false,
      now: 2_000,
    }),
  ).toBe(false);
  expect((await getWorkItem(db, itemId))?.state).toBe("running");
  expect(await mergeJobs(db)).toEqual([]);
});

test("an item without accepted work is not sent to the merge queue", async () => {
  const db = (await tempStore()).db;
  await insertQueuedItem(db, { id: "fresh", sessionKey: "ses", now: 1_000 });
  await beginImplementRun(db, "fresh", 1_000);
  expect(await mergeAcceptedWork(db, "fresh", { now: 2_000 })).toBe(false);
  expect(
    await settleRejectedPush(db, "fresh", {
      remoteHead: ACCEPTED,
      containsAccepted: true,
      now: 2_000,
    }),
  ).toBe(false);
  expect((await getWorkItem(db, "fresh"))?.state).toBe("running");
});

test("an accepted item queued again by a restart leaves that restart for the merge queue", async () => {
  const { db, itemId } = await acceptedItem();
  const item = (await getWorkItem(db, itemId))!;
  const job = (await restart(db, item, {
    reason: "follow_up",
    body: "go on",
    now: 2_000,
  }))!;
  expect((await getWorkItem(db, itemId))?.state).toBe("queued");
  expect(await mergeAcceptedWork(db, itemId, { now: 3_000, exceptJobId: job })).toBe(true);
  expect((await getWorkItem(db, itemId))?.state).toBe("merge_queue");
  expect((await listJobs(db)).find((entry) => entry.id === job)?.status).toBe("pending");
});

for (const reason of ["ci", "review"] as const) {
  test(`a rejected push of a turn carrying ${reason} input goes to the question, not the merge queue`, async () => {
    const { db, itemId } = await acceptedItem();
    const job = (await restart(db, (await getWorkItem(db, itemId))!, {
      reason,
      body: `fix ${reason}`,
      now: 2_000,
    }))!;
    await beginImplementRun(db, itemId, 2_500);
    await seed(db, (q) =>
      q.orm.update(q.t.job).set({ status: "running" }).where(eq(q.t.job.id, job)),
    );
    expect(
      await settleRejectedPush(db, itemId, {
        remoteHead: ACCEPTED,
        containsAccepted: true,
        now: 3_000,
      }),
    ).toBe(false);
    expect((await getWorkItem(db, itemId))?.state).toBe("running");
    expect(await mergeJobs(db)).toEqual([]);
  });
}

for (const decision of ["rejected", "blocked"] as const) {
  test(`accepted work whose latest Closeout run on that head is ${decision} is not merged`, async () => {
    const { db, itemId } = await acceptedItem();
    const identity = {
      taskId: itemId,
      base: "base",
      head: ACCEPTED,
      policyDigest: "p",
      policyPath: null,
    };
    await finishCloseoutProgress(db, itemId, identity, "accepted", 1_500);
    await finishCloseoutProgress(db, itemId, { ...identity, base: "newer" }, decision, 1_600);
    // A database written before rejection retired accepted_head can still carry it.
    await markCloseoutAccepted(db, itemId, ACCEPTED);
    expect(await mergeAcceptedWork(db, itemId, { now: 2_000 })).toBe(false);
    expect(await mergeJobs(db)).toEqual([]);
  });
}

test("a deferred handoff still needs a turn when its reason became transient", () => {
  expect(
    acceptedResumeNeedsTurn({
      acceptedHead: ACCEPTED,
      pullHead: ACCEPTED,
      reason: "transient_failure",
      handoff: "Fix the Closeout findings",
    }),
  ).toBe(true);
});
