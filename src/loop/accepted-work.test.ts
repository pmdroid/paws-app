import { expect, test } from "bun:test";
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
  migrate,
  openDatabase,
  restart,
  saveCheckpoint,
} from "../db";
import { acceptedResumeNeedsTurn, mergeAcceptedWork, settleRejectedPush } from "./accepted-work";

const ACCEPTED = "672c580b";

/** An item Closeout accepted at ACCEPTED, sent back to the agent from the merge queue. */
function acceptedItem() {
  const db = openDatabase(":memory:");
  migrate(db);
  const item = insertQueuedItem(db, { id: "pas-814", sessionKey: "ses", now: 1_000 });
  const { run } = beginImplementRun(db, item.id, 1_000);
  applyWorkItemEvent(db, item.id, "turn_ended");
  applyWorkItemEvent(db, item.id, "closeout_accepted");
  markCloseoutAccepted(db, item.id, ACCEPTED);
  saveCheckpoint(db, item.id, { phase: "merge_queue", baseSha: "base", wipCommit: ACCEPTED });
  applyWorkItemEvent(db, item.id, "ejected");
  return { db, itemId: item.id, runId: run.id };
}

function implementTurns(db: ReturnType<typeof acceptedItem>["db"]) {
  return listJobs(db).filter(
    (job) =>
      (job.queue === JOB_KIND.resume || job.queue === JOB_KIND.start) &&
      (job.status === "pending" || job.status === "running"),
  );
}

function mergeJobs(db: ReturnType<typeof acceptedItem>["db"]) {
  return listJobs(db).filter((job) => job.queue === JOB_KIND.merge && job.status === "pending");
}

test("an accepted head that is the pull request head goes to the merge queue without an implement turn", () => {
  const { db, itemId, runId } = acceptedItem();
  const resume = enqueueJob(db, {
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

  expect(mergeAcceptedWork(db, itemId, { now: 3_000 })).toBe(true);

  const item = getWorkItem(db, itemId)!;
  expect(item).toMatchObject({ state: "merge_queue", currentRunId: runId });
  expect(item.checkpoint).toMatchObject({ phase: "merge_queue", wipCommit: ACCEPTED });
  expect(getRun(db, runId)?.status).toBe("ended");
  expect(listJobs(db).find((job) => job.id === resume)?.status).toBe("cancelled");
  expect(implementTurns(db)).toEqual([]);
  expect(mergeJobs(db).map((job) => job.payload)).toEqual([
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

test("a rejected push whose remote is the accepted head goes to the merge queue without a question", () => {
  const { db, itemId } = acceptedItem();
  expect(getWorkItem(db, itemId)?.state).toBe("running");

  expect(
    settleRejectedPush(db, itemId, { remoteHead: ACCEPTED, containsAccepted: true, now: 2_000 }),
  ).toBe(true);

  expect(getWorkItem(db, itemId)?.state).toBe("merge_queue");
  expect(db.query("SELECT * FROM question").all()).toEqual([]);
  expect(listJobs(db).some((job) => job.queue === "item.ask")).toBe(false);
  expect(mergeJobs(db).map((job) => (job.payload as { head: string }).head)).toEqual([ACCEPTED]);
});

test("a rejected push whose remote contains the accepted head goes to the merge queue", () => {
  const { db, itemId } = acceptedItem();
  expect(
    settleRejectedPush(db, itemId, { remoteHead: "ahead", containsAccepted: true, now: 2_000 }),
  ).toBe(true);
  expect(getWorkItem(db, itemId)?.state).toBe("merge_queue");
});

test("a rejected push whose remote diverged from the accepted head is left to conflict handling", () => {
  const { db, itemId } = acceptedItem();
  expect(
    settleRejectedPush(db, itemId, { remoteHead: "diverged", containsAccepted: false, now: 2_000 }),
  ).toBe(false);
  expect(
    settleRejectedPush(db, itemId, { remoteHead: null, containsAccepted: false, now: 2_000 }),
  ).toBe(false);
  expect(getWorkItem(db, itemId)?.state).toBe("running");
  expect(mergeJobs(db)).toEqual([]);
});

test("an item without accepted work is not sent to the merge queue", () => {
  const db = openDatabase(":memory:");
  migrate(db);
  insertQueuedItem(db, { id: "fresh", sessionKey: "ses", now: 1_000 });
  beginImplementRun(db, "fresh", 1_000);
  expect(mergeAcceptedWork(db, "fresh", { now: 2_000 })).toBe(false);
  expect(
    settleRejectedPush(db, "fresh", { remoteHead: ACCEPTED, containsAccepted: true, now: 2_000 }),
  ).toBe(false);
  expect(getWorkItem(db, "fresh")?.state).toBe("running");
});

test("an accepted item queued again by a restart leaves that restart for the merge queue", () => {
  const { db, itemId } = acceptedItem();
  const item = getWorkItem(db, itemId)!;
  const job = restart(db, item, { reason: "follow_up", body: "go on", now: 2_000 })!;
  expect(getWorkItem(db, itemId)?.state).toBe("queued");
  expect(mergeAcceptedWork(db, itemId, { now: 3_000, exceptJobId: job })).toBe(true);
  expect(getWorkItem(db, itemId)?.state).toBe("merge_queue");
  expect(listJobs(db).find((entry) => entry.id === job)?.status).toBe("pending");
});

for (const reason of ["ci", "review"] as const) {
  test(`a rejected push of a turn carrying ${reason} input goes to the question, not the merge queue`, () => {
    const { db, itemId } = acceptedItem();
    const job = restart(db, getWorkItem(db, itemId)!, {
      reason,
      body: `fix ${reason}`,
      now: 2_000,
    })!;
    beginImplementRun(db, itemId, 2_500);
    db.run("UPDATE job SET status = 'running' WHERE id = ?", [job]);
    expect(
      settleRejectedPush(db, itemId, { remoteHead: ACCEPTED, containsAccepted: true, now: 3_000 }),
    ).toBe(false);
    expect(getWorkItem(db, itemId)?.state).toBe("running");
    expect(mergeJobs(db)).toEqual([]);
  });
}

for (const decision of ["rejected", "blocked"] as const) {
  test(`accepted work whose latest Closeout run on that head is ${decision} is not merged`, () => {
    const { db, itemId } = acceptedItem();
    const identity = {
      taskId: itemId,
      base: "base",
      head: ACCEPTED,
      policyDigest: "p",
      policyPath: null,
    };
    finishCloseoutProgress(db, itemId, identity, "accepted", 1_500);
    finishCloseoutProgress(db, itemId, { ...identity, base: "newer" }, decision, 1_600);
    // A database written before rejection retired accepted_head can still carry it.
    markCloseoutAccepted(db, itemId, ACCEPTED);
    expect(mergeAcceptedWork(db, itemId, { now: 2_000 })).toBe(false);
    expect(mergeJobs(db)).toEqual([]);
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
