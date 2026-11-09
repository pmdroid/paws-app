import type { Database } from "bun:sqlite";
import { and, asc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { JOB_KIND } from "../core";
import { settled, sqliteDb, type Db, type Q, type Steps } from "./db";
import { enqueueJobOnceSteps, emitJobReady } from "./jobs";
import { jsonField } from "./json-text";
import type { PullFeedbackWait } from "./pull-comments";

export type LinearCommentState =
  | "received"
  | "queued"
  | "delivered"
  | "answered"
  | "ignored"
  | "rejected"
  | "removed";

export type LinearCommentAuthority = "person" | "agent";
export type LinearCommentVia = "brief" | "follow_up" | "restart" | "answer";

export type LinearCommentReceipt = {
  commentId: string;
  issueId: string;
  organizationId: string | null;
  teamId: string | null;
  authorId: string | null;
  actorId: string | null;
  actorType: string | null;
  botActor: string | null;
  onBehalfOf: string | null;
  parentId: string | null;
  body: string;
  createdAtMs: number;
  updatedAtMs: number;
  removed: boolean;
  source: "webhook" | "poll";
};

export type LinearCommentRecord = Omit<LinearCommentReceipt, "removed"> & {
  receivedAt: number;
  edited: boolean;
  removedAt: number | null;
  state: LinearCommentState;
  reason: string | null;
  authority: LinearCommentAuthority | null;
  itemId: string | null;
  sessionId: string | null;
  generation: number | null;
  itemVersion: number | null;
  via: LinearCommentVia | null;
  settledAt: number | null;
};

export type LinearCommentChange = "inserted" | "updated" | "removed" | "unchanged";

const OPEN_STATES: readonly LinearCommentState[] = ["received", "queued"];

export function* getLinearCommentSteps(q: Q, commentId: string): Steps<LinearCommentRecord | null> {
  const { linearComment } = q.t;
  const row = yield* q.one(
    q.orm.select().from(linearComment).where(eq(linearComment.commentId, commentId)),
  );
  return row === undefined ? null : mapRow(row);
}

export function getLinearComment(db: Database, commentId: string): LinearCommentRecord | null {
  return settled(sqliteDb(db).run((q) => getLinearCommentSteps(q, commentId)));
}

type RecordedLinearComment = { record: LinearCommentRecord; change: LinearCommentChange };

export function* recordLinearCommentSteps(
  q: Q,
  receipt: LinearCommentReceipt,
  now: number,
): Steps<RecordedLinearComment> {
  const { linearComment } = q.t;
  const byId = eq(linearComment.commentId, receipt.commentId);
  const existing = yield* getLinearCommentSteps(q, receipt.commentId);
  if (existing === null) {
    yield* q.exec(
      q.orm.insert(linearComment).values({
        commentId: receipt.commentId,
        issueId: receipt.issueId,
        organizationId: receipt.organizationId,
        teamId: receipt.teamId,
        authorId: receipt.authorId,
        actorId: receipt.actorId,
        actorType: receipt.actorType,
        botActor: receipt.botActor,
        onBehalfOf: receipt.onBehalfOf,
        parentId: receipt.parentId,
        body: receipt.body,
        createdAtMs: receipt.createdAtMs,
        updatedAtMs: receipt.updatedAtMs,
        receivedAt: now,
        source: receipt.source,
        removedAt: receipt.removed ? now : null,
        state: receipt.removed ? "removed" : "received",
        reason: receipt.removed ? "deleted" : null,
        settledAt: receipt.removed ? now : null,
      }),
    );
    return {
      record: (yield* getLinearCommentSteps(q, receipt.commentId))!,
      change: receipt.removed ? "removed" : "inserted",
    };
  }
  if (existing.removedAt !== null) return { record: existing, change: "unchanged" };
  if (receipt.removed) {
    yield* q.exec(
      q.orm
        .update(linearComment)
        .set(
          OPEN_STATES.includes(existing.state)
            ? { removedAt: now, state: "removed", reason: "deleted", settledAt: now }
            : { removedAt: now },
        )
        .where(byId),
    );
    return { record: (yield* getLinearCommentSteps(q, receipt.commentId))!, change: "removed" };
  }
  if (receipt.updatedAtMs <= existing.updatedAtMs) return { record: existing, change: "unchanged" };
  const open = OPEN_STATES.includes(existing.state);
  yield* q.exec(
    q.orm
      .update(linearComment)
      .set(
        open
          ? { body: receipt.body, updatedAtMs: receipt.updatedAtMs, edited: 1 }
          : { updatedAtMs: receipt.updatedAtMs, edited: 1 },
      )
      .where(byId),
  );
  return {
    record: (yield* getLinearCommentSteps(q, receipt.commentId))!,
    change: open ? "updated" : "unchanged",
  };
}

export function recordLinearComment(
  db: Database,
  receipt: LinearCommentReceipt,
  now: number,
): RecordedLinearComment {
  return settled(sqliteDb(db).transaction((q) => recordLinearCommentSteps(q, receipt, now)));
}

type LinearCommentOutcome = {
  state: Exclude<LinearCommentState, "received" | "queued">;
  reason?: string;
  now: number;
};

export function* settleLinearCommentsSteps(
  q: Q,
  commentIds: readonly string[],
  outcome: LinearCommentOutcome,
): Steps<void> {
  const { linearComment } = q.t;
  for (const commentId of commentIds)
    yield* q.exec(
      q.orm
        .update(linearComment)
        .set({
          state: outcome.state,
          reason: sql`COALESCE(${outcome.reason ?? null}, ${linearComment.reason})`,
          settledAt: outcome.now,
        })
        .where(
          and(
            eq(linearComment.commentId, commentId),
            inArray(linearComment.state, [...OPEN_STATES]),
          ),
        ),
    );
}

export function settleLinearComments(
  db: Database,
  commentIds: readonly string[],
  outcome: LinearCommentOutcome,
): void {
  settled(sqliteDb(db).transaction((q) => settleLinearCommentsSteps(q, commentIds, outcome)));
}

type LinearCommentRoute = {
  itemId: string;
  sessionId: string;
  generation: number;
  authority: LinearCommentAuthority;
  reason?: string | null;
};

export function* queueLinearCommentSteps(
  q: Q,
  commentId: string,
  route: LinearCommentRoute,
): Steps<boolean> {
  const { linearComment } = q.t;
  const queued = yield* q.all(
    q.orm
      .update(linearComment)
      .set({
        state: "queued",
        itemId: route.itemId,
        sessionId: route.sessionId,
        generation: route.generation,
        authority: route.authority,
        reason: route.reason ?? null,
      })
      .where(and(eq(linearComment.commentId, commentId), eq(linearComment.state, "received")))
      .returning({ commentId: linearComment.commentId }),
  );
  return queued.length > 0;
}

export function queueLinearComment(
  db: Database,
  commentId: string,
  route: LinearCommentRoute,
): boolean {
  return settled(sqliteDb(db).run((q) => queueLinearCommentSteps(q, commentId, route)));
}

type LinearCommentDelivery = { via: LinearCommentVia; itemVersion: number; now: number };

export function* markLinearCommentsDeliveredSteps(
  q: Q,
  commentIds: readonly string[],
  delivery: LinearCommentDelivery,
): Steps<void> {
  const { linearComment } = q.t;
  for (const commentId of commentIds)
    yield* q.exec(
      q.orm
        .update(linearComment)
        .set({
          state: delivery.via === "answer" ? "answered" : "delivered",
          via: delivery.via,
          itemVersion: delivery.itemVersion,
          settledAt: delivery.now,
        })
        .where(and(eq(linearComment.commentId, commentId), eq(linearComment.state, "queued"))),
    );
}

export function markLinearCommentsDelivered(
  db: Database,
  commentIds: readonly string[],
  delivery: LinearCommentDelivery,
): void {
  settled(
    sqliteDb(db).transaction((q) => markLinearCommentsDeliveredSteps(q, commentIds, delivery)),
  );
}

export function* receivedLinearCommentsSteps(q: Q): Steps<LinearCommentRecord[]> {
  const { linearComment } = q.t;
  const rows = yield* q.all(
    q.orm
      .select()
      .from(linearComment)
      .where(eq(linearComment.state, "received"))
      .orderBy(asc(linearComment.createdAtMs), asc(linearComment.commentId)),
  );
  return rows.map(mapRow);
}

export function receivedLinearComments(db: Database): LinearCommentRecord[] {
  return settled(sqliteDb(db).run(receivedLinearCommentsSteps));
}

export function* pendingLinearCommentsSteps(q: Q, itemId: string): Steps<LinearCommentRecord[]> {
  const { linearComment } = q.t;
  const rows = yield* q.all(
    q.orm
      .select()
      .from(linearComment)
      .where(and(eq(linearComment.itemId, itemId), eq(linearComment.state, "queued")))
      .orderBy(asc(linearComment.createdAtMs), asc(linearComment.commentId)),
  );
  return rows.map(mapRow);
}

export function pendingLinearComments(db: Database, itemId: string): LinearCommentRecord[] {
  return settled(sqliteDb(db).run((q) => pendingLinearCommentsSteps(q, itemId)));
}

export function* queuedLinearCommentItemIdsSteps(q: Q, issueId: string): Steps<string[]> {
  const { linearComment } = q.t;
  const rows = yield* q.all(
    q.orm
      .selectDistinct({ itemId: linearComment.itemId })
      .from(linearComment)
      .where(
        and(
          eq(linearComment.issueId, issueId),
          eq(linearComment.state, "queued"),
          isNotNull(linearComment.itemId),
        ),
      ),
  );
  return rows.map((row) => row.itemId!);
}

export function queuedLinearCommentItemIds(db: Database, issueId: string): string[] {
  return settled(sqliteDb(db).run((q) => queuedLinearCommentItemIdsSteps(q, issueId)));
}

export function* linearCommentAuthorSteps(q: Q, commentId: string): Steps<string | null> {
  const { linearComment } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ authorId: linearComment.authorId })
      .from(linearComment)
      .where(eq(linearComment.commentId, commentId)),
  );
  return row?.authorId ?? null;
}

