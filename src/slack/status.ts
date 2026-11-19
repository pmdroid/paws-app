import {
  enqueueOutboxOnceSteps,
  getWorkItemSteps,
  readSettingSteps,
  settingsWithPrefixSteps,
  slackIssueTaskSteps,
  slackSessionOriginSteps,
  updateSettingSteps,
  type Q,
  type Steps,
} from "../db";

export const SLACK_STATUS_JOB = "slack.status";
export const SLACK_STATUS_EVERY_MS = 60_000;
export const SLACK_STATUS_REFRESH_MS = 50 * 60_000;
export const SLACK_STREAM_CLOSE_MS = 9 * 60_000;
export const SLACK_STREAM_LIFETIME_MS = 10 * 60_000;
const TURN_MS = 10 * 60_000;
const STREAM_CHUNK = 1_000;

export type SlackStatus = "processing" | "active" | "suspended" | "closed";

type Thread = {
  workspaceId: string;
  teamId: string;
  channelId: string;
  threadTs: string;
  slackUserId: string;
  generation: number;
};

export type SlackStatusPost = Thread & {
  kind: "status";
  member: { userId: string; linkId: string };
  status: SlackStatus;
  at: number;
  itemId?: string;
};

type Mark = { status: SlackStatus; at: number; generation: number; turnAt?: number };

const markKey = (t: Thread) =>
  `slack.status:${t.workspaceId}:${t.teamId}:${t.channelId}:${t.threadTs}`;

const WORKING = new Set(["running", "verifying", "recovering"]);
const TERMINAL = new Set(["completed", "merged", "cancelled", "failed"]);

export function slackStatusFor(state: string): SlackStatus {
  if (WORKING.has(state)) return "processing";
  if (state === "paused") return "suspended";
  return TERMINAL.has(state) ? "closed" : "active";
}

function* markSteps(q: Q, thread: Thread): Steps<Mark | null> {
  const value = yield* readSettingSteps(q, markKey(thread));
  const mark = value ? (JSON.parse(value) as Mark) : null;
  return mark?.generation === thread.generation ? mark : null;
}

export function* slackStatusSteps(
  q: Q,
  input: {
    thread: Thread;
    member: { userId: string; linkId: string };
    status: SlackStatus;
    itemId?: string;
    turn?: boolean;
  },
  now: number,
): Steps<boolean> {
  const { thread, status } = input;
  const prior = yield* markSteps(q, thread);
  const stale = status === "processing" && now - (prior?.at ?? 0) >= SLACK_STATUS_REFRESH_MS;
  const same = prior?.status === status && !stale;
  const turnAt = input.turn ? now : undefined;
  if (same && !input.turn && prior.turnAt === undefined) return false;
  const mark: Mark = { status, at: same ? prior.at : now, generation: thread.generation };
  const stored = JSON.stringify(turnAt === undefined ? mark : { ...mark, turnAt });
  yield* updateSettingSteps(q, markKey(thread), () => stored, now);
  if (same) return false;
  const payload: SlackStatusPost = {
    ...thread,
    kind: "status",
    member: input.member,
    status,
    at: now,
    ...(input.itemId ? { itemId: input.itemId } : {}),
  };
  yield* enqueueOutboxOnceSteps(q, {
    target: "slack",
    op: "agents.sessions.setStatus",
    idempotencyKey: `slack:status:${markKey(thread)}:${thread.generation}:${now}:${status}`,
    payload,
    now,
  });
  return true;
}

export function* slackStatusCurrentSteps(q: Q, post: SlackStatusPost): Steps<boolean> {
  const mark = yield* markSteps(q, post);
  return mark?.at === post.at && mark.status === post.status;
}

export function* slackThreadStatusSteps(q: Q, thread: Thread): Steps<SlackStatus> {
  return (yield* markSteps(q, thread))?.status ?? "active";
}

export function* slackTaskStatusSteps(
  q: Q,
  issueId: string,
): Steps<{ status: SlackStatus; itemId: string } | null> {
  const task = yield* slackIssueTaskSteps(q, issueId);
  const item = task ? yield* getWorkItemSteps(q, task.itemId) : null;
  return item ? { status: slackStatusFor(item.state), itemId: item.id } : null;
}

export function* reconcileSlackStatusSteps(q: Q, now: number): Steps<number> {
  let queued = 0;
  for (const { key } of yield* settingsWithPrefixSteps(q, "slack.issue:")) {
    const task = yield* slackIssueTaskSteps(q, key.slice("slack.issue:".length));
    const origin = task ? yield* slackSessionOriginSteps(q, task.sessionKey) : null;
    const item = task && origin ? yield* getWorkItemSteps(q, task.itemId) : null;
    if (!task || !origin?.slackUserId || !origin.linkId || !item) continue;
    if (item.sessionKey !== task.sessionKey) continue;
    const thread: Thread = { ...origin, slackUserId: origin.slackUserId };
    const prior = yield* markSteps(q, thread);
    if (prior?.turnAt !== undefined && now - prior.turnAt < TURN_MS) continue;
    const member = { userId: origin.userId, linkId: origin.linkId };
    const status = slackStatusFor(item.state);
    if (yield* slackStatusSteps(q, { thread, member, status, itemId: item.id }, now)) queued++;
  }
  return queued;
}

export type SlackStream = { ts: string; startedAt: number; sent: number; writing?: true };

export function slackStreamState(externalId: string | null): SlackStream | null {
  const match = /^stream:([0-9.]+):(\d+):(\d+)(:w)?$/.exec(externalId ?? "");
  if (!match) return null;
  const stream = { ts: match[1]!, startedAt: Number(match[2]), sent: Number(match[3]) };
  return match[4] ? { ...stream, writing: true } : stream;
}

export const slackStreamId = (s: SlackStream) =>
  `stream:${s.ts}:${s.startedAt}:${s.sent}${s.writing ? ":w" : ""}`;

export function slackStreamChunks(text: string): string[] {
  const chunks: string[] = [];
  for (let at = 0; at < text.length; at += STREAM_CHUNK)
    chunks.push(text.slice(at, at + STREAM_CHUNK));
  return chunks.length ? chunks : [""];
}
