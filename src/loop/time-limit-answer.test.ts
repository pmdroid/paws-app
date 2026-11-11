import { ask } from "./operations";
import { expect, test } from "bun:test";
import { FakeClock, JOB_KIND } from "../core";
import {
  accrueAwake,
  applyWorkItemEvent,
  beginImplementRun,
  claimNextJob,
  enqueueJob,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  listOutbox,
  markCloseoutAccepted,
  migrate,
  openDatabase,
  saveCheckpoint,
  sqliteDb,
} from "../db";
import { answerSteps } from "../questions";
import { questionEffects } from "./question-effects";

const MINUTE = 60_000;

async function askedAtTimeLimit(pendingHandoff?: string) {
  const clock = new FakeClock(20_000);
  const db = openDatabase(":memory:");
  migrate(db);
  const item = insertQueuedItem(db, {
    id: "eng-7",
    sessionKey: "ses",
    limits: { fixes: 30 * MINUTE },
    now: clock.now(),
  });
  beginImplementRun(db, item.id, clock.now());
  applyWorkItemEvent(db, item.id, "turn_ended");
  applyWorkItemEvent(db, item.id, "closeout_accepted");
  await markCloseoutAccepted(sqliteDb(db), item.id, "accepted");
  applyWorkItemEvent(db, item.id, "restart", { kind: "restart", reason: "review" });
  applyWorkItemEvent(db, item.id, "dispatched");
  saveCheckpoint(db, item.id, { phase: "running", baseSha: "base", wipCommit: "accepted" });
  if (pendingHandoff !== undefined)
    enqueueJob(db, {
      queue: "run.resume",
      payload: { itemId: item.id, reason: "review", handoff: pendingHandoff },
      now: clock.now(),
    });
  await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now(), undefined, true);
  clock.advance(31 * MINUTE);
  expect(
    (await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now(), undefined, true)).asked,
  ).toBe(true);
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

async function askedBeforeAcceptance(state: "running" | "verifying") {
  const clock = new FakeClock(20_000);
  const db = openDatabase(":memory:");
  migrate(db);
  const item = insertQueuedItem(db, {
    id: "eng-8",
    sessionKey: "ses",
    maxAwakeMs: 30 * MINUTE,
    limits: { closeout: 30 * MINUTE },
    now: clock.now(),
  });
  beginImplementRun(db, item.id, clock.now());
  saveCheckpoint(db, item.id, { phase: state, baseSha: "base", wipCommit: "head" });
  const queue = state === "verifying" ? JOB_KIND.reverify : JOB_KIND.resume;
  if (state === "verifying") applyWorkItemEvent(db, item.id, "turn_ended");
  enqueueJob(db, { queue, payload: { itemId: item.id }, now: clock.now() });
  claimNextJob(db, { now: clock.now(), leaseMs: 24 * 60 * MINUTE, queues: [queue] });
  await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now());
  clock.advance(31 * MINUTE);
  expect(await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now())).toMatchObject({
    capped: false,
    asked: true,
    stopAgent: true,
    item: { state },
  });
  expect(listJobs(db).find((job) => job.queue === queue)).toMatchObject({
    status: "cancelled",
    lastError: "time_limit",
  });
  const request = listJobs(db).find((job) => job.queue === "item.ask")!.payload as {
    body: string;
    options: string[];
    reason: string;
  };
  ask(
    db,
    { itemId: item.id, runId: getWorkItem(db, item.id)!.currentRunId, sessionId: "ses" },
    "time-limit",
    request.body,
    { options: request.options, reason: request.reason, now: clock.now() },
  );
  return { clock, db, item };
}

async function reply(
  db: Awaited<ReturnType<typeof askedAtTimeLimit>>["db"],
  body: string,
  now: number,
  asking?: (runId: string) => boolean,
) {
  return await sqliteDb(db).transaction((q) =>
    answerSteps(
      q,
      { sessionId: "ses", deliveryId: `reply:${body}`, body, answeredBy: "pascal", now },
      questionEffects(db, { now, ...(asking ? { asking } : {}) }),
    ),
  );
}

test("Continue at the time limit starts a fresh budget and resumes it", async () => {
  const { clock, db, item } = await askedAtTimeLimit();
  expect((await reply(db, "Continue", clock.now())).status).toBe("answered");
  expect(getWorkItem(db, item.id)).toMatchObject({
    state: "queued",
    fixMs: 0,
    maxAwakeMs: 3 * 60 * MINUTE,
  });
  const fresh = listOutbox(db).filter((row) => row.idempotencyKey.startsWith("fresh-budget:"));
  expect(fresh.map((row) => row.payload)).toEqual([
    {
      sessionId: "ses",
      kind: "thought",
      body: "Starting on your request with a fresh 30-minute fixes time limit.",
    },
  ]);
  expect(listJobs(db).find((job) => job.queue === "run.resume")?.payload).toMatchObject({
    itemId: item.id,
    reason: "answer",
  });
  await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now());
  clock.advance(170 * MINUTE);
  expect(await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now())).toMatchObject({
    capped: false,
    item: { state: "queued" },
  });
});

test("Continue hands over a review the time limit cut off before the agent started it", async () => {
  const review = "@reviewer requested changes on pull request #12.\n\nRename the flag.";
  const { clock, db, item } = await askedAtTimeLimit(review);
  const question = db.query<{ body: string }, []>("SELECT body FROM question").get()!;
  expect(question.body).toContain("The agent had not started on the latest feedback yet");
  expect((await reply(db, "Continue", clock.now())).status).toBe("answered");
  const resumes = listJobs(db).filter((job) => job.queue === "run.resume");
  expect(resumes.map((job) => job.status)).toEqual(["cancelled", "pending"]);
  const handoff = (resumes[1]!.payload as { handoff: string }).handoff;
  expect(handoff.startsWith(review)).toBe(true);
  expect(handoff).toContain("Answer: Continue");
  expect(getWorkItem(db, item.id)?.state).toBe("queued");
});

