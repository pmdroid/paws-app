import {
  enqueueOutboxOnceSteps,
  getWorkItemSteps,
  slackSessionOriginSteps,
  slackTaskScopeSteps,
  workspaceMemberSteps,
  workspaceMemberUsable,
  type Q,
  type Steps,
} from "../db";
import { isPawsAnswerKind, type StoredQuestion } from "../questions";
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
  repositories: string[];
  text: string;
  itemId: string;
  fence: { sessionId: string; generation: number; stop: boolean };
  questionId?: string;
  paws?: "repository" | "answer";
  progress?: true;
};

const CHOOSE_IN_PAWS = new Set(["repository", "runner-repository"]);

const TEXT_CHARS = 2_800;

export function* slackTaskUpdateSteps(
  q: Q,
  update: {
    sessionId: string;
    itemId: string;
    key: string;
    kind: SlackTaskUpdateKind;
    text: string;
    fence: { generation: number; stop: boolean };
    asked: StoredQuestion | null;
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
  const asked = update.kind === "question" ? update.asked : null;
  const paws = !asked
    ? undefined
    : CHOOSE_IN_PAWS.has(asked.kind)
      ? ("repository" as const)
      : isPawsAnswerKind(asked.kind)
        ? undefined
        : ("answer" as const);
  const identifier = task?.identifier ?? item.linearIdentifier;
  const url = task?.url ?? null;
  const link = url ? `<${url}|${identifier}>` : identifier;
  const heading =
    update.kind === "question"
      ? `*Paws asks on ${link}* (answer by mentioning @Paws in this thread)`
      : `*${link}*`;
  const body = text.replace(/<!--[\s\S]*?-->/g, "").trim();
  const payload: SlackTaskPost = {
    kind: "task",
    ...thread,
    slackUserId,
    member: { userId, linkId },
    identifier,
    url,
    repositories: yield* slackTaskScopeSteps(q, item.id),
    text: paws
      ? ""
      : `${heading}\n${body.length > TEXT_CHARS ? `${body.slice(0, TEXT_CHARS)}…` : body}`,
    itemId: item.id,
    fence: { sessionId: update.sessionId, ...update.fence },
    ...(asked ? { questionId: asked.id } : {}),
    ...(update.kind === "update" ? { progress: true as const } : {}),
    ...(paws ? { paws } : {}),
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