export function linearCommentAuthor(db: Database, commentId: string): string | null {
  return settled(sqliteDb(db).run((q) => linearCommentAuthorSteps(q, commentId)));
}

export function* gatherLinearCommentsSteps(
  q: Q,
  itemId: string,
  receivedAt: number,
  wait: PullFeedbackWait,
  jobKey: string,
): Steps<boolean> {
  const { job } = q.t;
  const item =
    q.dialect === "postgres"
      ? sql`${job.payload}->>'linearCommentsFor'`
      : sql`json_extract(${job.payload}, '$.linearCommentsFor')`;
  const pending = and(
    eq(job.status, "pending"),
    eq(job.queue, JOB_KIND.linearComments),
    eq(item, itemId),
  );
  const runAt =
    q.dialect === "postgres"
      ? sql`LEAST(GREATEST(${job.runAt}, ${receivedAt + wait.quietMs}), ${job.createdAt} + ${Math.max(wait.maxMs, wait.quietMs)})`
      : sql`MIN(MAX(${job.runAt}, ${receivedAt + wait.quietMs}), ${job.createdAt} + ${Math.max(wait.maxMs, wait.quietMs)})`;
  yield* q.exec(q.orm.update(job).set({ runAt }).where(pending));
  if (yield* q.one(q.orm.select({ id: job.id }).from(job).where(pending).limit(1))) return false;
  const { inserted } = yield* enqueueJobOnceSteps(q, {
    queue: JOB_KIND.linearComments,
    jobKey,
    payload: { linearCommentsFor: itemId },
    runAt: receivedAt + wait.quietMs,
    now: receivedAt,
  });
  return inserted;
}

