import { ask } from "./operations";
import { expect, test } from "bun:test";
import { FakeClock } from "../core";
import {
  accrueAwake,
  applyWorkItemEvent,
  beginImplementRun,
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

function askedAtTimeLimit() {
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
  applyWorkItemEvent(db, item.id, "turn_ended");
  applyWorkItemEvent(db, item.id, "closeout_accepted");
  markCloseoutAccepted(db, item.id, "accepted");
  applyWorkItemEvent(db, item.id, "ejected");
  saveCheckpoint(db, item.id, { phase: "running", baseSha: "base", wipCommit: "accepted" });
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
