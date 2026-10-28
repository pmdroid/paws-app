import { expect, test } from "bun:test";
import { JOB_KIND } from "../core";
import {
  applyWorkItemEvent,
  beginImplementRun,
  getLinkAsk,
  getWorkItem,
  insertQueuedItem,
  listCloseoutBypassChecks,
  listJobs,
  listOutbox,
  migrate,
  openDatabase,
  saveCheckpoint,
} from "../db";
import { findOpenQuestion, getQuestion } from "../questions";
import { saveSchedulingContext } from "../scheduler";
import { askCloseoutHelp } from "./closeout-help";
import { recoveryOptions } from "./closeout-recovery";
import {
  decideLinkAsk,
  guideLinkAsk,
  reverifyBypassed,
  RULE_REPLY_NOTE,
  type LinkAskEffects,
} from "./link-ask";

const NOW = 1_700_000_000_000;
const HEAD = "7f65200aa1b2c3d4e5f6";
const LINK = "https://paws.example/status/issues/PAS-633#rule";
const FEEDBACK =
  "Closeout rejected at 7f65200aa1b2c3d4e5f6.\n- api-contract (rule): failed — probe exited 1; P1 finding\n\napi-contract output:\nremoved field Task.title";

/** PAS-633 broke `api-contract`, a rule set to `onFail: approve`, and nothing else failed. */
function held(publicUrl: string | null = "https://paws.example") {
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
      failedChecks: ["api-contract"],
      retryBaseline: ["api-contract:1"],
      summary: "Closeout: exhausted",
    },
    {
      now: NOW,
      publicUrl,
      reason: "rule_approval",
      rules: [
        {
          id: "api-contract",
          summary: "No removed field or route, new required input, or narrowed type.",
          message: "probe exited 1; P1 finding",
          attempt: 1,
          feedback: FEEDBACK,
        },
      ],
      checks: [
        {
          id: "api-contract",
          kind: "rule",
          state: "failed",
          attempt: 1,
          message: "probe exited 1; P1 finding",
        },
      ],
    },
  );
  const question = findOpenQuestion(db, "ses_1")!;
  return { db, itemId: item.id, question };
}

const actor = { workspaceId: "ws", userId: "user-lead", name: "Lea Lead" };
const effects: (db: ReturnType<typeof openDatabase>) => LinkAskEffects = (db) => ({
  rule: (linkAsk, item, now) => reverifyBypassed(db, linkAsk, item, now),
});

test("a broken approve rule is a rule link ask with its summary and the link", () => {
  const { db, itemId, question } = held();
  expect(getWorkItem(db, itemId)?.state).toBe("awaiting_input");
  expect(question.kind).toBe("link");
  expect(getLinkAsk(db, question.id)).toMatchObject({
    kind: "rule",
    headCommit: HEAD,
    link: LINK,
    answerers: ["delegator", "lead"],
  });
  expect(question.body).toContain("**A rule broke on 7f65200 and needs your decision.**");
  expect(question.body).toContain(
    "Rule api-contract broke: No removed field or route, new required input, or narrowed type. Finding: probe exited 1; P1 finding.",
  );
  expect(question.body).toContain(`Decide in Paws: ${LINK}`);
  expect(question.body).toContain("A reply here cannot approve the break.");
  // The probe output stays out of Linear; the agent gets it on a send back.
  expect(question.body).not.toContain("removed field Task.title");
  expect(listCloseoutBypassChecks(db, question.id)).toMatchObject([
    { checkId: "api-contract", kind: "rule", state: "failed", attempt: 1, message: FEEDBACK },
  ]);
  expect(listJobs(db).some((job) => job.queue === JOB_KIND.resume)).toBe(false);
});

