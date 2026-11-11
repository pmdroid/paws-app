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
  sqliteDb,
} from "../db";
import { getQuestion } from "../questions";
import { saveSchedulingContextSteps } from "../scheduler";
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

async function asked(findings?: string) {
  const db = openDatabase(":memory:");
  migrate(db);
  const item = insertQueuedItem(db, { id: "PAS-759", sessionKey: "ses_1", title: "Rounds" });
  await beginImplementRun(sqliteDb(db), item.id, NOW - 10);
  await applyWorkItemEvent(sqliteDb(db), item.id, "turn_ended");
  db.run("UPDATE work_item SET delegated_by = 'delegator' WHERE id = ?", [item.id]);
  await sqliteDb(db).run((q) =>
    saveSchedulingContextSteps(q, { itemId: item.id, projectId: "project", projectLeadId: "lead" }),
  );
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
  const question = (await askReviewRounds(sqliteDb(db), {
    item: (await getWorkItem(sqliteDb(db), item.id))!,
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
    ...(findings ? { findings } : {}),
    publicUrl: "https://paws.example",
    now: NOW,
  }))!;
  return { db, itemId: item.id, question };
}

const actor = { workspaceId: "ws", userId: "user-lead", name: "Lea" };

async function handoff(db: Awaited<ReturnType<typeof asked>>["db"]): Promise<string> {
  const resume = (await listJobs(sqliteDb(db))).find((job) => job.queue === JOB_KIND.resume)!;
  return (resume.payload as { handoff: string }).handoff;
}

test("the limit comes from the exhausted review check", () => {
  expect(reviewRoundLimit("4 of 4 allowed failed review attempts used. Stop retrying.")).toBe(4);
  expect(reviewRoundLimit("src/a.ts:1 failed in 3 of 3 allowed review attempts.")).toBeNull();
  expect(reviewRoundLimit(undefined)).toBeNull();
});

test("one elicitation without options names the recurring bug class and links to the item", async () => {
  const { db, itemId, question } = await asked();
  expect((await getWorkItem(sqliteDb(db), itemId))?.state).toBe("awaiting_input");
  expect(await getLinkAsk(sqliteDb(db), question.id)).toMatchObject({
    kind: "rounds",
    rounds: ROUNDS,
  });
  const elicitations = (await listOutbox(sqliteDb(db))).filter((row) => row.op === "elicitation");
  expect(elicitations).toHaveLength(1);
  const payload = elicitations[0]!.payload as { body: string; options: unknown[] };
  expect(payload.options).toEqual([]);
  expect(payload.body).toBe(
    [
      '**Review rounds ran out on 4b317d5.**\nThe independent review failed 4 rounds and 2 findings are still open. The class of bug that keeps coming back is "unchecked null" (1 of 2 open findings). Rethink the approach, keep going, or stop.',
      "Decide in Paws: https://paws.example/dashboard/issues/PAS-759#review-rounds",
      "A reply here asks the agent to rethink the approach, with your reply as the note and the open findings.",
    ].join("\n\n"),
  );
  const links = (await listOutbox(sqliteDb(db))).filter((row) => row.op === "linear.session.links");
  expect(links.map((row) => row.payload)).toEqual([
    {
      sessionId: "ses_1",
      addedExternalUrls: [
        {
          label: "Answer question",
          url: "https://paws.example/dashboard/issues/PAS-759#review-rounds",
        },
      ],
    },
  ]);
  // Nobody answered yet, so no new round budget.
  expect((await recoveryOptions(sqliteDb(db), itemId)).retryBaseline).toEqual([]);
});

test("the question lists the open findings' text without changing the dashboard detail", async () => {
  const findings =
    "- review independent-review P1 at src/auth/session.ts:42: unchecked null: the session is read before the check. (session.ts:42)";
  const { db, question } = await asked(findings);
  const body = (
    (await listOutbox(sqliteDb(db))).find((row) => row.op === "elicitation")!.payload as {
      body: string;
    }
  ).body;
  expect(body).toContain(findings);
  expect(body.indexOf(findings)).toBeLessThan(body.indexOf("Decide in Paws:"));
  expect((await getLinkAsk(sqliteDb(db), question.id))?.detail).not.toContain(findings);
});

test("Rethink the approach restarts the item with the findings, the note and a new round budget", async () => {
  const { db, itemId, question } = await asked();
  expect(
    await decideLinkAsk(sqliteDb(db), {
      questionId: question.id,
      decision: "rethink",
      note: "Validate the session once at the boundary.",
      answeredBy: "lead",
      actor,
      now: NOW + 100,
    }),
  ).toBe("answered");
  expect(await getLinkAsk(sqliteDb(db), question.id)).toMatchObject({
    decision: "rethink",
    decidedBy: "lead",
    closedReason: "decided",
  });
  expect((await getWorkItem(sqliteDb(db), itemId))?.state).toBe("queued");
  const body = await handoff(db);
  expect(body).toContain("A person asked you to rethink the approach");
  expect(body).toContain("(most are unchecked null)");
  expect(body).toContain("Note from the person: Validate the session once at the boundary.");
  expect(body).toContain(ROUNDS.handoff);
  expect((await recoveryOptions(sqliteDb(db), itemId)).retryBaseline).toEqual(BASELINE);
  expect(
    db
      .query("SELECT action FROM workspace_access_audit")
      .all()
      .map((row) => row),
  ).toEqual([{ action: "decision.rounds.rethink" }]);
});

