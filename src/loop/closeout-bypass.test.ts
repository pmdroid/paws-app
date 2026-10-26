import { expect, test } from "bun:test";
import { JOB_KIND } from "../core";
import {
  applyWorkItemEvent,
  beginImplementRun,
  getLinkAsk,
  getWorkItem,
  insertQueuedItem,
  listCloseoutBypassChecks,
  listCloseoutRecoveries,
  listJobs,
  listOutbox,
  migrate,
  openDatabase,
  saveCheckpoint,
} from "../db";
import { bypassSummary } from "../closeout/bypass";
import { findOpenQuestion, getQuestion } from "../questions";
import { saveSchedulingContext } from "../scheduler";
import { askCloseoutHelp } from "./closeout-help";
import { recoveryOptions } from "./closeout-recovery";
import {
  BYPASS_REPLY_NOTE,
  decideLinkAsk,
  guideLinkAsk,
  reverifyBypassed,
  type LinkAskEffects,
} from "./link-ask";

const NOW = 1_700_000_000_000;
const HEAD = "7f65200aa1b2c3d4e5f6";
const LINK = "https://paws.example/status/issues/PAS-633#closeout";

function blocked(publicUrl: string | null = "https://paws.example") {
  const db = openDatabase(":memory:");
  migrate(db);
  const item = insertQueuedItem(db, { id: "PAS-633", sessionKey: "ses_1", title: "Signed URLs" });
  beginImplementRun(db, item.id, NOW - 10);
  applyWorkItemEvent(db, item.id, "turn_ended");
  saveCheckpoint(db, item.id, { phase: "verifying", baseSha: "base", wipCommit: HEAD });
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
    "Lea Lead",
    "lea@example.com",
  ]);
  askCloseoutHelp(
    db,
    "ses_1",
    {
      itemId: item.id,
      taskId: "PAS-633",
      base: "base",
      head: HEAD,
      policyDigest: "sha256:0eadf4c",
      failedChecks: ["independent-review", "test"],
      retryBaseline: ["test:1"],
      summary: "Closeout: exhausted",
    },
    {
      now: NOW,
      publicUrl,
      checks: [
        { id: "lint", kind: "command", state: "passed", attempt: 1, message: "exited 0" },
        {
          id: "independent-review",
          kind: "review",
          state: "failed",
          attempt: 1,
          message: "review findings block",
        },
        { id: "test", kind: "command", state: "exhausted", attempt: 3, message: "exited 1" },
      ],
    },
  );
  const question = findOpenQuestion(db, "ses_1")!;
  return { db, itemId: item.id, question };
}

const actor = { workspaceId: "ws", userId: "user-lead", name: "Lea Lead" };
const effects: (db: ReturnType<typeof openDatabase>) => LinkAskEffects = (db) => ({
  bypass: (linkAsk, item, now) => reverifyBypassed(db, linkAsk, item, now),
});

test("Closeout help is a bypass link ask with the failed checks of the head", () => {
  const { db, itemId, question } = blocked();
  expect(question.kind).toBe("link");
  expect(getLinkAsk(db, question.id)).toMatchObject({
    kind: "bypass",
    headCommit: HEAD,
    link: LINK,
    answerers: ["delegator", "lead"],
  });
  expect(question.body).toContain(`Decide in Paws: ${LINK}`);
  expect(question.body).toContain("2 checks failed (independent-review, test)");
  expect(question.body).not.toContain("/paws bypass");
  expect(listCloseoutRecoveries(db, itemId)[0]?.questionId).toBe(question.id);
  expect(
    listCloseoutBypassChecks(db, question.id).map(({ checkId, kind, state, attempt }) => ({
      checkId,
      kind,
      state,
      attempt,
    })),
  ).toEqual([
    { checkId: "independent-review", kind: "review", state: "failed", attempt: 1 },
    { checkId: "test", kind: "command", state: "exhausted", attempt: 3 },
  ]);
  expect(getWorkItem(db, itemId)?.state).toBe("awaiting_input");
});

