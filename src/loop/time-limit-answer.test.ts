import { ask } from "./operations";
import { expect, test } from "bun:test";
import { FakeClock } from "../core";
import {
  accrueAwake,
  applyWorkItemEvent,
  beginImplementRun,
  enqueueJob,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  listOutbox,
  markCloseoutAccepted,
  migrate,
  openDatabase,
  saveCheckpoint,
} from "../db";
import { answer } from "../questions";
import { questionEffects } from "./question-effects";

const MINUTE = 60_000;

function askedAtTimeLimit(pendingHandoff?: string) {
  const clock = new FakeClock(20_000);
  const db = openDatabase(":memory:");
  migrate(db);
  const item = insertQueuedItem(db, {
    id: "eng-7",
    sessionKey: "ses",
    maxAwakeMs: 30 * MINUTE,
    now: clock.now(),
  });
  beginImplementRun(db, item.id, clock.now());
  applyWorkItemEvent(db, item.id, "turn_ended", { now: clock.now() });
  applyWorkItemEvent(db, item.id, "closeout_accepted", { now: clock.now() });
  markCloseoutAccepted(db, item.id, "accepted");
  applyWorkItemEvent(db, item.id, "ejected", { now: clock.now() });
  saveCheckpoint(db, item.id, { phase: "running", baseSha: "base", wipCommit: "accepted" });
  clock.advance(1);
  if (pendingHandoff !== undefined)
    enqueueJob(db, {
      queue: "run.resume",
      payload: { itemId: item.id, reason: "review", handoff: pendingHandoff },
      now: clock.now(),
    });
  accrueAwake(db, item.id, clock.mono(), clock.now());
  clock.advance(31 * MINUTE);
  expect(accrueAwake(db, item.id, clock.mono(), clock.now()).asked).toBe(true);
  const request = listJobs(db).find((job) => job.queue === "item.ask")!.payload as {
    body: string;
    options: string[];
  };
  ask(
    db,
    { itemId: item.id, runId: getWorkItem(db, item.id)!.currentRunId, sessionId: "ses" },
    "time-limit",
    request.body,
    { options: request.options, now: clock.now() },
  );
  return { clock, db, item };
}

function reply(
  db: ReturnType<typeof askedAtTimeLimit>["db"],
  body: string,
  now: number,
  asking?: (runId: string) => boolean,
) {
  return answer(
    db,
    { sessionId: "ses", deliveryId: `reply:${body}`, body, answeredBy: "pascal", now },
    questionEffects(db, { now, ...(asking ? { asking } : {}) }),
  );
}

test("Continue at the time limit gives the agent another hour and resumes it", () => {
  const { clock, db, item } = askedAtTimeLimit();
  expect(reply(db, "Continue", clock.now()).status).toBe("answered");
  expect(getWorkItem(db, item.id)).toMatchObject({
    state: "queued",
    maxAwakeMs: 31 * MINUTE + 60 * MINUTE,
  });
  expect(listJobs(db).find((job) => job.queue === "run.resume")?.payload).toMatchObject({
    itemId: item.id,
    reason: "answer",
  });
  accrueAwake(db, item.id, clock.mono(), clock.now());
  clock.advance(30 * MINUTE);
  expect(accrueAwake(db, item.id, clock.mono(), clock.now())).toMatchObject({
    capped: false,
    item: { state: "queued" },
  });
});

test("Continue hands over a review the time limit cut off before the agent started it", () => {
  const review = "@reviewer requested changes on pull request #12.\n\nRename the flag.";
  const { clock, db, item } = askedAtTimeLimit(review);
  const question = db.query<{ body: string }, []>("SELECT body FROM question").get()!;
  expect(question.body).toContain("The agent had not started on the latest feedback yet");
  expect(reply(db, "Continue", clock.now()).status).toBe("answered");
  const resumes = listJobs(db).filter((job) => job.queue === "run.resume");
  expect(resumes.map((job) => job.status)).toEqual(["cancelled", "pending"]);
  const handoff = (resumes[1]!.payload as { handoff: string }).handoff;
  expect(handoff.startsWith(review)).toBe(true);
  expect(handoff).toContain("Answer: Continue");
  expect(getWorkItem(db, item.id)?.state).toBe("queued");
});

test("Stop at the time limit ends the task and names the accepted branch", () => {
  const { clock, db, item } = askedAtTimeLimit();
  expect(reply(db, "Stop", clock.now()).status).toBe("answered");
  expect(getWorkItem(db, item.id)?.state).toBe("failed");
  expect(listJobs(db).some((job) => job.queue === "run.resume")).toBe(false);
  expect(listOutbox(db).at(-1)?.payload).toMatchObject({
    kind: "error",
    body: expect.stringMatching(
      /^Stopped at the time limit, as asked in Linear\. The accepted work is on branch `.+`\.$/,
    ),
  });
});

test("Continue while the stopped run is still finishing queues one fenced restart", () => {
  const { clock, db, item } = askedAtTimeLimit();
  const runId = getWorkItem(db, item.id)!.currentRunId!;
  expect(reply(db, "Continue", clock.now(), (id) => id === runId).status).toBe("answered");
  expect(getWorkItem(db, item.id)).toMatchObject({
    state: "queued",
    maxAwakeMs: 31 * MINUTE + 60 * MINUTE,
  });
  expect(listJobs(db).some((job) => job.queue === "run.resume")).toBe(true);
});

test("the time-limit question for accepted work offers Merge, Continue and Stop", () => {
  const { db } = askedAtTimeLimit();
  const question = db
    .query<{ body: string; options: string }, []>(
      "SELECT body, options FROM question WHERE kind = 'time-limit'",
    )
    .get()!;
  expect(JSON.parse(question.options)).toEqual(["Merge the accepted work", "Continue", "Stop"]);
  expect(question.body).toContain("Stop ends the task without merging");
  expect(question.body).toContain("its pull request is not closed");
});

test("Merge the accepted work at the time limit goes to the merge queue without a turn", () => {
  const { clock, db, item } = askedAtTimeLimit();
  expect(reply(db, "Merge the accepted work", clock.now()).status).toBe("answered");
  expect(getWorkItem(db, item.id)).toMatchObject({ state: "merge_queue" });
  expect(getWorkItem(db, item.id)?.checkpoint).toMatchObject({
    phase: "merge_queue",
    wipCommit: "accepted",
  });
  expect(listJobs(db).some((job) => job.queue === "run.resume" && job.status === "pending")).toBe(
    false,
  );
  expect(
    listJobs(db)
      .filter((job) => job.queue === "github.merge")
      .map((job) => job.payload),
  ).toEqual([{ itemId: item.id, summary: "Closeout accepted.", head: "accepted" }]);
});
