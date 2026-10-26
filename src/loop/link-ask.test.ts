import { expect, test } from "bun:test";
import { JOB_KIND } from "../core";
import {
  applyWorkItemEvent,
  beginImplementRun,
  getLinkAsk,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  listOutbox,
  migrate,
  openDatabase,
} from "../db";
import { findOpenQuestion, getQuestion, LINK_ASK_REMINDER_MS } from "../questions";
import { saveSchedulingContext } from "../scheduler";
import {
  askWithLink,
  closeLinkAsksOnHead,
  decideLinkAsk,
  guideLinkAsk,
  LINK_ASK_NEEDS_PUBLIC_URL,
  remindLinkAsk,
} from "./link-ask";

const NOW = 1_700_000_000_000;
const HEAD = "7f65200aa1b2c3d4e5f6";

function asked(
  publicUrl: string | null = "https://paws.example/",
  kind: "bypass" | "risk" = "bypass",
) {
  const db = openDatabase(":memory:");
  migrate(db);
  const item = insertQueuedItem(db, { id: "PAS-633", sessionKey: "ses_1", title: "Signed URLs" });
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
  const opened = askWithLink(db, {
    item: getWorkItem(db, item.id)!,
    runId: run.id,
    kind,
    head: HEAD,
    detail: "independent-review failed (P1, docs/smoke-test.md). 7 other checks passed.",
    publicUrl,
    now: NOW,
  });
  return { db, itemId: item.id, ...opened };
}

const actor = { workspaceId: "ws", userId: "user-lead", name: "Lea" };

test("a link ask opens one elicitation without options and puts the link on the session", () => {
  const { db, itemId, question, linkAsk } = asked();
  expect(getWorkItem(db, itemId)?.state).toBe("awaiting_input");
  expect(linkAsk).toMatchObject({
    kind: "bypass",
    headCommit: HEAD,
    link: "https://paws.example/status/issues/PAS-633#closeout",
    answerers: ["delegator", "lead"],
  });
  const elicitations = listOutbox(db).filter((row) => row.op === "elicitation");
  expect(elicitations).toHaveLength(1);
  expect(elicitations[0]!.payload).toEqual({
    id: question.id,
    sessionId: "ses_1",
    questionId: question.id,
    options: [],
    body: [
      "**Closeout needs your decision on 7f65200.**\nindependent-review failed (P1, docs/smoke-test.md). 7 other checks passed.",
      "Decide in Paws: https://paws.example/status/issues/PAS-633#closeout",
      "Reply here to send the agent guidance instead. A reply here cannot bypass a check.",
    ].join("\n\n"),
  });
  const links = listOutbox(db).filter((row) => row.op === "linear.session.links");
  expect(links.map((row) => row.payload)).toEqual([
    {
      sessionId: "ses_1",
      addedExternalUrls: [
        { label: "Review bypass", url: "https://paws.example/status/issues/PAS-633#closeout" },
      ],
    },
  ]);
});

test("a Paws without a public HTTPS link refuses to ask with a link", () => {
  expect(() => asked(null)).toThrow(LINK_ASK_NEEDS_PUBLIC_URL);
  expect(() => asked("http://127.0.0.1:8787")).toThrow(LINK_ASK_NEEDS_PUBLIC_URL);
});

test("an answer from someone who did not delegate and does not lead the project is refused", () => {
  const { db, itemId, question } = asked();
  expect(
    decideLinkAsk(db, {
      questionId: question.id,
      decision: "approve",
      note: null,
      answeredBy: "someone-else",
      actor,
      now: NOW + 100,
    }),
  ).toBe("forbidden");
  expect(getQuestion(db, question.id)?.status).toBe("open");
  expect(getLinkAsk(db, question.id)?.closedAt).toBeNull();
  expect(getWorkItem(db, itemId)?.state).toBe("awaiting_input");
});