export function gatherLinearComments(
  db: Database,
  itemId: string,
  receivedAt: number,
  wait: PullFeedbackWait,
  jobKey: string,
): void {
  const inserted = settled(
    sqliteDb(db).transaction((q) => gatherLinearCommentsSteps(q, itemId, receivedAt, wait, jobKey)),
  );
  if (inserted) emitJobReady(db);
}

export async function gatherLinearCommentsAsync(
  store: Db,
  itemId: string,
  receivedAt: number,
  wait: PullFeedbackWait,
  jobKey: string,
): Promise<void> {
  const inserted = await store.transaction((q) =>
    gatherLinearCommentsSteps(q, itemId, receivedAt, wait, jobKey),
  );
  if (inserted) emitJobReady(store);
}

function mapRow(row: Q["t"]["linearComment"]["$inferSelect"]): LinearCommentRecord {
  return {
    commentId: row.commentId,
    issueId: row.issueId,
    organizationId: row.organizationId,
    teamId: row.teamId,
    authorId: row.authorId,
    actorId: row.actorId,
    actorType: row.actorType,
    botActor: row.botActor,
    onBehalfOf: row.onBehalfOf,
    parentId: row.parentId,
    body: row.body,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
    receivedAt: row.receivedAt,
    source: row.source as LinearCommentReceipt["source"],
    edited: row.edited === 1,
    removedAt: row.removedAt,
    state: row.state as LinearCommentState,
    reason: row.reason,
    authority: row.authority as LinearCommentAuthority | null,
    itemId: row.itemId,
    sessionId: row.sessionId,
    generation: row.generation,
    itemVersion: row.itemVersion,
    via: row.via as LinearCommentVia | null,
    settledAt: row.settledAt,
  };
}

/** Whether a webhook for this issue already carried the comment into an agent session. */
export function* commentOpenedAgentSessionSteps(q: Q, issueId: string, commentId: string) {
  const { inboxEvent } = q.t;
  const { payload } = inboxEvent;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(inboxEvent)
      .where(
        and(
          eq(inboxEvent.issueId, issueId),
          inArray(inboxEvent.action, ["created", "prompted"]),
          q.dialect === "sqlite" ? sql`json_valid(${payload})` : undefined,
          or(
            eq(jsonField(q, payload, "agentActivity", "sourceCommentId"), commentId),
            eq(jsonField(q, payload, "agentSession", "sourceCommentId"), commentId),
            eq(jsonField(q, payload, "agentSession", "commentId"), commentId),
            eq(jsonField(q, payload, "agentSession", "comment", "id"), commentId),
            eq(jsonField(q, payload, "sourceCommentId"), commentId),
          ),
        ),
      )
      .limit(1),
  );
  return row !== undefined;
}

export function commentOpenedAgentSession(
  db: Database,
  issueId: string,
  commentId: string,
): boolean {
  return settled(sqliteDb(db).run((q) => commentOpenedAgentSessionSteps(q, issueId, commentId)));
}
