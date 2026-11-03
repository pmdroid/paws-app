import type { Database } from "bun:sqlite";
import { isTerminalWorkItemState, parentIssueIdSql } from "../core";
import {
  DEFAULT_PULL_FEEDBACK_WAIT,
  enqueueOutboxOnce,
  gatherLinearComments,
  getLinearComment,
  getLinearSession,
  getLinearSessionAccess,
  getLinearSessionInstallation,
  getWorkItem,
  immediate,
  linearCommentAuthor,
  linearCommentsInBrief,
  markLinearCommentsDelivered,
  pendingChangeRequests,
  pendingLinearComments,
  pendingPullCiFailures,
  pendingPullComments,
  queueLinearComment,
  settleLinearComments,
  type LinearCommentAuthority,
  type LinearCommentRecord,
  type PullFeedbackWait,
  type WorkItemRecord,
} from "../db";
import { isPawsStop } from "../linear";
import { findOpenQuestion, type StoredQuestion } from "../questions";
import { restart } from "./operations";

export type LinearCommentActor = { id: string; teamId: string | null };

export type LinearCommentPolicy = {
  appUserId: string | null;
  agents: readonly string[];
  authorize?(actor: LinearCommentActor): Promise<boolean>;
  recheck?(actor: LinearCommentActor): boolean;
  wait?(): PullFeedbackWait;
};

export type LinearCommentRoute =
  | {
      kind: "settle";
      state: "ignored" | "rejected";
      reason: string;
      notify?: { sessionId: string; body: string };
    }
  | {
      kind: "queue";
      item: WorkItemRecord;
      sessionId: string;
      generation: number;
      teamId: string | null;
      authority: LinearCommentAuthority;
      actors: string[];
    };

export type LinearCommentStep = "done" | "wait" | "delivered" | "restarted" | "answered";

export type LinearCommentCapabilities = {
  now(): number;
  policy: LinearCommentPolicy;
  busy(item: WorkItemRecord): boolean;
  forward(item: WorkItemRecord, body: string): Promise<boolean>;
  answer(
    item: WorkItemRecord,
    comment: LinearCommentRecord,
    question: StoredQuestion,
  ): Promise<boolean>;
  flush(): Promise<void>;
};

export const ANSWERABLE_QUESTION_KINDS: readonly StoredQuestion["kind"][] = [
  "agent",
  "clarification",
];

const HELD_STATES = new Set(["paused", "manual", "failed"]);
const ACTIVE_STATES = new Set(["running", "verifying", "recovering"]);
const COMMENT_CHARS = 4_000;
const SECTION_CHARS = 12_000;

export const LINEAR_COMMENT_INSTRUCTION =
  "These comments were posted on the Linear issue while you worked on it. Treat them as direction from the team. A comment can be a question, a note or a status line rather than a request; change nothing for those.";

export function routeLinearComment(
  db: Database,
  comment: LinearCommentRecord,
  policy: LinearCommentPolicy,
): LinearCommentRoute {
  const settle = (state: "ignored" | "rejected", reason: string): LinearCommentRoute => ({
    kind: "settle",
    state,
    reason,
  });
  if (comment.body.trim() === "") return settle("ignored", "empty");
  if (isPawsStop(comment.body)) return settle("ignored", "control");
  if (comment.authorId === null) return settle("rejected", "unknown_author");
  if (policy.appUserId !== null && comment.authorId === policy.appUserId)
    return settle("ignored", "own");
  const agent = policy.agents.includes(comment.authorId);
  if (!agent && (comment.botActor !== null || (comment.actorType ?? "user") !== "user"))
    return settle("ignored", "bot");
  if (inAgentSession(db, comment, policy.appUserId)) return settle("ignored", "agent_session");
  const items = db
    .query<{ id: string; state: string; created_at: number }, [string]>(
      "SELECT id, state, created_at FROM work_item WHERE linear_issue_id = ? ORDER BY created_at DESC, id",
    )
    .all(comment.issueId);
  const open = items.filter(
    (row) => !isTerminalWorkItemState(row.state as WorkItemRecord["state"]),
  );
  if (open.length === 0) {
    if (items.length > 0) return settle("ignored", "ended");
    const parent = parentSession(db, comment.issueId);
    if (parent !== null)
      return {
        kind: "settle",
        state: "rejected",
        reason: "parent_issue",
        notify: {
          sessionId: parent,
          body: "A comment on this parent issue was not passed on: each sub-issue runs in its own session. Comment on the sub-issue whose work it is about.",
        },
      };
    return settle("ignored", "not_delegated");
  }
  const item = getWorkItem(db, open[0]!.id)!;
  if (comment.createdAtMs < open[0]!.created_at) return settle("ignored", "before_delegation");
  if (item.cancelRequested) return settle("ignored", "ended");
  if (item.sessionKey === null) return settle("rejected", "no_session");
  const session = getLinearSession(db, item.sessionKey);
  if (session === null || session.stoppedAt !== null) return settle("ignored", "session_stopped");
  const installation = getLinearSessionInstallation(db, item.sessionKey);
  if (getLinearSessionAccess(db, item.sessionKey) !== "allowed" || installation === null)
    return settle("rejected", "access");
  if (comment.organizationId !== null && comment.organizationId !== installation.organizationId)
    return settle("rejected", "workspace");
  if (
    comment.teamId !== null &&
    installation.teamId !== null &&
    comment.teamId !== installation.teamId
  )
    return settle("rejected", "team");
  const actors = agent
    ? comment.onBehalfOf === null
      ? []
      : [comment.onBehalfOf]
    : [comment.authorId];
  return {
    kind: "queue",
    item,
    sessionId: item.sessionKey,
    generation: session.generation,
    teamId: installation.teamId,
    authority: agent ? "agent" : "person",
    actors,
  };
}

