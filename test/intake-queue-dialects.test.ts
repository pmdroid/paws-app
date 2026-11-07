import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { listIntakeQueueSteps, type Db } from "../src/db";
import { forEachDialect, insertWorkItem, jsonValue } from "./dialects";

function insertEvent(
  db: Db,
  dedupeKey: string,
  receivedAt: number,
  values: { sessionId?: string; issueId?: string; action?: string; payload?: unknown },
) {
  return db.run(function* (q) {
    yield* q.exec(
      q.orm.insert(q.t.inboxEvent).values({
        dedupeKey,
        source: "webhook",
        action: values.action ?? "created",
        sessionId: values.sessionId ?? null,
        issueId: values.issueId ?? null,
        updatedAtMs: receivedAt,
        payload: jsonValue(q, values.payload ?? {}),
        receivedAt,
        attempts: 2,
        nextAttemptAt: 50,
        lastError: "boom",
      }),
    );
  });
}

forEachDialect((open) => {
  test("the intake queue names each waiting event from its payload or its latest item", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "old", 1);
      await insertWorkItem(db, "new", 2);
      await db.run(function* (q) {
        const { workItem } = q.t;
        yield* q.exec(
          q.orm
            .update(workItem)
            .set({ sessionKey: "session", state: "merged" })
            .where(eq(workItem.id, "old")),
        );
        yield* q.exec(
          q.orm
            .update(workItem)
            .set({ linearIssueId: "issue", title: "Newest title" })
            .where(eq(workItem.id, "new")),
        );
      });
      await insertEvent(db, "payload", 1, {
        sessionId: "session",
        payload: { agentSession: { issue: { identifier: "PAS-1", title: "From payload" } } },
      });
      await insertEvent(db, "item", 2, { sessionId: "elsewhere", issueId: "issue" });
      await insertEvent(db, "bare", 3, { payload: { identifier: "PAS-3" } });
      await insertEvent(db, "unknown", 4, {});
      await insertEvent(db, "other", 0, { action: "other" });
      const waiting = { attempts: 2, nextAttemptAt: 50, lastError: "boom" };
      expect(await db.run(listIntakeQueueSteps)).toEqual([
        { sessionId: "session", issue: "PAS-1", title: "From payload", receivedAt: 1, ...waiting },
        { sessionId: "elsewhere", issue: "new", title: "Newest title", receivedAt: 2, ...waiting },
        { sessionId: null, issue: "PAS-3", title: null, receivedAt: 3, ...waiting },
        { sessionId: null, issue: "unknown", title: null, receivedAt: 4, ...waiting },
      ]);
    } finally {
      await close();
    }
  });
});
