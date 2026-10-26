import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { approvalsAtHead, type ResolvedEvidence } from "../closeout";
import { JOB_KIND } from "../core";
import {
  applyWorkItemEvent,
  beginImplementRun,
  getLinkAsk,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  listOutbox,
  listVisualReviewMarks,
  migrate,
  openDatabase,
  saveEvidence,
} from "../db";
import { findOpenQuestion, getVisualReview, LINK_ASK_REMINDER_MS } from "../questions";
import { saveSchedulingContext } from "../scheduler";
import { closeLinkAsksOnHead, decideLinkAsk, guideLinkAsk } from "./link-ask";
import { awaitQuestion } from "./operations";
import {
  askForVisualReview,
  dueVisualReview,
  pendingVisualReview,
  VISUAL_REVIEW_REPLY_NOTE,
  visualReviewApprovals,
} from "./visual-review";

const NOW = 1_700_000_000_000;
const HEAD = "4b317d5aa1b2c3d4e5f6";
const REQUIREMENT: ResolvedEvidence = {
  id: "visual-proof",
  kind: "evidence",
  gate: "beforePR",
  media: ["image"],
  minimum: 1,
  approval: "human",
  paths: ["web/"],
};
const actor = { workspaceId: "ws", userId: "user-lead", name: "Lea" };

function evidence(db: ReturnType<typeof openDatabase>, itemId: string, runId: string) {
  for (const [id, name] of [
    ["ev-1", "Settings · Audit · 1440px"],
    ["ev-2", "Settings · Audit · 390px"],
  ] as const)
    saveEvidence(db, {
      id,
      itemId,
      runId,
      checkId: "visual-proof",
      attempt: 1,
      mediaType: "image/png",
      sizeBytes: 10,
      sha256: id.padEnd(64, "0"),
      displayName: name,
      headCommit: HEAD,
      createdAt: NOW - 5,
    });
}

/** The item verifies head S with its screenshots published; Paws can hand out an https link. */
function reviewing() {
  const db = openDatabase(":memory:");
  migrate(db);
  const item = insertQueuedItem(db, { id: "ENG-103", sessionKey: "ses_1", title: "Signed URLs" });
  const { run } = beginImplementRun(db, item.id, NOW - 10);
  applyWorkItemEvent(db, item.id, "turn_ended");
  db.run("UPDATE work_item SET delegated_by = 'delegator' WHERE id = ?", [item.id]);
  saveSchedulingContext(db, { itemId: item.id, projectId: "project", projectLeadId: "lead" });
  db.run("INSERT INTO workspace (id, linear_organization_id, name, created_at) VALUES (?,?,?,?)", [
    "ws",
    "org",
    "Kyku",
    NOW,
  ]);
  db.run("INSERT INTO workspace_user (id, linear_user_id, name, email) VALUES (?,?,?,?)", [
    "user-lead",
    "lead",
    "Lea",
    "lea@example.com",
  ]);
  evidence(db, item.id, run.id);
  const asked = askForVisualReview(db, {
    item: getWorkItem(db, item.id)!,
    runId: run.id,
    sessionId: "ses_1",
    checkId: "visual-proof",
    evidenceIds: ["ev-1", "ev-2"],
    base: "base",
    head: HEAD,
    publicUrl: "https://paws.example/",
    now: NOW,
  });
  expect(asked).toBe(true);
  return { db, itemId: item.id, question: findOpenQuestion(db, "ses_1")! };
}

