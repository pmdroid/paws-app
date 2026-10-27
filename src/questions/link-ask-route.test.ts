import { expect, test } from "bun:test";
import { insertQueuedItem, migrate, openDatabase, syncWorkspaceMember } from "../db";
import { openLinkAsk } from "./link-ask";
import { handleLinkAskAnswer, LINK_ASK_ANSWER_PATH, type LinkAskAnswer } from "./link-ask-route";

const NOW = 1_700_000_000_000;

function setup(role: "member" | "observer" = "member", kind: "risk" | "bypass" = "risk") {
  const db = openDatabase(":memory:");
  migrate(db);
  insertQueuedItem(db, { id: "PAS-633", sessionKey: "ses_1" });
  db.run("INSERT INTO workspace (id, linear_organization_id, name, created_at) VALUES (?,?,?,?)", [
    "ws",
    "org",
    "Kyku",
    NOW,
  ]);
  db.run("INSERT INTO workspace_user (id, linear_user_id, name, email) VALUES (?,?,?,?)", [
    "user-1",
    "linear-1",
    "Sam",
    "sam@example.com",
  ]);
  syncWorkspaceMember(db, {
    workspaceId: "ws",
    userId: "user-1",
    role,
    active: true,
    teamIds: [],
    now: NOW,
  });
  const { question } = openLinkAsk(db, {
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
  const { db, questionId, calls } = setup();
  const response = await handleLinkAskAnswer(post({ questionId, decision: "approve" }), {
    db,
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
  const { db, questionId } = setup();
  const response = await handleLinkAskAnswer(post({ questionId, decision: "approve" }), {
    db,
    principal: { workspaceId: "ws", userId: "user-1" },
    sessionIds: ["ses_1"],
    submit: async () => "forbidden",
    now: () => NOW + 5,
  });
  expect(response?.status).toBe(403);
  expect(
    db
      .query("SELECT action, subject FROM workspace_access_audit WHERE action LIKE 'decision.%'")
      .all(),
  ).toEqual([{ action: "decision.refused", subject: "PAS-633 7f65200 risk" }]);
});

test("an observer is refused before the loop sees the decision", async () => {
  const { db, questionId, calls } = setup("observer");
  const response = await handleLinkAskAnswer(post({ questionId, decision: "approve" }), {
    db,
    principal: { workspaceId: "ws", userId: "user-1" },
    sessionIds: ["ses_1"],
    submit: async (input) => (calls.push(input), "answered"),
  });
  expect(response?.status).toBe(403);
  expect(calls).toEqual([]);
});

test("signed out, another session, a wrong decision or no note are refused", async () => {
  const { db, questionId } = setup();
  const submit: LinkAskAnswer = async () => "answered";
  const principal = { workspaceId: "ws", userId: "user-1" };
  expect(
    (
      await handleLinkAskAnswer(post({ questionId, decision: "approve" }), {
        db,
        principal: undefined,
        sessionIds: undefined,
        submit,
      })
    )?.status,
  ).toBe(401);
  expect(
    (
      await handleLinkAskAnswer(post({ questionId, decision: "approve" }), {
        db,
        principal,
        sessionIds: ["other"],
        submit,
      })
    )?.status,
  ).toBe(409);
  expect(
    (
      await handleLinkAskAnswer(post({ questionId, decision: "answer", note: "x" }), {
        db,
        principal,
        sessionIds: ["ses_1"],
        submit,
      })
    )?.status,
  ).toBe(400);
  expect(
    (
      await handleLinkAskAnswer(post({ questionId, decision: "changes", note: " " }), {
        db,
        principal,
        sessionIds: ["ses_1"],
        submit,
      })
    )?.status,
  ).toBe(400);
});

test("a bypass approval sends each selected check with its reason", async () => {
  const { db, questionId, calls } = setup("member", "bypass");
  const options = {
    db,
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
  const { db, calls } = setup();
  const { question } = openLinkAsk(db, {
    asker: { itemId: "PAS-633", runId: null, sessionId: "ses_1" },
    kind: "rounds",
    head: "4b317d5aa",
    link: "https://paws.example/status/issues/PAS-633#review-rounds",
    detail: "The independent review failed 4 rounds.",
    answerers: ["linear-1"],
    now: NOW,
  });
  const options = {
    db,
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
  const risk = setup();
  const response = await handleLinkAskAnswer(
    post({ questionId: risk.questionId, decision: "stop" }),
    {
      db: risk.db,
      principal,
      sessionIds: ["ses_1"],
      submit: async (input) => (risk.calls.push(input), "answered"),
    },
  );
  expect(response?.status).toBe(200);
  expect(risk.calls).toMatchObject([{ decision: "stop", note: null, answeredBy: "linear-1" }]);
  const bypass = setup("member", "bypass");
  const refused = await handleLinkAskAnswer(
    post({ questionId: bypass.questionId, decision: "stop" }),
    {
      db: bypass.db,
      principal,
      sessionIds: ["ses_1"],
      submit: async (input) => (bypass.calls.push(input), "answered"),
    },
  );
  expect(refused?.status).toBe(400);
  expect(bypass.calls).toEqual([]);
});
