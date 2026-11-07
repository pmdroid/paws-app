import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  getLinearIssueContextSteps,
  linearSessionsForIssueContextSteps,
  saveLinearIssueContextSteps,
  type Db,
} from "../src/db";
import { forEachDialect, insertLinearSession, insertWorkItem, type DialectDb } from "./dialects";

async function withDb(open: () => Promise<DialectDb>, body: (db: Db) => Promise<void>) {
  const { db, close } = await open();
  try {
    await body(db);
  } finally {
    await close();
  }
}

forEachDialect((open) => {
  test("an issue's sessions come from its Linear sessions and its items, once each", async () =>
    withDb(open, async (db) => {
      await insertLinearSession(db, "session-b", "issue");
      await insertLinearSession(db, "session-c", "other");
      await insertWorkItem(db, "a");
      await insertWorkItem(db, "c");
      await insertWorkItem(db, "none");
      await db.run(function* (q) {
        const { workItem } = q.t;
        for (const [id, sessionKey] of [
          ["a", "session-a"],
          ["c", "session-b"],
        ] as const)
          yield* q.exec(
            q.orm
              .update(workItem)
              .set({ linearIssueId: "issue", sessionKey, state: "merged" })
              .where(eq(workItem.id, id)),
          );
        yield* q.exec(
          q.orm
            .update(workItem)
            .set({ linearIssueId: "issue", state: "merged" })
            .where(eq(workItem.id, "none")),
        );
      });
      expect(await db.run((q) => linearSessionsForIssueContextSteps(q, "issue"))).toEqual([
        "session-a",
        "session-b",
      ]);
    }));

  test("issue context keeps the newest observation and joins issues in id order", async () =>
    withDb(open, async (db) => {
      await insertLinearSession(db, "session");
      const save = (issueId: string, observedAt: number, context: string) =>
        db.run((q) =>
          saveLinearIssueContextSteps(q, { sessionId: "session", issueId, observedAt, context }),
        );
      await save("b", 2, "b new");
      await save("b", 1, "b old");
      await save("a", 1, "a first");
      await save("a", 1, "a same time");
      expect(await db.run((q) => getLinearIssueContextSteps(q, "session"))).toBe(
        "a same time\n\nb new",
      );
    }));
});
