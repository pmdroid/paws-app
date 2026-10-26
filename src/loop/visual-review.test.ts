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
  visualReviewContinueQuestion,
  VISUAL_REVIEW_CONTINUE_OPTIONS,
  VISUAL_REVIEW_OPTIONS,
  VISUAL_REVIEW_QUESTION,
  VISUAL_REVIEW_ROUNDS,
} from "../questions";
import { awaitQuestion } from "./operations";
import { questionEffects } from "./question-effects";
import { askForVisualReview } from "./visual-review";

const NOW = 1_700_000_000_000;

function reviewing() {
  const db = openDatabase(":memory:");
  migrate(db);
  const item = insertQueuedItem(db, { id: "ENG-3", sessionKey: "ses_1", title: "Hint" });
  const { run } = beginImplementRun(db, item.id, NOW - 10);
  applyWorkItemEvent(db, item.id, "turn_ended");
  const asked = askForVisualReview(db, {
    item: getWorkItem(db, item.id)!,
    runId: run.id,
    sessionId: "ses_1",
    checkId: "visual-proof",
    evidenceIds: ["ev-1", "ev-2", "ev-3"],
    base: "base",
    head: "head",
    publicUrl: "https://paws.example/",
    now: NOW,
    carried: [
      {
        evidenceId: "ev-3",
        fromEvidenceId: "ev-0",
        approvalId: "q-0",
        approvedBy: "lead",
        approvedAt: NOW - 100,
        match: "identical",
      },
    ],
    approved: new Map([["ev-2", "ev-9"]]),
  });
  expect(asked).toBe(true);
  // A pending-human check: the commands and the review run while it waits.
  expect(getWorkItem(db, item.id)?.state).toBe("verifying");
  return { db, itemId: item.id, question: findOpenQuestion(db, "ses_1")! };
}

const reply = (body: string) => ({
  sessionId: "ses_1",
  deliveryId: "activity:review",
  body,
  answeredBy: "lead",
  now: NOW + 100,
});

test("a visual review is asked as its own kind and shows its files in Linear", () => {
  const { db, question } = reviewing();
  expect(question).toMatchObject({ kind: "visual-review", body: VISUAL_REVIEW_QUESTION });
  const elicitations = listOutbox(db).filter((row) => row.op === "elicitation");
  expect(elicitations).toHaveLength(1);
  expect(elicitations[0]!.payload).toEqual({
    id: question.id,
    sessionId: "ses_1",
    questionId: question.id,
    body: VISUAL_REVIEW_QUESTION,
    options: [...VISUAL_REVIEW_OPTIONS],
    evidence: [
      { id: "ev-1", link: "https://paws.example/evidence/ev-1" },
      {
        id: "ev-2",
        link: "https://paws.example/evidence/ev-2",
        approved: { id: "ev-9", link: "https://paws.example/evidence/ev-9" },
      },
    ],
    carried: ["ev-3"],
  });
});

test("Accept while the other checks run passes the check and leaves the evaluation to them", () => {
  const { db, itemId, question } = reviewing();
  const outcome = answer(db, reply("Accept"), questionEffects(db, { now: NOW + 100 }));
  expect(outcome.status).toBe("answered");
  expect(getVisualReview(db, question.id)).toMatchObject({
    outcome: "accepted",
    answeredBy: "lead",
    headCommit: "head",
  });
  expect(getWorkItem(db, itemId)?.state).toBe("verifying");
  expect(listJobs(db).filter((job) => job.queue !== JOB_KIND.visualReviewReminder)).toEqual([]);
});

test("Accept after the other checks finished completes the evaluation of the same head", () => {
  const { db, itemId, question } = reviewing();
  awaitQuestion(db, getWorkItem(db, itemId)!, question, NOW + 50);
  expect(getWorkItem(db, itemId)?.state).toBe("awaiting_input");

  answer(db, reply("Accept"), questionEffects(db, { now: NOW + 100 }));

  expect(getWorkItem(db, itemId)?.state).toBe("verifying");
  expect(
    listJobs(db)
      .filter((job) => job.queue !== JOB_KIND.visualReviewReminder)
      .map((job) => [job.queue, job.jobKey, job.payload]),
  ).toEqual([
    [JOB_KIND.reverify, `visual-review-accepted:${question.id}`, { itemId, decide: true }],
  ]);
});

test("Request changes restarts the item for review with the feedback", () => {
  const { db, itemId, question } = reviewing();
  answer(db, reply("Make the hint shorter"), questionEffects(db, { now: NOW + 100 }));

  expect(getVisualReview(db, question.id)?.outcome).toBe("changes_requested");
  const item = getWorkItem(db, itemId)!;
  expect(item.state).toBe("queued");
  expect(item.currentRunId).not.toBeNull();
  const restarted = db
    .query<{ reason: string }, [string]>(
      "SELECT reason FROM work_item_event WHERE item_id = ? AND kind = 'restart'",
    )
    .all(itemId);
  expect(restarted).toEqual([{ reason: "review" }]);
  const [resume] = listJobs(db).filter((job) => job.queue === JOB_KIND.resume);
  expect(resume).toMatchObject({ jobKey: `resume:answer:${question.id}` });
  expect((resume!.payload as { handoff: string }).handoff).toContain("Make the hint shorter");
  expect((resume!.payload as { reason: string }).reason).toBe("review");
});

test("the round-limit question waits behind a sibling's queued question", () => {
  const { db, itemId, question } = reviewing();
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
