import { and, asc, count, eq, inArray, lt, lte, or, type SQL } from "drizzle-orm";
import type { Q, Steps } from "./db";
import type { slackFollowUp } from "./schema-pg";
import { jsonField } from "./json-text";
import { getWorkItemSteps } from "./items";
import { getItemPullRequestSteps } from "./stop-response";
import { lockSlackStatusSteps } from "./slack-threads";
import { ulid } from "./ulid";

const MEMBER_LIMIT = 10;
const LIFETIME_MS = 24 * 60 * 60_000;
const ENDED_STATES = ["merged", "completed", "failed", "cancelled"];

export type SlackFollowUpThread = Record<
  "workspaceId" | "teamId" | "channelId" | "threadTs",
  string
> & {
  generation: number;
};

export type SlackFollowUpTrigger =
  | { type: "timer"; at: number }
  | { type: "work"; itemId: string; identifier: string; on: "ended" | "pull_request" };

export type SlackFollowUpStatus = "pending" | "claimed" | "done" | "cancelled" | "expired";

export type SlackFollowUpInput = SlackFollowUpThread & {
  slackUserId: string;
  userId: string;
  linkId: string;
  mentionTs: string;
  purpose: string;
  trigger: SlackFollowUpTrigger;
};

export type SlackFollowUp = SlackFollowUpInput & {
  id: string;
  status: SlackFollowUpStatus;
  createdAt: number;
  dueAt: number | null;
  expiresAt: number;
  claimedAt: number | null;
  finishedAt: number | null;
};

export type SlackFollowUpRefusal =
  | NonNullable<ReturnType<typeof refusal>>
  | "thread_busy"
  | "member_limit";

type Row = typeof slackFollowUp.$inferSelect;

const followUp = (row: Row): SlackFollowUp => ({
  ...row,
  status: row.status as SlackFollowUpStatus,
  trigger: row.trigger as SlackFollowUpTrigger,
});

function threadIs(q: Q, thread: SlackFollowUpThread) {
  const table = q.t.slackFollowUp;
  const fields = ["workspaceId", "teamId", "channelId", "threadTs", "generation"] as const;
  return and(...fields.map((name) => eq(table[name], thread[name])));
}

const openStatus = (q: Q) => inArray(q.t.slackFollowUp.status, ["pending", "claimed"]);

function refusal(input: SlackFollowUpInput, now: number) {
  if (!input.purpose.trim()) return "purpose_empty";
  if (input.purpose.length > 500) return "purpose_too_long";
  if (input.trigger.type !== "timer") return null;
  if (input.trigger.at - now < 5 * 60_000) return "timer_too_soon";
  if (input.trigger.at - now > LIFETIME_MS) return "timer_too_late";
  return null;
}

export function* createSlackFollowUpSteps(
  q: Q,
  input: SlackFollowUpInput,
  now: number,
): Steps<{ ok: true; followUp: SlackFollowUp } | { ok: false; reason: SlackFollowUpRefusal }> {
  const refused = refusal(input, now);
  if (refused) return { ok: false, reason: refused };
  return yield* q.transaction(function* (tx) {
    const table = tx.t.slackFollowUp;
    const { workspaceId, teamId, channelId, threadTs, generation } = input;
    const scope = [workspaceId, teamId, channelId, threadTs, generation].join(":");
    yield* lockSlackStatusSteps(tx, `slack.follow-up.thread:${scope}`);
    yield* lockSlackStatusSteps(tx, `slack.follow-up.user:${input.userId}`);
    const busy = yield* tx.one(
      tx.orm
        .select({ id: table.id })
        .from(table)
        .where(and(threadIs(tx, input), openStatus(tx)))
        .limit(1),
    );
    if (busy) return { ok: false, reason: "thread_busy" as const };
    const open = yield* tx.one(
      tx.orm
        .select({ n: count() })
        .from(table)
        .where(and(eq(table.userId, input.userId), openStatus(tx))),
    );
    if ((Number(open?.n) || 0) >= MEMBER_LIMIT)
      return { ok: false, reason: "member_limit" as const };
    const row = yield* tx.one(
      tx.orm
        .insert(table)
        .values({
          ...input,
          id: ulid(now),
          status: "pending",
          createdAt: now,
          dueAt: input.trigger.type === "timer" ? input.trigger.at : null,
          expiresAt: now + LIFETIME_MS,
        })
        .returning(),
    );
    return { ok: true as const, followUp: followUp(row!) };
  });
}

