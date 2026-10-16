import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  activateLinearItem,
  advanceLinearSessionGeneration,
  applyLinearTurns,
  beginImplementRun,
  bindLinearSessionTask,
  completeAnswerTask,
  ensureLinearSession,
  enqueueOutbox,
  insertQueuedItem,
  markArtifact,
  migrate,
  openDatabase,
  recordLinearTurn,
  saveArtifact,
  saveLinearActivitySnapshot,
  saveTaskMode,
} from "../src/db";
import { handleStatusRequest } from "../src/web";
import type { readLinearConversations } from "../src/web/src/live/conversations";
import { createInboxStore } from "../src/linear";
import { openQuestion } from "../src/questions";
import { tempHome } from "./helpers";

const ADDRESS = "http://127.0.0.1:8787/api/linear/conversations";

test("private conversation state survives reopening without exposing raw private payloads", async () => {
  const path = join(tempHome(), "conversations.db");
  let db = openDatabase(path);
  migrate(db);
  const item = insertQueuedItem(db, {
    id: "task",
    title: "Explain the chart",
    sessionKey: "session",
    now: 1,
  });
  ensureLinearSession(db, { sessionId: "session", issueId: "issue", creatorId: "human", now: 1 });
  bindLinearSessionTask(db, "session", item.delegationId);
  activateLinearItem(db, "session", item.id);
  const run = beginImplementRun(db, item.id, 1).run;
  saveTaskMode(db, item.id, "answer");
  completeAnswerTask(db, item.id, "The total is 42.", 2);
  for (const ordinal of [1, 3]) {
    recordLinearTurn(db, {
      eventKey: `turn:${ordinal}`,
      activityId: `prompt:${ordinal}`,
      sessionId: "session",
      actorId: "human",
      body: `Private correction ${ordinal} https://uploads.linear.app/file.png?signature=private-signature`,
      payload: JSON.stringify({ auth: "private-auth" }),
      createdAtMs: ordinal,
      now: ordinal,
    });
  }
  applyLinearTurns(db, "session", ["turn:1"], item.id);
  advanceLinearSessionGeneration(db, "session", { stop: true, now: 10 });
  advanceLinearSessionGeneration(db, "session", { now: 11 });
  recordLinearTurn(db, {
    eventKey: "turn:2",
    activityId: "prompt:2",
    sessionId: "session",
    actorId: "human",
    body: "Private correction 2",
    payload: JSON.stringify({ auth: "private-auth" }),
    createdAtMs: 11,
    now: 11,
  });
  saveLinearActivitySnapshot(db, {
    id: "remote",
    sessionId: "session",
    createdAt: new Date(4).toISOString(),
    snapshot: JSON.stringify({
      id: "remote",
      createdAt: new Date(4).toISOString(),
      content: { type: "thought", body: "Inspecting the chart" },
      signalMetadata: { token: "private-token" },
    }),
  });
  const artifactId = crypto.randomUUID();
  saveArtifact(
    db,
    {
      id: artifactId,
      itemId: item.id,
      runId: run.id,
      path: "chart.png",
      displayName: "chart.png",
      mimeType: "image/png",
      sizeBytes: 10,
      sha256: "a".repeat(64),
      state: "pending",
      assetUrl: null,
    },
    5,
  );
  markArtifact(db, artifactId, null);
  const question = openQuestion(db, {
    itemId: item.id,
    sessionId: "session",
    body: "Which total?",
    options: ["Annual"],
    now: 6,
  });
  const cancelled = db
    .query<{ name: string }, []>("PRAGMA table_info(question)")
    .all()
    .some((column) => column.name === "cancelled_at");
  if (!cancelled) db.run("ALTER TABLE question ADD COLUMN cancelled_at INTEGER");
  db.run("UPDATE question SET cancelled_at = 10, options = ? WHERE id = ?", [
    JSON.stringify([{ label: "Annual", value: "year" }]),
    question.id,
  ]);
  createInboxStore(db).commit({
    dedupeKey: "created",
    deliveryId: null,
    source: "webhook",
    action: "created",
    sessionId: "session",
    issueId: "issue",
    activityId: null,
    body: null,
    signal: null,
    updatedAtMs: 1,
    payload: JSON.stringify({ agentSession: { url: "https://linear.app/acme/issue/ENG-1" } }),
  });
  for (const [generation, content] of [
    [2, "Read chart"],
    [1, "Obsolete plan"],
  ] as const) {
    enqueueOutbox(db, {
      target: "linear",
      op: "linear.session.plan",
      orderingKey: "session",
      idempotencyKey: `plan:${generation}`,
      generation,
      payload: { plan: [{ content, status: "inProgress" }] },
      now: 7,
    });
  }
  enqueueOutbox(db, {
    target: "linear",
    op: "activity",
    orderingKey: "session",
    idempotencyKey: "pending-response",
    generation: 2,
    payload: {
      id: "response",
      kind: "response",
      body: "The total is 42.",
      auth: { token: "private-token" },
    },
    now: 8,
  });
  enqueueOutbox(db, {
    target: "linear",
    op: "linear.session.links",
    orderingKey: "session",
    idempotencyKey: "links",
    generation: 2,
    payload: {
      addedExternalUrls: [
        { label: "PR #42", url: "https://github.com/acme/project/pull/42" },
        { label: "Unsafe", url: "javascript:alert(1)" },
      ],
    },
    now: 9,
  });
  enqueueOutbox(db, {
    target: "linear",
    op: "linear.session.links",
    orderingKey: "session",
    idempotencyKey: "replace-links",
    generation: 2,
    payload: {
      externalUrls: [
        { label: "Temporary", url: "https://github.com/acme/project/pull/1" },
        { label: "PR #42", url: "https://github.com/acme/project/pull/42" },
      ],
    },
    now: 10,
  });
  enqueueOutbox(db, {
    target: "linear",
    op: "linear.session.links",
    orderingKey: "session",
    idempotencyKey: "remove-link",
    generation: 2,
    payload: { removedExternalUrls: ["https://github.com/acme/project/pull/1"] },
    now: 11,
  });
  ensureLinearSession(db, { sessionId: "new-session", now: 12 });
  advanceLinearSessionGeneration(db, "new-session", { stop: true, now: 13 });
  createInboxStore(db).commit({
    dedupeKey: "new-created",
    deliveryId: null,
    source: "webhook",
    action: "created",
    sessionId: "new-session",
    issueId: "new-issue",
    activityId: null,
    body: null,
    signal: null,
    updatedAtMs: 12,
    payload: JSON.stringify({ agentSession: { url: "https://linear.app/acme/issue/ENG-2" } }),
  });
  db.close();
  db = openDatabase(path);
  try {
    const response = await handleStatusRequest(new Request(ADDRESS), { db, staticDir: null });
    expect(response?.status).toBe(200);
    expect(response?.headers.get("access-control-allow-origin")).toBeNull();
    expect(response?.headers.get("cache-control")).toBe("no-store");
    const body = (await response!.json()) as {
      sessions: ReturnType<typeof readLinearConversations>;
    };
    expect(body.sessions).toHaveLength(2);
    const session = body.sessions.find((entry) => entry.id === "session")!;
    expect(body.sessions.find((entry) => entry.id === "new-session")?.links).toEqual([
      { label: "Linear session", href: "https://linear.app/acme/issue/ENG-2" },
    ]);
    expect(session.stopped).toBe(false);
    expect(body.sessions.find((entry) => entry.id === "new-session")?.stopped).toBe(true);
    expect(session.items[0]).toMatchObject({
      id: item.id,
      mode: "answer",
      response: "The total is 42.",
    });
    expect(
      session.messages
        .filter((entry: { kind: string }) => entry.kind === "prompt")
        .map((entry: { state: string }) => entry.state),
    ).toEqual(["applied", "cancelled", "pending"]);
    expect(session.messages.find((entry: { id: string }) => entry.id === "response")?.state).toBe(
      "pending",
    );
    expect(session.plan).toEqual([{ content: "Read chart", status: "inProgress" }]);
    expect(session.planState).toBe("pending");
    expect(session.questions[0]?.options).toEqual([{ label: "Annual", value: "year" }]);
    expect(session.questions[0]?.state).toBe("cancelled");
    expect(session.artifacts[0]).toMatchObject({
      href: `/api/linear/artifacts/${artifactId}`,
      state: "failed",
    });
    expect(session.links.map((link: { href: string }) => link.href)).toEqual([
      "https://github.com/acme/project/pull/42",
      "https://linear.app/acme/issue/ENG-1",
    ]);
    const serialized = JSON.stringify(body);
    for (const secret of [
      "private-signature",
      "private-auth",
      "private-token",
      "signalMetadata",
      "Obsolete plan",
    ])
      expect(serialized).not.toContain(secret);
    const publicResponse = await handleStatusRequest(
      new Request("http://127.0.0.1:8787/api/status"),
      { db, staticDir: null },
    );
    expect(await publicResponse!.text()).not.toContain("Private correction");
  } finally {
    db.close();
  }
});

test("conversation access rejects remote and cross-origin requests before public CORS", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  try {
    for (const request of [
      new Request("http://192.168.1.5:8787/api/linear/conversations"),
      new Request(ADDRESS, { headers: { origin: "https://evil.test" } }),
      new Request(ADDRESS, { headers: { host: "evil.test" } }),
      new Request(ADDRESS, { headers: { "sec-fetch-site": "cross-site" } }),
    ]) {
      const response = await handleStatusRequest(request, { db, staticDir: null });
      expect(response?.status).toBe(403);
      expect(response?.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect(
      (await handleStatusRequest(new Request(ADDRESS, { method: "POST" }), { db }))?.status,
    ).toBe(405);
    db.run("DROP TABLE IF EXISTS linear_session");
    const olderStore = await handleStatusRequest(new Request(ADDRESS), { db });
    expect(await olderStore!.json()).toEqual({ sessions: [] });
  } finally {
    db.close();
  }
});
