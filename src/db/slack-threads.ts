import { and, asc, desc, eq, gt, isNotNull, isNull, like, max, or } from "drizzle-orm";
import type { Q, Steps } from "./db";
import { jsonField } from "./json-text";
import { getLinearSessionSteps } from "./linear-sessions";
import { readSettingSteps } from "./settings";
import { workspaceForOrganizationSteps } from "./workspace";
import { ulid } from "./ulid";
import { getWorkItemSteps } from "./items";
import { getWorkItemRepositorySteps } from "./repositories";
import { listRepositoryCandidatesSteps } from "./repository-catalog";

export type SlackThreadIdentity = {
  workspaceId: string;
  teamId: string;
  installGeneration: number;
  channelId: string;
  threadTs: string;
};

export type SlackConversation = SlackThreadIdentity & {
  id: string;
  appId: string | null;
  startedBySlackUserId: string;
  startedEventId: string;
  replyChannelId: string;
  replyThreadTs: string;
  workItemId: string | null;
  issueId: string | null;
  stoppedTs: string | null;
  stoppedBySlackUserId: string | null;
};

function* findSlackConversationSteps(q: Q, thread: SlackThreadIdentity) {
  const table = q.t.slackConversation;
  const fields = ["workspaceId", "teamId", "installGeneration", "channelId", "threadTs"] as const;
  return yield* q.one(
    q.orm
      .select()
      .from(table)
      .where(and(...fields.map((name) => eq(table[name], thread[name])))),
  );
}

export function* slackConversationSteps(
  q: Q,
  thread: SlackThreadIdentity,
): Steps<SlackConversation | null> {
  return (yield* findSlackConversationSteps(q, thread)) ?? null;
}

