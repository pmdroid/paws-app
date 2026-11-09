import { expect, test } from "bun:test";
import { getLinearConversationSourceSteps, type Db } from "../src/db";
import { forEachDialect, insertLinearSession, jsonValue, type DialectDb } from "./dialects";

async function withDb(open: () => Promise<DialectDb>, body: (db: Db) => Promise<void>) {
  const { db, close } = await open();
  try {
    await body(db);
  } finally {
    await close();
  }
}

function insertInbox(
  db: Db,
  dedupeKey: string,
  action: string,
  receivedAt: number,
  payload: unknown,
) {
  return db.run(function* (q) {
    yield* q.exec(
      q.orm.insert(q.t.inboxEvent).values({
        dedupeKey,
        source: "webhook",
        action,
        sessionId: "session",
        updatedAtMs: receivedAt,
        payload: jsonValue(q, payload),
        receivedAt,
      }),
    );
  });
}

function insertTurn(db: Db, eventKey: string, payload: unknown) {
  return db.run(function* (q) {
    yield* q.exec(
      q.orm.insert(q.t.linearTurn).values({
        eventKey,
        sessionId: "session",
        body: "",
        payload: jsonValue(q, payload),
        createdAtMs: 0,
        receivedAt: 0,
      }),
    );
  });
}

const source = (db: Db) => db.run((q) => getLinearConversationSourceSteps(q, "session"));

forEachDialect((open) => {
  test("the conversation source is the earliest created event's session or issue URL", async () =>
    withDb(open, async (db) => {
      expect(await source(db)).toBeNull();
      await insertInbox(db, "prompted", "prompted", 1, { agentSession: { url: "https://p" } });
      await insertInbox(db, "empty", "created", 2, { agentSession: { url: "" } });
      await insertInbox(db, "number", "created", 3, { agentSession: { url: 5 } });
      await insertInbox(db, "issue", "created", 5, {
        agentSession: { url: null, issue: { url: "https://issue" } },
      });
      await insertInbox(db, "session", "created", 6, { agentSession: { url: "https://later" } });
      expect(await source(db)).toBe("https://issue");
    }));

  test("without a created event the first turn with a URL is the source", async () =>
    withDb(open, async (db) => {
      await insertLinearSession(db, "session");
      await insertTurn(db, "first", { agentSession: {} });
      await insertTurn(db, "second", { agentSession: { url: "https://second" } });
      await insertTurn(db, "third", { agentSession: { url: "https://third" } });
      expect(await source(db)).toBe("https://second");
    }));
});
