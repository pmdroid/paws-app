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
import { askCloseoutHelp, questionEffects, verifyAgain } from "../src/loop";
import { recoveryOptions } from "../src/loop/closeout-recovery";
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

test("a /paws bypass reply is guidance: it restarts the agent and bypasses nothing", async () => {
  const { db, asker, question } = closeoutHelp();
  const body = "/paws bypass test -- Known fixture failure";
  answer(db, reply(body), questionEffects(db, { now: NOW + 100 }));
  expect(getWorkItem(db, asker.itemId)?.state).toBe("queued");
  expect(jobs(db)).toEqual([
    {
      queue: JOB_KIND.resume,
      jobKey: `closeout-guidance:${question.id}`,
      payload: {
        itemId: asker.itemId,
        runId: asker.runId,
        handoff: handoffNote({ question: "Closeout: rejected", answer: body }),
        reason: "answer",
      },
    },
  ]);
  expect(await recoveryOptions(db, asker.itemId)).toEqual({
    retryBaseline: ["test:1"],
    bypasses: [],
  });
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

test("a Closeout stall asked while another question is open is delivered after its answer", async () => {
  const { db, asker } = parked();
  const open = ask(db, asker, "runner-wait", "Move or keep waiting?", { now: NOW });
  await askCloseoutHelp(db, "ses_1", help("Closeout: blocked\nMessage: stalled"), { now: NOW + 1 });
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

test("a policy field this Paws does not know asks for a Paws update", async () => {
  const { db } = parked();
  await askCloseoutHelp(
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

test("other blocked policies keep the usual Closeout question", async () => {
  const { db } = parked();
  await askCloseoutHelp(db, "ses_1", help("Closeout: blocked\nMessage: invalid YAML"), {
    now: NOW,
  });
  expect(delivered(db)[0]?.body).not.toContain("Update Paws");
  expect(delivered(db)[0]?.body).toContain("Reply with guidance");
});

test("the Closeout help question names the task as its Linear identifier", async () => {
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
  await askCloseoutHelp(db, "ses_1", { ...help(summary), taskId: pathId }, { now: NOW });
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

const blocked = {
  ...help("Closeout: blocked\nMessage: .agents/closeout.yaml could not be read"),
  retryBaseline: ["test:1"],
};

async function askedAbout(
  checks: { id: string; kind: string; state: string; message: string }[],
  reason = "blocked_check",
) {
  const { db, asker } = parked();
  await askCloseoutHelp(db, "ses_1", blocked, { now: NOW, reason, checks });
  const question = getQuestion(db, listCloseoutRecoveries(db, asker.itemId)[0]!.questionId)!;
  return { db, asker, question };
}

const runs = (db: ReturnType<typeof tempDb>) =>
  db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM run").get()!.count;

for (const body of ["Retry Closeout", "  RETRY "])
  test(`${JSON.stringify(body)} on a question blocked on an unreadable policy re-verifies the head without the agent`, async () => {
    const { db, asker, question } = await askedAbout([]);
    expect(question.options).toEqual(["Retry Closeout"]);
    expect(delivered(db)[0]?.body).toContain("Choose Retry Closeout, or reply retry");
    answer(db, reply(body), questionEffects(db, { now: NOW + 100 }));
    expect(getWorkItem(db, asker.itemId)?.state).toBe("verifying");
    expect(jobs(db)).toEqual([
      {
        queue: JOB_KIND.reverify,
        jobKey: `retry-closeout:${question.id}`,
        payload: { itemId: asker.itemId },
      },
    ]);
    expect(runs(db)).toBe(1);
    expect(getQuestion(db, question.id)).toMatchObject({
      answer: "Retry Closeout",
      answeredBy: "pascal",
    });
    expect((await recoveryOptions(db, asker.itemId)).retryBaseline).toEqual([]);
  });

test("a longer reply to that question is guidance and restarts the agent with it", async () => {
  const { db, asker, question } = await askedAbout([
    { id: "test", kind: "command", state: "failed", message: "command timed out" },
  ]);
  expect(question.options).toEqual(["Retry Closeout"]);
  answer(db, reply("retry, but also fix X"), questionEffects(db, { now: NOW + 100 }));
  expect(getWorkItem(db, asker.itemId)?.state).toBe("queued");
  expect(jobs(db)).toMatchObject([
    {
      queue: JOB_KIND.resume,
      jobKey: `closeout-guidance:${question.id}`,
      payload: {
        handoff: handoffNote({ question: blocked.summary, answer: "retry, but also fix X" }),
      },
    },
  ]);
});

test("a check failing on the code offers no Retry Closeout, and retry restarts the agent", async () => {
  const { db, asker, question } = await askedAbout([
    { id: "setup", kind: "setup", state: "failed", message: "setup exited 1" },
    { id: "test", kind: "command", state: "failed", message: "command exited 1" },
  ]);
  expect(question.options).toEqual([]);
  expect(delivered(db)[0]?.body).not.toContain("Retry Closeout");
  answer(db, reply("retry"), questionEffects(db, { now: NOW + 100 }));
  expect(getWorkItem(db, asker.itemId)?.state).toBe("queued");
  expect(jobs(db).map((job) => job.jobKey)).toEqual([`closeout-guidance:${question.id}`]);
});

test("blocking review findings offer no Retry Closeout", async () => {
  const { question } = await askedAbout([
    { id: "independent-review", kind: "review", state: "failed", message: "finding at P1" },
  ]);
  expect(question.options).toEqual([]);
});

test("evidence waiting for a visual review offers no Retry Closeout", async () => {
  const { question } = await askedAbout([
    {
      id: "visual-proof",
      kind: "evidence",
      state: "missing",
      message: "waiting for a visual review",
    },
  ]);
  expect(question.options).toEqual([]);
});

test("a spent Closeout retry limit offers no Retry Closeout", async () => {
  const { question } = await askedAbout([], "budget_spent");
  expect(question.options).toEqual([]);
});

test("the exported re-verify path settles an unanswered question without the agent", async () => {
  const { db, asker, question } = await askedAbout([]);
  db.run("UPDATE question SET status='answered', answer=? WHERE id=?", [
    "Retry Closeout",
    question.id,
  ]);
  verifyAgain(db, getQuestion(db, question.id)!, { now: NOW + 100, key: "policy-loaded" });
  expect(getWorkItem(db, asker.itemId)?.state).toBe("verifying");
  expect(jobs(db).map((job) => job.jobKey)).toEqual([`policy-loaded:${question.id}`]);
  expect(runs(db)).toBe(1);
});
