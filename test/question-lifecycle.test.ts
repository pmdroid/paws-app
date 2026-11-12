import { afterEach, expect, test } from "bun:test";
import {
  beginImplementRun,
  ensureCloseoutProgress,
  insertQueuedItem,
  listOutbox,
  saveCheckpoint,
  saveCloseoutRecovery,
  setCurrentRun,
  setJournalSink,
  syncSteps,
  type Db,
  type Q,
} from "../src/db";
import { findOpenQuestion, getQuestion, openQuestion } from "../src/questions";
import {
  answerPg as answer,
  askPg as ask,
  cancelItemQuestionsPg as cancelItemQuestions,
} from "./questions";
import { tempStore } from "./pglite";

const NOW = 1_700_000_000_000;

const stores: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of stores.splice(0)) await close();
});

async function setup() {
  const { db, close } = await tempStore();
  stores.push(close);
  const item = await insertQueuedItem(db, {
    id: "ENG-7",
    sessionKey: "ses_1",
    title: "Export rows",
  });
  const { run } = await beginImplementRun(db, item.id, NOW - 10);
  return { db, asker: { itemId: item.id, runId: run.id, sessionId: "ses_1" } };
}

const elicitations = async (db: Db) =>
  (await listOutbox(db))
    .filter((row) => row.op === "elicitation")
    .map((row) => (row.payload as { questionId: string }).questionId);

const reply = (deliveryId: string, body: string, now = NOW + 100) => ({
  sessionId: "ses_1",
  deliveryId,
  body,
  answeredBy: "human-1",
  now,
});

test("a question asks at once when the session waits on nothing", async () => {
  const { db, asker } = await setup();
  const asked = await ask(db, asker, "runner-wait", "Move or keep waiting?", {
    options: ["Move to another runner", "Keep waiting"],
    context: "Waiting: runner goldbox is paused.",
    now: NOW,
  });
  expect(asked.status).toBe("asked");
  expect(asked.question).toMatchObject({ kind: "runner-wait", status: "open" });
  expect(await elicitations(db)).toEqual([asked.question.id]);
  const payload = (await listOutbox(db))[0]?.payload as { body: string };
  expect(payload.body).toContain("Waiting: runner goldbox is paused.");
});

test("a second ask is queued and delivered in order once the open one is answered", async () => {
  const { db, asker } = await setup();
  const first = await openQuestion(db, {
    ...asker,
    body: "Include archived rows?",
    now: NOW,
  });
  const second = await ask(db, asker, "agent", "Which format?", { now: NOW + 1 });
  const third = await ask(db, asker, "agent", "Which delimiter?", { now: NOW + 2 });
  expect(second.status).toBe("queued");
  expect(third.status).toBe("queued");
  expect(await elicitations(db)).toEqual([]);

  const outcome = await answer(db, reply("answer-1", "Yes"));
  expect(outcome).toMatchObject({ status: "answered", question: { id: first.id } });
  expect(outcome.status === "answered" && outcome.next?.id).toBe(second.question.id);
  expect(await getQuestion(db, second.question.id)).toMatchObject({
    status: "open",
    createdAt: NOW + 100,
  });
  expect((await getQuestion(db, third.question.id))?.status).toBe("queued");
  expect(await elicitations(db)).toEqual([second.question.id]);
});

test("a newer runner wait replaces a queued one of the same kind", async () => {
  const { db, asker } = await setup();
  await openQuestion(db, { ...asker, body: "Include archived rows?", now: NOW });
  const older = await ask(db, asker, "runner-wait", "Move or keep waiting?", { now: NOW + 1 });
  const newer = await ask(db, asker, "runner-wait", "Move or keep waiting?", { now: NOW + 2 });
  expect((await getQuestion(db, older.question.id))?.status).toBe("cancelled");
  expect((await getQuestion(db, newer.question.id))?.status).toBe("queued");
});

test("a newer CI help replaces only its own task's queued CI help", async () => {
  const { db, asker } = await setup();
  const sibling = await insertQueuedItem(db, {
    id: "ENG-8",
    sessionKey: "ses_1",
    title: "Import rows",
  });
  await openQuestion(db, { ...asker, body: "Include archived rows?", now: NOW });
  const older = await ask(db, asker, "ci-help", "CI failed.", { now: NOW + 1 });
  const other = await ask(
    db,
    { ...asker, itemId: sibling.id, runId: null },
    "ci-help",
    "CI failed.",
    {
      now: NOW + 2,
    },
  );
  const newer = await ask(db, asker, "ci-help", "CI failed again.", { now: NOW + 3 });
  expect((await getQuestion(db, older.question.id))?.status).toBe("cancelled");
  expect((await getQuestion(db, other.question.id))?.status).toBe("queued");
  expect((await getQuestion(db, newer.question.id))?.status).toBe("queued");
});

