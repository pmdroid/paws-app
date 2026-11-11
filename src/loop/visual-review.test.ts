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
  sqliteDb,
} from "../db";
import {
  answerSteps,
  askSteps as askQuestionSteps,
  findOpenQuestion,
  getQuestion,
  getVisualReview,
  openVisualReviewSteps,
  visualReviewContinueQuestion,
  VISUAL_REVIEW_CONTINUE_OPTIONS,
  VISUAL_REVIEW_ROUNDS,
} from "../questions";
import { askSteps } from "./operations";
import { questionEffects } from "./question-effects";
import { askForVisualReviewSteps, VISUAL_REVIEW_NEEDS_LINK } from "./visual-review";

const NOW = 1_700_000_000_000;

async function verifying() {
  const db = openDatabase(":memory:");
  migrate(db);
  const item = insertQueuedItem(db, { id: "ENG-3", sessionKey: "ses_1", title: "Hint" });
  const { run } = await beginImplementRun(sqliteDb(db), item.id, NOW - 10);
  await applyWorkItemEvent(sqliteDb(db), item.id, "turn_ended");
  return { db, itemId: item.id, runId: run.id };
}

test("a Paws without an https dashboard link asks nothing in Linear and says why once", async () => {
  const { db, itemId, runId } = await verifying();
  const input = {
    item: (await getWorkItem(sqliteDb(db), itemId))!,
    runId,
    sessionId: "ses_1",
    checkId: "visual-proof",
    evidenceIds: ["ev-1"],
    base: "base",
    head: "head",
    publicUrl: "http://127.0.0.1:8787/",
    now: NOW,
  };
  const store = sqliteDb(db);
  expect(await store.transaction((q) => askForVisualReviewSteps(q, input))).toBe(false);
  expect(
    await store.transaction((q) => askForVisualReviewSteps(q, { ...input, now: NOW + 1 })),
  ).toBe(false);
  expect(await findOpenQuestion(sqliteDb(db), "ses_1")).toBeNull();
  expect((await listOutbox(sqliteDb(db))).filter((row) => row.op === "elicitation")).toEqual([]);
  const notes = (await listOutbox(sqliteDb(db))).filter((row) => row.op === "activity");
  expect(notes.map((row) => (row.payload as { body: string }).body)).toEqual([
    VISUAL_REVIEW_NEEDS_LINK,
  ]);
  // The check stays unapproved; the item keeps verifying.
  expect((await getWorkItem(sqliteDb(db), itemId))?.state).toBe("verifying");
});

/** A review question Linear asked with options before the link ask, still open. */
async function askedBefore() {
  const { db, itemId, runId } = await verifying();
  const { question } = await sqliteDb(db).transaction((q) =>
    openVisualReviewSteps(q, {
      ask: (reads, asker, ...rest) => askSteps(reads, { ...asker, pending: true }, ...rest),
      itemId,
      runId,
      sessionId: "ses_1",
      checkId: "visual-proof",
      evidenceIds: ["ev-1", "ev-2"],
      headCommit: "head",
      now: NOW,
    }),
  );
  return { db, itemId, question };
}

const reply = (body: string) => ({
  sessionId: "ses_1",
  deliveryId: "activity:review",
  body,
  answeredBy: "lead",
  now: NOW + 100,
});

test("Accept on a question asked before the link ask requests changes and never approves", async () => {
  const { db, itemId, question } = await askedBefore();
  const outcome = await sqliteDb(db).transaction((q) =>
    answerSteps(q, reply("Accept"), questionEffects(sqliteDb(db), { now: NOW + 100 })),
  );
  expect(outcome.status).toBe("answered");
  expect(await getVisualReview(sqliteDb(db), question.id)).toMatchObject({
    outcome: "changes_requested",
    feedback: "Accept",
  });
  expect((await getWorkItem(sqliteDb(db), itemId))?.state).toBe("queued");
  const [resume] = (await listJobs(sqliteDb(db))).filter((job) => job.queue === JOB_KIND.resume);
  expect(resume).toMatchObject({ jobKey: `resume:answer:${question.id}` });
  expect((resume!.payload as { reason: string }).reason).toBe("review");
  expect((await listJobs(sqliteDb(db))).filter((job) => job.queue === JOB_KIND.reverify)).toEqual(
    [],
  );
});

test("Request changes restarts the item for review with the feedback", async () => {
  const { db, itemId, question } = await askedBefore();
  await sqliteDb(db).transaction((q) =>
    answerSteps(
      q,
      reply("Make the hint shorter"),
      questionEffects(sqliteDb(db), { now: NOW + 100 }),
    ),
  );
  expect((await getVisualReview(sqliteDb(db), question.id))?.outcome).toBe("changes_requested");
  expect((await getWorkItem(sqliteDb(db), itemId))?.state).toBe("queued");
  const [resume] = (await listJobs(sqliteDb(db))).filter((job) => job.queue === JOB_KIND.resume);
  expect((resume!.payload as { handoff: string }).handoff).toContain("Make the hint shorter");
});

test("the round-limit question waits behind a sibling's queued question", async () => {
  const { db, itemId, question } = await askedBefore();
  for (let round = 1; round < VISUAL_REVIEW_ROUNDS; round += 1)
    db.run(
      `INSERT INTO visual_review (question_id, item_id, check_id, evidence_ids, created_at, outcome)
       VALUES (?, ?, 'visual-proof', '[]', ?, 'changes_requested')`,
      [`old-${round}`, itemId, NOW - round],
    );
  const sibling = insertQueuedItem(db, { id: "ENG-4", sessionKey: "ses_1", title: "Other" });
  const ci = await sqliteDb(db).transaction((q) =>
    askQuestionSteps(q, { itemId: sibling.id, runId: null, sessionId: "ses_1" }, "ci-help", "CI?", {
      now: NOW + 1,
    }),
  );
  expect(ci.status).toBe("queued");

  await sqliteDb(db).transaction((q) =>
    answerSteps(
      q,
      reply("Make the hint shorter"),
      questionEffects(sqliteDb(db), { now: NOW + 100 }),
    ),
  );

  expect((await getVisualReview(sqliteDb(db), question.id))?.outcome).toBe("changes_requested");
  expect((await findOpenQuestion(sqliteDb(db), "ses_1"))?.id).toBe(ci.question.id);
  const queued = db
    .query<{ id: string }, [string]>(
      "SELECT question_id AS id FROM visual_review WHERE item_id = ? AND kind = 'continue'",
    )
    .get(itemId)!;
  expect(await getQuestion(sqliteDb(db), queued.id)).toMatchObject({
    kind: "visual-review",
    status: "queued",
    body: visualReviewContinueQuestion(VISUAL_REVIEW_ROUNDS),
    options: [...VISUAL_REVIEW_CONTINUE_OPTIONS],
  });
  expect((await getWorkItem(sqliteDb(db), itemId))?.state).toBe("awaiting_input");
  expect((await listJobs(sqliteDb(db))).filter((job) => job.queue === JOB_KIND.resume)).toEqual([]);
});