export function* recordSlackConversationSteps(
  q: Q,
  input: SlackThreadIdentity & { appId: string | null; slackUserId: string; eventId: string },
  now: number,
): Steps<SlackConversation> {
  const { slackUserId, eventId, ...thread } = input;
  yield* q.exec(
    q.orm
      .insert(q.t.slackConversation)
      .values({
        ...thread,
        id: ulid(now),
        startedBySlackUserId: slackUserId,
        startedEventId: eventId,
        replyChannelId: thread.channelId,
        replyThreadTs: thread.threadTs,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing(),
  );
  return (yield* findSlackConversationSteps(q, thread))!;
}

export function* stopSlackConversationSteps(
  q: Q,
  input: { id: string; ts: string; slackUserId: string },
  now: number,
): Steps<void> {
  const table = q.t.slackConversation;
  const current = yield* q.one(
    q.orm
      .select({ stoppedTs: table.stoppedTs })
      .from(table)
      .where(eq(table.id, input.id))
      .for("update"),
  );
  const order = (ts: string) => BigInt(ts.replace(".", ""));
  if (current?.stoppedTs && order(current.stoppedTs) >= order(input.ts)) return;
  yield* q.exec(
    q.orm
      .update(table)
      .set({ stoppedTs: input.ts, stoppedBySlackUserId: input.slackUserId, updatedAt: now })
      .where(eq(table.id, input.id)),
  );
}

export function* takeSettingSteps(q: Q, key: string): Steps<string | null> {
  const { setting } = q.t;
  const row = yield* q.one(
    q.orm.delete(setting).where(eq(setting.key, key)).returning({ value: setting.value }),
  );
  return row?.value ?? null;
}

export function* settingsWithPrefixSteps(q: Q, prefix: string) {
  const { setting } = q.t;
  const pattern = `${prefix.replace(/[\\%_]/g, "\\$&")}%`;
  return yield* q.all(
    q.orm
      .select({ key: setting.key, value: setting.value })
      .from(setting)
      .where(like(setting.key, pattern)),
  );
}

export function* slackOutboxExistsSteps(q: Q, idempotencyKey: string): Steps<boolean> {
  const { outbox } = q.t;
  const query = q.orm.select({ id: outbox.id }).from(outbox);
  return (yield* q.one(query.where(eq(outbox.idempotencyKey, idempotencyKey)))) !== undefined;
}

export function* slackThreadContextSteps(
  q: Q,
  scope: Record<"workspaceId" | "teamId" | "channelId" | "threadTs" | "userId", string> & {
    generation: number;
  },
): Steps<unknown[]> {
  const { outbox } = q.t;
  const fields = Object.entries({ ...scope, generation: String(scope.generation) });
  const rows = yield* q.all(
    q.orm
      .select({ payload: outbox.payload })
      .from(outbox)
      .where(
        and(
          eq(outbox.target, "slack"),
          eq(outbox.op, "chat.postMessage"),
          eq(outbox.status, "sent"),
          ...fields.map(([name, value]) => eq(jsonField(q, outbox.payload, name), value)),
        ),
      )
      .orderBy(asc(outbox.id)),
  );
  return rows.map((row) => row.payload);
}

type Held = { id: number; lockedBy: string | null; attempts: number };

function held(q: Q, row: Held) {
  const { outbox } = q.t;
  return and(
    eq(outbox.id, row.id),
    eq(outbox.status, "pending"),
    row.lockedBy === null ? isNull(outbox.lockedBy) : eq(outbox.lockedBy, row.lockedBy),
    eq(outbox.attempts, row.attempts),
  );
}

export function* slackSendingSteps(q: Q, row: Held, sending: boolean): Steps<boolean> {
  const { outbox } = q.t;
  const from = sending ? isNull(outbox.externalId) : eq(outbox.externalId, "sending");
  const updated = yield* q.all(
    q.orm
      .update(outbox)
      .set({ externalId: sending ? "sending" : null })
      .where(and(held(q, row), from))
      .returning({ id: outbox.id }),
  );
  return updated.length === 1;
}

export function* slackOutboxExternalIdSteps(q: Q, id: number): Steps<string | null> {
  const { outbox } = q.t;
  const query = q.orm.select({ externalId: outbox.externalId }).from(outbox);
  return (yield* q.one(query.where(eq(outbox.id, id))))?.externalId ?? null;
}

export function* slackLaterProgressSteps(q: Q, id: number, itemId: string): Steps<boolean> {
  const { outbox } = q.t;
  const later = yield* q.one(
    q.orm
      .select({ id: outbox.id })
      .from(outbox)
      .where(
        and(
          eq(outbox.target, "slack"),
          eq(outbox.status, "pending"),
          gt(outbox.id, id),
          eq(jsonField(q, outbox.payload, "itemId"), itemId),
          eq(jsonField(q, outbox.payload, "progress"), "true"),
        ),
      )
      .limit(1),
  );
  return later !== undefined;
}

export function* slackStreamingSteps(q: Q, row: Held, state: string): Steps<boolean> {
  const { outbox } = q.t;
  const from = or(eq(outbox.externalId, "sending"), like(outbox.externalId, "stream:%"));
  const updated = yield* q.all(
    q.orm
      .update(outbox)
      .set({ externalId: state })
      .where(and(held(q, row), from))
      .returning({ id: outbox.id }),
  );
  return updated.length === 1;
}

export type SlackSendOutcome =
  | { kind: "sent"; ts: string }
  | { kind: "unknown" | "withheld" | "refused"; note: string };

export function* settleSlackOutboxSteps(
  q: Q,
  row: Held,
  outcome: SlackSendOutcome,
  now: number,
): Steps<void> {
  const sent = outcome.kind === "sent";
  yield* q.exec(
    q.orm
      .update(q.t.outbox)
      .set({
        status: sent ? "sent" : "dropped",
        externalId: sent ? outcome.ts : outcome.kind,
        error: sent ? null : outcome.note,
        sentAt: sent ? now : null,
        lockedBy: null,
        lockedUntil: null,
      })
      .where(held(q, row)),
  );
}

export const slackIssueKey = (issueId: string) => `slack.issue:${issueId}`;

export type SlackIssueOrigin = {
  workspaceId: string;
  teamId: string;
  channelId: string;
  threadTs: string;
  generation: number;
  ownerId?: string;
  userId: string;
  slackUserId?: string;
  linkId?: string;
  context?: string;
};

export function* slackIssueOriginSteps(
  q: Q,
  issueId: string,
  organizationId: string,
): Steps<SlackIssueOrigin | null> {
  const value = yield* readSettingSteps(q, slackIssueKey(issueId));
  const origin = value ? (JSON.parse(value) as SlackIssueOrigin) : null;
  const workspace = origin ? yield* workspaceForOrganizationSteps(q, organizationId) : null;
  return workspace && origin?.workspaceId === workspace.id ? origin : null;
}

export function* slackIssueOwnerSteps(q: Q, issueId: string, organizationId: string) {
  return (yield* slackIssueOriginSteps(q, issueId, organizationId))?.ownerId ?? null;
}

export function* slackSessionOriginSteps(q: Q, sessionId: string) {
  const session = yield* getLinearSessionSteps(q, sessionId);
  const { issueId, organizationId } = session ?? {};
  if (!issueId || !organizationId) return null;
  const origin = yield* slackIssueOriginSteps(q, issueId, organizationId);
  return origin ? { ...origin, issueId } : null;
}

export function* slackIssueTaskSteps(
  q: Q,
  issueId: string,
): Steps<{ itemId: string; sessionKey: string } | null> {
  const { workItem } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ itemId: workItem.id, sessionKey: workItem.sessionKey })
      .from(workItem)
      .where(and(eq(workItem.linearIssueId, issueId), isNotNull(workItem.sessionKey)))
      .orderBy(desc(workItem.createdAt), desc(workItem.id))
      .limit(1),
  );
  return row?.sessionKey ? { itemId: row.itemId, sessionKey: row.sessionKey } : null;
}

export function* slackTaskScopeSteps(q: Q, itemId: string): Steps<string[]> {
  const bound = yield* getWorkItemRepositorySteps(q, itemId);
  if (bound) return [`${bound.owner}/${bound.repo}`];
  const item = yield* getWorkItemSteps(q, itemId);
  if (!item?.sessionKey) return [];
  const candidates = yield* listRepositoryCandidatesSteps(q, item.sessionKey, []);
  return candidates.map((candidate) => `${candidate.owner}/${candidate.repo}`);
}

export function* slackOutboxMarkSteps(q: Q): Steps<number> {
  const { outbox } = q.t;
  const row = yield* q.one(q.orm.select({ id: max(outbox.id) }).from(outbox));
  return row?.id ?? 0;
}
