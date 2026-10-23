import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { JOB_KIND } from "../src/core";
import {
  applyWorkItemEvent,
  beginImplementRun,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  listOpenQuestions,
  listOutbox,
} from "../src/db";
import { questionEffects } from "../src/loop";
import {
  answer,
  ask,
  elicitationBody,
  handoffNote,
  getQuestion,
  openQuestion,
} from "../src/questions";
import { tempDb } from "./helpers";

test("elicitation keeps select options and a free-text reply", () => {
  const body = elicitationBody("Include archived rows?", "The export is empty today.");
  expect(body).toContain("Include archived rows?");
  expect(body).toContain("answer in your own words");
  expect(body).not.toContain("- yes");
});

const NOW = 1_700_000_000_000;

test.each([
  [[], "Which outcome?\n\nContext."],
  [
    ["Code"],
    "Which outcome?\n\nContext.\n\nReply with one of the options, or answer in your own words.",
  ],
])("only a question with options asks to reply with one of them", (options, body) => {
  const { db, asker } = parked();
  ask(db, asker, "clarification", "Which outcome?", { options, context: "Context.", now: NOW });
  expect(listOutbox(db)[0]?.payload).toMatchObject({ body });
});

function parked() {
  const db = tempDb();
  const item = insertQueuedItem(db, { id: "ENG-2", sessionKey: "ses_1", title: "Export rows" });
  const { run } = beginImplementRun(db, item.id, NOW - 10);
  applyWorkItemEvent(db, item.id, "blocking_question");
  return { db, asker: { itemId: item.id, runId: run.id, sessionId: "ses_1" } };
}

const reply = (body: string, deliveryId = "activity:ans") => ({
  sessionId: "ses_1",
  deliveryId,
  body,
  answeredBy: "human-1",
  now: NOW + 100,
});

const resumes = (db: Database) => listJobs(db).filter((job) => job.queue === JOB_KIND.resume);

test("an answered agent question resumes as a fresh session with the handoff", () => {
  const { db, asker } = parked();
  const asked = ask(db, asker, "agent", "Include archived rows?", {
    options: ["yes", "no"],
    now: NOW,
  });
  expect(listOutbox(db).map((row) => row.idempotencyKey)).toEqual([
    `question:${asked.question.id}`,
  ]);

  const outcome = answer(db, reply("parquet, please"), questionEffects(db, { now: NOW + 100 }));

  expect(outcome.status).toBe("answered");
  expect(getWorkItem(db, asker.itemId)?.state).toBe("running");
  expect(resumes(db)).toEqual([
    expect.objectContaining({
      jobKey: `resume:answer:${asked.question.id}`,
      status: "pending",
      payload: {
        itemId: asker.itemId,
        freshSession: true,
        reason: "answer",
        handoff: handoffNote({
          question: "Include archived rows?",
          answer: "parquet, please",
          options: ["yes", "no"],
        }),
      },
    }),
  ]);
  expect(answer(db, reply("parquet, please"), questionEffects(db, { now: NOW + 100 })).status).toBe(
    "duplicate",
  );
  expect(resumes(db)).toHaveLength(1);
});

test.each(["clarification", "repository"] as const)(
  "an answered %s question resumes the task like an agent question",
  (kind) => {
    const { db, asker } = parked();
    const asked = ask(db, asker, kind, "Which outcome?", { now: NOW });
    answer(db, reply("Change the code"), questionEffects(db, { now: NOW + 100 }));
    expect(getWorkItem(db, asker.itemId)?.state).toBe("running");
    expect(resumes(db).map((job) => job.jobKey)).toEqual([`resume:answer:${asked.question.id}`]);
  },
);

test("an answer while the asking run is still live leaves the resume to the end of that run", () => {
  const { db, asker } = parked();
  ask(db, asker, "agent", "Include archived rows?", { now: NOW });
  const effects = questionEffects(db, { now: NOW + 100, asking: (runId) => runId === asker.runId });
  expect(answer(db, reply("parquet"), effects).status).toBe("answered");
  expect(getWorkItem(db, asker.itemId)?.state).toBe("running");
  expect(resumes(db)).toEqual([]);
});

test("a redirecting answer resumes the task without a handoff job", () => {
  const { db, asker } = parked();
  ask(db, asker, "agent", "Include archived rows?", { now: NOW });
  const effects = questionEffects(db, { now: NOW + 100, redirect: true });
  expect(answer(db, reply("parquet"), effects).status).toBe("answered");
  expect(getWorkItem(db, asker.itemId)?.state).toBe("running");
  expect(resumes(db)).toEqual([]);
});

test("an agent question queued behind another is delivered once that one is answered", () => {
  const { db, asker } = parked();
  const waiting = ask(db, { ...asker, itemId: "other", runId: null }, "runner-wait", "Move?", {
    now: NOW,
  });
  const queued = ask(db, asker, "agent", "Include archived rows?", { now: NOW + 1 });
  expect(queued.status).toBe("queued");

  const outcome = answer(db, reply("Keep waiting"), questionEffects(db, { now: NOW + 100 }));

  expect(outcome).toMatchObject({
    status: "answered",
    question: { id: waiting.question.id },
    next: { id: queued.question.id, status: "open" },
  });
  expect(getWorkItem(db, asker.itemId)?.state).toBe("awaiting_input");
  expect(resumes(db)).toEqual([]);
  expect(listOutbox(db).map((row) => row.idempotencyKey)).toEqual([
    `question:${waiting.question.id}`,
    `question:${queued.question.id}`,
  ]);
});

test("an amended question delivers and keeps the added context and options", () => {
  const { db, asker } = parked();
  const asked = ask(db, asker, "agent", "Include archived rows?", {
    options: ["yes"],
    now: NOW,
    amend: (question) => ({
      context: "Saved decision: archive rows stay out",
      options: [...question.options, { label: "Use saved decision", value: "/paws decision 1" }],
    }),
  });
  expect(asked.question).toMatchObject({
    context: "Saved decision: archive rows stay out",
    options: ["yes", { label: "Use saved decision", value: "/paws decision 1" }],
  });
  expect(listOutbox(db)[0]?.payload).toMatchObject({
    body: elicitationBody("Include archived rows?", "Saved decision: archive rows stay out"),
    options: ["yes", { label: "Use saved decision", value: "/paws decision 1" }],
  });
});

test("structured choices persist their values and display their labels", () => {
  const db = tempDb();
  const item = insertQueuedItem(db, {
    id: "ENG-choices",
    sessionKey: "ses-choices",
    title: "Choose",
  });
  const options = ["Other", { label: "Paws", value: "https://github.com/pmdroid/paws-app" }];
  const question = openQuestion(db, {
    itemId: item.id,
    sessionId: "ses-choices",
    body: "Which?",
    options,
  });
  expect(getQuestion(db, question.id)?.options).toEqual(options);
  expect(listOpenQuestions(db)[0]?.options).toEqual(["Other", "Paws"]);
  db.close();
});
