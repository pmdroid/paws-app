import { expect, test } from "bun:test";
import { JOB_KIND } from "../src/core";
import {
  applyWorkItemEvent,
  beginImplementRun,
  getWorkItem,
  insertQueuedItem,
  listCloseoutRecoveries,
  listJobs,
  saveCheckpoint,
  saveCloseoutRecovery,
} from "../src/db";
import { questionEffects } from "../src/loop";
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
  expect(getWorkItem(db, asker.itemId)?.state).toBe("running");
  expect(jobs(db)).toEqual([
    {
      queue: JOB_KIND.resume,
      jobKey: `closeout-guidance:${question.id}`,
      payload: {
        itemId: asker.itemId,
        freshSession: true,
        handoff: handoffNote({ question: "Closeout: rejected", answer: "Create ok.txt" }),
        reason: "closeout-guidance",
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

test("a CI help answer resumes the agent with the handoff", () => {
  const { db, asker } = parked();
  const { question } = ask(db, asker, "ci-help", "CI failed on the pull request.", { now: NOW });
  answer(db, reply("Fix the flaky test"), questionEffects(db, { now: NOW + 100 }));
  expect(getWorkItem(db, asker.itemId)?.state).toBe("running");
  expect(jobs(db).map((job) => job.jobKey)).toEqual([`resume:answer:${question.id}`]);
});