export async function authorizeLinearComment(
  route: Extract<LinearCommentRoute, { kind: "queue" }>,
  policy: LinearCommentPolicy,
): Promise<boolean> {
  if (policy.authorize === undefined) return true;
  for (const id of route.actors)
    if (!(await policy.authorize({ id, teamId: route.teamId }))) return false;
  return true;
}

export function commitLinearCommentRoute(
  db: Database,
  commentId: string,
  route: LinearCommentRoute,
  options: { now: number; wait?: PullFeedbackWait; authorized: boolean },
): LinearCommentRecord | null {
  return immediate(db, () => {
    const comment = getLinearComment(db, commentId);
    if (comment === null || comment.state !== "received") return comment;
    if (route.kind === "settle") {
      settleLinearComments(db, [commentId], {
        state: route.state,
        reason: route.reason,
        now: options.now,
      });
      if (route.notify)
        enqueueOutboxOnce(db, {
          target: "linear",
          op: "activity",
          orderingKey: route.notify.sessionId,
          idempotencyKey: `linear-comment:${route.reason}:${commentId}`,
          payload: {
            sessionId: route.notify.sessionId,
            kind: "thought",
            body: route.notify.body,
            id: crypto.randomUUID(),
          },
          now: options.now,
        });
      return getLinearComment(db, commentId);
    }
    if (!options.authorized) {
      settleLinearComments(db, [commentId], {
        state: "rejected",
        reason: route.authority === "agent" ? "on_behalf_of" : "not_member",
        now: options.now,
      });
      return getLinearComment(db, commentId);
    }
    const item = getWorkItem(db, route.item.id);
    if (
      item === null ||
      isTerminalWorkItemState(item.state) ||
      item.cancelRequested ||
      item.sessionKey !== route.sessionId
    ) {
      settleLinearComments(db, [commentId], {
        state: "ignored",
        reason: "ended",
        now: options.now,
      });
      return getLinearComment(db, commentId);
    }
    queueLinearComment(db, commentId, {
      itemId: item.id,
      sessionId: route.sessionId,
      generation: route.generation,
      authority: route.authority,
    });
    enqueueOutboxOnce(db, {
      target: "linear",
      op: "activity",
      orderingKey: route.sessionId,
      idempotencyKey: `linear-comment:received:${commentId}`,
      payload: {
        sessionId: route.sessionId,
        kind: "thought",
        body: receivedNote(item),
        id: crypto.randomUUID(),
      },
      now: options.now,
    });
    gatherLinearComments(
      db,
      item.id,
      options.now,
      options.wait ?? DEFAULT_PULL_FEEDBACK_WAIT,
      `linear-comments:${item.id}:${commentId}`,
    );
    return getLinearComment(db, commentId);
  });
}

export function receivedNote(item: WorkItemRecord): string {
  const issue = item.linearIdentifier;
  if (item.state === "paused")
    return `Received a comment on ${issue}. The task is paused, so the comment waits with it and reaches the agent when the task resumes.`;
  if (item.state === "manual")
    return `Received a comment on ${issue}. The task is held for a person, so the comment waits with it and reaches the agent when the task runs again.`;
  if (item.state === "failed")
    return `Received a comment on ${issue}. The task has stopped, so the comment waits with it. Reply in this session to run the task again.`;
  if (item.state === "awaiting_input")
    return `Received a comment on ${issue}. The task waits for an answer in this session. Paws passes the comment on as that answer only when it is the one reply to the agent's own question; otherwise it reaches the agent when the task runs again.`;
  return `Received a comment on ${issue}. Paws hands it to the agent at its next turn.`;
}

