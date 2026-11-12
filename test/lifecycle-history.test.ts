import { afterEach, expect, test } from "bun:test";
import { FakeClock } from "../src/core";
import {
  accrueAwake,
  applyWorkItemEvent,
  beginImplementRun,
  enterMergeQueue,
  failWorkItem,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  listWorkItemEventRows,
  markCloseoutAccepted,
  restartedFromMergeQueue,
  saveCheckpoint,
  savePlanProposal,
  emitJobReady,
  saveTaskMode,
  type Db,
} from "../src/db";
import { askSteps, questionEffects, restart } from "../src/loop";
import { answerSteps, type AnswerEffects, type QuestionReply } from "../src/questions";
import { parseIssueListResponse } from "../src/dashboard";
import { createLiveStatusProvider } from "../src/dashboard/src/live/provider";
import { tempStore } from "./pglite";

const MINUTE = 60_000;
const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

const loopAsk = (
  db: Db,
  ...args: Parameters<typeof askSteps> extends [unknown, ...infer R] ? R : never
) => db.transaction((q) => askSteps(q, ...args));

async function answer(db: Db, message: QuestionReply, effects: AnswerEffects = {}) {
  const outcome = await db.transaction((q) => answerSteps(q, message, effects));
  emitJobReady(db);
  return outcome;
}

async function database() {
  const { db, close } = await tempStore();
  open.push(close);
  return db;
}

async function history(db: Db, itemId: string, fromVersion = 0): Promise<string[]> {
  return (await listWorkItemEventRows(db, itemId))
    .filter((row) => row.version > fromVersion)
    .map((row) => `${row.fromState} -${row.event}-> ${row.toState}`);
}

async function reply(db: Db, body: string, now: number) {
  return await answer(
    db,
    { sessionId: "ses", deliveryId: `reply:${body}:${now}`, body, answeredBy: "pascal", now },
    questionEffects(db, { now }),
  );
}

async function askedAtTimeLimit() {
  const clock = new FakeClock(Date.now());
  const db = await database();
  const item = await insertQueuedItem(db, {
    id: "eng-7",
    sessionKey: "ses",
    limits: { fixes: 30 * MINUTE },
    now: clock.now(),
  });
  await beginImplementRun(db, item.id, clock.now());
  const now = clock.now();
  await applyWorkItemEvent(db, item.id, "turn_ended", { now });
  await applyWorkItemEvent(db, item.id, "closeout_accepted", { now });
  await markCloseoutAccepted(db, item.id, "accepted");
  await applyWorkItemEvent(db, item.id, "restart", {
    kind: "restart",
    reason: "review",
    now,
  });
  await applyWorkItemEvent(db, item.id, "dispatched", { now });
  await saveCheckpoint(db, item.id, {
    phase: "running",
    baseSha: "base",
    wipCommit: "accepted",
  });
  await accrueAwake(db, item.id, clock.mono(), clock.now(), undefined, true);
  clock.advance(31 * MINUTE);
  await accrueAwake(db, item.id, clock.mono(), clock.now(), undefined, true);
  const request = (await listJobs(db)).find((job) => job.queue === "item.ask")!.payload as {
    body: string;
    options: string[];
  };
  await loopAsk(
    db,
    {
      itemId: item.id,
      runId: (await getWorkItem(db, item.id))!.currentRunId,
      sessionId: "ses",
    },
    "time-limit",
    request.body,
    { options: request.options, now: clock.now() },
  );
  const asked = (await getWorkItem(db, item.id))!;
  expect(asked.state).toBe("awaiting_input");
  return { clock, db, itemId: item.id, askedAt: asked.version };
}

