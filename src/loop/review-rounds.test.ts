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
  type LinkAskRounds,
} from "../db";
import { getQuestion } from "../questions";
import { saveSchedulingContext } from "../scheduler";
import { recoveryOptions } from "./closeout-recovery";
import { decideLinkAsk, guideLinkAsk } from "./link-ask";
import { askReviewRounds, reviewRoundLimit } from "./review-rounds";

const NOW = 1_700_000_000_000;
const HEAD = "4b317d5aa1b2c3d4e5f6";
const BASELINE = ["review:independent-review:1", "review:independent-review:2"];

const ROUNDS: LinkAskRounds = {
  rounds: [
    { head: "1111111aaaa", findings: 3 },
    { head: "2222222bbbb", findings: 2 },
    { head: "3333333cccc", findings: 2 },
    { head: HEAD, findings: 2 },
  ],
  open: [
    { severity: "P1", location: "src/auth/session.ts:42", bugClass: "unchecked null" },
    { severity: "P2", location: "src/auth/token.ts:9", bugClass: "missing await" },
  ],
  bugClass: "unchecked null",
  limit: 4,
  handoff: "- review independent-review P1 at src/auth/session.ts:42: unchecked null",
};

function asked() {
  const db = openDatabase(":memory:");
  migrate(db);
  const item = insertQueuedItem(db, { id: "PAS-759", sessionKey: "ses_1", title: "Rounds" });
  beginImplementRun(db, item.id, NOW - 10);
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
  const question = askReviewRounds(db, {
    item: getWorkItem(db, item.id)!,
    help: {
      itemId: item.id,
      taskId: item.id,
      base: "base",
      head: HEAD,
      policyDigest: "digest",
      failedChecks: ["independent-review"],
      retryBaseline: BASELINE,
      summary: "Closeout: exhausted",
    },
    rounds: ROUNDS,
    publicUrl: "https://paws.example",
    now: NOW,
  })!;
  return { db, itemId: item.id, question };
}

const actor = { workspaceId: "ws", userId: "user-lead", name: "Lea" };

function handoff(db: ReturnType<typeof asked>["db"]): string {
  const resume = listJobs(db).find((job) => job.queue === JOB_KIND.resume)!;
  return (resume.payload as { handoff: string }).handoff;
}

test("the limit comes from the exhausted review check", () => {
  expect(reviewRoundLimit("4 of 4 allowed failed review attempts used. Stop retrying.")).toBe(4);
  expect(reviewRoundLimit("src/a.ts:1 failed in 3 of 3 allowed review attempts.")).toBeNull();
  expect(reviewRoundLimit(undefined)).toBeNull();
});

test("one elicitation without options names the recurring bug class and links to the item", () => {
  const { db, itemId, question } = asked();
  expect(getWorkItem(db, itemId)?.state).toBe("awaiting_input");
  expect(getLinkAsk(db, question.id)).toMatchObject({ kind: "rounds", rounds: ROUNDS });
  const elicitations = listOutbox(db).filter((row) => row.op === "elicitation");
  expect(elicitations).toHaveLength(1);
  const payload = elicitations[0]!.payload as { body: string; options: unknown[] };
  expect(payload.options).toEqual([]);
  expect(payload.body).toBe(
    [
      '**Review rounds ran out on 4b317d5.**\nThe independent review failed 4 rounds and 2 findings are still open. The class of bug that keeps coming back is "unchecked null" (1 of 2 open findings). Rethink the approach, keep going, or stop.',
      "Decide in Paws: https://paws.example/status/issues/PAS-759#review-rounds",
      "A reply here asks the agent to rethink the approach, with your reply as the note and the open findings.",
    ].join("\n\n"),
  );
  const links = listOutbox(db).filter((row) => row.op === "linear.session.links");
  expect(links.map((row) => row.payload)).toEqual([
    {
      sessionId: "ses_1",
      addedExternalUrls: [
        {
          label: "Answer question",
          url: "https://paws.example/status/issues/PAS-759#review-rounds",
        },
      ],
    },
  ]);
  // Nobody answered yet, so no new round budget.
  expect(recoveryOptions(db, itemId).retryBaseline).toEqual([]);
});

test("Rethink the approach restarts the item with the findings, the note and a new round budget", () => {
  const { db, itemId, question } = asked();
  expect(
    decideLinkAsk(db, {
      questionId: question.id,
      decision: "rethink",
      note: "Validate the session once at the boundary.",
      answeredBy: "lead",
      actor,
      now: NOW + 100,
    }),
  ).toBe("answered");
  expect(getLinkAsk(db, question.id)).toMatchObject({
    decision: "rethink",
    decidedBy: "lead",
    closedReason: "decided",
  });
  expect(getWorkItem(db, itemId)?.state).toBe("queued");
  const body = handoff(db);
  expect(body).toContain("A person asked you to rethink the approach");
  expect(body).toContain("(most are unchecked null)");
  expect(body).toContain("Note from the person: Validate the session once at the boundary.");
  expect(body).toContain(ROUNDS.handoff);
  expect(recoveryOptions(db, itemId).retryBaseline).toEqual(BASELINE);
  expect(
    db
      .query("SELECT action FROM workspace_access_audit")
      .all()
      .map((row) => row),
  ).toEqual([{ action: "decision.rounds.rethink" }]);
});

