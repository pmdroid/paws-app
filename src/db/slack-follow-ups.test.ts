import { expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import {
  cancelSlackFollowUpSteps,
  cancelThreadFollowUpsSteps,
  claimDueSlackFollowUpsSteps,
  createSlackFollowUpSteps,
  finishSlackFollowUpSteps,
  insertQueuedItem,
  listSlackFollowUpsSteps,
  recordItemPullRequest,
  type Db,
  type SlackFollowUpInput,
  type SlackFollowUpTrigger,
} from "./index";
import { tempStore } from "../../test/pglite";

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const thread = {
  workspaceId: "w",
  teamId: "T1",
  channelId: "C1",
  threadTs: "1.000",
  generation: 1,
};

const input = (overrides: Partial<SlackFollowUpInput> = {}): SlackFollowUpInput => ({
  ...thread,
  slackUserId: "SMEMBER",
  userId: "um",
  linkId: "link",
  mentionTs: "1.001",
  purpose: "check the build",
  trigger: { type: "timer", at: T0 + 20 * MIN },
  ...overrides,
});

const timer = (at: number): SlackFollowUpTrigger => ({ type: "timer", at });
const work = (itemId: string, on: "ended" | "pull_request"): SlackFollowUpTrigger => ({
  type: "work",
  itemId,
  identifier: "PAS-1",
  on,
});

const create = (db: Db, overrides: Partial<SlackFollowUpInput> = {}, now = T0) =>
  db.run((q) => createSlackFollowUpSteps(q, input(overrides), now));

async function created(db: Db, overrides: Partial<SlackFollowUpInput> = {}, now = T0) {
  const result = await create(db, overrides, now);
  if (!result.ok) throw new Error(result.reason);
  return result.followUp;
}

const claim = (db: Db, now: number, limit = 10) =>
  db.run((q) => claimDueSlackFollowUpsSteps(q, now, limit));

const rows = (db: Db) =>
  db.run((q) =>
    q.all(
      q.orm
        .select({ id: q.t.slackFollowUp.id, status: q.t.slackFollowUp.status })
        .from(q.t.slackFollowUp)
        .orderBy(asc(q.t.slackFollowUp.id)),
    ),
  );

const statusOf = async (db: Db, id: string) =>
  (await rows(db)).find((row) => row.id === id)?.status;

const setState = (db: Db, id: string, state: string) =>
  db.run((q) => q.exec(q.orm.update(q.t.workItem).set({ state }).where(eq(q.t.workItem.id, id))));

test("a thread holds one open follow-up until it is done, cancelled or expired", async () => {
  const { db } = await tempStore();
  const first = await created(db);
  expect(first).toMatchObject({
    status: "pending",
    dueAt: T0 + 20 * MIN,
    expiresAt: T0 + 24 * HOUR,
  });
  expect(await create(db, { userId: "other" })).toEqual({ ok: false, reason: "thread_busy" });
  expect(await claim(db, T0 + 20 * MIN)).toHaveLength(1);
  expect(await create(db)).toEqual({ ok: false, reason: "thread_busy" });
  await db.run((q) => finishSlackFollowUpSteps(q, first.id, T0 + 21 * MIN));
  expect(await statusOf(db, first.id)).toBe("done");
  const second = await created(db);
  await db.run((q) => cancelSlackFollowUpSteps(q, second.id, "um", T0));
  await insertQueuedItem(db, { id: "item-x", sessionKey: "ses_x", now: T0 });
  const third = await created(db, { trigger: work("item-x", "ended") });
  const later = T0 + 24 * HOUR + MIN;
  expect(await claim(db, later)).toEqual([]);
  expect(await statusOf(db, third.id)).toBe("expired");
  expect((await create(db, { trigger: timer(later + 20 * MIN) }, later)).ok).toBe(true);
});

test("the eleventh open follow-up for a member across threads is refused", async () => {
  const { db } = await tempStore();
  for (let n = 0; n < 10; n += 1) await created(db, { threadTs: `2.${n}` });
  expect(await create(db, { threadTs: "3.0" })).toEqual({ ok: false, reason: "member_limit" });
  expect((await create(db, { threadTs: "3.0", userId: "other" })).ok).toBe(true);
  expect(await rows(db)).toHaveLength(11);
});

test("two concurrent creates in one thread leave exactly one row", async () => {
  const { db } = await tempStore();
  const results = await Promise.all([create(db), create(db, { userId: "other" })]);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(await rows(db)).toHaveLength(1);
});

test("timers outside five minutes to 24 hours and bad purposes are refused without writing", async () => {
  const { db } = await tempStore();
  const refused = await Promise.all([
    create(db, { trigger: timer(T0 + 4 * MIN) }),
    create(db, { trigger: timer(T0 + 25 * HOUR) }),
    create(db, { purpose: "  " }),
    create(db, { purpose: "x".repeat(501) }),
  ]);
  expect(refused.map((result) => !result.ok && result.reason)).toEqual([
    "timer_too_soon",
    "timer_too_late",
    "purpose_empty",
    "purpose_too_long",
  ]);
  expect(await rows(db)).toEqual([]);
});

test("only the owner cancels a row, and the thread cancel covers pending and claimed rows", async () => {
  const { db } = await tempStore();
  const own = await created(db);
  expect(await db.run((q) => listSlackFollowUpsSteps(q, thread, "um"))).toMatchObject([
    { id: own.id },
  ]);
  expect(await db.run((q) => listSlackFollowUpsSteps(q, thread, "other"))).toEqual([]);
  expect(await db.run((q) => cancelSlackFollowUpSteps(q, own.id, "other", T0))).toBe(false);
  expect(await statusOf(db, own.id)).toBe("pending");
  expect(await db.run((q) => cancelSlackFollowUpSteps(q, own.id, "um", T0))).toBe(true);
  expect(await statusOf(db, own.id)).toBe("cancelled");

  const claimed = await created(db);
  await claim(db, T0 + 20 * MIN);
  const elsewhere = { ...thread, threadTs: "9.000" };
  const pending = await created(db, { ...elsewhere, userId: "other" });
  expect(await db.run((q) => cancelThreadFollowUpsSteps(q, thread, T0))).toBe(1);
  expect(await db.run((q) => cancelThreadFollowUpsSteps(q, elsewhere, T0))).toBe(1);
  expect(await statusOf(db, claimed.id)).toBe("cancelled");
  expect(await statusOf(db, pending.id)).toBe("cancelled");
  expect(await db.run((q) => finishSlackFollowUpSteps(q, claimed.id, T0))).toBe(false);
  expect(await statusOf(db, claimed.id)).toBe("cancelled");
});

test("claiming returns a due timer once, work triggers when their item ends or opens a pull request, and never an expired row", async () => {
  const { db } = await tempStore();
  await insertQueuedItem(db, { id: "item-a", sessionKey: "ses_a", now: T0 });
  await insertQueuedItem(db, { id: "item-b", sessionKey: "ses_b", now: T0 });
  const due = await created(db);
  const ended = await created(db, { threadTs: "2.0", trigger: work("item-a", "ended") });
  const pull = await created(db, { threadTs: "3.0", trigger: work("item-b", "pull_request") });
  const late = await created(db, { threadTs: "4.0", trigger: timer(T0 + 24 * HOUR) });

  expect(await claim(db, T0 + 19 * MIN)).toEqual([]);
  expect((await claim(db, T0 + 20 * MIN)).map((row) => row.id)).toEqual([due.id]);
  expect(await claim(db, T0 + 20 * MIN)).toEqual([]);

  await setState(db, "item-a", "running");
  await setState(db, "item-b", "merged");
  expect(await claim(db, T0 + 30 * MIN)).toEqual([]);
  await setState(db, "item-a", "merged");
  expect((await claim(db, T0 + 31 * MIN)).map((row) => row.id)).toEqual([ended.id]);

  await recordItemPullRequest(db, { itemId: "item-b", pullNumber: 7, pullUrl: null, openedAt: T0 });
  const claimed = await claim(db, T0 + 32 * MIN);
  expect(claimed).toMatchObject([{ id: pull.id, status: "claimed", claimedAt: T0 + 32 * MIN }]);

  expect(await claim(db, T0 + 24 * HOUR + 1)).toEqual([]);
  expect(await statusOf(db, late.id)).toBe("expired");
  expect(await statusOf(db, due.id)).toBe("expired");
  expect(await statusOf(db, pull.id)).toBe("expired");
});
