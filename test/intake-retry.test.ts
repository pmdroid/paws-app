import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  JobLoop,
  OutboxDispatcher,
  applyWorkItemEvent,
  getLinearSession,
  blockLinearSessionCleanup,
  enqueueJob,
  failWorkItem,
  getWorkItem,
  insertRun,
  recordLinearInstallation,
  saveConversation,
} from "../src/db";
import { intakeDelegatedIssue } from "../src/intake";
import { acknowledgeNewSession, createFakeTracker } from "../src/linear";
import { systemClock } from "../src/core";
import { attachOrchestrator } from "../src/loop";
import { tempDb } from "./helpers";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function fixture() {
  const db = tempDb();
  databases.push(db);
  const tracker = createFakeTracker([
    {
      linearIssueId: "issue",
      identifier: "PAS-372",
      title: "Retry me",
      description: null,
      subIssues: [],
    },
  ]);
  for (const sessionId of ["old", "new", "other"])
    recordLinearInstallation(db, {
      sessionId,
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      teamId: "team",
      observedAtMs: 1,
    });
  const admit = (sessionId: string, onAccepted?: () => void, taskKey = sessionId) =>
    intakeDelegatedIssue(db, tracker, {
      linearIssueId: "issue",
      sessionId,
      taskKey,
      onAccepted,
    });
  return { db, tracker, admit };
}

async function failedAttempt() {
  const { db, tracker, admit } = fixture();
  const first = await admit("old");
  if (!first.ok) throw new Error("Expected admission");
  const id = first.items[0]!.id;
  enqueueJob(db, { queue: "item.start", payload: { itemId: id } });
  applyWorkItemEvent(db, id, "dispatched");
  failWorkItem(db, getWorkItem(db, id)!, "no_repository", "No repository accessible", 10);
  tracker.progress.length = 0;
  return { db, tracker, id, admit };
}

test("a new session replaces an empty failed attempt and preserves its history", async () => {
  const { db, id, admit } = await failedAttempt();
  const replacement = await admit("new");
  expect(replacement.ok).toBe(true);
  if (!replacement.ok) return;
  expect(replacement.items[0]?.id).not.toBe(id);
  expect(replacement.items[0]?.state).toBe("queued");
  expect(getWorkItem(db, id)).toMatchObject({ state: "cancelled", cancelRequested: true });
  expect(db.query("SELECT last_error FROM job").get()).toEqual({ last_error: "no_repository" });
  expect(db.query("SELECT id FROM outbox").all()).toHaveLength(1);
  expect(db.query("SELECT id FROM run").all()).toHaveLength(0);
  const replay = await admit("new");
  expect(replay.ok && replay.alreadyExisted).toBe(true);
  expect(replay.ok && replay.items[0]?.id).toBe(replacement.items[0]?.id);
  const oldReplay = await admit("old");
  expect(oldReplay.ok && oldReplay.alreadyExisted).toBe(true);
  expect(getWorkItem(db, id)?.state).toBe("cancelled");
  expect(db.query("SELECT id FROM work_item").all()).toHaveLength(2);
});

test("replacement and retirement roll back together when admission fails", async () => {
  const { db, id, admit } = await failedAttempt();
  await expect(
    admit("new", () => {
      throw new Error("Admission failed");
    }),
  ).rejects.toThrow("Admission failed");
  expect(getWorkItem(db, id)?.state).toBe("failed");
  expect(db.query("SELECT id FROM work_item").all()).toHaveLength(1);
  expect((await admit("new")).ok).toBe(true);
});

