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
  sqliteDb,
} from "../db";
import { bypassSummary } from "../closeout";
import { findOpenQuestion, getQuestion } from "../questions";
import { saveSchedulingContextSteps } from "../scheduler";
import { askCloseoutHelp } from "./closeout-help";
import { recoveryOptions } from "./closeout-recovery";
import {
  BYPASS_REPLY_NOTE,
  decideLinkAsk,
  guideLinkAsk,
  reverifyBypassedSteps,
  type LinkAskEffects,
} from "./link-ask";

const NOW = 1_700_000_000_000;
const HEAD = "7f65200aa1b2c3d4e5f6";
const LINK = "https://paws.example/dashboard/issues/PAS-633#closeout";

async function blocked(publicUrl: string | null = "https://paws.example") {
  const db = openDatabase(":memory:");
  migrate(db);
  const item = insertQueuedItem(db, { id: "PAS-633", sessionKey: "ses_1", title: "Signed URLs" });
  await beginImplementRun(sqliteDb(db), item.id, NOW - 10);
  await applyWorkItemEvent(sqliteDb(db), item.id, "turn_ended");
  await saveCheckpoint(sqliteDb(db), item.id, {
    phase: "verifying",
    baseSha: "base",
    wipCommit: HEAD,
  });
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
    "Lea Lead",
    "lea@example.com",
  ]);
  await askCloseoutHelp(
    sqliteDb(db),
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
  const question = (await findOpenQuestion(sqliteDb(db), "ses_1"))!;
  return { db, itemId: item.id, question };
}

const actor = { workspaceId: "ws", userId: "user-lead", name: "Lea Lead" };
const effects: LinkAskEffects = { bypass: reverifyBypassedSteps };

test("Closeout help is a bypass link ask with the failed checks of the head", async () => {
  const { db, itemId, question } = await blocked();
  expect(question.kind).toBe("link");
  expect(await getLinkAsk(sqliteDb(db), question.id)).toMatchObject({
    kind: "bypass",
    headCommit: HEAD,
    link: LINK,
    answerers: ["delegator", "lead"],
  });
  expect(question.body).toContain(`Decide in Paws: ${LINK}`);
  expect(question.body).toContain("2 checks failed (independent-review, test)");
  expect(question.body).not.toContain("/paws bypass");
  expect((await listCloseoutRecoveries(sqliteDb(db), itemId))[0]?.questionId).toBe(question.id);
  expect(
    (await listCloseoutBypassChecks(sqliteDb(db), question.id)).map(
      ({ checkId, kind, state, attempt }) => ({
        checkId,
        kind,
        state,
        attempt,
      }),
    ),
  ).toEqual([
    { checkId: "independent-review", kind: "review", state: "failed", attempt: 1 },
    { checkId: "test", kind: "command", state: "exhausted", attempt: 3 },
  ]);
  expect((await getWorkItem(sqliteDb(db), itemId))?.state).toBe("awaiting_input");
});

