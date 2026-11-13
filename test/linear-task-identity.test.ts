import { expect, test } from "bun:test";
import { and, asc, count, eq, notInArray, sql } from "drizzle-orm";
import {
  JobLoop,
  OutboxDispatcher,
  activateLinearItem,
  advanceLinearSessionGeneration,
  applyLinearTurns,
  bindLinearSessionTask,
  ensureLinearSession,
  getLinearSession,
  getLinearSessionGeneration,
  delegatedLinearUserId,
  getWorkItem,
  putWorkspaceUser,
  saveTaskClassification,
  listPendingLinearTurns,
  recordLinearTurn,
  syncSteps,
  type Db,
} from "../src/db";
import { createFakeTracker } from "../src/linear";
import { intakeDelegatedIssue } from "../src/intake";
import { attachOrchestrator, itemPathId } from "../src/loop";
import { systemClock } from "../src/core";
import { seed } from "./dialects";
import { tempStore } from "./pglite";

const setState = (db: Db, id: string, state: string) =>
  seed(db, (q) => q.orm.update(q.t.workItem).set({ state }).where(eq(q.t.workItem.id, id)));

const ownerOf = async (db: Db, id: string) =>
  (
    await db.run((q) =>
      q.one(
        q.orm
          .select({ owner: q.t.workItem.ownerUserId })
          .from(q.t.workItem)
          .where(eq(q.t.workItem.id, id)),
      ),
    )
  )?.owner;

const snapshot = {
  linearIssueId: "issue",
  identifier: "ENG-1",
  title: "Request",
  description: null,
  subIssues: [],
};

async function task(db: Db, key?: string) {
  const result = await intakeDelegatedIssue(db, createFakeTracker([snapshot]), {
    linearIssueId: "issue",
    taskKey: key,
  });
  if (!result.ok) throw new Error("Unexpected cycle");
  return result;
}

test("new tasks keep source IDs and get separate worktree identities while intake replay is stable", async () => {
  const { db, close } = await tempStore();
  try {
    const initial = await task(db);
    await setState(db, initial.items[0]!.id, "merged");
    const later = await task(db, "turn:followup");
    const replay = await task(db, "turn:followup");
    expect(replay.delegation.id).toBe(later.delegation.id);
    expect(initial.delegation.id).not.toBe(later.delegation.id);
    const first = (await getWorkItem(db, initial.items[0]!.id))!;
    const next = (await getWorkItem(db, later.items[0]!.id))!;
    expect(first.linearIssueId).toBe(next.linearIssueId);
    expect(itemPathId(first)).toBe("ENG-1");
    expect(itemPathId(next)).toContain(next.id);
    expect(itemPathId(first)).not.toBe(itemPathId(next));
  } finally {
    await close();
  }
});

test("session ownership and active child routing remain separate from shared issue identity", async () => {
  const { db, close } = await tempStore();
  try {
    const first = await task(db);
    await setState(db, first.items[0]!.id, "merged");
    const second = await task(db, "session:second");
    await ensureLinearSession(db, {
      sessionId: "first",
      issueId: "issue",
      organizationId: "org",
      appUserId: "app",
      creatorId: "human",
    });
    await bindLinearSessionTask(db, "first", first.delegation.id);
    await activateLinearItem(db, "first", first.items[0]!.id);
    await ensureLinearSession(db, { sessionId: "second", issueId: "issue" });
    await bindLinearSessionTask(db, "second", second.delegation.id);
    await activateLinearItem(db, "second", second.items[0]!.id);
    expect(await delegatedLinearUserId(db, first.items[0]!.id)).toBe("human");
    expect(await delegatedLinearUserId(db, second.items[0]!.id)).toBeNull();
    await expect(
      ensureLinearSession(db, { sessionId: "first", organizationId: "other" }),
    ).rejects.toThrow("ownership changed");
    await expect(bindLinearSessionTask(db, "second", first.delegation.id)).rejects.toThrow();
    await expect(activateLinearItem(db, "second", first.items[0]!.id)).rejects.toThrow(
      "route changed",
    );
    expect((await getWorkItem(db, first.items[0]!.id))?.sessionKey).toBe("first");
  } finally {
    await close();
  }
});

