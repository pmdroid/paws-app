import { expect, test } from "bun:test";
import { JOB_KIND } from "../src/core";
import {
  applyWorkItemEvent,
  beginImplementRun,
  getWorkItem,
  insertQueuedItem,
  listCloseoutRecoveries,
  listJobs,
  listOutbox,
  saveCheckpoint,
  saveCloseoutRecovery,
} from "../src/db";
import { formatEvidenceSummary } from "../src/closeout";
import { askCloseoutHelp, questionEffects } from "../src/loop";
import { answer, ask, findOpenQuestion, getQuestion, handoffNote } from "../src/questions";
import { tempDb } from "./helpers";

const NOW = 1_700_000_000_000;

function parked() {
  const db = tempDb();
  const item = insertQueuedItem(db, { id: "ENG-2", sessionKey: "ses_1", title: "Export rows" });
  const { run } = beginImplementRun(db, item.id, NOW - 10);
  applyWorkItemEvent(db, item.id, "blocking_question");
  saveCheckpoint(db, item.id, { phase: "awaiting_input", baseSha: "base", wipCommit: "head" });
  return { db, asker: { itemId: item.id, runId: run.id, sessionId: "ses_1" } };
}

function closeoutHelp() {
  const { db, asker } = parked();
  const { question } = ask(db, asker, "closeout-help", "Closeout needs your help.", { now: NOW });
  saveCloseoutRecovery(db, {
    questionId: question.id,
    taskId: "ENG-2",
    itemId: asker.itemId,
    base: "base",
    head: "head",
    policyDigest: "policy",
    failedChecks: ["test"],
    retryBaseline: ["test:1"],
    summary: "Closeout: rejected",
  });
  return { db, asker, question };
}

const reply = (body: string) => ({
  sessionId: "ses_1",
  deliveryId: "activity:ans",
  body,
  answeredBy: "pascal",
  now: NOW + 100,
});

const jobs = (db: ReturnType<typeof tempDb>) =>
  listJobs(db).map((job) => ({ queue: job.queue, jobKey: job.jobKey, payload: job.payload }));

test("a Closeout guidance answer resumes the agent with the Closeout summary", () => {
  const { db, asker, question } = closeoutHelp();
  answer(db, reply("Create ok.txt"), questionEffects(db, { now: NOW + 100 }));
  expect(getWorkItem(db, asker.itemId)?.state).toBe("queued");
  expect(jobs(db)).toEqual([
    {
      queue: JOB_KIND.resume,
      jobKey: `closeout-guidance:${question.id}`,
      payload: {
        itemId: asker.itemId,
        runId: asker.runId,
        handoff: handoffNote({ question: "Closeout: rejected", answer: "Create ok.txt" }),
        reason: "answer",
      },
    },
  ]);
});

test("a Closeout bypass answer verifies the recorded candidate again", () => {
  const { db, asker, question } = closeoutHelp();
  answer(
    db,
    reply("/paws bypass test -- Known fixture failure"),
    questionEffects(db, { now: NOW + 100 }),
  );
  expect(getWorkItem(db, asker.itemId)).toMatchObject({
    state: "verifying",
    checkpoint: { phase: "verifying", baseSha: "base", wipCommit: "head" },
  });
  expect(jobs(db)).toEqual([
    {
      queue: JOB_KIND.reverify,
      jobKey: `closeout-bypass:${question.id}`,
      payload: { itemId: asker.itemId },
    },
  ]);
});

test("an unusable bypass answer asks the Closeout question again with the error", () => {
  const { db, asker, question } = closeoutHelp();
  answer(db, reply("/paws bypass test"), questionEffects(db, { now: NOW + 100 }));
  const again = findOpenQuestion(db, "ses_1")!;
  expect(getQuestion(db, question.id)?.status).toBe("answered");
  expect(again).toMatchObject({ kind: "closeout-help", runId: asker.runId });
  expect(again.body).toContain("Use /paws bypass check-id -- your reason");
  expect(listCloseoutRecoveries(db, asker.itemId).at(-1)).toMatchObject({
    questionId: again.id,
    failedChecks: ["test"],
    retryBaseline: ["test:1"],
  });
  expect(getWorkItem(db, asker.itemId)?.state).toBe("awaiting_input");
  expect(jobs(db)).toEqual([]);
});

