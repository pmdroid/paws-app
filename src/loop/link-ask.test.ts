import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { JOB_KIND } from "../core";
import {
  applyWorkItemEvent,
  beginImplementRun,
  getLinkAsk,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  listOutbox,
  type Db,
} from "../db";
import { findOpenQuestion, getQuestion, LINK_ASK_REMINDER_MS } from "../questions";
import { saveSchedulingContextSteps } from "../scheduler";
import {
  askWithLinkSteps,
  closeLinkAsksOnHead,
  decideLinkAsk,
  guideLinkAsk,
  LINK_ASK_NEEDS_PUBLIC_URL,
  remindLinkAsk,
} from "./link-ask";
import { seed } from "../../test/dialects";
import { tempStore } from "../../test/pglite";

const NOW = 1_700_000_000_000;
const HEAD = "7f65200aa1b2c3d4e5f6";

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

function audit(db: Db) {
  return db.run((q) =>
    q.all(
      q.orm
        .select({
          userId: q.t.workspaceAccessAudit.userId,
          action: q.t.workspaceAccessAudit.action,
          subject: q.t.workspaceAccessAudit.subject,
        })
        .from(q.t.workspaceAccessAudit),
    ),
  );
}

async function asked(
  publicUrl: string | null = "https://paws.example/",
  kind: "bypass" | "risk" = "bypass",
) {
  const { db, close } = await tempStore();
  open.push(close);
  const item = await insertQueuedItem(db, {
    id: "PAS-633",
    sessionKey: "ses_1",
    title: "Signed URLs",
  });
  const { run } = await beginImplementRun(db, item.id, NOW - 10);
  await applyWorkItemEvent(db, item.id, "turn_ended");
  await seed(
    db,
    (q) =>
      q.orm
        .update(q.t.workItem)
        .set({ delegatedBy: "delegator" })
        .where(eq(q.t.workItem.id, item.id)),
    (q) =>
      q.orm
        .insert(q.t.workspace)
        .values({ id: "ws", linearOrganizationId: "org", name: "Kyku", createdAt: NOW }),
    (q) =>
      q.orm
        .insert(q.t.workspaceUser)
        .values({ id: "user-lead", linearUserId: "lead", name: "Lea", email: "lea@example.com" }),
  );
  await db.run((q) =>
    saveSchedulingContextSteps(q, { itemId: item.id, projectId: "project", projectLeadId: "lead" }),
  );
  const current = (await getWorkItem(db, item.id))!;
  const opened = await db.transaction((q) =>
    askWithLinkSteps(q, {
      item: current,
      runId: run.id,
      kind,
      head: HEAD,
      detail: "independent-review failed (P1, docs/smoke-test.md). 7 other checks passed.",
      publicUrl,
      now: NOW,
    }),
  );
  return { db, itemId: item.id, ...opened };
}

const actor = { workspaceId: "ws", userId: "user-lead", name: "Lea" };

test("a link ask opens one elicitation without options and puts the link on the session", async () => {
  const { db, itemId, question, linkAsk } = await asked();
  expect((await getWorkItem(db, itemId))?.state).toBe("awaiting_input");
  expect(linkAsk).toMatchObject({
    kind: "bypass",
    headCommit: HEAD,
    link: "https://paws.example/dashboard/issues/PAS-633#closeout",
    answerers: ["delegator", "lead"],
  });
  const elicitations = (await listOutbox(db)).filter((row) => row.op === "elicitation");
  expect(elicitations).toHaveLength(1);
  expect(elicitations[0]!.payload).toEqual({
    id: question.id,
    sessionId: "ses_1",
    questionId: question.id,
    options: [],
    body: [
      "**Closeout needs your decision on 7f65200.**\nindependent-review failed (P1, docs/smoke-test.md). 7 other checks passed.",
      "Decide in Paws: https://paws.example/dashboard/issues/PAS-633#closeout",
      "Reply here to send the agent guidance instead. A reply here cannot bypass a check.",
    ].join("\n\n"),
  });
  const links = (await listOutbox(db)).filter((row) => row.op === "linear.session.links");
  expect(links.map((row) => row.payload)).toEqual([
    {
      sessionId: "ses_1",
      addedExternalUrls: [
        { label: "Review bypass", url: "https://paws.example/dashboard/issues/PAS-633#closeout" },
      ],
    },
  ]);
});

test("a Paws without a public HTTPS link refuses to ask with a link", async () => {
  await expect(asked(null)).rejects.toThrow(LINK_ASK_NEEDS_PUBLIC_URL);
  await expect(asked("http://127.0.0.1:8787")).rejects.toThrow(LINK_ASK_NEEDS_PUBLIC_URL);
});

test("an answer from someone who did not delegate and does not lead the project is refused", async () => {
  const { db, itemId, question } = await asked();
  expect(
    await decideLinkAsk(db, {
      questionId: question.id,
      decision: "approve",
      note: null,
      answeredBy: "someone-else",
      actor,
      now: NOW + 100,
    }),
  ).toBe("forbidden");
  expect((await getQuestion(db, question.id))?.status).toBe("open");
  expect((await getLinkAsk(db, question.id))?.closedAt).toBeNull();
  expect((await getWorkItem(db, itemId))?.state).toBe("awaiting_input");
});

