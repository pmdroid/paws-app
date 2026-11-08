import { expect, test } from "bun:test";
import {
  insertWorkspaceAssignmentSteps,
  invalidateWorkspaceAssignmentSteps,
  latestWorkspaceAssignmentSteps,
  linkWorkspaceAssignmentSteps,
  moveWorkspaceAssignmentSteps,
  pendingWorkspaceAssignmentTokensSteps,
  workspaceAssignmentByTokenSteps,
  workspaceAssignmentTokenForLinkSteps,
  type Db,
  type Q,
} from "../src/db";
import { forEachDialect, json, withoutForeignKeys, type DialectDb } from "./dialects";

function hold(generation: number, overrides: { sessionId?: string; actorId?: string } = {}) {
  return {
    sessionId: "session",
    generation,
    workspaceId: "acme",
    actorId: "actor",
    tokenHash: `hash-${overrides.sessionId ?? "session"}-${generation}`,
    linkId: `link-${overrides.sessionId ?? "session"}-${generation}`,
    linkExpiresAt: 50,
    fingerprint: "{}",
    event: JSON.stringify({ action: "created", generation }),
    expiresAt: 50,
    ...overrides,
  };
}

function* status(q: Q, tokenHash: string) {
  return (yield* workspaceAssignmentByTokenSteps(q, tokenHash))?.status;
}

function* seedLegacy(db: Db, q: Q) {
  yield* q.exec(
    q.orm.insert(q.t.workspaceAssignment).values({
      sessionId: "legacy",
      generation: 1,
      workspaceId: "acme",
      actorId: "actor",
      tokenHash: "legacy-hash",
      fingerprint: "{}",
      event: json(db, {}),
      expiresAt: 5,
      status: "pending",
    }),
  );
}

forEachDialect((open) => {
  async function withDb(body: (db: Db) => Promise<void>) {
    const opened: DialectDb = await open();
    try {
      await withoutForeignKeys(opened.db);
      await body(opened.db);
    } finally {
      await opened.close();
    }
  }

  test("a session generation holds once and the latest generation wins", () =>
    withDb(async (db) => {
      expect(await db.run((q) => latestWorkspaceAssignmentSteps(q, "session"))).toBeNull();
      expect(await db.run((q) => insertWorkspaceAssignmentSteps(q, hold(1)))).toBe(true);
      expect(
        await db.run((q) =>
          insertWorkspaceAssignmentSteps(q, { ...hold(1), tokenHash: "other", linkId: "other" }),
        ),
      ).toBe(false);
      expect(await db.run((q) => insertWorkspaceAssignmentSteps(q, hold(2)))).toBe(true);
      const latest = await db.run((q) => latestWorkspaceAssignmentSteps(q, "session"));
      expect(latest).toMatchObject({ generation: 2, status: "pending", linkExpiresAt: 50 });
      expect(JSON.parse(latest!.event)).toEqual({ action: "created", generation: 2 });
      expect(
        (await db.run((q) => workspaceAssignmentByTokenSteps(q, "hash-session-1")))?.generation,
      ).toBe(1);
      expect(await db.run((q) => workspaceAssignmentByTokenSteps(q, "missing"))).toBeNull();
      expect(await db.run((q) => workspaceAssignmentTokenForLinkSteps(q, "link-session-2"))).toBe(
        "hash-session-2",
      );
      expect(await db.run((q) => workspaceAssignmentTokenForLinkSteps(q, "missing"))).toBeNull();
    }));

  test("pending holds list by link state and by person", () =>
    withDb(async (db) => {
      await db.run((q) => insertWorkspaceAssignmentSteps(q, hold(1)));
      await db.run((q) =>
        insertWorkspaceAssignmentSteps(q, hold(1, { sessionId: "other", actorId: "someone" })),
      );
      await db.run((q) => seedLegacy(db, q));
      await db.run((q) =>
        moveWorkspaceAssignmentSteps(q, "hash-other-1", {
          from: "pending",
          to: "ready",
          completedAt: 1,
        }),
      );
      expect(
        await db.run((q) => pendingWorkspaceAssignmentTokensSteps(q, { linked: false })),
      ).toEqual(["legacy-hash"]);
      expect(
        await db.run((q) => pendingWorkspaceAssignmentTokensSteps(q, { linked: true })),
      ).toEqual(["hash-session-1"]);
      const mine = await db.run((q) =>
        pendingWorkspaceAssignmentTokensSteps(q, { workspaceId: "acme", actorId: "actor" }),
      );
      expect(mine.sort()).toEqual(["hash-session-1", "legacy-hash"]);
    }));

  test("a hold moves forward one status at a time and a continued hold is never invalidated", () =>
    withDb(async (db) => {
      const token = "hash-session-1";
      await db.run((q) => insertWorkspaceAssignmentSteps(q, hold(1)));
      await db.run((q) =>
        moveWorkspaceAssignmentSteps(q, token, { from: "ready", to: "accepted" }),
      );
      expect(await db.run((q) => status(q, token))).toBe("pending");
      await db.run((q) =>
        moveWorkspaceAssignmentSteps(q, token, { from: "pending", to: "ready", completedAt: 7 }),
      );
      await db.run((q) =>
        moveWorkspaceAssignmentSteps(q, token, { from: "ready", to: "accepted" }),
      );
      await db.run((q) =>
        moveWorkspaceAssignmentSteps(q, token, { from: "accepted", to: "continued" }),
      );
      expect(await db.run((q) => status(q, token))).toBe("continued");
      await db.run((q) => invalidateWorkspaceAssignmentSteps(q, token));
      expect(await db.run((q) => status(q, token))).toBe("continued");
      await db.run((q) => insertWorkspaceAssignmentSteps(q, hold(2)));
      await db.run((q) => invalidateWorkspaceAssignmentSteps(q, "hash-session-2"));
      expect(await db.run((q) => status(q, "hash-session-2"))).toBe("invalid");
    }));

  test("a legacy hold gets one link and a new token hash", () =>
    withDb(async (db) => {
      await db.run((q) => seedLegacy(db, q));
      const link = { linkId: "new-link", expiresAt: 99, tokenHash: "new-hash" };
      await db.run((q) => linkWorkspaceAssignmentSteps(q, "legacy-hash", link));
      expect(await db.run((q) => workspaceAssignmentByTokenSteps(q, "new-hash"))).toMatchObject({
        linkId: "new-link",
        linkExpiresAt: 99,
        expiresAt: 99,
      });
      await db.run((q) =>
        linkWorkspaceAssignmentSteps(q, "new-hash", {
          linkId: "again",
          expiresAt: 1,
          tokenHash: "x",
        }),
      );
      expect(await db.run((q) => workspaceAssignmentTokenForLinkSteps(q, "again"))).toBeNull();
    }));
});