export async function deliverLinearComments(
  db: Database,
  itemId: string,
  caps: LinearCommentCapabilities,
): Promise<LinearCommentStep> {
  const item = getWorkItem(db, itemId);
  const all = pendingLinearComments(db, itemId);
  if (all.length === 0) return "done";
  if (item === null || isTerminalWorkItemState(item.state) || item.cancelRequested) {
    settleLinearComments(
      db,
      all.map((comment) => comment.commentId),
      { state: "ignored", reason: "ended", now: caps.now() },
    );
    return "done";
  }
  const pending = current(db, item, all, caps);
  if (pending.length === 0) return "done";
  if (item.state === "awaiting_input") {
    const question = findOpenQuestion(db, item.sessionKey!);
    if (
      question !== null &&
      question.itemId === item.id &&
      ANSWERABLE_QUESTION_KINDS.includes(question.kind) &&
      pending.length === 1 &&
      pending[0]!.authority === "person"
    ) {
      const comment = pending[0]!;
      if (await caps.answer(item, comment, question)) {
        markLinearCommentsDelivered(db, [comment.commentId], {
          via: "answer",
          itemVersion: item.version,
          now: caps.now(),
        });
        return "answered";
      }
    }
    if (question !== null) {
      enqueueOutboxOnce(db, {
        target: "linear",
        op: "activity",
        orderingKey: item.sessionKey!,
        idempotencyKey: `linear-comment:question:${question.id}:${pending.at(-1)!.commentId}`,
        payload: {
          sessionId: item.sessionKey!,
          kind: "thought",
          body: "Paws keeps the comment on the issue as context for the agent. The open question here still needs an answer in this session.",
          id: crypto.randomUUID(),
        },
        now: caps.now(),
      });
      await caps.flush();
    }
    return "done";
  }
  if (HELD_STATES.has(item.state) || item.state === "queued") return "done";
  if (item.state === "running") {
    const body = linearCommentSection(pending, item.linearIdentifier);
    if (body !== null && (await caps.forward(item, body))) {
      immediate(db, () => {
        markLinearCommentsDelivered(
          db,
          pending.map((comment) => comment.commentId),
          { via: "follow_up", itemVersion: item.version, now: caps.now() },
        );
        enqueueOutboxOnce(db, {
          target: "linear",
          op: "activity",
          orderingKey: item.sessionKey!,
          idempotencyKey: `linear-comment:forwarded:${pending[0]!.commentId}`,
          payload: {
            sessionId: item.sessionKey!,
            kind: "thought",
            body: `Sent ${count(pending)} on ${item.linearIdentifier} to the running agent.`,
            id: crypto.randomUUID(),
          },
          now: caps.now(),
        });
      });
      await caps.flush();
      return "delivered";
    }
    return "wait";
  }
  if (ACTIVE_STATES.has(item.state)) return "wait";
  if (item.state !== "merge_queue" || caps.busy(item)) return "wait";
  if (
    pendingPullComments(db, item.id).length > 0 ||
    pendingPullCiFailures(db, item.id).length > 0 ||
    pendingChangeRequests(db, item.id).length > 0
  )
    return "wait";
  const step = immediate(db, (): LinearCommentStep => {
    const latest = getWorkItem(db, item.id);
    if (latest === null || latest.version !== item.version || latest.state !== "merge_queue")
      return "wait";
    const batch = current(db, latest, pendingLinearComments(db, item.id), caps);
    const body = linearCommentSection(batch, latest.linearIdentifier);
    if (body === null) return "done";
    const jobKey = `linear-comment:${latest.id}:${batch[0]!.commentId}`;
    const jobId = restart(db, latest, { reason: "follow_up", body, jobKey, now: caps.now() });
    if (jobId === null) return "wait";
    const restarted = getWorkItem(db, latest.id)!;
    markLinearCommentsDelivered(
      db,
      batch.map((comment) => comment.commentId),
      { via: "restart", itemVersion: restarted.version, now: caps.now() },
    );
    enqueueOutboxOnce(db, {
      target: "linear",
      op: "activity",
      orderingKey: latest.sessionKey!,
      idempotencyKey: `linear-comment:restarted:${batch[0]!.commentId}`,
      payload: {
        sessionId: latest.sessionKey!,
        kind: "thought",
        body: `Handed ${count(batch)} on ${latest.linearIdentifier} to the agent. It works on ${batch.length === 1 ? "it" : "them"} now.`,
        id: crypto.randomUUID(),
      },
      now: caps.now(),
    });
    return "restarted";
  });
  if (step === "restarted") await caps.flush();
  return step;
}

export function takeLinearCommentBrief(
  db: Database,
  item: WorkItemRecord,
  caps: Pick<LinearCommentCapabilities, "now" | "policy">,
): string | null {
  const pending = current(db, item, pendingLinearComments(db, item.id), caps);
  if (pending.length > 0)
    markLinearCommentsDelivered(
      db,
      pending.map((comment) => comment.commentId),
      { via: "brief", itemVersion: item.version, now: caps.now() },
    );
  return linearCommentSection(
    linearCommentsInBrief(db, item.id, item.version),
    item.linearIdentifier,
  );
}

