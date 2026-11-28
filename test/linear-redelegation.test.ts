import { afterEach, expect, test } from "bun:test";
import {
  applyWorkItemEvent,
  ensureLinearSession,
  insertQueuedItem,
  listWorkItems,
} from "../src/db";
import { setJournalSink } from "../src/journal";
import { checkRedelegation, createInboxStore, createSessionStarter } from "../src/linear";
import type { AcceptedLinearEvent, LinearClient } from "../src/linear";
import { tempStore } from "./pglite";
import { waitFor } from "./wait-for";

const MINUTE = 60_000;
const DELEGATED_AT = 100 * MINUTE;

let restoreJournal: (() => void) | null = null;
afterEach(() => {
  restoreJournal?.();
  restoreJournal = null;
});

async function fixture(
  delegateId: string | null = "paws-app",
  options: { fail?: boolean; noItem?: boolean } = {},
) {
  const db = (await tempStore()).db;
  const store = createInboxStore(db);
  const delivered: AcceptedLinearEvent[] = [];
  const creates: unknown[] = [];
  const lines: string[] = [];
  restoreJournal = setJournalSink((line) => lines.push(line));
  const client: LinearClient = {
    async query(query, variables) {
      if (!query.includes("agentSessionCreateOnIssue"))
        return { agentSessionUpdate: { success: true } };
      creates.push(variables);
      if (options.fail) throw new Error("Linear refused the session");
      const n = creates.length;
      return {
        agentSessionCreateOnIssue: {
          success: true,
          agentSession: {
            id: `fresh-session-${n}`,
            url: null,
            createdAt: new Date(DELEGATED_AT + MINUTE).toISOString(),
            updatedAt: new Date(DELEGATED_AT + MINUTE).toISOString(),
            appUser: { id: "paws-app", organization: { id: "org" } },
            issue: { id: "lin-item-task", identifier: "PAS-1", title: "Task", description: null },
          },
        },
      };
    },
  };
  const intake = async (event: AcceptedLinearEvent) => {
    delivered.push(event);
    if (event.sessionId?.startsWith("fresh-session") && !options.noItem)
      await insertQueuedItem(db, { id: "task-again", sessionKey: event.sessionId });
  };
  const starter = createSessionStarter({ client, store, appUserId: "paws-app", onEvent: intake });
  const check = async (issueId: string, delegatedAtMs = DELEGATED_AT) => {
    await store.setCursor(`delegated:${issueId}`, delegatedAtMs);
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
        onEvent: intake,
        startSession: (id) => starter({ kind: "issue", id }, "http://127.0.0.1:8787/dashboard/"),
      },
      { issueId, delegatedAtMs },
    );
  };
  const session = async (sessionId: string, issueId: string, now: number) =>
    await ensureLinearSession(db, { sessionId, issueId, appUserId: "paws-app", now });
  return { db, store, delivered, creates, lines, check, session };
}

test("a re-delegation into an earlier idle session starts work in that session", async () => {
  const f = await fixture();
  await f.session("old-session", "issue-1", 10 * MINUTE);

  expect(await f.check("issue-1")).toBe(true);

  expect(f.delivered).toHaveLength(1);
  expect(f.delivered[0]).toMatchObject({
    dedupeKey: `session:old-session:created:${DELEGATED_AT}`,
    action: "created",
    sessionId: "old-session",
    issueId: "issue-1",
  });
  expect((await f.store.commit(f.delivered[0]!)).handled).toBe(true);
  expect(await f.check("issue-1")).toBe(false);
  expect(f.delivered).toHaveLength(1);
});

test("a re-delegation that brought a new session leaves intake to that session", async () => {
  const f = await fixture();
  await f.session("old-session", "issue-1", 10 * MINUTE);
  await f.session("new-session", "issue-1", DELEGATED_AT + 2_000);

  expect(await f.check("issue-1")).toBe(false);
  expect(f.delivered).toHaveLength(0);
});

test("an issue that already has an open task starts nothing", async () => {
  const f = await fixture();
  await insertQueuedItem(f.db, { id: "task", sessionKey: "new-session" });
  await f.session("old-session", "lin-item-task", 10 * MINUTE);

  expect(await f.check("lin-item-task")).toBe(false);
  expect(f.delivered).toHaveLength(0);
  expect(f.creates).toHaveLength(0);
});

test("an issue undelegated again before the check starts nothing", async () => {
  const f = await fixture(null);
  await f.session("old-session", "issue-1", 10 * MINUTE);

  expect(await f.check("issue-1")).toBe(false);
  expect(f.delivered).toHaveLength(0);
});

test("a check superseded by a later delegation leaves it to the later check", async () => {
  const f = await fixture();
  await f.session("old-session", "issue-1", 10 * MINUTE);
  await f.store.setCursor("delegated:issue-1", DELEGATED_AT + MINUTE);

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

async function cancelledInOldSession(f: Awaited<ReturnType<typeof fixture>>) {
  await insertQueuedItem(f.db, { id: "task", sessionKey: "old-session" });
  await applyWorkItemEvent(f.db, "task", "cancel");
  await f.session("old-session", "lin-item-task", 10 * MINUTE);
}

test("a cancelled issue re-delegated into its old session starts one fresh session", async () => {
  const f = await fixture();
  await cancelledInOldSession(f);

  expect(await f.check("lin-item-task")).toBe(true);
  const items = await waitFor(async () => {
    const all = await listWorkItems(f.db);
    return all.length === 2 ? all : null;
  });

  expect(f.creates).toHaveLength(1);
  expect(items?.find((item) => item.id === "task-again")?.sessionKey).toBe("fresh-session-1");
  expect(f.delivered).toHaveLength(1);
  expect(f.delivered[0]).toMatchObject({ action: "created", sessionId: "fresh-session-1" });
  expect(
    f.lines.some((line) =>
      line.includes(
        "redelegation_new_session issue=lin-item-task old_session=old-session new_session=fresh-session-1",
      ),
    ),
  ).toBe(true);
  expect(await f.check("lin-item-task")).toBe(false);
  expect(f.creates).toHaveLength(1);
});

test("a replayed re-delegation starts no second session", async () => {
  const f = await fixture("paws-app", { noItem: true });
  await cancelledInOldSession(f);

  expect(await f.check("lin-item-task")).toBe(true);
  expect(await f.check("lin-item-task")).toBe(false);
  expect(f.creates).toHaveLength(1);
});

test("a cancelled issue no longer delegated to Paws starts no session", async () => {
  const f = await fixture(null);
  await cancelledInOldSession(f);

  expect(await f.check("lin-item-task")).toBe(false);
  expect(f.creates).toHaveLength(0);
});

test("a failed session create is journaled and creates no item", async () => {
  const f = await fixture("paws-app", { fail: true });
  await cancelledInOldSession(f);

  expect(await f.check("lin-item-task")).toBe(false);
  expect(f.delivered).toHaveLength(0);
  expect(
    f.lines.some((line) =>
      line.includes(
        "redelegation_new_session_failed issue=lin-item-task old_session=old-session reason=Linear refused the session",
      ),
    ),
  ).toBe(true);
  expect(await f.check("lin-item-task")).toBe(false);
  expect(f.creates).toHaveLength(2);
});