test("prompt before hydration persists, ordered duplicates apply once and Stop fences pending turns", async () => {
  const { db, close } = await tempStore();
  try {
    const turn = (eventKey: string, createdAtMs: number) => ({
      eventKey,
      activityId: eventKey,
      sessionId: "session",
      actorId: "human",
      body: eventKey,
      payload: "{}",
      createdAtMs,
    });
    await recordLinearTurn(db, turn("later", 20));
    await recordLinearTurn(db, turn("earlier", 10));
    await recordLinearTurn(db, { ...turn("later", 20), body: "Edited comment" });
    expect((await getLinearSession(db, "session"))?.delegationId).toBeNull();
    expect((await listPendingLinearTurns(db, "session")).map((entry) => entry.body)).toEqual([
      "earlier",
      "later",
    ]);
    const result = await task(db);
    await bindLinearSessionTask(db, "session", result.delegation.id, {
      actorId: "human",
    });
    const itemId = result.items[0]!.id;
    await activateLinearItem(db, "session", itemId);
    await applyLinearTurns(db, "session", ["earlier"], itemId);
    await applyLinearTurns(db, "session", ["earlier"], itemId);
    expect((await listPendingLinearTurns(db, "session")).map((entry) => entry.eventKey)).toEqual([
      "later",
    ]);
    expect(await advanceLinearSessionGeneration(db, "session", { stop: true, now: 30 })).toBe(1);
    expect(await getLinearSessionGeneration(db, "session")).toBe(1);
    expect(await listPendingLinearTurns(db, "session")).toEqual([]);
    await recordLinearTurn(db, turn("after-stop", 40));
    expect((await listPendingLinearTurns(db, "session")).map((entry) => entry.eventKey)).toEqual([
      "after-stop",
    ]);
  } finally {
    await close();
  }
});

test("a second session for an active issue is rejected and a prompt still hydrates after that item is cancelled", async () => {
  const { db, close } = await tempStore();
  const orchestrator = attachOrchestrator({
    store: db,
    tracker: createFakeTracker([snapshot]),
    jobs: new JobLoop(db, systemClock),
    outbox: new OutboxDispatcher(db, systemClock),
    pawsRoot: "/tmp/unused-identity-fixture",
  });
  try {
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
    await orchestrator.onLinearEvent(created("first"));
    const first = (await getLinearSession(db, "first"))!;
    expect(first.activeItemId).not.toBeNull();
    expect(
      await db.run((q) =>
        q.all(
          q.orm
            .select({ name: sql<string>`table_name` })
            .from(sql`information_schema.tables`)
            .where(sql`table_name = 'epic'`),
        ),
      ),
    ).toEqual([]);
    await expect(orchestrator.onLinearEvent(created("second"))).rejects.toThrow(
      "ENG-1 has an unfinished attempt in another Paws session. Reply in that session to continue, or stop it before starting a new one.",
    );
    expect((await getLinearSession(db, "second"))?.delegationId ?? null).toBeNull();
    expect((await db.run((q) => q.one(q.orm.select({ n: count() }).from(q.t.workItem))))?.n).toBe(
      1,
    );
    await setState(db, first.activeItemId, "cancelled");
    await orchestrator.onLinearEvent({
      ...created("before-created"),
      dedupeKey: "activity:early",
      action: "prompted",
      activityId: "early",
      body: "Do this after hydration",
    });
    expect((await listPendingLinearTurns(db, "before-created"))[0]?.body).toBe(
      "Do this after hydration",
    );
    await orchestrator.onLinearEvent(created("before-created"));
    expect((await getLinearSession(db, "before-created"))?.activeItemId).not.toBeNull();
    expect(await listPendingLinearTurns(db, "before-created")).toHaveLength(1);
    expect(
      await delegatedLinearUserId(
        db,
        (await getLinearSession(db, "before-created"))!.activeItemId!,
      ),
    ).toBe("human");
  } finally {
    await orchestrator.shutdown();
    await close();
  }
});