export function linearCommentSection(
  comments: readonly LinearCommentRecord[],
  identifier: string,
): string | null {
  const entries = comments.filter((comment) => comment.body.trim() !== "");
  if (entries.length === 0) return null;
  const lines = [`New comments on the Linear issue ${identifier}.`, ""];
  entries.forEach((comment, index) => {
    lines.push(`${index + 1}. ${who(comment)} at ${new Date(comment.createdAtMs).toISOString()}:`);
    lines.push(indent(clip(comment.body.trim(), COMMENT_CHARS)), "");
  });
  lines.push(LINEAR_COMMENT_INSTRUCTION);
  return clip(lines.join("\n"), SECTION_CHARS);
}

function current(
  db: Database,
  item: WorkItemRecord,
  comments: readonly LinearCommentRecord[],
  caps: Pick<LinearCommentCapabilities, "now" | "policy">,
): LinearCommentRecord[] {
  const kept: LinearCommentRecord[] = [];
  for (const comment of comments) {
    const reason = staleReason(db, item, comment, caps.policy);
    if (reason === null) kept.push(comment);
    else
      settleLinearComments(db, [comment.commentId], {
        state: reason === "not_member" ? "rejected" : "ignored",
        reason,
        now: caps.now(),
      });
  }
  return kept;
}

function staleReason(
  db: Database,
  item: WorkItemRecord,
  comment: LinearCommentRecord,
  policy: LinearCommentPolicy,
): string | null {
  if (comment.sessionId === null || item.sessionKey !== comment.sessionId) return "superseded";
  const session = getLinearSession(db, comment.sessionId);
  if (session === null || session.stoppedAt !== null) return "session_stopped";
  if (
    db
      .query("SELECT 1 FROM linear_stop_receipt WHERE session_id = ? AND generation > ?")
      .get(comment.sessionId, comment.generation ?? 0) !== null
  )
    return "session_stopped";
  if (inAgentSession(db, comment, policy.appUserId)) return "agent_session";
  if (policy.recheck && comment.authorId !== null) {
    const teamId = getLinearSessionInstallation(db, comment.sessionId)?.teamId ?? null;
    const actors =
      comment.authority === "agent"
        ? comment.onBehalfOf === null
          ? []
          : [comment.onBehalfOf]
        : [comment.authorId];
    if (comment.authority === "agent" && !policy.agents.includes(comment.authorId))
      return "not_member";
    if (actors.some((id) => !policy.recheck!({ id, teamId }))) return "not_member";
  }
  return null;
}

function inAgentSession(
  db: Database,
  comment: LinearCommentRecord,
  appUserId: string | null,
): boolean {
  if (
    comment.parentId !== null &&
    appUserId !== null &&
    linearCommentAuthor(db, comment.parentId) === appUserId
  )
    return true;
  const ids =
    comment.parentId === null ? [comment.commentId] : [comment.commentId, comment.parentId];
  for (const id of ids)
    if (
      db
        .query(
          `SELECT 1 FROM inbox_event WHERE issue_id = ?1 AND action IN ('created','prompted')
             AND json_valid(payload) AND (
               json_extract(payload, '$.agentActivity.sourceCommentId') = ?2
               OR json_extract(payload, '$.agentSession.sourceCommentId') = ?2
               OR json_extract(payload, '$.agentSession.commentId') = ?2
               OR json_extract(payload, '$.agentSession.comment.id') = ?2
               OR json_extract(payload, '$.sourceCommentId') = ?2)
           LIMIT 1`,
        )
        .get(comment.issueId, id) !== null
    )
      return true;
  return false;
}

function parentSession(db: Database, issueId: string): string | null {
  return (
    db
      .query<{ session_id: string }, [string]>(
        `SELECT s.session_id FROM linear_session s
         WHERE s.issue_id = ?1 AND s.stopped_at IS NULL
           AND EXISTS (SELECT 1 FROM work_item w WHERE w.linear_issue_id <> ?1
                         AND ${parentIssueIdSql("w")} = ?1
                         AND w.state NOT IN ('completed','merged','cancelled'))
         ORDER BY s.created_at DESC LIMIT 1`,
      )
      .get(issueId)?.session_id ?? null
  );
}

function who(comment: LinearCommentRecord): string {
  if (comment.authority === "agent")
    return comment.onBehalfOf === null
      ? `Agent ${comment.authorId}`
      : `Agent ${comment.authorId} for ${comment.onBehalfOf}`;
  return `Linear user ${comment.authorId}`;
}

function count(comments: readonly LinearCommentRecord[]): string {
  return comments.length === 1 ? "the comment" : `${comments.length} comments`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `   ${line}`)
    .join("\n");
}
