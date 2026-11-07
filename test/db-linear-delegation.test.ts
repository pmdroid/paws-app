import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  ensureLinearSessionSteps,
  getLinearTaskDelegationSteps,
  linearSessionsForDelegatedTeamsSteps,
  linearSessionsForUndelegatedIssueSteps,
  requireLinearTaskDelegationSteps,
  type Db,
  type Q,
} from "../src/db";
import { forEachDialect, insertWorkItemSteps } from "./dialects";

function* sessionWithItem(q: Q, sessionId: string, itemId: string) {
  yield* insertWorkItemSteps(q, itemId);
  yield* ensureLinearSessionSteps(q, {
    sessionId,
    organizationId: "org",
    appUserId: "app",
    issueId: `session-issue-${sessionId}`,
    now: 0,
  });
  yield* q.exec(
    q.orm.update(q.t.workItem).set({ sessionKey: sessionId }).where(eq(q.t.workItem.id, itemId)),
  );
  yield* q.exec(
    q.orm
      .update(q.t.linearSession)
      .set({ oauthClientId: "client" })
      .where(eq(q.t.linearSession.sessionId, sessionId)),
  );
}

forEachDialect((open) => {
  async function withDb(body: (db: Db) => Promise<void>) {
    const opened = await open();
    try {
      await body(opened.db);
    } finally {
      await opened.close();
    }
  }

  test("a task delegation keeps its app user and first human actor", () =>
    withDb(async (db) => {
      const input = { itemId: "item", issueId: "issue", teamId: "team", appUserId: "app" };
      await db.run((q) => insertWorkItemSteps(q, "item"));
      expect(await db.run((q) => getLinearTaskDelegationSteps(q, "item", "issue"))).toBeNull();
      await db.run((q) => requireLinearTaskDelegationSteps(q, input));
      await db.run((q) =>
        requireLinearTaskDelegationSteps(q, { ...input, teamId: "moved", humanActorId: "human" }),
      );
      await db.run((q) => requireLinearTaskDelegationSteps(q, input));
      expect(await db.run((q) => getLinearTaskDelegationSteps(q, "item", "issue"))).toEqual({
        appUserId: "app",
        humanActorId: "human",
        teamId: "team",
      });
      await expect(
        db.run((q) => requireLinearTaskDelegationSteps(q, { ...input, humanActorId: "other" })),
      ).rejects.toThrow("Linear delegation ownership changed.");
      await expect(
        db.run((q) => requireLinearTaskDelegationSteps(q, { ...input, teamId: " " })),
      ).rejects.toThrow("Linear delegation ownership is incomplete.");
    }));

  test("sessions whose delegated team lost access are listed once", () =>
    withDb(async (db) => {
      await db.transaction(function* (q) {
        yield* sessionWithItem(q, "s2", "item-2");
        yield* sessionWithItem(q, "s1", "item-1");
        yield* sessionWithItem(q, "s3", "item-3");
        for (const [itemId, issueId, teamId] of [
          ["item-1", "issue-1", "blocked"],
          ["item-1", "issue-1b", "blocked"],
          ["item-2", "issue-2", "blocked"],
          ["item-3", "issue-3", "open"],
        ] as const)
          yield* requireLinearTaskDelegationSteps(q, { itemId, issueId, teamId, appUserId: "app" });
        for (const [teamId, allowed] of [
          ["blocked", 0],
          ["open", 1],
        ] as const)
          yield* q.exec(
            q.orm.insert(q.t.linearTeamAccess).values({
              organizationId: "org",
              oauthClientId: "client",
              appUserId: "app",
              teamId,
              allowed,
              observedAt: 0,
            }),
          );
      });
      const scope = { organizationId: "org", oauthClientId: "client", appUserId: "app" };
      expect(
        await db.run((q) =>
          linearSessionsForDelegatedTeamsSteps(q, { ...scope, teamIds: ["blocked", "open"] }),
        ),
      ).toEqual(["s1", "s2"]);
      expect(
        await db.run((q) => linearSessionsForDelegatedTeamsSteps(q, { ...scope, teamIds: [] })),
      ).toEqual([]);
    }));

  test("sessions still working on an undelegated issue are found by issue or epic", () =>
    withDb(async (db) => {
      await db.transaction(function* (q) {
        yield* sessionWithItem(q, "by-item", "item-1");
        yield* sessionWithItem(q, "by-epic", "item-2");
        yield* sessionWithItem(q, "done", "item-3");
        yield* ensureLinearSessionSteps(q, {
          sessionId: "empty",
          organizationId: "org",
          appUserId: "app",
          issueId: "epic",
          now: 0,
        });
        const brief = { epic: { issueId: "epic" } };
        yield* q.exec(
          q.orm
            .update(q.t.workItem)
            .set({ linearIssueId: "epic" })
            .where(eq(q.t.workItem.id, "item-1")),
        );
        yield* q.exec(
          q.orm
            .update(q.t.workItem)
            .set({ brief: q.dialect === "postgres" ? brief : JSON.stringify(brief) })
            .where(eq(q.t.workItem.id, "item-2")),
        );
        yield* q.exec(
          q.orm
            .update(q.t.workItem)
            .set({ linearIssueId: "epic", state: "merged" })
            .where(eq(q.t.workItem.id, "item-3")),
        );
      });
      const input = { organizationId: "org", appUserId: "app", issueId: "epic", createdAtMs: 0 };
      expect(await db.run((q) => linearSessionsForUndelegatedIssueSteps(q, input))).toEqual([
        "by-epic",
        "by-item",
        "empty",
      ]);
      expect(
        await db.run((q) =>
          linearSessionsForUndelegatedIssueSteps(q, { ...input, appUserId: "x" }),
        ),
      ).toEqual([]);
    }));
});
