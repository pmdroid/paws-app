import { expect, test } from "bun:test";
import { like } from "drizzle-orm";
import { insertQueuedItem, putWorkspaceUser, syncWorkspaceMember } from "../db";
import { openLinkAsk } from "./link-ask";
import { handleLinkAskAnswer, LINK_ASK_ANSWER_PATH, type LinkAskAnswer } from "./link-ask-route";
import { seed } from "../../test/dialects";
import { tempStore } from "../../test/pglite";

const NOW = 1_700_000_000_000;

async function setup(active = true, kind: "risk" | "bypass" | "rule" = "risk") {
  const db = (await tempStore()).db;
  await insertQueuedItem(db, { id: "PAS-633", sessionKey: "ses_1" });
  await seed(db, (q) =>
    q.orm
      .insert(q.t.workspace)
      .values({ id: "ws", linearOrganizationId: "org", name: "Kyku", createdAt: NOW }),
  );
  await putWorkspaceUser(db, {
    id: "user-1",
    linearUserId: "linear-1",
    name: "Sam",
    email: "sam@example.com",
  });
  await syncWorkspaceMember(db, {
    workspaceId: "ws",
    userId: "user-1",
    role: "member",
    active,
    teamIds: [],
    now: NOW,
  });
  const { question } = await openLinkAsk(db, {
    asker: { itemId: "PAS-633", runId: null, sessionId: "ses_1" },
    kind,
    head: "7f65200aa",
    link: "https://paws.example/status/issues/PAS-633#risk",
    detail: "High-risk paths changed: src/auth/session.ts.",
    answerers: ["lead"],
    now: NOW,
  });
  const calls: Parameters<LinkAskAnswer>[0][] = [];
  return { db, questionId: question.id, calls };
}