test("Stop at the time limit ends the task and names the accepted branch", async () => {
  const { clock, db, item } = await askedAtTimeLimit();
  expect((await reply(db, "Stop", clock.now())).status).toBe("answered");
  expect(getWorkItem(db, item.id)?.state).toBe("failed");
  expect(listJobs(db).some((job) => job.queue === "run.resume")).toBe(false);
  expect(listOutbox(db).at(-1)?.payload).toMatchObject({
    kind: "error",
    body: expect.stringMatching(
      /^Stopped at the time limit, as asked in Linear\. The accepted work is on branch `.+`\.$/,
    ),
  });
});

test("Continue while the stopped run is still finishing queues one fenced restart", async () => {
  const { clock, db, item } = await askedAtTimeLimit();
  const runId = getWorkItem(db, item.id)!.currentRunId!;
  expect((await reply(db, "Continue", clock.now(), (id) => id === runId)).status).toBe("answered");
  expect(getWorkItem(db, item.id)).toMatchObject({
    state: "queued",
    fixMs: 0,
    maxAwakeMs: 3 * 60 * MINUTE,
  });
  expect(listJobs(db).some((job) => job.queue === "run.resume")).toBe(true);
});

test("the time-limit question for accepted work offers Merge, Continue and Stop", async () => {
  const { db } = await askedAtTimeLimit();
  const question = db
    .query<{ body: string; options: string }, []>(
      "SELECT body, options FROM question WHERE kind = 'time-limit'",
    )
    .get()!;
  expect(JSON.parse(question.options)).toEqual(["Merge the accepted work", "Continue", "Stop"]);
  expect(question.body).toContain("Stop ends the task without merging");
  expect(question.body).toContain("its pull request is not closed");
  expect(question.body).toContain("Continue starts the agent on a fresh fixes limit");
});

test("Merge the accepted work at the time limit goes to the merge queue without a turn", async () => {
  const { clock, db, item } = await askedAtTimeLimit();
  expect((await reply(db, "Merge the accepted work", clock.now())).status).toBe("answered");
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

test("Continue with new instructions at the time limit starts a fresh budget", async () => {
  const { clock, db, item } = await askedAtTimeLimit();
  expect((await reply(db, "Continue, but fix the acme lint first", clock.now())).status).toBe(
    "answered",
  );
  expect(getWorkItem(db, item.id)).toMatchObject({ fixMs: 0, maxAwakeMs: 3 * 60 * MINUTE });
  expect(listOutbox(db).some((row) => row.idempotencyKey.startsWith("fresh-budget:"))).toBe(true);
});

for (const state of ["running", "verifying"] as const) {
  test(`a ${state} item without an accepted head asks Continue or Stop at the time limit`, async () => {
    const { db, item } = await askedBeforeAcceptance(state);
    expect(getWorkItem(db, item.id)).toMatchObject({
      state: "awaiting_input",
      cancelRequested: false,
    });
    const question = db
      .query<{ body: string; options: string }, []>(
        "SELECT body, options FROM question WHERE kind = 'time-limit'",
      )
      .get()!;
    expect(JSON.parse(question.options)).toEqual(["Continue", "Stop"]);
    expect(question.body).toStartWith(
      `${state === "running" ? "Implementation" : "Closeout"} reached its 30 min limit; continue or stop?`,
    );
    expect(question.body).not.toContain("accepted");
    expect(listOutbox(db).some((row) => (row.payload as { kind?: string }).kind === "error")).toBe(
      false,
    );
  });
}

test("Continue after the time limit stopped Closeout checks the same head again with a fresh budget", async () => {
  const { clock, db, item } = await askedBeforeAcceptance("verifying");
  expect((await reply(db, "Continue", clock.now())).status).toBe("answered");
  expect(getWorkItem(db, item.id)).toMatchObject({
    state: "verifying",
    closeoutMs: 0,
    maxAwakeMs: 3 * 60 * MINUTE,
    checkpoint: { phase: "verifying", wipCommit: "head" },
  });
  expect(
    listJobs(db)
      .filter((job) => job.queue.startsWith("run.") || job.queue === "item.start")
      .map((job) => [job.queue, job.status]),
  ).toEqual([
    ["run.reverify", "cancelled"],
    ["run.reverify", "pending"],
  ]);
});

test("Continue after the time limit stopped an agent without an accepted head resumes it", async () => {
  const { clock, db, item } = await askedBeforeAcceptance("running");
  expect((await reply(db, "Continue", clock.now())).status).toBe("answered");
  expect(getWorkItem(db, item.id)).toMatchObject({
    state: "queued",
    implementMs: 0,
    maxAwakeMs: 3 * 60 * MINUTE,
  });
  expect(
    listJobs(db).find((job) => job.queue === "run.resume" && job.status === "pending"),
  ).toMatchObject({ payload: { reason: "answer" } });
});

test("Stop at the time limit without an accepted head names the branch with the work", async () => {
  const { clock, db, item } = await askedBeforeAcceptance("verifying");
  expect((await reply(db, "Stop", clock.now())).status).toBe("answered");
  expect(getWorkItem(db, item.id)?.state).toBe("failed");
  expect(listOutbox(db).at(-1)?.payload).toMatchObject({
    kind: "error",
    body: expect.stringMatching(
      /^Stopped at the time limit, as asked in Linear\. The work is on branch `.+`\.$/,
    ),
  });
});