test("Rethink the approach needs no note", () => {
  const { db, itemId, question } = asked();
  expect(
    decideLinkAsk(db, {
      questionId: question.id,
      decision: "rethink",
      note: null,
      answeredBy: "delegator",
      actor,
      now: NOW + 100,
    }),
  ).toBe("answered");
  expect(getWorkItem(db, itemId)?.state).toBe("queued");
  expect(handoff(db)).not.toContain("Note from the person");
});

test("Keep going restarts the item with four more rounds", () => {
  const { db, itemId, question } = asked();
  expect(
    decideLinkAsk(db, {
      questionId: question.id,
      decision: "continue",
      note: null,
      answeredBy: "lead",
      actor,
      now: NOW + 100,
    }),
  ).toBe("answered");
  expect(getWorkItem(db, itemId)?.state).toBe("queued");
  expect(handoff(db)).toContain("A person allowed 4 more review rounds: fix the open findings.");
  expect(recoveryOptions(db, itemId).retryBaseline).toEqual(BASELINE);
  const notes = listOutbox(db).filter((row) => row.idempotencyKey.startsWith("link-ask-decided:"));
  expect(notes.map((row) => (row.payload as { body: string }).body)).toEqual([
    "Lea allowed 4 more review rounds in Paws.",
  ]);
});

test("Stop ends the item as asked and sends nothing back to the agent", () => {
  const { db, itemId, question } = asked();
  expect(
    decideLinkAsk(db, {
      questionId: question.id,
      decision: "stop",
      note: null,
      answeredBy: "lead",
      actor,
      now: NOW + 100,
    }),
  ).toBe("answered");
  expect(getWorkItem(db, itemId)?.state).toBe("failed");
  expect(listJobs(db).some((job) => job.queue === JOB_KIND.resume)).toBe(false);
  const failure = listOutbox(db).find((row) =>
    row.idempotencyKey.includes(":closeout:review_rounds"),
  )!;
  expect((failure.payload as { body: string }).body).toContain(
    "Stopped after 4 failed review rounds, as Lea asked in Paws.",
  );
});

test("a decision of another kind does not fit a rounds ask", () => {
  const { db, itemId, question } = asked();
  for (const decision of ["approve", "changes", "answer"] as const)
    expect(
      decideLinkAsk(db, {
        questionId: question.id,
        decision,
        note: "note",
        answeredBy: "lead",
        actor,
        now: NOW + 100,
      }),
    ).toBe("rejected");
  expect(getWorkItem(db, itemId)?.state).toBe("awaiting_input");
});

test("someone who did not delegate and does not lead the project cannot stop the item", () => {
  const { db, itemId, question } = asked();
  expect(
    decideLinkAsk(db, {
      questionId: question.id,
      decision: "stop",
      note: null,
      answeredBy: "someone-else",
      actor,
      now: NOW + 100,
    }),
  ).toBe("forbidden");
  expect(getWorkItem(db, itemId)?.state).toBe("awaiting_input");
});

test("a reply in Linear is Rethink the approach with the reply as the note", () => {
  const { db, itemId, question } = asked();
  expect(
    guideLinkAsk(db, {
      questionId: question.id,
      eventKey: "activity:reply",
      body: "Stop patching; move the check into the middleware.",
      answeredBy: "delegator",
      now: NOW + 100,
    }),
  ).toBe(true);
  expect(getLinkAsk(db, question.id)).toMatchObject({
    decision: "rethink",
    note: "Stop patching; move the check into the middleware.",
    decidedBy: "delegator",
    closedReason: "decided",
  });
  expect(getQuestion(db, question.id)?.answer).toBe(
    "rethink: Stop patching; move the check into the middleware.",
  );
  expect(getWorkItem(db, itemId)?.state).toBe("queued");
  const body = handoff(db);
  expect(body).toContain("A person asked you to rethink the approach");
  expect(body).toContain(
    "Note from the person: Stop patching; move the check into the middleware.",
  );
  expect(body).toContain(ROUNDS.handoff);
  expect(recoveryOptions(db, itemId).retryBaseline).toEqual(BASELINE);
  const notes = listOutbox(db).filter((row) => row.idempotencyKey.startsWith("link-ask-guidance:"));
  expect(notes.map((row) => (row.payload as { body: string }).body)).toEqual([
    "Sent your reply to the agent: it rethinks the approach with the open findings and a new round budget.",
  ]);
  // The page cannot decide again once the reply did.
  expect(
    decideLinkAsk(db, {
      questionId: question.id,
      decision: "stop",
      note: null,
      answeredBy: "lead",
      actor,
      now: NOW + 200,
    }),
  ).toBe("rejected");
});