test("Merge at the time limit records one acceptance, no agent turn, and no running time", async () => {
  const { clock, db, itemId, askedAt } = await askedAtTimeLimit();
  clock.advance(10 * MINUTE);
  expect((await reply(db, "Merge the accepted work", clock.now())).status).toBe("answered");
  expect(await history(db, itemId, askedAt)).toEqual([
    "awaiting_input -closeout_accepted-> merge_queue",
  ]);

  clock.advance(5 * MINUTE);
  const provider = createLiveStatusProvider(db, {
    now: () => new Date(clock.now()),
    env: {},
  });
  const parsed = parseIssueListResponse(JSON.parse(JSON.stringify(await provider.issues())));
  if (!parsed.ok) throw new Error(parsed.error);
  const times = parsed.response.issues.find((entry) => entry.id === itemId)!.stateTimes!;
  expect(times.current).toBe("merge_queue");
  const ms = Object.fromEntries(times.states.map((entry) => [entry.state, entry.ms]));
  expect(ms.awaiting_input).toBe(10 * MINUTE);
  expect(ms.merge_queue).toBe(5 * MINUTE);

  await restart(db, (await getWorkItem(db, itemId))!, {
    reason: "ci",
    body: "CI failed",
    now: clock.now(),
  });
  expect(await restartedFromMergeQueue(db, itemId)).toBe(true);
});

test("Stop at the time limit records answer_stopped from the wait, not a run failure", async () => {
  const { clock, db, itemId, askedAt } = await askedAtTimeLimit();
  expect((await reply(db, "Stop", clock.now())).status).toBe("answered");
  expect(await history(db, itemId, askedAt)).toEqual(["awaiting_input -answer_stopped-> failed"]);
});

test("an answered runner wait re-verifies without passing through running", async () => {
  const db = await database();
  const item = await insertQueuedItem(db, { id: "eng-8", sessionKey: "ses", now: 1_000 });
  const { run } = await beginImplementRun(db, item.id, 1_000);
  await applyWorkItemEvent(db, item.id, "turn_ended");
  await loopAsk(
    db,
    { itemId: item.id, runId: run.id, sessionId: "ses" },
    "runner-wait",
    "The runner is paused. Keep waiting or move?",
    { options: ["Keep waiting", "Move"], now: 2_000 },
  );
  const askedAt = (await getWorkItem(db, item.id))!.version;
  expect((await reply(db, "Keep waiting", 3_000)).status).toBe("answered");
  expect(await history(db, item.id, askedAt)).toEqual([
    "awaiting_input -reverify_requested-> verifying",
  ]);
  expect((await listJobs(db)).some((job) => job.queue === "run.reverify")).toBe(true);
});

test("Discarding a plan completes it from the wait with one answer_completed", async () => {
  const db = await database();
  const item = await insertQueuedItem(db, { id: "eng-9", sessionKey: "ses", now: 1_000 });
  await saveTaskMode(db, item.id, "plan");
  const { run } = await beginImplementRun(db, item.id, 1_000);
  const asked = await loopAsk(
    db,
    { itemId: item.id, runId: run.id, sessionId: "ses" },
    "plan-approval",
    "File these sub-issues?",
    { options: ["Create", "Edit", "Discard"], now: 2_000 },
  );
  await savePlanProposal(db, {
    questionId: asked.question.id,
    itemId: item.id,
    parentIssueId: "issue-9",
    repository: null,
    drafts: [
      { title: "One", description: "Do one.", acceptanceCriteria: ["One is done."], blockedBy: [] },
    ],
    now: 2_000,
  });
  const askedAt = (await getWorkItem(db, item.id))!.version;
  expect((await reply(db, "Discard", 3_000)).status).toBe("answered");
  expect(await history(db, item.id, askedAt)).toEqual([
    "awaiting_input -answer_completed-> completed",
  ]);
});

test("a failure in the merge queue records work_failed, not a lease expiry", async () => {
  const db = await database();
  const item = await insertQueuedItem(db, { id: "eng-10", sessionKey: "ses", now: 1_000 });
  await beginImplementRun(db, item.id, 1_000);
  await enterMergeQueue(db, item.id, {
    phase: "merge_queue",
    baseSha: "base",
    wipCommit: "head",
  });
  const queued = (await getWorkItem(db, item.id))!;
  expect(await failWorkItem(db, queued, "merge_error", "The merge failed.", 2_000)).toBe(true);
  expect(await history(db, item.id, queued.version)).toEqual(["merge_queue -work_failed-> failed"]);
});