test("two new sessions racing to retry admit exactly one replacement", async () => {
  const { db, admit } = await failedAttempt();
  const results = await Promise.allSettled([admit("new"), admit("other")]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  expect(db.query("SELECT id FROM work_item WHERE state = 'queued'").all()).toHaveLength(1);
});

test("the original session keeps its failed attempt for ordinary resume", async () => {
  const { db, id, admit } = await failedAttempt();
  expect((await admit("old")).ok).toBe(true);
  await expect(admit("old", undefined, "another-task")).rejects.toThrow("PAS-372");
  expect(getWorkItem(db, id)?.state).toBe("failed");
});

test.each(["run", "checkpoint", "job", "conversation", "cleanup", "parent", "sibling"])(
  "a failed attempt with %s ownership cannot be replaced",
  async (held) => {
    const { db, id, admit } = await failedAttempt();
    if (held === "run") insertRun(db, { itemId: id, now: 1, status: "ended" });
    if (held === "checkpoint")
      db.run("UPDATE work_item SET checkpoint = ? WHERE id = ?", ['{"phase":"running"}', id]);
    if (held === "job") enqueueJob(db, { queue: "item.start", payload: { itemId: id } });
    if (held === "conversation") saveConversation(db, id, "[]", null, true);
    if (held === "cleanup") blockLinearSessionCleanup(db, "old");
    if (held === "parent")
      db.run("UPDATE work_item SET brief = json_set(brief, '$.epic', json(?)) WHERE id = ?", [
        '{"issueId":"parent"}',
        id,
      ]);
    if (held === "sibling")
      db.run(
        `INSERT INTO work_item (id,delegation_id,linear_issue_id,linear_identifier,title,state,position,version,branch_name,created_at)
         SELECT 'sibling',delegation_id,'sibling','PAS-373','Sibling','queued',1,0,'paws/pas-373',1
         FROM work_item WHERE id = ?`,
        [id],
      );
    await expect(admit("new")).rejects.toThrow("PAS-372");
    expect(getWorkItem(db, id)?.state).toBe("failed");
  },
);

test.each(["organization_id", "oauth_client_id", "app_user_id", "team_id"])(
  "a new session from another %s cannot retire an attempt",
  async (column) => {
    const { db, id, admit } = await failedAttempt();
    db.run(`UPDATE linear_session SET ${column} = 'different' WHERE session_id = 'new'`);
    await expect(admit("new")).rejects.toThrow("PAS-372");
    expect(getWorkItem(db, id)?.state).toBe("failed");
  },
);

test.each(["queued", "running", "awaiting_input", "paused"])(
  "%s work still rejects another session",
  async (state) => {
    const { db, id, admit } = await failedAttempt();
    db.run("UPDATE work_item SET state = ?, cancel_requested = 0 WHERE id = ?", [state, id]);
    await expect(admit("new")).rejects.toThrow("PAS-372");
    expect(getWorkItem(db, id)?.state).toBe(state);
  },
);

test("session conflicts report one actionable error without suggesting another retry", async () => {
  const { db, id, tracker, admit } = await failedAttempt();
  insertRun(db, { itemId: id, now: 1, status: "ended" });
  await expect(
    acknowledgeNewSession(
      tracker,
      {
        dedupeKey: "new:created",
        deliveryId: "delivery",
        source: "webhook",
        action: "created",
        sessionId: "new",
        issueId: "issue",
        activityId: null,
        body: null,
        signal: null,
        updatedAtMs: 1,
        payload: "{}",
      },
      async () => {
        await admit("new");
      },
    ),
  ).rejects.toThrow("PAS-372");
  expect(tracker.progress.filter((update) => update.kind === "error")).toEqual([
    {
      sessionId: "new",
      kind: "error",
      body: "PAS-372 has an unfinished attempt in another Paws session. Reply in that session to continue, or stop it before starting a new one.",
    },
  ]);
});

test("created events replace a failed start, bind the new session and fence replies in the old one", async () => {
  const { db, tracker } = fixture();
  const orchestrator = attachOrchestrator({
    db,
    tracker,
    jobs: new JobLoop(db, systemClock),
    outbox: new OutboxDispatcher(db, systemClock),
    pawsRoot: "/tmp/unused-empty-retry-fixture",
  });
  const created = (sessionId: string) => ({
    dedupeKey: `session:${sessionId}:created`,
    deliveryId: null,
    source: "webhook" as const,
    action: "created" as const,
    sessionId,
    issueId: "issue",
    activityId: null,
    body: null,
    signal: null,
    updatedAtMs: 10,
    payload: JSON.stringify({
      organizationId: "org",
      appUserId: "app",
      agentSession: { creatorId: "human" },
    }),
  });
  try {
    await orchestrator.onLinearEvent(created("old"));
    const originalId = getLinearSession(db, "old")!.activeItemId!;
    applyWorkItemEvent(db, originalId, "dispatched");
    failWorkItem(db, getWorkItem(db, originalId)!, "no_repository", "No repository accessible", 10);
    await orchestrator.onLinearEvent(created("new"));
    const replacementId = getLinearSession(db, "new")!.activeItemId!;
    expect(replacementId).not.toBe(originalId);
    expect(getWorkItem(db, replacementId)).toMatchObject({ state: "queued", sessionKey: "new" });
    expect(getWorkItem(db, originalId)?.state).toBe("cancelled");
    await orchestrator.onLinearEvent(created("new"));
    await orchestrator.onLinearEvent(created("old"));
    await expect(
      orchestrator.onLinearEvent({
        ...created("old"),
        dedupeKey: "activity:retry-old",
        action: "prompted",
        activityId: "retry-old",
        body: "retry",
      }),
    ).rejects.toThrow("PAS-372");
    expect(getWorkItem(db, originalId)?.state).toBe("cancelled");
    expect(getLinearSession(db, "new")!.activeItemId).toBe(replacementId);
    expect(db.query("SELECT id FROM work_item").all()).toHaveLength(2);
  } finally {
    await orchestrator.shutdown();
  }
});