test("the project lead decides on the item page: audit row, decided note, back to the merge queue", async () => {
  const { db, itemId, question } = await asked("https://paws.example/", "risk");
  expect(
    await decideLinkAsk(db, {
      questionId: question.id,
      decision: "approve",
      note: "Flaky reviewer finding, docs only.",
      answeredBy: "lead",
      actor,
      now: NOW + 100,
    }),
  ).toBe("answered");
  expect(await getLinkAsk(db, question.id)).toMatchObject({
    decision: "approve",
    decidedBy: "lead",
    closedReason: "decided",
  });
  expect(await audit(db)).toEqual([
    {
      userId: "user-lead",
      action: "decision.risk.approve",
      subject: "PAS-633 · 7f65200 · Flaky reviewer finding, docs only.",
    },
  ]);
  // A risk approval comes after the pull request response, so it is a response, not a thought.
  const notes = (await listOutbox(db)).filter((row) =>
    row.idempotencyKey.startsWith("risk-approval:"),
  );
  expect(notes.map((row) => row.payload as { kind: string; body: string })).toMatchObject([
    {
      kind: "response",
      body: "Lea approved the high-risk changes in 7f65200 in Paws. The pull request joins the merge queue.\n\nFlaky reviewer finding, docs only.",
    },
  ]);
  expect(
    (await listOutbox(db)).some(
      (row) =>
        row.op === "linear.session.links" &&
        JSON.stringify(row.payload).includes('"removedExternalUrls"'),
    ),
  ).toBe(true);
  // The approval binds to the head and never goes to the agent: Closeout completes S again.
  expect((await getWorkItem(db, itemId))?.state).toBe("verifying");
  // A second decision finds nothing open.
  expect(
    await decideLinkAsk(db, {
      questionId: question.id,
      decision: "changes",
      note: "Never mind",
      answeredBy: "delegator",
      actor,
      now: NOW + 200,
    }),
  ).toBe("rejected");
});

test("a Linear reply never resolves an approval kind, whatever it says", async () => {
  const { db, itemId, question } = await asked();
  expect(
    await guideLinkAsk(db, {
      questionId: question.id,
      eventKey: "activity:approve",
      body: "Approved. Bypass the check.",
      answeredBy: "lead",
      now: NOW + 100,
    }),
  ).toBe(true);
  const linkAsk = (await getLinkAsk(db, question.id))!;
  expect(linkAsk).toMatchObject({ decision: null, closedReason: "guidance" });
  expect(await audit(db)).toEqual([]);
  expect((await getWorkItem(db, itemId))?.state).toBe("queued");
  const resume = (await listJobs(db)).find((job) => job.queue === JOB_KIND.resume)!;
  expect((resume.payload as { handoff: string }).handoff).toContain(
    "The reply is guidance and approves nothing",
  );
  // The dashboard cannot decide an ask a reply already closed.
  expect(
    await decideLinkAsk(db, {
      questionId: question.id,
      decision: "approve",
      note: null,
      answeredBy: "lead",
      actor,
      now: NOW + 200,
    }),
  ).toBe("rejected");
});

test("the reminder fires once after 24 hours", async () => {
  const { db, question } = await asked();
  const job = (await listJobs(db)).find((entry) => entry.queue === JOB_KIND.linkAskReminder)!;
  expect(job.runAt).toBe(NOW + LINK_ASK_REMINDER_MS);
  expect(await remindLinkAsk(db, question.id, NOW + LINK_ASK_REMINDER_MS)).toBe(true);
  expect(await remindLinkAsk(db, question.id, NOW + 2 * LINK_ASK_REMINDER_MS)).toBe(false);
  const reminders = (await listOutbox(db)).filter((row) =>
    row.idempotencyKey.startsWith("link-ask-reminder:"),
  );
  expect(reminders).toHaveLength(1);
  expect((reminders[0]!.payload as { body: string; options: unknown[] }).options).toEqual([]);
  expect((reminders[0]!.payload as { body: string }).body).toContain(
    "Decide in Paws: https://paws.example/dashboard/issues/PAS-633#closeout",
  );
});

test("no reminder once the ask is decided", async () => {
  const { db, question } = await asked();
  await decideLinkAsk(db, {
    questionId: question.id,
    decision: "changes",
    note: "Fix the finding first.",
    answeredBy: "delegator",
    actor,
    now: NOW + 100,
  });
  expect(await remindLinkAsk(db, question.id, NOW + LINK_ASK_REMINDER_MS)).toBe(false);
});

test("a new head closes the open ask", async () => {
  const { db, question } = await asked();
  expect(await closeLinkAsksOnHead(db, "PAS-633", HEAD, NOW + 50)).toBe(0);
  expect(await closeLinkAsksOnHead(db, "PAS-633", "4b317d5ffff", NOW + 100)).toBe(1);
  expect(await getLinkAsk(db, question.id)).toMatchObject({
    closedReason: "head_moved",
    decision: null,
  });
  expect((await getQuestion(db, question.id))?.status).toBe("cancelled");
  expect(await findOpenQuestion(db, "ses_1")).toBeNull();
  expect(await remindLinkAsk(db, question.id, NOW + LINK_ASK_REMINDER_MS)).toBe(false);
  expect(
    await decideLinkAsk(db, {
      questionId: question.id,
      decision: "approve",
      note: null,
      answeredBy: "lead",
      actor,
      now: NOW + 200,
    }),
  ).toBe("rejected");
});
