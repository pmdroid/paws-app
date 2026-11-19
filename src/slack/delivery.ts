import {
  enqueueOutboxOnceSteps,
  getWorkItemRepositorySteps,
  getWorkItemSteps,
  slackSessionOriginSteps,
  workspaceMemberSteps,
  workspaceMemberUsable,
  type Q,
  type Steps,
} from "../db";
import { filedTaskSteps } from "./work";

export type SlackTaskUpdateKind = "question" | "update" | "response" | "error";

export type SlackTaskPost = {
  kind: "task";
  workspaceId: string;
  teamId: string;
  channelId: string;
  threadTs: string;
  slackUserId: string;
  generation: number;
  member: { userId: string; linkId: string };
  identifier: string;
  url: string | null;
  repository: string | null;
  text: string;
};

const TEXT_CHARS = 2_800;

export function* slackTaskUpdateSteps(
  q: Q,
  update: {
    sessionId: string;
    itemId: string;
    key: string;
    kind: SlackTaskUpdateKind;
    text: string;
  },
  now: number,
): Steps<boolean> {
  const text = update.text.trim();
  const origin = text ? yield* slackSessionOriginSteps(q, update.sessionId) : null;
  const item = origin && (yield* getWorkItemSteps(q, update.itemId));
  if (!origin?.slackUserId || !origin.linkId || item?.sessionKey !== update.sessionId) return false;
  const { workspaceId, teamId, channelId, threadTs, generation, userId, linkId, slackUserId } =
    origin;
  const thread = { workspaceId, teamId, channelId, threadTs, generation };
  const task = yield* filedTaskSteps(q, { ...thread, slackUserId });
  const bound = yield* getWorkItemRepositorySteps(q, item.id);
  const identifier = task?.identifier ?? item.linearIdentifier;
  const url = task?.url ?? null;
  const link = url ? `<${url}|${identifier}>` : identifier;
  const heading =
    update.kind === "question" ? `*Paws asks on ${link}* (answer it in Linear)` : `*${link}*`;
  const payload: SlackTaskPost = {
    kind: "task",
    ...thread,
    slackUserId,
    member: { userId, linkId },
    identifier,
    url,
    repository: bound ? `${bound.owner}/${bound.repo}` : null,
    text: `${heading}\n${text.length > TEXT_CHARS ? `${text.slice(0, TEXT_CHARS)}…` : text}`,
  };
  yield* enqueueOutboxOnceSteps(q, {
    target: "slack",
    op: "chat.postMessage",
    idempotencyKey: `slack:task:${update.key}`,
    payload,
    now,
  });
  return true;
}

export function* slackHandoffSteps(q: Q, sessionId: string): Steps<string> {
  const origin = yield* slackSessionOriginSteps(q, sessionId);
  if (!origin?.context) return "";
  const member = yield* workspaceMemberSteps(q, origin.workspaceId, origin.userId);
  if (!workspaceMemberUsable(member)) return "";
  return `Slack thread context: this task was filed from a Slack channel thread. Below is that thread up to the request, for your understanding only. It is private to Paws: do not quote or copy it into Linear, the pull request, commits, code or any other output. The issue description and acceptance criteria stay the requirements.\n${origin.context}`;
}
