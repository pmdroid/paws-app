import { expect, test } from "bun:test";
import { JOB_KIND } from "../core";
import {
  applyWorkItemEvent,
  beginImplementRun,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  listOutbox,
  migrate,
  openDatabase,
} from "../db";
import {
  answer,
  ask,
  findOpenQuestion,
  getQuestion,
  getVisualReview,
  openVisualReview,
  visualReviewContinueQuestion,
  VISUAL_REVIEW_CONTINUE_OPTIONS,
  VISUAL_REVIEW_ROUNDS,
} from "../questions";
import { ask as askQuestion } from "./operations";
import { questionEffects } from "./question-effects";
import { askForVisualReview, VISUAL_REVIEW_NEEDS_LINK } from "./visual-review";

const NOW = 1_700_000_000_000;

function verifying() {
  const db = openDatabase(":memory:");
  migrate(db);
  const item = insertQueuedItem(db, { id: "ENG-3", sessionKey: "ses_1", title: "Hint" });
  const { run } = beginImplementRun(db, item.id, NOW - 10);
  applyWorkItemEvent(db, item.id, "turn_ended");
  return { db, itemId: item.id, runId: run.id };
}

test("a Paws without an https dashboard link asks nothing in Linear and says why once", () => {
  const { db, itemId, runId } = verifying();
  const input = {
    item: getWorkItem(db, itemId)!,
    runId,
    sessionId: "ses_1",
    checkId: "visual-proof",
    evidenceIds: ["ev-1"],
    base: "base",
    head: "head",
    publicUrl: "http://127.0.0.1:8787/",
    now: NOW,
  };
  expect(askForVisualReview(db, input)).toBe(false);
  expect(askForVisualReview(db, { ...input, now: NOW + 1 })).toBe(false);
  expect(findOpenQuestion(db, "ses_1")).toBeNull();
  expect(listOutbox(db).filter((row) => row.op === "elicitation")).toEqual([]);
  const notes = listOutbox(db).filter((row) => row.op === "activity");
  expect(notes.map((row) => (row.payload as { body: string }).body)).toEqual([
    VISUAL_REVIEW_NEEDS_LINK,
  ]);
  // The check stays unapproved; the item keeps verifying.
  expect(getWorkItem(db, itemId)?.state).toBe("verifying");
});

/** A review question Linear asked with options before the link ask, still open. */
function askedBefore() {
  const { db, itemId, runId } = verifying();
  const { question } = openVisualReview(db, {
    ask: (store, asker, ...rest) => askQuestion(store, { ...asker, pending: true }, ...rest),
    itemId,
    runId,
    sessionId: "ses_1",
    checkId: "visual-proof",
    evidenceIds: ["ev-1", "ev-2"],
    headCommit: "head",
    now: NOW,
  });
  return { db, itemId, question };
}

const reply = (body: string) => ({
  sessionId: "ses_1",
  deliveryId: "activity:review",
  body,
  answeredBy: "lead",
  now: NOW + 100,
});

test("Accept on a question asked before the link ask requests changes and never approves", () => {
  const { db, itemId, question } = askedBefore();
  const outcome = answer(db, reply("Accept"), questionEffects(db, { now: NOW + 100 }));
  expect(outcome.status).toBe("answered");
  expect(getVisualReview(db, question.id)).toMatchObject({
    outcome: "changes_requested",
    feedback: "Accept",
  });
  expect(getWorkItem(db, itemId)?.state).toBe("queued");
  const [resume] = listJobs(db).filter((job) => job.queue === JOB_KIND.resume);
  expect(resume).toMatchObject({ jobKey: `resume:answer:${question.id}` });
  expect((resume!.payload as { reason: string }).reason).toBe("review");
  expect(listJobs(db).filter((job) => job.queue === JOB_KIND.reverify)).toEqual([]);
});

test("Request changes restarts the item for review with the feedback", () => {
  const { db, itemId, question } = askedBefore();
  answer(db, reply("Make the hint shorter"), questionEffects(db, { now: NOW + 100 }));
  expect(getVisualReview(db, question.id)?.outcome).toBe("changes_requested");
  expect(getWorkItem(db, itemId)?.state).toBe("queued");
  const [resume] = listJobs(db).filter((job) => job.queue === JOB_KIND.resume);
  expect((resume!.payload as { handoff: string }).handoff).toContain("Make the hint shorter");
});

test("the round-limit question waits behind a sibling's queued question", () => {
  const { db, itemId, question } = askedBefore();
  for (let round = 1; round < VISUAL_REVIEW_ROUNDS; round += 1)
    db.run(
      `INSERT INTO visual_review (question_id, item_id, check_id, evidence_ids, created_at, outcome)
       VALUES (?, ?, 'visual-proof', '[]', ?, 'changes_requested')`,
      [`old-${round}`, itemId, NOW - round],
    );
  const sibling = insertQueuedItem(db, { id: "ENG-4", sessionKey: "ses_1", title: "Other" });
  const ci = ask(db, { itemId: sibling.id, runId: null, sessionId: "ses_1" }, "ci-help", "CI?", {
    now: NOW + 1,
  });
  expect(ci.status).toBe("queued");

  answer(db, reply("Make the hint shorter"), questionEffects(db, { now: NOW + 100 }));

  expect(getVisualReview(db, question.id)?.outcome).toBe("changes_requested");
  expect(findOpenQuestion(db, "ses_1")?.id).toBe(ci.question.id);
  const queued = db
    .query<{ id: string }, [string]>(
      "SELECT question_id AS id FROM visual_review WHERE item_id = ? AND kind = 'continue'",
    )
    .get(itemId)!;
  expect(getQuestion(db, queued.id)).toMatchObject({
    kind: "visual-review",
    status: "queued",
    body: visualReviewContinueQuestion(VISUAL_REVIEW_ROUNDS),
    options: [...VISUAL_REVIEW_CONTINUE_OPTIONS],
  });
  expect(getWorkItem(db, itemId)?.state).toBe("awaiting_input");
  expect(listJobs(db).filter((job) => job.queue === JOB_KIND.resume)).toEqual([]);
});
