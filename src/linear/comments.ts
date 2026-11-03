import { journalCaught } from "../journal";
import type { PolledComment } from "./catchup";
import type { AcceptedLinearEvent } from "./events";
import { isRecord, readString } from "./read";

export type LinearComment = {
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

const COMMENT_KIND = "comment";

export function linearCommentKey(commentId: string, removed: boolean, updatedAtMs: number): string {
  return removed ? `comment:${commentId}:removed` : `comment:${commentId}:at:${updatedAtMs}`;
}

export function webhookCommentEvent(
  parsed: Record<string, unknown>,
  rawBody: string,
  deliveryId: string,
): AcceptedLinearEvent | null {
  const comment = readWebhookComment(parsed);
  if (comment === null) return null;
  return {
    dedupeKey: linearCommentKey(comment.commentId, comment.removed, comment.updatedAtMs),
    deliveryId,
    source: "webhook",
    action: "other",
    sessionId: null,
    issueId: comment.issueId,
    activityId: null,
    actorId: comment.authorId,
    body: comment.body,
    signal: null,
    updatedAtMs: comment.updatedAtMs,
    payload: rawBody,
  };
}

export function polledCommentEvent(polled: PolledComment): AcceptedLinearEvent | null {
  if (polled.issueId === null) return null;
  const comment: Omit<LinearComment, "source"> = {
    commentId: polled.id,
    issueId: polled.issueId,
    organizationId: null,
    teamId: polled.teamId ?? null,
    authorId: polled.authorId ?? null,
    actorId: null,
    actorType: null,
    botActor: polled.botActor ?? null,
    onBehalfOf: null,
    parentId: polled.parentId ?? null,
    body: polled.body,
    createdAtMs: polled.createdAtMs ?? polled.updatedAtMs,
    updatedAtMs: polled.updatedAtMs,
    removed: false,
  };
  const payload = JSON.stringify({ kind: COMMENT_KIND, comment });
  return {
    dedupeKey: linearCommentKey(comment.commentId, false, comment.updatedAtMs),
    deliveryId: null,
    source: "poll",
    action: "other",
    sessionId: null,
    issueId: comment.issueId,
    activityId: null,
    actorId: comment.authorId,
    body: comment.body,
    signal: null,
    updatedAtMs: comment.updatedAtMs,
    payload,
  };
}

export function linearCommentOf(event: AcceptedLinearEvent): LinearComment | null {
  if (event.action !== "other" || event.sessionId !== null || event.signal === "stop") return null;
  if (!event.dedupeKey.startsWith("comment:")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.payload);
  } catch (error) {
    journalCaught(error, "comments.linearCommentOf.parse", null);
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (event.source === "webhook") {
    const comment = readWebhookComment(parsed);
    return comment === null ? null : { ...comment, source: "webhook" };
  }
  if (parsed["kind"] !== COMMENT_KIND || !isRecord(parsed["comment"])) return null;
  const stored = parsed["comment"];
  const commentId = readString(stored, "commentId");
  const issueId = readString(stored, "issueId");
  const body = readString(stored, "body");
  const createdAtMs = stored["createdAtMs"];
  const updatedAtMs = stored["updatedAtMs"];
  if (
    commentId === null ||
    issueId === null ||
    body === null ||
    typeof createdAtMs !== "number" ||
    typeof updatedAtMs !== "number"
  )
    return null;
  return {
    commentId,
    issueId,
    organizationId: null,
    teamId: readString(stored, "teamId"),
    authorId: readString(stored, "authorId"),
    actorId: null,
    actorType: null,
    botActor: readString(stored, "botActor"),
    onBehalfOf: null,
    parentId: readString(stored, "parentId"),
    body,
    createdAtMs,
    updatedAtMs,
    removed: false,
    source: "poll",
  };
}

function readWebhookComment(parsed: Record<string, unknown>): Omit<LinearComment, "source"> | null {
  if (readString(parsed, "type") !== "Comment") return null;
  const action = readString(parsed, "action");
  if (action !== "create" && action !== "update" && action !== "remove") return null;
  const data = isRecord(parsed["data"]) ? parsed["data"] : null;
  if (data === null) return null;
  const issue = isRecord(data["issue"]) ? data["issue"] : null;
  const user = isRecord(data["user"]) ? data["user"] : null;
  const parent = isRecord(data["parent"]) ? data["parent"] : null;
  const team = issue !== null && isRecord(issue["team"]) ? issue["team"] : null;
  const actor = isRecord(parsed["actor"]) ? parsed["actor"] : null;
  const commentId = readString(data, "id");
  const issueId = readString(data, "issueId") ?? (issue === null ? null : readString(issue, "id"));
  const createdAtMs = readTime(data, "createdAt");
  const updatedAtMs = readTime(data, "updatedAt") ?? createdAtMs;
  if (commentId === null || issueId === null || createdAtMs === null || updatedAtMs === null)
    return null;
  const authorId = readString(data, "userId") ?? (user === null ? null : readString(user, "id"));
  const actorId = actor === null ? null : readString(actor, "id");
  const actorType = actor === null ? null : readString(actor, "type");
  const removed =
    action === "remove" ||
    readString(data, "archivedAt") !== null ||
    readString(data, "deletedAt") !== null;
  return {
    commentId,
    issueId,
    organizationId: readString(parsed, "organizationId"),
    teamId:
      (issue === null ? null : readString(issue, "teamId")) ??
      (team === null ? null : readString(team, "id")),
    authorId,
    actorId,
    actorType,
    botActor: isRecord(data["botActor"]) ? JSON.stringify(data["botActor"]) : null,
    onBehalfOf:
      actorType === "user" && actorId !== null && authorId !== null && actorId !== authorId
        ? actorId
        : null,
    parentId: readString(data, "parentId") ?? (parent === null ? null : readString(parent, "id")),
    body: readString(data, "body") ?? "",
    createdAtMs,
    updatedAtMs,
    removed,
  };
}

function readTime(node: Record<string, unknown>, key: string): number | null {
  const value = readString(node, key);
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function linearSourceCommentId(event: AcceptedLinearEvent): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.payload);
  } catch (error) {
    journalCaught(error, "comments.linearSourceCommentId.parse", null);
    return null;
  }
  if (!isRecord(parsed)) return null;
  const activity = isRecord(parsed["agentActivity"]) ? parsed["agentActivity"] : null;
  const source =
    activity !== null && isRecord(activity["sourceComment"]) ? activity["sourceComment"] : null;
  return (
    (activity === null ? null : readString(activity, "sourceCommentId")) ??
    (source === null ? null : readString(source, "id")) ??
    readString(parsed, "sourceCommentId")
  );
}
