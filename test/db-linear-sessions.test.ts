import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { JOB_KIND } from "../src/core";
import {
  activateLinearItemSteps,
  applyLinearTurnsSteps,
  bindLinearSessionTaskSteps,
  delegatedLinearUserIdSteps,
  discardLinearTurnsSteps,
  ensureLinearSessionSteps,
  getLinearSessionGenerationSteps,
  getLinearSessionSteps,
  getLinearTurnGenerationSteps,
  linearSessionClientIdSteps,
  linearSessionInWorkspaceSteps,
  listLinearTurnsForItemSteps,
  listPendingLinearTurnsSteps,
  recordLinearTurnSteps,
  releaseIdleSessionItemSteps,
  sessionActiveRunsSteps,
  workItemForSessionSteps,
  type Db,
  type Q,
} from "../src/db";
import { forEachDialect, insertWorkItemSteps, type DialectDb } from "./dialects";

function* setItem(q: Q, id: string, values: Partial<Q["t"]["workItem"]["$inferInsert"]>) {
  yield* q.exec(q.orm.update(q.t.workItem).set(values).where(eq(q.t.workItem.id, id)));
}

function turn(eventKey: string, createdAtMs: number) {
  return {
    eventKey,
    activityId: `activity-${eventKey}`,
    sessionId: "session",
    actorId: null,
    body: `body ${eventKey}`,
    payload: JSON.stringify({ eventKey }),
    createdAtMs,
    now: 1,
  };
}