async function queuedCloseoutHelp() {
  const { db, asker } = await setup();
  await saveCheckpoint(db, asker.itemId, {
    phase: "awaiting_input",
    baseSha: "base",
    wipCommit: "head-1",
  });
  await ensureCloseoutProgress(
    db,
    asker.itemId,
    { taskId: "ENG-7", base: "base", head: "head-1", policyDigest: "policy-1", policyPath: null },
    NOW,
    true,
  );
  await openQuestion(db, { ...asker, body: "Include archived rows?", now: NOW });
  const help = await ask(db, asker, "closeout-help", "Closeout needs your help.", { now: NOW + 1 });
  await saveCloseoutRecovery(db, {
    questionId: help.question.id,
    taskId: "ENG-7",
    itemId: asker.itemId,
    base: "base",
    head: "head-1",
    policyDigest: "policy-1",
    failedChecks: ["test"],
    retryBaseline: [],
    summary: "Closeout: rejected",
  });
  return { db, asker, help: help.question };
}

async function promote(db: Db): Promise<string[]> {
  const lines: string[] = [];
  const restore = setJournalSink((line) => lines.push(line));
  try {
    await answer(db, reply("answer-1", "Yes"));
  } finally {
    restore();
  }
  return lines;
}

test("a queued Closeout help for the same candidate and policy is delivered", async () => {
  const { db, help } = await queuedCloseoutHelp();
  expect(await promote(db)).toEqual([]);
  expect((await findOpenQuestion(db, "ses_1"))?.id).toBe(help.id);
  expect(await elicitations(db)).toEqual([help.id]);
});

test("a queued Closeout help is dropped once its candidate moved", async () => {
  const { db, asker, help } = await queuedCloseoutHelp();
  await saveCheckpoint(db, asker.itemId, {
    phase: "verifying",
    baseSha: "base",
    wipCommit: "head-2",
  });
  expect(await promote(db)).toEqual([
    `question ${help.id} dropped from the queue: its candidate moved`,
  ]);
  expect((await getQuestion(db, help.id))?.status).toBe("cancelled");
  expect(await elicitations(db)).toEqual([]);
});

test("a queued Closeout help is dropped once the Closeout policy changed", async () => {
  const { db, asker, help } = await queuedCloseoutHelp();
  await ensureCloseoutProgress(
    db,
    asker.itemId,
    { taskId: "ENG-7", base: "base", head: "head-1", policyDigest: "policy-2", policyPath: null },
    NOW + 50,
    true,
  );
  expect(await promote(db)).toEqual([
    `question ${help.id} dropped from the queue: its Closeout policy changed`,
  ]);
  expect(await elicitations(db)).toEqual([]);
});

test("the answer is idempotent on the delivery id and runs its kind's effect once", async () => {
  const { db, asker } = await setup();
  const asked = await ask(db, asker, "runner-wait", "Move or keep waiting?", { now: NOW });
  const resumed: string[] = [];
  const effects = {
    "runner-wait": (_q: Q, question: { id: string }) =>
      syncSteps(() => {
        resumed.push(question.id);
      }),
  };
  expect((await answer(db, reply("answer-1", "Keep waiting"), effects)).status).toBe("answered");
  expect((await answer(db, reply("answer-1", "Keep waiting"), effects)).status).toBe("duplicate");
  expect((await answer(db, reply("answer-2", "Keep waiting"), effects)).status).toBe("unasked");
  expect(resumed).toEqual([asked.question.id]);
  expect(await getQuestion(db, asked.question.id)).toMatchObject({
    status: "answered",
    answer: "Keep waiting",
    answerEventKey: "answer-1",
  });
});

test("a queued question for a run that is no longer current is dropped with a journal entry", async () => {
  const { db, asker } = await setup();
  await openQuestion(db, { ...asker, body: "Include archived rows?", now: NOW });
  const stale = await ask(db, asker, "runner-wait", "Move or keep waiting?", { now: NOW + 1 });
  await setCurrentRun(db, asker.itemId, null);
  const lines: string[] = [];
  const restore = setJournalSink((line) => lines.push(line));
  try {
    await answer(db, reply("answer-1", "Yes"));
  } finally {
    restore();
  }
  expect((await getQuestion(db, stale.question.id))?.status).toBe("cancelled");
  expect(await findOpenQuestion(db, "ses_1")).toBeNull();
  expect(lines).toEqual([
    `question ${stale.question.id} dropped from the queue: its run is no longer current`,
  ]);
  expect(await elicitations(db)).toEqual([]);
});

test("cancelling the task cancels its open and queued questions", async () => {
  const { db, asker } = await setup();
  const open = await openQuestion(db, {
    ...asker,
    body: "Include archived rows?",
    now: NOW,
  });
  const queued = await ask(db, asker, "runner-wait", "Move or keep waiting?", { now: NOW + 1 });
  await cancelItemQuestions(db, asker.itemId, NOW + 2);
  expect((await getQuestion(db, open.id))?.status).toBe("cancelled");
  expect((await getQuestion(db, queued.question.id))?.status).toBe("cancelled");
  expect(await elicitations(db)).toEqual([]);
});
