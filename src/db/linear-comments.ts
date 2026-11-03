import type { Database } from "bun:sqlite";
import { JOB_KIND } from "../core";
import { enqueueJobOnce } from "./jobs";
import type { PullFeedbackWait } from "./pull-comments";
import { immediate } from "./tx";

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

type Row = {
  comment_id: string;
  issue_id: string;
  organization_id: string | null;
  team_id: string | null;
  author_id: string | null;
  actor_id: string | null;
  actor_type: string | null;
  bot_actor: string | null;
  on_behalf_of: string | null;
  parent_id: string | null;
  body: string;
  created_at_ms: number;
  updated_at_ms: number;
  received_at: number;
  source: "webhook" | "poll";
  edited: number;
  removed_at: number | null;
  state: LinearCommentState;
  reason: string | null;
  authority: LinearCommentAuthority | null;
  item_id: string | null;
  session_id: string | null;
  generation: number | null;
  item_version: number | null;
  via: LinearCommentVia | null;
  settled_at: number | null;
};

const OPEN_STATES: readonly LinearCommentState[] = ["received", "queued"];

export function getLinearComment(db: Database, commentId: string): LinearCommentRecord | null {
  const row = db
    .query<Row, [string]>("SELECT * FROM linear_comment WHERE comment_id = ?")
    .get(commentId);
  return row === null ? null : mapRow(row);
}