forEachDialect((open) => {
  async function withDb(body: (db: Db) => Promise<void>) {
    const opened: DialectDb = await open();
    try {
      await body(opened.db);
    } finally {
      await opened.close();
    }
  }

  test("a session keeps its first owners and its linked delegation", () =>
    withDb(async (db) => {
      expect(await db.run((q) => getLinearSessionSteps(q, "session"))).toBeNull();
      await db.transaction((q) =>
        ensureLinearSessionSteps(q, { sessionId: "session", creatorId: "creator", now: 5 }),
      );
      const session = await db.transaction((q) =>
        ensureLinearSessionSteps(q, { sessionId: "session", issueId: "issue", appUserId: "app" }),
      );
      expect(session).toEqual({
        sessionId: "session",
        issueId: "issue",
        organizationId: null,
        appUserId: "app",
        creatorId: "creator",
        delegationId: null,
        activeItemId: null,
        generation: 0,
        stoppedAt: null,
      });
      await expect(
        db.transaction((q) =>
          ensureLinearSessionSteps(q, { sessionId: "session", creatorId: "other" }),
        ),
      ).rejects.toThrow("Linear session creatorId ownership changed");
      expect(await db.run((q) => getLinearSessionGenerationSteps(q, "session"))).toBe(0);
      expect(await db.run((q) => getLinearSessionGenerationSteps(q, "missing"))).toBe(0);
    }));

  test("binding a task routes its items, owner and delegator to the session", () =>
    withDb(async (db) => {
      await db.transaction(function* (q) {
        yield* insertWorkItemSteps(q, "item");
        yield* q.exec(
          q.orm
            .insert(q.t.workspaceUser)
            .values({ id: "user", linearUserId: "creator", name: "Ada", email: "a@example.com" }),
        );
        yield* ensureLinearSessionSteps(q, { sessionId: "session", creatorId: "creator" });
        yield* bindLinearSessionTaskSteps(q, "session", "delegation-item");
      });
      expect(await db.run((q) => workItemForSessionSteps(q, "session"))).toEqual({
        id: "item",
        delegationId: "delegation-item",
        state: "queued",
      });
      expect(await db.run((q) => delegatedLinearUserIdSteps(q, "item"))).toBe("creator");
      expect(await db.run((q) => delegatedLinearUserIdSteps(q, "missing"))).toBeNull();
      expect((await db.run((q) => getLinearSessionSteps(q, "session")))?.delegationId).toBe(
        "delegation-item",
      );
    }));

  test("activating an item refuses while the previous item is in flight", () =>
    withDb(async (db) => {
      await db.transaction(function* (q) {
        yield* insertWorkItemSteps(q, "first");
        yield* insertWorkItemSteps(q, "second");
        yield* setItem(q, "second", { delegationId: "delegation-first" });
        yield* ensureLinearSessionSteps(q, { sessionId: "session" });
        yield* activateLinearItemSteps(q, "session", "first");
        yield* setItem(q, "first", { state: "running" });
      });
      await expect(
        db.transaction((q) => activateLinearItemSteps(q, "session", "second")),
      ).rejects.toThrow("Previous Linear task is still active");
      await db.run((q) => setItem(q, "first", { state: "merged" }));
      await db.transaction((q) => activateLinearItemSteps(q, "session", "second"));
      expect((await db.run((q) => getLinearSessionSteps(q, "session")))?.activeItemId).toBe(
        "second",
      );
    }));

  test("turns are recorded once, applied to an item and discarded", () =>
    withDb(async (db) => {
      await db.run((q) => insertWorkItemSteps(q, "item"));
      const first = await db.transaction((q) => recordLinearTurnSteps(q, turn("a", 10)));
      await db.transaction((q) => recordLinearTurnSteps(q, turn("b", 20)));
      await db.transaction((q) => recordLinearTurnSteps(q, turn("c", 30)));
      const again = await db.transaction((q) =>
        recordLinearTurnSteps(q, { ...turn("a", 10), actorId: "actor" }),
      );
      expect(first).toMatchObject({ eventKey: "a", state: "pending", actorId: null });
      expect(JSON.parse(first.payload)).toEqual({ eventKey: "a" });
      expect(again).toMatchObject({ eventKey: "a", actorId: "actor", ordinal: first.ordinal });
      expect(
        (await db.run((q) => listPendingLinearTurnsSteps(q, "session"))).map((t) => t.eventKey),
      ).toEqual(["a", "b", "c"]);

      await expect(
        db.transaction((q) => applyLinearTurnsSteps(q, "session", ["a"], "item")),
      ).rejects.toThrow("Linear turn route is no longer active");
      await db.run((q) => setItem(q, "item", { sessionKey: "session" }));
      await db.transaction((q) => applyLinearTurnsSteps(q, "session", ["a"], "item"));
      await db.transaction((q) => discardLinearTurnsSteps(q, "session", ["b"]));
      expect(
        (await db.run((q) => listLinearTurnsForItemSteps(q, "item"))).map((t) => t.eventKey),
      ).toEqual(["a"]);
      expect(
        (await db.run((q) => listPendingLinearTurnsSteps(q, "session"))).map((t) => t.eventKey),
      ).toEqual(["c"]);
      expect(
        await db.run((q) => getLinearTurnGenerationSteps(q, "session", "x", "activity-c")),
      ).toBeNull();
    }));

  test("an idle session item is released only without live runs or jobs", () =>
    withDb(async (db) => {
      await db.transaction(function* (q) {
        yield* insertWorkItemSteps(q, "item");
        yield* ensureLinearSessionSteps(q, { sessionId: "session" });
        yield* activateLinearItemSteps(q, "session", "item");
        yield* q.exec(
          q.orm.insert(q.t.job).values({
            queue: JOB_KIND.start,
            payload:
              q.dialect === "postgres" ? { itemId: "item" } : JSON.stringify({ itemId: "item" }),
            runAt: 0,
            status: "running",
            createdAt: 0,
            lockedUntil: 100,
          }),
        );
      });
      const active = async () =>
        (await db.run((q) => getLinearSessionSteps(q, "session")))?.activeItemId;
      await db.run((q) => releaseIdleSessionItemSteps(q, "item", 50));
      expect(await active()).toBe("item");
      await db.run((q) => releaseIdleSessionItemSteps(q, "item", 100));
      expect(await active()).toBeNull();
    }));

  test("a session reports its client, workspace and active runs", () =>
    withDb(async (db) => {
      await db.transaction(function* (q) {
        yield* insertWorkItemSteps(q, "item");
        yield* setItem(q, "item", { sessionKey: "session", state: "running", currentRunId: "run" });
        yield* q.exec(
          q.orm.insert(q.t.workspace).values({
            id: "workspace",
            linearOrganizationId: "org",
            name: "Paws",
            createdAt: 0,
          }),
        );
        yield* ensureLinearSessionSteps(q, { sessionId: "session", organizationId: "org" });
        yield* q.exec(
          q.orm
            .update(q.t.linearSession)
            .set({ oauthClientId: "client" })
            .where(eq(q.t.linearSession.sessionId, "session")),
        );
      });
      expect(await db.run((q) => linearSessionClientIdSteps(q, "session"))).toBe("client");
      expect(await db.run((q) => linearSessionClientIdSteps(q, "missing"))).toBeNull();
      expect(await db.run((q) => linearSessionInWorkspaceSteps(q, "session", "workspace"))).toBe(
        true,
      );
      expect(await db.run((q) => linearSessionInWorkspaceSteps(q, "session", "other"))).toBe(false);
      expect(await db.run((q) => sessionActiveRunsSteps(q, "session"))).toEqual([
        { itemId: "item", runId: "run" },
      ]);
    }));
});