const help = (summary: string) => ({
  itemId: "ENG-2",
  taskId: "ENG-2",
  base: "base",
  head: "head",
  policyDigest: "",
  failedChecks: [],
  retryBaseline: [],
  summary,
});

const delivered = (db: ReturnType<typeof tempDb>) =>
  listOutbox(db)
    .filter((row) => row.op === "elicitation")
    .map((row) => row.payload as { questionId: string; body: string });

test("a Closeout stall asked while another question is open is delivered after its answer", () => {
  const { db, asker } = parked();
  const open = ask(db, asker, "runner-wait", "Move or keep waiting?", { now: NOW });
  askCloseoutHelp(db, "ses_1", help("Closeout: blocked\nMessage: stalled"), { now: NOW + 1 });
  const queued = listCloseoutRecoveries(db, asker.itemId)[0]!;
  expect(getQuestion(db, queued.questionId)).toMatchObject({
    kind: "closeout-help",
    status: "queued",
  });
  expect(delivered(db).map((payload) => payload.questionId)).toEqual([open.question.id]);

  answer(db, reply("Keep waiting"), questionEffects(db, { now: NOW + 100 }));

  expect(findOpenQuestion(db, "ses_1")?.id).toBe(queued.questionId);
  expect(delivered(db).at(-1)?.body).toContain("Closeout needs your help.");
});

test("a policy field this Paws does not know asks for a Paws update", () => {
  const { db } = parked();
  askCloseoutHelp(
    db,
    "ses_1",
    help(
      "Closeout: blocked\nMessage: .agents/closeout.yaml: /retry must NOT have additional properties ('maxFailedReviewAttempts' was unexpected)",
    ),
    { now: NOW },
  );
  expect(delivered(db)[0]?.body).toContain(
    "The Closeout policy on origin/main uses `maxFailedReviewAttempts`, which this version of Paws does not support. Update Paws, then reply retry.",
  );
});

test("other blocked policies keep the usual Closeout question", () => {
  const { db } = parked();
  askCloseoutHelp(db, "ses_1", help("Closeout: blocked\nMessage: invalid YAML"), { now: NOW });
  expect(delivered(db)[0]?.body).not.toContain("Update Paws");
  expect(delivered(db)[0]?.body).toContain("Reply with guidance");
});

test("the Closeout help question names the task as its Linear identifier", () => {
  const { db } = parked();
  const pathId = "PAS-367-01M5NDWPQZ0JQ91E1MFMVEY6EP";
  const summary = formatEvidenceSummary({
    outcome: "exhausted",
    taskId: pathId,
    taskLabel: "PAS-367",
    base: "base",
    head: "head",
    fixAttempts: 3,
    evaluations: 4,
    exitCode: 1,
    decision: null,
  });
  askCloseoutHelp(db, "ses_1", { ...help(summary), taskId: pathId }, { now: NOW });
  const body = delivered(db)[0]?.body ?? "";
  expect(body).toContain("Task: PAS-367\n");
  expect(body).not.toContain("01M5NDWPQZ0JQ91E1MFMVEY6EP");
});

test("a CI help answer resumes the agent with the handoff", () => {
  const { db, asker } = parked();
  const { question } = ask(db, asker, "ci-help", "CI failed on the pull request.", { now: NOW });
  answer(db, reply("Fix the flaky test"), questionEffects(db, { now: NOW + 100 }));
  expect(getWorkItem(db, asker.itemId)?.state).toBe("queued");
  expect(jobs(db).map((job) => job.jobKey)).toEqual([`resume:answer:${question.id}`]);
});