test("bypassing from the page writes the rows and verifies the same head again", () => {
  const { db, itemId, question } = blocked();
  expect(
    decideLinkAsk(
      db,
      {
        questionId: question.id,
        decision: "approve",
        note: null,
        bypasses: [{ checkId: "independent-review", reason: " Smoke run moved to PAS-744. " }],
        answeredBy: "lead",
        actor,
        now: NOW + 100,
      },
      effects(db),
    ),
  ).toBe("answered");
  expect(getWorkItem(db, itemId)).toMatchObject({
    state: "verifying",
    checkpoint: { phase: "verifying", baseSha: "base", wipCommit: HEAD },
  });
  expect(listJobs(db).map((job) => [job.queue, job.jobKey])).toContainEqual([
    JOB_KIND.reverify,
    `closeout-bypass:${question.id}`,
  ]);
  expect(listJobs(db).some((job) => job.queue === JOB_KIND.resume)).toBe(false);
  expect(listCloseoutBypassChecks(db, question.id)[0]).toMatchObject({
    checkId: "independent-review",
    reason: "Smoke run moved to PAS-744.",
    approvedBy: "lead",
    approvedByName: "Lea Lead",
    approvedAt: NOW + 100,
  });
  expect(listCloseoutBypassChecks(db, question.id)[1]?.approvedAt).toBeNull();
  const { bypasses } = recoveryOptions(db, itemId);
  expect(bypasses).toEqual([
    {
      questionId: question.id,
      taskId: "PAS-633",
      base: "base",
      head: HEAD,
      policyDigest: "sha256:0eadf4c",
      checkIds: ["independent-review"],
      actor: "lead",
      actorName: "Lea Lead",
      reason: "Smoke run moved to PAS-744.",
    },
  ]);
  expect(db.query("SELECT action, subject FROM workspace_access_audit").all() as unknown[]).toEqual(
    [
      {
        action: "decision.bypass.approve",
        subject: "PAS-633 · 7f65200 · independent-review: Smoke run moved to PAS-744.",
      },
    ],
  );
  expect(bypassSummary(bypasses)).toBe(
    [
      "Bypassed checks:",
      `- independent-review: Smoke run moved to PAS-744. — approved by Lea Lead in Paws for head ${HEAD} and policy sha256:0eadf4c (question ${question.id}).`,
    ].join("\n"),
  );
});

test("a bypass needs offered checks, each once, each with a reason", () => {
  const { db, itemId, question } = blocked();
  for (const bypasses of [
    [],
    [{ checkId: "lint", reason: "Passed anyway" }],
    [{ checkId: "test", reason: "  " }],
    [
      { checkId: "test", reason: "Flaky" },
      { checkId: "test", reason: "Flaky" },
    ],
  ])
    expect(
      decideLinkAsk(
        db,
        {
          questionId: question.id,
          decision: "approve",
          note: "Bypass it",
          bypasses,
          answeredBy: "delegator",
          actor,
          now: NOW + 100,
        },
        effects(db),
      ),
    ).toBe("rejected");
  expect(getQuestion(db, question.id)?.status).toBe("open");
  expect(getWorkItem(db, itemId)?.state).toBe("awaiting_input");
  expect(recoveryOptions(db, itemId).bypasses).toEqual([]);
});

test("someone who did not delegate and does not lead the project cannot bypass", () => {
  const { db, itemId, question } = blocked();
  expect(
    decideLinkAsk(
      db,
      {
        questionId: question.id,
        decision: "approve",
        note: null,
        bypasses: [{ checkId: "test", reason: "Looks fine to me" }],
        answeredBy: "agent-bot",
        actor,
        now: NOW + 100,
      },
      effects(db),
    ),
  ).toBe("forbidden");
  expect(getQuestion(db, question.id)?.status).toBe("open");
  expect(listCloseoutBypassChecks(db, question.id).every((check) => !check.approvedBy)).toBe(true);
  expect(recoveryOptions(db, itemId).bypasses).toEqual([]);
});

test("a /paws bypass reply in Linear is guidance and gets the link back once", () => {
  const { db, itemId, question } = blocked();
  expect(
    guideLinkAsk(db, {
      questionId: question.id,
      eventKey: "activity:bypass",
      body: "/paws bypass test -- Known fixture failure",
      answeredBy: "lead",
      now: NOW + 100,
    }),
  ).toBe(true);
  expect(getLinkAsk(db, question.id)).toMatchObject({ decision: null, closedReason: "guidance" });
  expect(getWorkItem(db, itemId)?.state).toBe("queued");
  expect(listJobs(db).some((job) => job.queue === JOB_KIND.reverify)).toBe(false);
  expect(recoveryOptions(db, itemId)).toEqual({ retryBaseline: ["test:1"], bypasses: [] });
  const notes = listOutbox(db).filter((row) => row.idempotencyKey.startsWith("link-ask-guidance:"));
  expect(notes.map((row) => (row.payload as { body: string }).body)).toEqual([
    `${BYPASS_REPLY_NOTE} ${LINK}`,
  ]);
});

test("guidance from the page restarts the agent and authorizes a new round", () => {
  const { db, itemId, question } = blocked();
  expect(
    decideLinkAsk(
      db,
      {
        questionId: question.id,
        decision: "changes",
        note: "Record the smoke run instead.",
        answeredBy: "delegator",
        actor,
        now: NOW + 100,
      },
      effects(db),
    ),
  ).toBe("answered");
  expect(getWorkItem(db, itemId)?.state).toBe("queued");
  const resume = listJobs(db).find((job) => job.queue === JOB_KIND.resume)!;
  expect((resume.payload as { handoff: string }).handoff).toContain(
    "Record the smoke run instead.",
  );
  expect(recoveryOptions(db, itemId)).toEqual({ retryBaseline: ["test:1"], bypasses: [] });
});

test("without a public link, Closeout help is a Linear question that cannot bypass", () => {
  const { db, question } = blocked(null);
  expect(question.kind).toBe("closeout-help");
  expect(getLinkAsk(db, question.id)).toBeNull();
  expect(question.body).toContain("A reply here cannot bypass a check.");
  expect(question.body).not.toContain("/paws bypass");
});
