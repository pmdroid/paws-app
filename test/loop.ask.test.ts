import { expect, test } from "bun:test";
import { FakeClock, JOB_KIND } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  applyWorkItemEvent,
  beginImplementRun,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  listOpenQuestions,
} from "../src/db";
import type { AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator } from "../src/loop";
import { elicitationBody, handoffNote, getQuestion, openQuestion } from "../src/questions";
import { tempDb } from "./helpers";

test("elicitation keeps select options and a free-text reply", () => {
  const body = elicitationBody("Include archived rows?", "The export is empty today.");
  expect(body).toContain("Include archived rows?");
  expect(body).toContain("answer in your own words");
  expect(body).not.toContain("- yes");
});

test("a prompted answer with no waiting session resumes as a fresh session", async () => {
  const db = tempDb();
  const seeded = insertQueuedItem(db, { id: "ENG-2", sessionKey: "ses_1", title: "Export rows" });
  beginImplementRun(db, seeded.id, 1);
  applyWorkItemEvent(db, seeded.id, "blocking_question");
  const parked = getWorkItem(db, seeded.id);
  expect(parked?.state).toBe("awaiting_input");

  const clock = new FakeClock(1_000);
  const jobs = new JobLoop(db, clock);
  const outbox = new OutboxDispatcher(db, clock);
  const orchestrator = attachOrchestrator({
    db,
    jobs,
    outbox,
    pawsRoot: "/tmp/paws-ask",
    tracker: null,
    clock,
  });
  db.run(
    `INSERT INTO question (
       id, item_id, run_id, session_id, body, options, status, created_at
     ) VALUES (?, ?, NULL, ?, ?, ?, 'open', ?)`,
    ["q-1", seeded.id, "ses_1", "Include archived rows?", JSON.stringify(["yes", "no"]), 1],
  );

  await orchestrator.onLinearEvent(prompted("parquet, please"));

  const item = getWorkItem(db, seeded.id);
  expect(item?.state).toBe("running");
  const resume = listJobs(db).find((job) => job.queue === JOB_KIND.resume);
  expect(resume?.status).toBe("pending");
  const payload = resume?.payload as { freshSession?: boolean; handoff?: string };
  expect(payload.freshSession).toBe(true);
  expect(payload.handoff).toBe(
    handoffNote({
      question: "Include archived rows?",
      answer: "parquet, please",
      options: ["yes", "no"],
    }),
  );
  expect(payload.handoff).toContain("Handoff from the previous session.");
  expect(payload.handoff).toContain("Do not ask again.");
});

function prompted(body: string): AcceptedLinearEvent {
  return {
    dedupeKey: "activity:ans",
    deliveryId: "del",
    source: "webhook",
    action: "prompted",
    sessionId: "ses_1",
    issueId: "iss",
    activityId: "ans",
    actorId: "human-1",
    body,
    signal: null,
    updatedAtMs: 2,
    payload: "{}",
  };
}

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