test("a redirect cancels the previous item before the replacement is inserted", async () => {
  const { db, close } = await tempStore();
  const orchestrator = attachOrchestrator({
    store: db,
    tracker: createFakeTracker([snapshot]),
    jobs: new JobLoop(db, systemClock),
    outbox: new OutboxDispatcher(db, systemClock),
    pawsRoot: "/tmp/unused-redirect-fixture",
  });
  try {
    await ensureLinearSession(db, {
      sessionId: "session",
      issueId: "issue",
      organizationId: "org",
      creatorId: "human",
    });
    const initial = await task(db, "original");
    const previousId = initial.items[0]!.id;
    await saveTaskClassification(db, "original", {
      mode: "code",
      redirect: { taskKey: "resolved:original", itemId: previousId },
    });
    const replaced = await orchestrator.intakeLinearTask("issue", "session", "original");
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    expect((await getWorkItem(db, previousId))?.state).toBe("cancelled");
    expect(replaced.items).toHaveLength(1);
    expect(replaced.items[0]?.id).not.toBe(previousId);
    expect(replaced.items[0]?.state).toBe("queued");
    expect(replaced.items[0]?.linearIssueId).toBe("issue");
    expect(
      (
        await db.run((q) =>
          q.one(
            q.orm
              .select({ n: count() })
              .from(q.t.workItem)
              .where(
                and(
                  eq(q.t.workItem.linearIssueId, "issue"),
                  notInArray(q.t.workItem.state, ["completed", "merged", "cancelled"]),
                ),
              ),
          ),
        )
      )?.n,
    ).toBe(1);
  } finally {
    await orchestrator.shutdown();
    await close();
  }
});

test("intake sets the session owner's workspace user on each new solo item and leaves an unknown actor unset", async () => {
  const { db, close } = await tempStore();
  await putWorkspaceUser(db, {
    id: "delegate-user",
    linearUserId: "delegate",
    name: "Delegate",
    email: "delegate@example.test",
  });
  await putWorkspaceUser(db, {
    id: "human-user",
    linearUserId: "human",
    name: "Human",
    email: "human@example.test",
  });
  const parent = {
    linearIssueId: "parent",
    identifier: "P",
    title: "Parent",
    description: null,
    subIssues: [
      { linearIssueId: "child-a", identifier: "A", title: "A" },
      { linearIssueId: "child-b", identifier: "B", title: "B" },
    ],
  };
  const orchestrator = attachOrchestrator({
    store: db,
    tracker: createFakeTracker([
      parent,
      {
        linearIssueId: "ghost-issue",
        identifier: "G",
        title: "Ghost",
        description: null,
        subIssues: [],
      },
      {
        linearIssueId: "human-issue",
        identifier: "H",
        title: "Human",
        description: null,
        subIssues: [],
      },
    ]),
    jobs: new JobLoop(db, systemClock),
    outbox: new OutboxDispatcher(db, systemClock),
    pawsRoot: "/tmp/unused-owner-fixture",
    linearIntakeActor: (_q, sessionId) =>
      syncSteps(() => (sessionId === "delegated" ? "delegate" : undefined)),
  });
  try {
    await ensureLinearSession(db, {
      sessionId: "delegated",
      issueId: "parent",
      organizationId: "org",
      creatorId: "human",
    });
    await ensureLinearSession(db, {
      sessionId: "ghost-session",
      issueId: "ghost-issue",
      organizationId: "org",
      creatorId: "ghost",
    });
    await ensureLinearSession(db, {
      sessionId: "human-session",
      issueId: "human-issue",
      organizationId: "org",
      creatorId: "human",
    });
    const delegated = await orchestrator.intakeLinearTask("parent", "delegated", "delegated-task");
    expect(delegated.ok).toBe(true);
    if (!delegated.ok) return;
    expect(delegated.items.map((item) => item.linearIssueId).sort()).toEqual([
      "child-a",
      "child-b",
    ]);
    expect(
      await db.run((q) =>
        q.all(
          q.orm
            .select({
              linear_issue_id: q.t.workItem.linearIssueId,
              owner_user_id: q.t.workItem.ownerUserId,
            })
            .from(q.t.workItem)
            .orderBy(asc(q.t.workItem.linearIssueId)),
        ),
      ),
    ).toEqual([
      { linear_issue_id: "child-a", owner_user_id: "delegate-user" },
      { linear_issue_id: "child-b", owner_user_id: "delegate-user" },
    ]);
    const ghost = await orchestrator.intakeLinearTask("ghost-issue", "ghost-session", "ghost-task");
    expect(ghost.ok).toBe(true);
    if (!ghost.ok) return;
    expect(await ownerOf(db, ghost.items[0]!.id)).toBeNull();
    const human = await orchestrator.intakeLinearTask("human-issue", "human-session", "human-task");
    expect(human.ok).toBe(true);
    if (!human.ok) return;
    expect(await ownerOf(db, human.items[0]!.id)).toBe("human-user");
  } finally {
    await orchestrator.shutdown();
    await close();
  }
});
