import { expect, test } from "bun:test";
import { ensureLinearSession, insertQueuedItem, migrate, openDatabase } from "../src/db";
import { checkRedelegation, createInboxStore } from "../src/linear";
import type { AcceptedLinearEvent } from "../src/linear";

const MINUTE = 60_000;
const DELEGATED_AT = 100 * MINUTE;

function fixture(delegateId: string | null = "paws-app") {
  const db = openDatabase(":memory:");
  migrate(db);
  const store = createInboxStore(db);
  const delivered: AcceptedLinearEvent[] = [];
  const check = (issueId: string, delegatedAtMs = DELEGATED_AT) => {
    store.setCursor(`delegated:${issueId}`, delegatedAtMs);
    return checkRedelegation(
      {
        db,
        store,
        appUserId: "paws-app",
        inspect: async (id) => ({
          id,
          teamId: "team",
          assigneeId: null,
          delegateId,
          stateType: "started",
        }),
        onEvent: async (event) => {
          delivered.push(event);
        },
      },
      { issueId, delegatedAtMs },
    );
  };
  const session = (sessionId: string, issueId: string, now: number) =>
    ensureLinearSession(db, { sessionId, issueId, appUserId: "paws-app", now });
  return { db, store, delivered, check, session };
}

test("a re-delegation into an earlier idle session starts work in that session", async () => {
  const f = fixture();
  f.session("old-session", "issue-1", 10 * MINUTE);

  expect(await f.check("issue-1")).toBe(true);

  expect(f.delivered).toHaveLength(1);
  expect(f.delivered[0]).toMatchObject({
    dedupeKey: `session:old-session:created:${DELEGATED_AT}`,
    action: "created",
    sessionId: "old-session",
    issueId: "issue-1",
  });
  expect(f.store.commit(f.delivered[0]!).handled).toBe(true);
  expect(await f.check("issue-1")).toBe(false);
  expect(f.delivered).toHaveLength(1);
});

test("a re-delegation that brought a new session leaves intake to that session", async () => {
  const f = fixture();
  f.session("old-session", "issue-1", 10 * MINUTE);
  f.session("new-session", "issue-1", DELEGATED_AT + 2_000);

  expect(await f.check("issue-1")).toBe(false);
  expect(f.delivered).toHaveLength(0);
});

test("an issue that already has an open task starts nothing", async () => {
  const f = fixture();
  insertQueuedItem(f.db, { id: "task", sessionKey: "new-session" });
  f.session("old-session", "lin-item-task", 10 * MINUTE);

  expect(await f.check("lin-item-task")).toBe(false);
  expect(f.delivered).toHaveLength(0);
});

test("an issue undelegated again before the check starts nothing", async () => {
  const f = fixture(null);
  f.session("old-session", "issue-1", 10 * MINUTE);

  expect(await f.check("issue-1")).toBe(false);
  expect(f.delivered).toHaveLength(0);
});

test("a check superseded by a later delegation leaves it to the later check", async () => {
  const f = fixture();
  f.session("old-session", "issue-1", 10 * MINUTE);
  f.store.setCursor("delegated:issue-1", DELEGATED_AT + MINUTE);

  expect(
    await checkRedelegation(
      {
        db: f.db,
        store: f.store,
        appUserId: "paws-app",
        inspect: async () => {
          throw new Error("superseded checks do not read Linear");
        },
        onEvent: async (event) => {
          f.delivered.push(event);
        },
      },
      { issueId: "issue-1", delegatedAtMs: DELEGATED_AT },
    ),
  ).toBe(false);
  expect(f.delivered).toHaveLength(0);
});