test("Rethink the approach needs no note", async () => {
  const { db, itemId, question } = await asked();
  expect(
    await decideLinkAsk(sqliteDb(db), {
      questionId: question.id,
      decision: "rethink",
      note: null,
      answeredBy: "delegator",
      actor,
      now: NOW + 100,
    }),
  ).toBe("answered");
  expect((await getWorkItem(sqliteDb(db), itemId))?.state).toBe("queued");
  expect(await handoff(db)).not.toContain("Note from the person");
});

test("Keep going restarts the item with four more rounds", async () => {
  const { db, itemId, question } = await asked();
  expect(
    await decideLinkAsk(sqliteDb(db), {
      questionId: question.id,
      decision: "continue",
      note: null,
      answeredBy: "lead",
      actor,
      now: NOW + 100,
    }),
  ).toBe("answered");
  expect((await getWorkItem(sqliteDb(db), itemId))?.state).toBe("queued");
  expect(await handoff(db)).toContain(
    "A person allowed 4 more review rounds: fix the open findings.",
  );
  expect((await recoveryOptions(sqliteDb(db), itemId)).retryBaseline).toEqual(BASELINE);
  const notes = (await listOutbox(sqliteDb(db))).filter((row) =>
    row.idempotencyKey.startsWith("link-ask-decided:"),
  );
  expect(notes.map((row) => (row.payload as { body: string }).body)).toEqual([
    "Lea allowed 4 more review rounds in Paws.",
  ]);
});

test("Stop ends the item as asked and sends nothing back to the agent", async () => {
  const { db, itemId, question } = await asked();
  expect(
    await decideLinkAsk(sqliteDb(db), {
      questionId: question.id,
      decision: "stop",
      note: null,
      answeredBy: "lead",
      actor,
      now: NOW + 100,
    }),
  ).toBe("answered");
  expect((await getWorkItem(sqliteDb(db), itemId))?.state).toBe("failed");
  expect((await listJobs(sqliteDb(db))).some((job) => job.queue === JOB_KIND.resume)).toBe(false);
  const failure = (await listOutbox(sqliteDb(db))).find((row) =>
    row.idempotencyKey.includes(":closeout:review_rounds"),
  )!;
  expect((failure.payload as { body: string }).body).toContain(
    "Stopped after 4 failed review rounds, as Lea asked in Paws.",
  );
});

test("a decision of another kind does not fit a rounds ask", async () => {
  const { db, itemId, question } = await asked();
  for (const decision of ["approve", "changes", "answer"] as const)
    expect(
      await decideLinkAsk(sqliteDb(db), {
        questionId: question.id,
        decision,
        note: "note",
        answeredBy: "lead",
        actor,
        now: NOW + 100,
      }),
    ).toBe("rejected");
  expect((await getWorkItem(sqliteDb(db), itemId))?.state).toBe("awaiting_input");
});

test("someone who did not delegate and does not lead the project cannot stop the item", async () => {
  const { db, itemId, question } = await asked();
  expect(
    await decideLinkAsk(sqliteDb(db), {
      questionId: question.id,
      decision: "stop",
      note: null,
      answeredBy: "someone-else",
      actor,
      now: NOW + 100,
    }),
  ).toBe("forbidden");
  expect((await getWorkItem(sqliteDb(db), itemId))?.state).toBe("awaiting_input");
});

test("a reply in Linear is Rethink the approach with the reply as the note", async () => {
  const { db, itemId, question } = await asked();
  expect(
    await guideLinkAsk(sqliteDb(db), {
      questionId: question.id,
      eventKey: "activity:reply",
      body: "Stop patching; move the check into the middleware.",
      answeredBy: "delegator",
      now: NOW + 100,
    }),
  ).toBe(true);
  expect(await getLinkAsk(sqliteDb(db), question.id)).toMatchObject({
    decision: "rethink",
    note: "Stop patching; move the check into the middleware.",
    decidedBy: "delegator",
    closedReason: "decided",
  });
  expect((await getQuestion(sqliteDb(db), question.id))?.answer).toBe(
    "rethink: Stop patching; move the check into the middleware.",
  );
  expect((await getWorkItem(sqliteDb(db), itemId))?.state).toBe("queued");
  const body = await handoff(db);
  expect(body).toContain("A person asked you to rethink the approach");
  expect(body).toContain(
    "Note from the person: Stop patching; move the check into the middleware.",
  );
  expect(body).toContain(ROUNDS.handoff);
  expect((await recoveryOptions(sqliteDb(db), itemId)).retryBaseline).toEqual(BASELINE);
  const notes = (await listOutbox(sqliteDb(db))).filter((row) =>
    row.idempotencyKey.startsWith("link-ask-guidance:"),
  );
  expect(notes.map((row) => (row.payload as { body: string }).body)).toEqual([
    "Sent your reply to the agent: it rethinks the approach with the open findings and a new round budget.",
  ]);
  // The page cannot decide again once the reply did.
  expect(
    await decideLinkAsk(sqliteDb(db), {
      questionId: question.id,
      decision: "stop",
      note: null,
      answeredBy: "lead",
      actor,
      now: NOW + 200,
    }),
  ).toBe("rejected");
});
