import { expect, test } from "bun:test";
import { insertQueuedItem, migrate, openDatabase, syncWorkspaceMember } from "../db";
import { openLinkAsk } from "./link-ask";
import { handleLinkAskAnswer, LINK_ASK_ANSWER_PATH, type LinkAskAnswer } from "./link-ask-route";

const NOW = 1_700_000_000_000;

function setup(role: "member" | "observer" = "member") {
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
    kind: "risk",
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
