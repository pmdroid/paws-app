import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
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
  migrate,
  openDatabase,
  restartedFromMergeQueue,
  saveCheckpoint,
  savePlanProposal,
  saveTaskMode,
} from "../src/db";
import { ask, questionEffects, restart } from "../src/loop";
import { answer } from "../src/questions";
import { parseStatusSnapshot } from "../src/web/src/contract";
import { createLiveStatusProvider } from "../src/web/src/live/provider";

const MINUTE = 60_000;
const open: Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function database(): Database {
  const db = openDatabase(":memory:");
  migrate(db);
  open.push(db);
  return db;
}

function history(db: Database, itemId: string, fromVersion = 0): string[] {
  return listWorkItemEventRows(db, itemId)
    .filter((row) => row.version > fromVersion)
    .map((row) => `${row.fromState} -${row.event}-> ${row.toState}`);
}

function reply(db: Database, body: string, now: number) {
  return answer(
    db,
    { sessionId: "ses", deliveryId: `reply:${body}:${now}`, body, answeredBy: "pascal", now },
    questionEffects(db, { now }),
  );
}

function askedAtTimeLimit() {
  const clock = new FakeClock(Date.now());
  const db = database();
  const item = insertQueuedItem(db, {
    id: "eng-7",
    sessionKey: "ses",
    maxAwakeMs: 30 * MINUTE,
    now: clock.now(),
  });
  beginImplementRun(db, item.id, clock.now());
  const now = clock.now();
  applyWorkItemEvent(db, item.id, "turn_ended", { now });
  applyWorkItemEvent(db, item.id, "closeout_accepted", { now });
  markCloseoutAccepted(db, item.id, "accepted");
  applyWorkItemEvent(db, item.id, "restart", { kind: "restart", reason: "review", now });
  applyWorkItemEvent(db, item.id, "dispatched", { now });
  saveCheckpoint(db, item.id, { phase: "running", baseSha: "base", wipCommit: "accepted" });
  accrueAwake(db, item.id, clock.mono(), clock.now(), undefined, true);
  clock.advance(31 * MINUTE);
  accrueAwake(db, item.id, clock.mono(), clock.now(), undefined, true);
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
  const asked = getWorkItem(db, item.id)!;
  expect(asked.state).toBe("awaiting_input");
  return { clock, db, itemId: item.id, askedAt: asked.version };
}

test("Merge at the time limit records one acceptance, no agent turn, and no running time", () => {
  const { clock, db, itemId, askedAt } = askedAtTimeLimit();
  clock.advance(10 * MINUTE);
  expect(reply(db, "Merge the accepted work", clock.now()).status).toBe("answered");
  expect(history(db, itemId, askedAt)).toEqual(["awaiting_input -closeout_accepted-> merge_queue"]);

  clock.advance(5 * MINUTE);
  const provider = createLiveStatusProvider(db, { now: () => new Date(clock.now()), env: {} });
  const parsed = parseStatusSnapshot(JSON.parse(JSON.stringify(provider.snapshot())));
  if (!parsed.ok) throw new Error(parsed.error);
  const times = parsed.snapshot.items.find((entry) => entry.id === itemId)!.stateTimes!;
  expect(times.current).toBe("merge_queue");
  const ms = Object.fromEntries(times.states.map((entry) => [entry.state, entry.ms]));
  expect(ms.awaiting_input).toBe(10 * MINUTE);
  expect(ms.merge_queue).toBe(5 * MINUTE);

  restart(db, getWorkItem(db, itemId)!, { reason: "ci", body: "CI failed", now: clock.now() });
  expect(restartedFromMergeQueue(db, itemId)).toBe(true);
});

test("Stop at the time limit records answer_stopped from the wait, not a run failure", () => {
  const { clock, db, itemId, askedAt } = askedAtTimeLimit();
  expect(reply(db, "Stop", clock.now()).status).toBe("answered");
  expect(history(db, itemId, askedAt)).toEqual(["awaiting_input -answer_stopped-> failed"]);
});

test("an answered runner wait re-verifies without passing through running", () => {
  const db = database();
  const item = insertQueuedItem(db, { id: "eng-8", sessionKey: "ses", now: 1_000 });
  const { run } = beginImplementRun(db, item.id, 1_000);
  applyWorkItemEvent(db, item.id, "turn_ended");
  ask(
    db,
    { itemId: item.id, runId: run.id, sessionId: "ses" },
    "runner-wait",
    "The runner is paused. Keep waiting or move?",
    { options: ["Keep waiting", "Move"], now: 2_000 },
  );
  const askedAt = getWorkItem(db, item.id)!.version;
  expect(reply(db, "Keep waiting", 3_000).status).toBe("answered");
  expect(history(db, item.id, askedAt)).toEqual(["awaiting_input -reverify_requested-> verifying"]);
  expect(listJobs(db).some((job) => job.queue === "run.reverify")).toBe(true);
});

test("Discarding a plan completes it from the wait with one answer_completed", () => {
  const db = database();
  const item = insertQueuedItem(db, { id: "eng-9", sessionKey: "ses", now: 1_000 });
  saveTaskMode(db, item.id, "plan");
  const { run } = beginImplementRun(db, item.id, 1_000);
  const asked = ask(
    db,
    { itemId: item.id, runId: run.id, sessionId: "ses" },
    "plan-approval",
    "File these sub-issues?",
    { options: ["Create", "Edit", "Discard"], now: 2_000 },
  );
  savePlanProposal(db, {
    questionId: asked.question.id,
    itemId: item.id,
    parentIssueId: "issue-9",
    repository: null,
    drafts: [
      { title: "One", description: "Do one.", acceptanceCriteria: ["One is done."], blockedBy: [] },
    ],
    now: 2_000,
  });
  const askedAt = getWorkItem(db, item.id)!.version;
  expect(reply(db, "Discard", 3_000).status).toBe("answered");
  expect(history(db, item.id, askedAt)).toEqual(["awaiting_input -answer_completed-> completed"]);
});

test("a failure in the merge queue records work_failed, not a lease expiry", () => {
  const db = database();
  const item = insertQueuedItem(db, { id: "eng-10", sessionKey: "ses", now: 1_000 });
  beginImplementRun(db, item.id, 1_000);
  enterMergeQueue(db, item.id, { phase: "merge_queue", baseSha: "base", wipCommit: "head" });
  const queued = getWorkItem(db, item.id)!;
  expect(failWorkItem(db, queued, "merge_error", "The merge failed.", 2_000)).toBe(true);
  expect(history(db, item.id, queued.version)).toEqual(["merge_queue -work_failed-> failed"]);
});