test("the visual review is a link ask without options, reminded once from the shared link ask", () => {
  const { db, itemId, question } = reviewing();
  // Asked beside the other checks: the item keeps verifying.
  expect(getWorkItem(db, itemId)?.state).toBe("verifying");
  expect(question.kind).toBe("link");
  expect(getLinkAsk(db, question.id)).toMatchObject({
    kind: "screenshots",
    headCommit: HEAD,
    link: "https://paws.example/status/issues/ENG-103#visual-review",
    answerers: ["delegator", "lead"],
    detail:
      "2 changed screens for visual-proof: Settings · Audit · 1440px, Settings · Audit · 390px.",
  });
  expect(getVisualReview(db, question.id)).toMatchObject({
    evidenceIds: ["ev-1", "ev-2"],
    headCommit: HEAD,
    outcome: null,
  });
  expect(pendingVisualReview(db, getWorkItem(db, itemId)!)?.question.id).toBe(question.id);
  const elicitations = listOutbox(db).filter((row) => row.op === "elicitation");
  expect(elicitations).toHaveLength(1);
  const payload = elicitations[0]!.payload as { options: unknown[]; body: string };
  expect(payload.options).toEqual([]);
  expect(payload.body).toContain(
    "Decide in Paws: https://paws.example/status/issues/ENG-103#visual-review",
  );
  expect(payload.body).toContain("A reply here cannot approve the screens.");
  expect(listJobs(db).map((job) => [job.queue, job.runAt])).toEqual([
    [JOB_KIND.linkAskReminder, NOW + LINK_ASK_REMINDER_MS],
  ]);
});

test("Approve on the page passes the check for that head and those files", () => {
  const { db, itemId, question } = reviewing();
  const outcome = decideLinkAsk(db, {
    questionId: question.id,
    decision: "approve",
    note: null,
    answeredBy: "lead",
    actor,
    now: NOW + 100,
  });
  expect(outcome).toBe("answered");
  expect(getVisualReview(db, question.id)).toMatchObject({
    outcome: "accepted",
    answeredBy: "lead",
    headCommit: HEAD,
  });
  expect(visualReviewApprovals(db, itemId, "ENG-103")).toMatchObject([
    { checkId: "visual-proof", evidenceIds: ["ev-1", "ev-2"], approvedBy: "lead", commit: HEAD },
  ]);
  expect(
    dueVisualReview(db, itemId, [REQUIREMENT], visualReviewApprovals(db, itemId, "ENG-103")),
  ).toBeNull();
  // The evaluation still running on S picks the approval up; nothing restarts.
  expect(getWorkItem(db, itemId)?.state).toBe("verifying");
  expect(listJobs(db).filter((job) => job.queue === JOB_KIND.resume)).toEqual([]);
  const notes = listOutbox(db).filter((row) => row.op === "activity");
  expect(notes.map((row) => (row.payload as { body: string }).body)).toContain(
    "Lea accepted the screens of 4b317d5 in Paws.",
  );
});

test("Approve after the other checks finished completes the evaluation of the same head", () => {
  const { db, itemId, question } = reviewing();
  awaitQuestion(db, getWorkItem(db, itemId)!, question, NOW + 50);
  expect(getWorkItem(db, itemId)?.state).toBe("awaiting_input");
  decideLinkAsk(db, {
    questionId: question.id,
    decision: "approve",
    note: null,
    answeredBy: "delegator",
    actor,
    now: NOW + 100,
  });
  expect(getWorkItem(db, itemId)?.state).toBe("verifying");
  expect(
    listJobs(db)
      .filter((job) => job.queue === JOB_KIND.reverify)
      .map((job) => [job.jobKey, job.payload]),
  ).toEqual([[`visual-review-accepted:${question.id}`, { itemId, decide: true }]]);
});

test("someone else cannot approve on the page", () => {
  const { db, question } = reviewing();
  expect(
    decideLinkAsk(db, {
      questionId: question.id,
      decision: "approve",
      note: null,
      answeredBy: "someone",
      actor,
      now: NOW + 100,
    }),
  ).toBe("forbidden");
  expect(getVisualReview(db, question.id)?.outcome).toBeNull();
});

