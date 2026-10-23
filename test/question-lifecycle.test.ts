import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  beginImplementRun,
  insertQueuedItem,
  listOutbox,
  migrations,
  openDatabase,
  setCurrentRun,
  setJournalSink,
} from "../src/db";
import {
  answer,
  ask,
  cancelItemQuestions,
  findOpenQuestion,
  getQuestion,
  openQuestion,
} from "../src/questions";
import { tempDb } from "./helpers";

const NOW = 1_700_000_000_000;

function setup() {
  const db = tempDb();
  const item = insertQueuedItem(db, { id: "ENG-7", sessionKey: "ses_1", title: "Export rows" });
  const { run } = beginImplementRun(db, item.id, NOW - 10);
  return { db, asker: { itemId: item.id, runId: run.id, sessionId: "ses_1" } };
}

const elicitations = (db: Database) =>
  listOutbox(db)
    .filter((row) => row.op === "elicitation")
    .map((row) => (row.payload as { questionId: string }).questionId);

const reply = (deliveryId: string, body: string, now = NOW + 100) => ({
  sessionId: "ses_1",
  deliveryId,
  body,
  answeredBy: "human-1",
  now,
});

test("a question asks at once when the session waits on nothing", () => {
  const { db, asker } = setup();
  const asked = ask(db, asker, "runner-wait", "Move or keep waiting?", {
    options: ["Move to another runner", "Keep waiting"],
    context: "Waiting: runner goldbox is paused.",
    now: NOW,
  });
  expect(asked.status).toBe("asked");
  expect(asked.question).toMatchObject({ kind: "runner-wait", status: "open" });
  expect(elicitations(db)).toEqual([asked.question.id]);
  const payload = listOutbox(db)[0]?.payload as { body: string };
  expect(payload.body).toContain("Waiting: runner goldbox is paused.");
});

test("a second ask is queued and delivered in order once the open one is answered", () => {
  const { db, asker } = setup();
  const first = openQuestion(db, { ...asker, body: "Include archived rows?", now: NOW });
  const second = ask(db, asker, "agent", "Which format?", { now: NOW + 1 });
  const third = ask(db, asker, "agent", "Which delimiter?", { now: NOW + 2 });
  expect(second.status).toBe("queued");
  expect(third.status).toBe("queued");
  expect(elicitations(db)).toEqual([]);

  const outcome = answer(db, reply("answer-1", "Yes"));
  expect(outcome).toMatchObject({ status: "answered", question: { id: first.id } });
  expect(outcome.status === "answered" && outcome.next?.id).toBe(second.question.id);
  expect(getQuestion(db, second.question.id)).toMatchObject({
    status: "open",
    createdAt: NOW + 100,
  });
  expect(getQuestion(db, third.question.id)?.status).toBe("queued");
  expect(elicitations(db)).toEqual([second.question.id]);
});

test("a newer runner wait replaces a queued one of the same kind", () => {
  const { db, asker } = setup();
  openQuestion(db, { ...asker, body: "Include archived rows?", now: NOW });
  const older = ask(db, asker, "runner-wait", "Move or keep waiting?", { now: NOW + 1 });
  const newer = ask(db, asker, "runner-wait", "Move or keep waiting?", { now: NOW + 2 });
  expect(getQuestion(db, older.question.id)?.status).toBe("cancelled");
  expect(getQuestion(db, newer.question.id)?.status).toBe("queued");
});

test("the answer is idempotent on the delivery id and runs its kind's effect once", () => {
  const { db, asker } = setup();
  const asked = ask(db, asker, "runner-wait", "Move or keep waiting?", { now: NOW });
  const resumed: string[] = [];
  const effects = { "runner-wait": (question: { id: string }) => resumed.push(question.id) };
  expect(answer(db, reply("answer-1", "Keep waiting"), effects).status).toBe("answered");
  expect(answer(db, reply("answer-1", "Keep waiting"), effects).status).toBe("duplicate");
  expect(answer(db, reply("answer-2", "Keep waiting"), effects).status).toBe("unasked");
  expect(resumed).toEqual([asked.question.id]);
  expect(getQuestion(db, asked.question.id)).toMatchObject({
    status: "answered",
    answer: "Keep waiting",
    answerEventKey: "answer-1",
  });
});

test("a queued question for a run that is no longer current is dropped with a journal entry", () => {
  const { db, asker } = setup();
  openQuestion(db, { ...asker, body: "Include archived rows?", now: NOW });
  const stale = ask(db, asker, "runner-wait", "Move or keep waiting?", { now: NOW + 1 });
  setCurrentRun(db, asker.itemId, null);
  const lines: string[] = [];
  const restore = setJournalSink((line) => lines.push(line));
  try {
    answer(db, reply("answer-1", "Yes"));
  } finally {
    restore();
  }
  expect(getQuestion(db, stale.question.id)?.status).toBe("cancelled");
  expect(findOpenQuestion(db, "ses_1")).toBeNull();
  expect(lines).toEqual([
    `question ${stale.question.id} dropped from the queue: its run is no longer current`,
  ]);
  expect(elicitations(db)).toEqual([]);
});

test("cancelling the task cancels its open and queued questions", () => {
  const { db, asker } = setup();
  const open = openQuestion(db, { ...asker, body: "Include archived rows?", now: NOW });
  const queued = ask(db, asker, "runner-wait", "Move or keep waiting?", { now: NOW + 1 });
  cancelItemQuestions(db, asker.itemId, NOW + 2);
  expect(getQuestion(db, open.id)?.status).toBe("cancelled");
  expect(getQuestion(db, queued.question.id)?.status).toBe("cancelled");
  expect(elicitations(db)).toEqual([]);
});

test("the migration classifies an open runner wait and leaves every other row an agent question", () => {
  const db = openDatabase(":memory:");
  db.run("CREATE TABLE schema_migration (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT");
  const cutoff = migrations.findIndex((migration) => migration.id === "113_question_kind_queue");
  const run = (migration: (typeof migrations)[number]) => {
    if (migration.foreignKeys === false) db.run("PRAGMA foreign_keys = OFF");
    db.transaction(() => db.run(migration.sql)).immediate();
    db.run("PRAGMA foreign_keys = ON");
  };
  for (const migration of migrations.slice(0, cutoff)) run(migration);
  const insert = db.prepare(
    `INSERT INTO question (id, item_id, session_id, body, options, status, created_at)
     VALUES (?, 'ENG-7', ?, 'Body', ?, ?, 1)`,
  );
  const wait = JSON.stringify(["Move to another runner", "Keep waiting"]);
  insert.run("wait-open", "ses_1", wait, "open");
  insert.run("wait-answered", "ses_2", wait, "answered");
  insert.run("agent-open", "ses_3", JSON.stringify(["Yes", "No"]), "open");
  run(migrations[cutoff]!);
  expect(db.query("SELECT id, kind, status FROM question ORDER BY id").all() as unknown[]).toEqual([
    { id: "agent-open", kind: "agent", status: "open" },
    { id: "wait-answered", kind: "agent", status: "answered" },
    { id: "wait-open", kind: "runner-wait", status: "open" },
  ]);
  expect(() => insert.run("queued", "ses_1", null, "queued")).not.toThrow();
});