export function* listSlackFollowUpsSteps(
  q: Q,
  thread: SlackFollowUpThread,
  userId: string,
): Steps<SlackFollowUp[]> {
  const table = q.t.slackFollowUp;
  const rows = yield* q.all(
    q.orm
      .select()
      .from(table)
      .where(and(threadIs(q, thread), eq(table.userId, userId), eq(table.status, "pending")))
      .orderBy(asc(table.createdAt), asc(table.id)),
  );
  return rows.map(followUp);
}

function* settleSteps(q: Q, status: string, where: SQL | undefined, now: number) {
  const table = q.t.slackFollowUp;
  const rows = yield* q.all(
    q.orm.update(table).set({ status, finishedAt: now }).where(where).returning({ id: table.id }),
  );
  return rows.length;
}

export function* cancelSlackFollowUpSteps(q: Q, id: string, userId: string, now = Date.now()) {
  const table = q.t.slackFollowUp;
  const own = and(eq(table.id, id), eq(table.userId, userId), eq(table.status, "pending"));
  return (yield* settleSteps(q, "cancelled", own, now)) === 1;
}

export function* cancelThreadFollowUpsSteps(q: Q, thread: SlackFollowUpThread, now = Date.now()) {
  return yield* settleSteps(q, "cancelled", and(threadIs(q, thread), openStatus(q)), now);
}

function* workDueSteps(q: Q, trigger: SlackFollowUpTrigger): Steps<boolean> {
  if (trigger.type === "timer") return true;
  if (trigger.on === "pull_request")
    return (yield* getItemPullRequestSteps(q, trigger.itemId)) !== null;
  const item = yield* getWorkItemSteps(q, trigger.itemId);
  return item !== null && ENDED_STATES.includes(item.state);
}

export function* claimDueSlackFollowUpsSteps(
  q: Q,
  now: number,
  limit: number,
): Steps<SlackFollowUp[]> {
  return yield* q.transaction(function* (tx) {
    const table = tx.t.slackFollowUp;
    yield* settleSteps(tx, "expired", and(openStatus(tx), lt(table.expiresAt, now)), now);
    const candidates = yield* tx.all(
      tx.orm
        .select()
        .from(table)
        .where(
          and(
            eq(table.status, "pending"),
            or(lte(table.dueAt, now), eq(jsonField(tx, table.trigger, "type"), "work")),
          ),
        )
        .orderBy(asc(table.createdAt), asc(table.id))
        .for("update", { skipLocked: true }),
    );
    const claimed: SlackFollowUp[] = [];
    for (const row of candidates) {
      if (claimed.length >= limit) break;
      if (!(yield* workDueSteps(tx, row.trigger as SlackFollowUpTrigger))) continue;
      const updated = yield* tx.one(
        tx.orm
          .update(table)
          .set({ status: "claimed", claimedAt: now })
          .where(and(eq(table.id, row.id), eq(table.status, "pending")))
          .returning(),
      );
      if (updated) claimed.push(followUp(updated));
    }
    return claimed;
  });
}

export function* finishSlackFollowUpSteps(
  q: Q,
  id: string,
  now = Date.now(),
  status: "done" | "cancelled" | "expired" = "done",
) {
  const table = q.t.slackFollowUp;
  const claimed = and(eq(table.id, id), eq(table.status, "claimed"));
  return (yield* settleSteps(q, status, claimed, now)) === 1;
}

export function* getSlackFollowUpSteps(q: Q, id: string): Steps<SlackFollowUp | null> {
  const table = q.t.slackFollowUp;
  const row = yield* q.one(q.orm.select().from(table).where(eq(table.id, id)));
  return row ? followUp(row) : null;
}