test("Request changes on the page restarts the item with the marks and the note", () => {
  const { db, itemId, question } = reviewing();
  const marks = [
    {
      id: "mark-1",
      questionId: question.id,
      evidenceId: "ev-2",
      sizeBytes: 12,
      sha256: "a".repeat(64),
      createdAt: NOW + 90,
    },
  ];
  const outcome = decideLinkAsk(db, {
    questionId: question.id,
    decision: "changes",
    note: "The Retry button wraps under the row.",
    answeredBy: "lead",
    actor,
    marks,
    now: NOW + 100,
  });
  expect(outcome).toBe("answered");
  expect(getVisualReview(db, question.id)).toMatchObject({
    outcome: "changes_requested",
    feedback: "The Retry button wraps under the row.",
  });
  expect(listVisualReviewMarks(db, question.id).map((mark) => mark.id)).toEqual(["mark-1"]);
  expect(getWorkItem(db, itemId)?.state).toBe("queued");
  const [resume] = listJobs(db).filter((job) => job.queue === JOB_KIND.resume);
  const handoff = (resume!.payload as { handoff: string }).handoff;
  expect(handoff).toContain("The Retry button wraps under the row.");
  expect(handoff).toContain("Settings · Audit · 390px (evidence ev-2");
  expect((resume!.payload as { reason: string }).reason).toBe("review");
});

test("a Linear reply that says approve requests changes and never approves", () => {
  const { db, itemId, question } = reviewing();
  const guided = guideLinkAsk(db, {
    questionId: question.id,
    eventKey: "activity:reply",
    body: "approve",
    answeredBy: "lead",
    now: NOW + 100,
  });
  expect(guided).toBe(true);
  expect(getVisualReview(db, question.id)).toMatchObject({
    outcome: "changes_requested",
    feedback: "approve",
  });
  expect(visualReviewApprovals(db, itemId, "ENG-103")).toEqual([]);
  expect(getLinkAsk(db, question.id)).toMatchObject({ closedReason: "guidance", decision: null });
  expect(getWorkItem(db, itemId)?.state).toBe("queued");
  const [resume] = listJobs(db).filter((job) => job.queue === JOB_KIND.resume);
  expect((resume!.payload as { handoff: string }).handoff).toContain(
    "The reviewer requested changes in the visual review of check visual-proof:\napprove",
  );
  const notes = listOutbox(db).filter((row) => row.op === "activity");
  expect(notes.map((row) => (row.payload as { body: string }).body)).toContain(
    VISUAL_REVIEW_REPLY_NOTE,
  );
});

test("a new head closes the open ask unless it has the same patch", () => {
  const { db, itemId, question } = reviewing();
  expect(closeLinkAsksOnHead(db, itemId, "rebased", NOW + 10, [question.id])).toBe(0);
  expect(getLinkAsk(db, question.id)?.closedAt).toBeNull();
  expect(closeLinkAsksOnHead(db, itemId, "different", NOW + 20)).toBe(1);
  expect(getLinkAsk(db, question.id)?.closedReason).toBe("head_moved");
  expect(findOpenQuestion(db, "ses_1")).toBeNull();
});

let repo: string | null = null;
afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
  repo = null;
});

test("a later commit with a different patch asks again", async () => {
  repo = mkdtempSync(path.join(tmpdir(), "paws-visual-review-"));
  const dir = repo;
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(
      ["git", "-c", "user.name=Paws Test", "-c", "user.email=paws-test@example.invalid", ...args],
      { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  const commit = (text: string) => {
    mkdirSync(path.join(dir, "web"), { recursive: true });
    writeFileSync(path.join(dir, "web/page.tsx"), `${text}\n`);
    git("add", "-A");
    git("commit", "-q", "--no-gpg-sign", "-m", text);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  const base = commit("base");
  const approved = commit("retry button on one line");
  const { db, itemId, question } = reviewing();
  db.run("UPDATE link_ask SET head_commit = ? WHERE question_id = ?", [approved, question.id]);
  decideLinkAsk(db, {
    questionId: question.id,
    decision: "approve",
    note: null,
    answeredBy: "lead",
    actor,
    now: NOW + 100,
  });
  const approvals = visualReviewApprovals(db, itemId, "ENG-103");
  expect(await approvalsAtHead(dir, approved, approvals, [REQUIREMENT], undefined, base)).toEqual(
    approvals,
  );
  const changed = commit("retry button wraps again");
  const kept = await approvalsAtHead(dir, changed, approvals, [REQUIREMENT], undefined, base);
  expect(kept).toEqual([]);
  expect(dueVisualReview(db, itemId, [REQUIREMENT], kept)?.evidenceIds).toEqual(["ev-1", "ev-2"]);
});
