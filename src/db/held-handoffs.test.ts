import { expect, test } from "bun:test";
import { JOB_KIND } from "../core";
import {
  applyWorkItemEvent,
  beginImplementRun,
  claimNextJob,
  failWorkItem,
  getWorkItem,
  heldHandoffs,
  insertQueuedItem,
  listJobs,
  migrate,
  openDatabase,
  restart,
} from "./index";

const REVIEW = "@reviewer requested changes on pull request #12.\n\nRename the flag.";

function running() {
  const db = openDatabase(":memory:");
  migrate(db);
  insertQueuedItem(db, { id: "eng-1", sessionKey: "ses", now: 1_000 });
  beginImplementRun(db, "eng-1", 1_000);
  return db;
}

/** The review restart is dispatched and its resume claimed, as a runner picks it up. */
function reviewClaimed(db: ReturnType<typeof running>, now: number) {
  restart(db, getWorkItem(db, "eng-1")!, { reason: "review", body: REVIEW, now });
  applyWorkItemEvent(db, "eng-1", "dispatched", { now });
  return claimNextJob(db, { now, leaseMs: 60_000, queues: [JOB_KIND.resume] })!;
}

function resumes(db: ReturnType<typeof running>) {
  return listJobs(db)
    .filter((job) => job.queue === JOB_KIND.resume)
    .map((job) => ({ status: job.status, handoff: (job.payload as { handoff: string }).handoff }));
}

test("a review whose run failed before the agent started reaches the agent with the retry", () => {
  const db = running();
  reviewClaimed(db, 2_000);
  // The runner is too old for the skill hooks: the run fails before the agent takes a turn.
  failWorkItem(db, getWorkItem(db, "eng-1")!, "run_error", "Runner needs 0.1.53.", 3_000);
  expect(getWorkItem(db, "eng-1")?.state).toBe("failed");

  restart(db, getWorkItem(db, "eng-1")!, { reason: "follow_up", body: "retry", now: 4_000 });
  expect(resumes(db)).toEqual([
    { status: "cancelled", handoff: REVIEW },
    { status: "pending", handoff: `${REVIEW}\n\nretry` },
  ]);
  expect(heldHandoffs(db, "eng-1")).toEqual([]);
});

test("a carried handoff is not handed over a second time on its own", () => {
  const db = running();
  reviewClaimed(db, 2_000);
  failWorkItem(db, getWorkItem(db, "eng-1")!, "run_error", "Runner needs 0.1.53.", 3_000);
  restart(db, getWorkItem(db, "eng-1")!, { reason: "follow_up", body: "retry", now: 4_000 });
  // No runner claimed the retry either, so it carries the review on with it.
  restart(db, getWorkItem(db, "eng-1")!, { reason: "follow_up", body: "again", now: 5_000 });
  expect(resumes(db).at(-1)).toEqual({
    status: "pending",
    handoff: `${REVIEW}\n\nretry\n\nagain`,
  });
});

test("a handoff the agent finished a turn on is not handed over again", () => {
  const db = running();
  reviewClaimed(db, 2_000);
  applyWorkItemEvent(db, "eng-1", "turn_ended", { now: 3_000 });
  failWorkItem(db, getWorkItem(db, "eng-1")!, "run_error", "The run failed.", 4_000);
  restart(db, getWorkItem(db, "eng-1")!, { reason: "follow_up", body: "retry", now: 5_000 });
  expect(resumes(db).at(-1)).toEqual({ status: "pending", handoff: "retry" });
});

test("a running resume that a new restart replaces is not handed over again", () => {
  const db = running();
  reviewClaimed(db, 2_000);
  // A person's follow-up while the agent works on the review halts that run.
  restart(db, getWorkItem(db, "eng-1")!, { reason: "follow_up", body: "Also fix X.", now: 3_000 });
  expect(resumes(db)).toEqual([
    { status: "cancelled", handoff: REVIEW },
    { status: "pending", handoff: "Also fix X." },
  ]);
});

test("a queued resume that a new restart replaces before any runner claimed it is kept", () => {
  const db = running();
  restart(db, getWorkItem(db, "eng-1")!, { reason: "review", body: REVIEW, now: 2_000 });
  restart(db, getWorkItem(db, "eng-1")!, { reason: "follow_up", body: "Also fix X.", now: 3_000 });
  expect(resumes(db).at(-1)).toEqual({ status: "pending", handoff: `${REVIEW}\n\nAlso fix X.` });
});