const post = (body: unknown) =>
  new Request(`https://paws.example${LINK_ASK_ANSWER_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("a decision goes to the loop with the signed-in person's Linear id", async () => {
  const { db, questionId, calls } = await setup();
  const response = await handleLinkAskAnswer(post({ questionId, decision: "approve" }), {
    store: db,
    principal: { workspaceId: "ws", userId: "user-1" },
    sessionIds: ["ses_1"],
    submit: async (input) => (calls.push(input), "answered"),
  });
  expect(response?.status).toBe(200);
  expect(calls).toEqual([
    {
      questionId,
      decision: "approve",
      note: null,
      answeredBy: "linear-1",
      actor: { workspaceId: "ws", userId: "user-1", name: "Sam" },
    },
  ]);
});

test("someone the loop refuses gets 403 and an Audit history row", async () => {
  const { db, questionId } = await setup();
  const response = await handleLinkAskAnswer(post({ questionId, decision: "approve" }), {
    store: db,
    principal: { workspaceId: "ws", userId: "user-1" },
    sessionIds: ["ses_1"],
    submit: async () => "forbidden",
    now: () => NOW + 5,
  });
  expect(response?.status).toBe(403);
  expect(
    await db.run((q) =>
      q.all(
        q.orm
          .select({
            action: q.t.workspaceAccessAudit.action,
            subject: q.t.workspaceAccessAudit.subject,
          })
          .from(q.t.workspaceAccessAudit)
          .where(like(q.t.workspaceAccessAudit.action, "decision.%")),
      ),
    ),
  ).toEqual([{ action: "decision.refused", subject: "PAS-633 7f65200 risk" }]);
});

test("an inactive member is refused before the loop sees the decision", async () => {
  const { db, questionId, calls } = await setup(false);
  const response = await handleLinkAskAnswer(post({ questionId, decision: "approve" }), {
    store: db,
    principal: { workspaceId: "ws", userId: "user-1" },
    sessionIds: ["ses_1"],
    submit: async (input) => (calls.push(input), "answered"),
  });
  expect(response?.status).toBe(403);
  expect(calls).toEqual([]);
});

test("signed out, another session, a wrong decision or no note are refused", async () => {
  const { db, questionId } = await setup();
  const submit: LinkAskAnswer = async () => "answered";
  const principal = { workspaceId: "ws", userId: "user-1" };
  expect(
    (
      await handleLinkAskAnswer(post({ questionId, decision: "approve" }), {
        store: db,
        principal: undefined,
        sessionIds: undefined,
        submit,
      })
    )?.status,
  ).toBe(401);
  expect(
    (
      await handleLinkAskAnswer(post({ questionId, decision: "approve" }), {
        store: db,
        principal,
        sessionIds: ["other"],
        submit,
      })
    )?.status,
  ).toBe(409);
  expect(
    (
      await handleLinkAskAnswer(post({ questionId, decision: "answer", note: "x" }), {
        store: db,
        principal,
        sessionIds: ["ses_1"],
        submit,
      })
    )?.status,
  ).toBe(400);
  expect(
    (
      await handleLinkAskAnswer(post({ questionId, decision: "changes", note: " " }), {
        store: db,
        principal,
        sessionIds: ["ses_1"],
        submit,
      })
    )?.status,
  ).toBe(400);
});

test("a bypass approval sends each selected check with its reason", async () => {
  const { db, questionId, calls } = await setup(true, "bypass");
  const options = {
    store: db,
    principal: { workspaceId: "ws", userId: "user-1" },
    sessionIds: ["ses_1"],
    submit: (async (input) => (calls.push(input), "answered")) as LinkAskAnswer,
  };
  for (const bypasses of [
    undefined,
    [],
    [{ checkId: "test", reason: " " }],
    [{ checkId: "test" }],
    [
      { checkId: "test", reason: "Flaky" },
      { checkId: "test", reason: "Flaky" },
    ],
  ])
    expect(
      (await handleLinkAskAnswer(post({ questionId, decision: "approve", bypasses }), options))
        ?.status,
    ).toBe(400);
  expect(calls).toEqual([]);
  const response = await handleLinkAskAnswer(
    post({
      questionId,
      decision: "approve",
      bypasses: [{ checkId: "test", reason: " Fixture is known to fail. " }],
    }),
    options,
  );
  expect(response?.status).toBe(200);
  expect(calls).toEqual([
    {
      questionId,
      decision: "approve",
      note: null,
      bypasses: [{ checkId: "test", reason: "Fixture is known to fail." }],
      answeredBy: "linear-1",
      actor: { workspaceId: "ws", userId: "user-1", name: "Sam" },
    },
  ]);
});

test("a rounds ask takes Stop without a note and refuses Approve", async () => {
  const { db, calls } = await setup();
  const { question } = await openLinkAsk(db, {
    asker: { itemId: "PAS-633", runId: null, sessionId: "ses_1" },
    kind: "rounds",
    head: "4b317d5aa",
    link: "https://paws.example/status/issues/PAS-633#review-rounds",
    detail: "The independent review failed 4 rounds.",
    answerers: ["linear-1"],
    now: NOW,
  });
  const options = {
    store: db,
    principal: { workspaceId: "ws", userId: "user-1" },
    sessionIds: ["ses_1"],
    submit: (async (input) => (calls.push(input), "answered")) as LinkAskAnswer,
  };
  const approve = await handleLinkAskAnswer(
    post({ questionId: question.id, decision: "approve" }),
    options,
  );
  expect(approve?.status).toBe(400);
  for (const decision of ["stop", "continue", "rethink"]) {
    const response = await handleLinkAskAnswer(
      post({ questionId: question.id, decision }),
      options,
    );
    expect(response?.status).toBe(200);
  }
  expect(calls.map((call) => [call.decision, call.note])).toEqual([
    ["stop", null],
    ["continue", null],
    ["rethink", null],
  ]);
});

test("Stop on the Risk card goes to the loop without a note; it does not fit other kinds", async () => {
  const principal = { workspaceId: "ws", userId: "user-1" };
  const risk = await setup();
  const response = await handleLinkAskAnswer(
    post({ questionId: risk.questionId, decision: "stop" }),
    {
      store: risk.db,
      principal,
      sessionIds: ["ses_1"],
      submit: async (input) => (risk.calls.push(input), "answered"),
    },
  );
  expect(response?.status).toBe(200);
  expect(risk.calls).toMatchObject([{ decision: "stop", note: null, answeredBy: "linear-1" }]);
  const bypass = await setup(true, "bypass");
  const refused = await handleLinkAskAnswer(
    post({ questionId: bypass.questionId, decision: "stop" }),
    {
      store: bypass.db,
      principal,
      sessionIds: ["ses_1"],
      submit: async (input) => (bypass.calls.push(input), "answered"),
    },
  );
  expect(refused?.status).toBe(400);
  expect(bypass.calls).toEqual([]);
});

test("approving a rule break needs a reason, which goes to the loop as the note", async () => {
  const { db, questionId, calls } = await setup(true, "rule");
  const options = {
    store: db,
    principal: { workspaceId: "ws", userId: "user-1" },
    sessionIds: ["ses_1"],
    submit: (async (input) => (calls.push(input), "answered")) as LinkAskAnswer,
  };
  for (const note of [undefined, "", "  "]) {
    const response = await handleLinkAskAnswer(
      post({ questionId, decision: "approve", note }),
      options,
    );
    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({ error: "Write why the rule may break." });
  }
  expect(calls).toEqual([]);
  const response = await handleLinkAskAnswer(
    post({ questionId, decision: "approve", note: " The v2 contract drops Task.title. " }),
    options,
  );
  expect(response?.status).toBe(200);
  expect(calls).toEqual([
    {
      questionId,
      decision: "approve",
      note: "The v2 contract drops Task.title.",
      answeredBy: "linear-1",
      actor: { workspaceId: "ws", userId: "user-1", name: "Sam" },
    },
  ]);
});