test("bypassing from the page writes the rows and verifies the same head again", async () => {
  const { db, itemId, question } = await blocked();
  expect(
    await decideLinkAsk(
      sqliteDb(db),
      {
        questionId: question.id,
        decision: "approve",
        note: null,
        bypasses: [{ checkId: "independent-review", reason: " Smoke run moved to PAS-744. " }],
        answeredBy: "lead",
        actor,
        now: NOW + 100,
      },
      effects,
    ),
  ).toBe("answered");
  expect(await getWorkItem(sqliteDb(db), itemId)).toMatchObject({
    state: "verifying",
    checkpoint: { phase: "verifying", baseSha: "base", wipCommit: HEAD },
  });
  expect((await listJobs(sqliteDb(db))).map((job) => [job.queue, job.jobKey])).toContainEqual([
    JOB_KIND.reverify,
    `closeout-bypass:${question.id}`,
  ]);
  expect((await listJobs(sqliteDb(db))).some((job) => job.queue === JOB_KIND.resume)).toBe(false);
  expect((await listCloseoutBypassChecks(sqliteDb(db), question.id))[0]).toMatchObject({
    checkId: "independent-review",
    reason: "Smoke run moved to PAS-744.",
    approvedBy: "lead",
    approvedByName: "Lea Lead",
    approvedAt: NOW + 100,
  });
  expect((await listCloseoutBypassChecks(sqliteDb(db), question.id))[1]?.approvedAt).toBeNull();
  const { bypasses } = await recoveryOptions(sqliteDb(db), itemId);
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

test("a bypass needs offered checks, each once, each with a reason", async () => {
  const { db, itemId, question } = await blocked();
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
      await decideLinkAsk(
        sqliteDb(db),
        {
          questionId: question.id,
          decision: "approve",
          note: "Bypass it",
          bypasses,
          answeredBy: "delegator",
          actor,
          now: NOW + 100,
        },
        effects,
      ),
    ).toBe("rejected");
  expect((await getQuestion(sqliteDb(db), question.id))?.status).toBe("open");
  expect((await getWorkItem(sqliteDb(db), itemId))?.state).toBe("awaiting_input");
  expect((await recoveryOptions(sqliteDb(db), itemId)).bypasses).toEqual([]);
});

test("someone who did not delegate and does not lead the project cannot bypass", async () => {
  const { db, itemId, question } = await blocked();
  expect(
    await decideLinkAsk(
      sqliteDb(db),
      {
        questionId: question.id,
        decision: "approve",
        note: null,
        bypasses: [{ checkId: "test", reason: "Looks fine to me" }],
        answeredBy: "agent-bot",
        actor,
        now: NOW + 100,
      },
      effects,
    ),
  ).toBe("forbidden");
  expect((await getQuestion(sqliteDb(db), question.id))?.status).toBe("open");
  expect(
    (await listCloseoutBypassChecks(sqliteDb(db), question.id)).every((check) => !check.approvedBy),
  ).toBe(true);
  expect((await recoveryOptions(sqliteDb(db), itemId)).bypasses).toEqual([]);
});

test("a /paws bypass reply in Linear is guidance and gets the link back once", async () => {
  const { db, itemId, question } = await blocked();
  expect(
    await guideLinkAsk(sqliteDb(db), {
      questionId: question.id,
      eventKey: "activity:bypass",
      body: "/paws bypass test -- Known fixture failure",
      answeredBy: "lead",
      now: NOW + 100,
    }),
  ).toBe(true);
  expect(await getLinkAsk(sqliteDb(db), question.id)).toMatchObject({
    decision: null,
    closedReason: "guidance",
  });
  expect((await getWorkItem(sqliteDb(db), itemId))?.state).toBe("queued");
  expect((await listJobs(sqliteDb(db))).some((job) => job.queue === JOB_KIND.reverify)).toBe(false);
  expect(await recoveryOptions(sqliteDb(db), itemId)).toEqual({
    retryBaseline: ["test:1"],
    bypasses: [],
  });
  const notes = (await listOutbox(sqliteDb(db))).filter((row) =>
    row.idempotencyKey.startsWith("link-ask-guidance:"),
  );
  expect(notes.map((row) => (row.payload as { body: string }).body)).toEqual([
    `${BYPASS_REPLY_NOTE} ${LINK}`,
  ]);
});

test("guidance from the page restarts the agent and authorizes a new round", async () => {
  const { db, itemId, question } = await blocked();
  expect(
    await decideLinkAsk(
      sqliteDb(db),
      {
        questionId: question.id,
        decision: "changes",
        note: "Record the smoke run instead.",
        answeredBy: "delegator",
        actor,
        now: NOW + 100,
      },
      effects,
    ),
  ).toBe("answered");
  expect((await getWorkItem(sqliteDb(db), itemId))?.state).toBe("queued");
  const resume = (await listJobs(sqliteDb(db))).find((job) => job.queue === JOB_KIND.resume)!;
  expect((resume.payload as { handoff: string }).handoff).toContain(
    "Record the smoke run instead.",
  );
  expect(await recoveryOptions(sqliteDb(db), itemId)).toEqual({
    retryBaseline: ["test:1"],
    bypasses: [],
  });
});

test("without a public link, Closeout help is a Linear question that cannot bypass", async () => {
  const { db, question } = await blocked(null);
  expect(question.kind).toBe("closeout-help");
  expect(await getLinkAsk(sqliteDb(db), question.id)).toBeNull();
  expect(question.body).toContain("A reply here cannot bypass a check.");
  expect(question.body).not.toContain("/paws bypass");
});