test("Approve records who and why and verifies the same head again", () => {
  const { db, itemId, question } = held();
  expect(
    decideLinkAsk(
      db,
      {
        questionId: question.id,
        decision: "approve",
        note: " The contract change is intended for v2. ",
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
    reason: "The contract change is intended for v2.",
    approvedBy: "lead",
    approvedByName: "Lea Lead",
    approvedAt: NOW + 100,
  });
  // Bound to the task, base, head and policy; applyBypasses passes it for that head only.
  expect(recoveryOptions(db, itemId).bypasses).toEqual([
    {
      questionId: question.id,
      taskId: "PAS-633",
      base: "base",
      head: HEAD,
      policyDigest: "sha256:0eadf4c",
      checkIds: ["api-contract"],
      actor: "lead",
      actorName: "Lea Lead",
      reason: "The contract change is intended for v2.",
    },
  ]);
  expect(db.query("SELECT action, subject FROM workspace_access_audit").all() as unknown[]).toEqual(
    [
      {
        action: "decision.rule.approve",
        subject: "PAS-633 · 7f65200 · The contract change is intended for v2.",
      },
    ],
  );
  const notes = listOutbox(db).filter((row) => row.idempotencyKey.startsWith("link-ask-decided:"));
  expect(notes.map((row) => (row.payload as { body: string }).body)).toEqual([
    "Lea Lead approved the rule break on 7f65200 in Paws: The contract change is intended for v2.",
  ]);
});

test("Approve needs a reason and a person who may decide", () => {
  const { db, itemId, question } = held();
  for (const note of [null, "  "])
    expect(
      decideLinkAsk(
        db,
        { questionId: question.id, decision: "approve", note, answeredBy: "lead", actor, now: NOW },
        effects(db),
      ),
    ).toBe("rejected");
  expect(
    decideLinkAsk(
      db,
      {
        questionId: question.id,
        decision: "approve",
        note: "Fine by me",
        answeredBy: "agent-bot",
        actor,
        now: NOW,
      },
      effects(db),
    ),
  ).toBe("forbidden");
  expect(getQuestion(db, question.id)?.status).toBe("open");
  expect(getWorkItem(db, itemId)?.state).toBe("awaiting_input");
  expect(recoveryOptions(db, itemId).bypasses).toEqual([]);
});

test("Send back restarts the agent with the finding", () => {
  const { db, itemId, question } = held();
  expect(
    decideLinkAsk(
      db,
      {
        questionId: question.id,
        decision: "changes",
        note: "Keep Task.title; add the new field beside it.",
        answeredBy: "delegator",
        actor,
        now: NOW + 100,
      },
      effects(db),
    ),
  ).toBe("answered");
  expect(getWorkItem(db, itemId)?.state).toBe("queued");
  const handoff = (
    listJobs(db).find((job) => job.queue === JOB_KIND.resume)!.payload as { handoff: string }
  ).handoff;
  expect(handoff).toContain("Keep Task.title; add the new field beside it.");
  expect(handoff).toContain("removed field Task.title");
  expect(handoff).toContain("api-contract (rule): failed");
  expect(listJobs(db).some((job) => job.queue === JOB_KIND.reverify)).toBe(false);
  expect(recoveryOptions(db, itemId)).toEqual({ retryBaseline: ["api-contract:1"], bypasses: [] });
});

test("a reply in Linear sends the finding back and approves nothing", () => {
  const { db, itemId, question } = held();
  expect(
    guideLinkAsk(db, {
      questionId: question.id,
      eventKey: "activity:approve",
      body: "Approved, ship it",
      answeredBy: "lead",
      now: NOW + 100,
    }),
  ).toBe(true);
  expect(getLinkAsk(db, question.id)).toMatchObject({ decision: null, closedReason: "guidance" });
  expect(getWorkItem(db, itemId)?.state).toBe("queued");
  expect(listJobs(db).some((job) => job.queue === JOB_KIND.reverify)).toBe(false);
  const handoff = (
    listJobs(db).find((job) => job.queue === JOB_KIND.resume)!.payload as { handoff: string }
  ).handoff;
  expect(handoff).toContain("The reply is guidance and approves nothing");
  expect(handoff).toContain("removed field Task.title");
  expect(listCloseoutBypassChecks(db, question.id)[0]?.approvedAt).toBeNull();
  expect(recoveryOptions(db, itemId).bypasses).toEqual([]);
  const notes = listOutbox(db).filter((row) => row.idempotencyKey.startsWith("link-ask-guidance:"));
  expect(notes.map((row) => (row.payload as { body: string }).body)).toEqual([
    `${RULE_REPLY_NOTE} ${LINK}`,
  ]);
});

test("without a public link the rule is a Linear question a reply sends back", () => {
  const { db, itemId, question } = held(null);
  expect(question.kind).toBe("closeout-help");
  expect(getLinkAsk(db, question.id)).toBeNull();
  expect(getWorkItem(db, itemId)?.state).toBe("awaiting_input");
});
