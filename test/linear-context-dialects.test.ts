import { expect, test } from "bun:test";
import {
  getLinearSessionContextSteps,
  hasLinearSessionSnapshotContextSteps,
  listLinearActivitySnapshotsSteps,
  saveLinearActivitySnapshotSteps,
  saveLinearIssueContextSteps,
  saveLinearSessionContextSteps,
  saveLinearSessionSnapshotContextSteps,
  type Db,
} from "../src/db";
import { forEachDialect, insertLinearSession, type DialectDb } from "./dialects";

async function withDb(open: () => Promise<DialectDb>, body: (db: Db) => Promise<void>) {
  const { db, close } = await open();
  try {
    await body(db);
  } finally {
    await close();
  }
}

forEachDialect((open) => {
  test("a session's context keeps the richest write, then its snapshot and issue context", async () =>
    withDb(open, async (db) => {
      await insertLinearSession(db, "session");
      const context = () => db.run((q) => getLinearSessionContextSteps(q, "session"));
      const hydrated = () => db.run((q) => hasLinearSessionSnapshotContextSteps(q, "session"));
      expect(await context()).toBe("");
      expect(await hydrated()).toBe(false);
      await db.run((q) => saveLinearSessionContextSteps(q, "session", ""));
      expect(await hydrated()).toBe(false);
      await db.run((q) => saveLinearSessionContextSteps(q, "session", "rich", 2));
      await db.run((q) => saveLinearSessionContextSteps(q, "session", "plain", 1));
      expect(await context()).toBe("rich");
      expect(await hydrated()).toBe(false);
      await db.run((q) => saveLinearSessionSnapshotContextSteps(q, "session", "snapshot"));
      await db.run((q) => saveLinearSessionSnapshotContextSteps(q, "session", "later"));
      expect(await hydrated()).toBe(true);
      await db.run((q) =>
        saveLinearIssueContextSteps(q, {
          sessionId: "session",
          issueId: "issue",
          observedAt: 1,
          context: "issue",
        }),
      );
      expect(await context()).toBe("rich\n\nsnapshot\n\nissue");
    }));

  test("a snapshot-only session starts empty and takes its context later", async () =>
    withDb(open, async (db) => {
      await db.run((q) => saveLinearSessionSnapshotContextSteps(q, "session", "snapshot"));
      await db.run((q) => saveLinearSessionContextSteps(q, "session", "first"));
      expect(await db.run((q) => getLinearSessionContextSteps(q, "session"))).toBe(
        "first\n\nsnapshot",
      );
    }));

  test("activity snapshots are stored once and listed by creation time", async () =>
    withDb(open, async (db) => {
      const save = (id: string, createdAt: string, snapshot: unknown) =>
        db.run((q) =>
          saveLinearActivitySnapshotSteps(q, {
            id,
            sessionId: "session",
            createdAt,
            snapshot: JSON.stringify(snapshot),
          }),
        );
      await save("b", "2026-11-07T10:00:00Z", { body: "second" });
      await save("a", "2026-11-07T09:00:00Z", { body: "first", n: 1 });
      await save("b", "2026-11-07T08:00:00Z", { body: "ignored" });
      const listed = await db.run((q) => listLinearActivitySnapshotsSteps(q, "session"));
      expect(listed.map((snapshot) => JSON.parse(snapshot))).toEqual([
        { body: "first", n: 1 },
        { body: "second" },
      ]);
      expect(await db.run((q) => listLinearActivitySnapshotsSteps(q, "other"))).toEqual([]);
    }));
});