export function recordLinearComment(
  db: Database,
  receipt: LinearCommentReceipt,
  now: number,
): { record: LinearCommentRecord; change: LinearCommentChange } {
  return immediate(db, () => {
    const existing = getLinearComment(db, receipt.commentId);
    if (existing === null) {
      db.run(
        `INSERT INTO linear_comment (
           comment_id, issue_id, organization_id, team_id, author_id, actor_id, actor_type,
           bot_actor, on_behalf_of, parent_id, body, created_at_ms, updated_at_ms, received_at,
           source, removed_at, state, reason, settled_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          receipt.commentId,
          receipt.issueId,
          receipt.organizationId,
          receipt.teamId,
          receipt.authorId,
          receipt.actorId,
          receipt.actorType,
          receipt.botActor,
          receipt.onBehalfOf,
          receipt.parentId,
          receipt.body,
          receipt.createdAtMs,
          receipt.updatedAtMs,
          now,
          receipt.source,
          receipt.removed ? now : null,
          receipt.removed ? "removed" : "received",
          receipt.removed ? "deleted" : null,
          receipt.removed ? now : null,
        ],
      );
      return {
        record: getLinearComment(db, receipt.commentId)!,
        change: receipt.removed ? "removed" : "inserted",
      };
    }
    if (existing.removedAt !== null) return { record: existing, change: "unchanged" };
    if (receipt.removed) {
      if (OPEN_STATES.includes(existing.state))
        db.run(
          `UPDATE linear_comment SET removed_at = ?, state = 'removed', reason = 'deleted', settled_at = ?
           WHERE comment_id = ?`,
          [now, now, receipt.commentId],
        );
      else
        db.run("UPDATE linear_comment SET removed_at = ? WHERE comment_id = ?", [
          now,
          receipt.commentId,
        ]);
      return { record: getLinearComment(db, receipt.commentId)!, change: "removed" };
    }
    if (receipt.updatedAtMs <= existing.updatedAtMs)
      return { record: existing, change: "unchanged" };
    if (OPEN_STATES.includes(existing.state)) {
      db.run(
        "UPDATE linear_comment SET body = ?, updated_at_ms = ?, edited = 1 WHERE comment_id = ?",
        [receipt.body, receipt.updatedAtMs, receipt.commentId],
      );
      return { record: getLinearComment(db, receipt.commentId)!, change: "updated" };
    }
    db.run("UPDATE linear_comment SET updated_at_ms = ?, edited = 1 WHERE comment_id = ?", [
      receipt.updatedAtMs,
      receipt.commentId,
    ]);
    return { record: getLinearComment(db, receipt.commentId)!, change: "unchanged" };
  });
}

export function settleLinearComments(
  db: Database,
  commentIds: readonly string[],
  outcome: {
    state: Exclude<LinearCommentState, "received" | "queued">;
    reason?: string;
    now: number;
  },
): void {
  immediate(db, () => {
    for (const commentId of commentIds)
      db.run(
        `UPDATE linear_comment SET state = ?, reason = COALESCE(?, reason), settled_at = ?
         WHERE comment_id = ? AND state IN ('received','queued')`,
        [outcome.state, outcome.reason ?? null, outcome.now, commentId],
      );
  });
}

export function queueLinearComment(
  db: Database,
  commentId: string,
  route: {
    itemId: string;
    sessionId: string;
    generation: number;
    authority: LinearCommentAuthority;
    reason?: string | null;
  },
): boolean {
  return (
    db.run(
      `UPDATE linear_comment SET state = 'queued', item_id = ?, session_id = ?, generation = ?,
         authority = ?, reason = ?
       WHERE comment_id = ? AND state = 'received'`,
      [
        route.itemId,
        route.sessionId,
        route.generation,
        route.authority,
        route.reason ?? null,
        commentId,
      ],
    ).changes > 0
  );
}

export function markLinearCommentsDelivered(
  db: Database,
  commentIds: readonly string[],
  delivery: { via: LinearCommentVia; itemVersion: number; now: number },
): void {
  immediate(db, () => {
    for (const commentId of commentIds)
      db.run(
        `UPDATE linear_comment SET state = ?, via = ?, item_version = ?, settled_at = ?
         WHERE comment_id = ? AND state = 'queued'`,
        [
          delivery.via === "answer" ? "answered" : "delivered",
          delivery.via,
          delivery.itemVersion,
          delivery.now,
          commentId,
        ],
      );
  });
}

export function receivedLinearComments(db: Database): LinearCommentRecord[] {
  return db
    .query<Row, []>(
      "SELECT * FROM linear_comment WHERE state = 'received' ORDER BY created_at_ms, comment_id",
    )
    .all()
    .map(mapRow);
}

export function pendingLinearComments(db: Database, itemId: string): LinearCommentRecord[] {
  return db
    .query<Row, [string]>(
      `SELECT * FROM linear_comment WHERE item_id = ? AND state = 'queued'
       ORDER BY created_at_ms, comment_id`,
    )
    .all(itemId)
    .map(mapRow);
}

export function linearCommentAuthor(db: Database, commentId: string): string | null {
  return (
    db
      .query<{ author_id: string | null }, [string]>(
        "SELECT author_id FROM linear_comment WHERE comment_id = ?",
      )
      .get(commentId)?.author_id ?? null
  );
}

export function gatherLinearComments(
  db: Database,
  itemId: string,
  receivedAt: number,
  wait: PullFeedbackWait,
  jobKey: string,
): void {
  db.run(
    `UPDATE job SET run_at = MIN(MAX(run_at, ?), created_at + ?)
     WHERE status = 'pending' AND queue = ? AND json_extract(payload, '$.linearCommentsFor') = ?`,
    [
      receivedAt + wait.quietMs,
      Math.max(wait.maxMs, wait.quietMs),
      JOB_KIND.linearComments,
      itemId,
    ],
  );
  const gathering = db
    .query<{ n: number }, [string, string]>(
      `SELECT count(*) AS n FROM job WHERE queue = ? AND status = 'pending'
       AND json_extract(payload, '$.linearCommentsFor') = ?`,
    )
    .get(JOB_KIND.linearComments, itemId);
  if ((gathering?.n ?? 0) > 0) return;
  enqueueJobOnce(db, {
    queue: JOB_KIND.linearComments,
    jobKey,
    payload: { linearCommentsFor: itemId },
    runAt: receivedAt + wait.quietMs,
    now: receivedAt,
  });
}

function mapRow(row: Row): LinearCommentRecord {
  return {
    commentId: row.comment_id,
    issueId: row.issue_id,
    organizationId: row.organization_id,
    teamId: row.team_id,
    authorId: row.author_id,
    actorId: row.actor_id,
    actorType: row.actor_type,
    botActor: row.bot_actor,
    onBehalfOf: row.on_behalf_of,
    parentId: row.parent_id,
    body: row.body,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    receivedAt: row.received_at,
    source: row.source,
    edited: row.edited === 1,
    removedAt: row.removed_at,
    state: row.state,
    reason: row.reason,
    authority: row.authority,
    itemId: row.item_id,
    sessionId: row.session_id,
    generation: row.generation,
    itemVersion: row.item_version,
    via: row.via,
    settledAt: row.settled_at,
  };
}