test("the project lead decides on the item page: audit row, decided note, back to the agent", () => {
  const { db, itemId, question } = asked("https://paws.example/", "risk");
  expect(
    decideLinkAsk(db, {
      questionId: question.id,
      decision: "approve",
      note: "Flaky reviewer finding, docs only.",
      answeredBy: "lead",
      actor,
      now: NOW + 100,
    }),
  ).toBe("answered");
  expect(getLinkAsk(db, question.id)).toMatchObject({
    decision: "approve",
    decidedBy: "lead",
    closedReason: "decided",
  });
  expect(
    db.query("SELECT user_id AS userId, action, subject FROM workspace_access_audit").all(),
  ).toEqual([
    {
      userId: "user-lead",
      action: "decision.risk.approve",
      subject: "PAS-633 · 7f65200 · Flaky reviewer finding, docs only.",
    },
  ]);
  const notes = listOutbox(db).filter((row) => row.idempotencyKey.startsWith("link-ask-decided:"));
  expect(notes.map((row) => (row.payload as { body: string }).body)).toEqual([
    "Lea approved the high-risk changes in 7f65200 in Paws: Flaky reviewer finding, docs only.",
  ]);
  expect(
    listOutbox(db).some(
      (row) =>
        row.op === "linear.session.links" &&
        JSON.stringify(row.payload).includes('"removedExternalUrls"'),
    ),
  ).toBe(true);
  expect(getWorkItem(db, itemId)?.state).toBe("queued");
  // A second decision finds nothing open.
  expect(
    decideLinkAsk(db, {
      questionId: question.id,
      decision: "changes",
      note: "Never mind",
      answeredBy: "delegator",
      actor,
      now: NOW + 200,
    }),
  ).toBe("rejected");
});

test("a Linear reply never resolves an approval kind, whatever it says", () => {
  const { db, itemId, question } = asked();
  expect(
    guideLinkAsk(db, {
      questionId: question.id,
      eventKey: "activity:approve",
      body: "Approved. Bypass the check.",
      answeredBy: "lead",
      now: NOW + 100,
    }),
  ).toBe(true);
  const linkAsk = getLinkAsk(db, question.id)!;
  expect(linkAsk).toMatchObject({ decision: null, closedReason: "guidance" });
  expect(db.query("SELECT COUNT(*) AS n FROM workspace_access_audit").get()).toEqual({ n: 0 });
  expect(getWorkItem(db, itemId)?.state).toBe("queued");
  const resume = listJobs(db).find((job) => job.queue === JOB_KIND.resume)!;
  expect((resume.payload as { handoff: string }).handoff).toContain(
    "The reply is guidance and approves nothing",
  );
  // The dashboard cannot decide an ask a reply already closed.
  expect(
    decideLinkAsk(db, {
      questionId: question.id,
      decision: "approve",
      note: null,
      answeredBy: "lead",
      actor,
      now: NOW + 200,
    }),
  ).toBe("rejected");
});

test("the reminder fires once after 24 hours", () => {
  const { db, question } = asked();
  const job = listJobs(db).find((entry) => entry.queue === JOB_KIND.linkAskReminder)!;
  expect(job.runAt).toBe(NOW + LINK_ASK_REMINDER_MS);
  expect(remindLinkAsk(db, question.id, NOW + LINK_ASK_REMINDER_MS)).toBe(true);
  expect(remindLinkAsk(db, question.id, NOW + 2 * LINK_ASK_REMINDER_MS)).toBe(false);
  const reminders = listOutbox(db).filter((row) =>
    row.idempotencyKey.startsWith("link-ask-reminder:"),
  );
  expect(reminders).toHaveLength(1);
  expect((reminders[0]!.payload as { body: string; options: unknown[] }).options).toEqual([]);
  expect((reminders[0]!.payload as { body: string }).body).toContain(
    "Decide in Paws: https://paws.example/status/issues/PAS-633#closeout",
  );
});

test("no reminder once the ask is decided", () => {
  const { db, question } = asked();
  decideLinkAsk(db, {
    questionId: question.id,
    decision: "changes",
    note: "Fix the finding first.",
    answeredBy: "delegator",
    actor,
    now: NOW + 100,
  });
  expect(remindLinkAsk(db, question.id, NOW + LINK_ASK_REMINDER_MS)).toBe(false);
});

test("a new head closes the open ask", () => {
  const { db, question } = asked();
  expect(closeLinkAsksOnHead(db, "PAS-633", HEAD, NOW + 50)).toBe(0);
  expect(closeLinkAsksOnHead(db, "PAS-633", "4b317d5ffff", NOW + 100)).toBe(1);
  expect(getLinkAsk(db, question.id)).toMatchObject({ closedReason: "head_moved", decision: null });
  expect(getQuestion(db, question.id)?.status).toBe("cancelled");
  expect(findOpenQuestion(db, "ses_1")).toBeNull();
  expect(remindLinkAsk(db, question.id, NOW + LINK_ASK_REMINDER_MS)).toBe(false);
  expect(
    decideLinkAsk(db, {
      questionId: question.id,
      decision: "approve",
      note: null,
      answeredBy: "lead",
      actor,
      now: NOW + 200,
    }),
  ).toBe("rejected");
});
