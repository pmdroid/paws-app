import {
  enqueueOutboxOnceSteps,
  getWorkItemSteps,
  linearSessionGenerationSteps,
  lockSlackStatusSteps,
  readSettingSteps,
  settingsWithPrefixSteps,
  slackIssueTaskSteps,
  slackSessionOriginSteps,
  updateSettingSteps,
  type Q,
  type Steps,
} from "../db";
import { filedTasksSteps } from "./work";
import { slackWorkMessageSteps } from "./work-message";

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

export type SlackTurn = { ts: string; slackUserId: string; event: string; at: number };

type Mark = {
  status: SlackStatus;
  at: number;
  generation: number;
  turnAt?: number;
  turns?: SlackTurn[];
};

const liveTurns = (mark: Mark | null, now: number) =>
  (mark?.turns ?? []).filter((turn) => now - turn.at < TURN_MS);

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
    change?: Omit<SlackTurn, "at"> & { open: boolean };
  },
  now: number,
): Steps<boolean> {
  const { thread, change } = input;
  yield* lockSlackStatusSteps(q, markKey(thread));
  const prior = yield* markSteps(q, thread);
  const live = liveTurns(prior, now);
  const held = live.find((turn) => turn.ts === change?.ts);
  const kept = live.filter((turn) => turn.ts !== change?.ts);
  const turns = change?.open
    ? [
        ...kept,
        held ?? { ts: change.ts, slackUserId: change.slackUserId, event: change.event, at: now },
      ]
    : kept;
  const status = turns.length ? "processing" : input.status;
  const stale = status === "processing" && now - (prior?.at ?? 0) >= SLACK_STATUS_REFRESH_MS;
  const same = prior?.status === status && !stale;
  const turnAt = input.turn ? now : change ? prior?.turnAt : undefined;
  const unchanged = JSON.stringify(turns) === JSON.stringify(prior?.turns ?? []);
  if (same && turnAt === prior.turnAt && unchanged) return false;
  const mark: Mark = {
    status,
    at: same ? prior.at : now,
    generation: thread.generation,
    ...(turnAt === undefined ? {} : { turnAt }),
    ...(turns.length ? { turns } : {}),
  };
  const stored = JSON.stringify(mark);
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

export function* slackTurnsSteps(q: Q, thread: Thread, now: number): Steps<SlackTurn[]> {
  return liveTurns(yield* markSteps(q, thread), now);
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

const RANK: Record<SlackStatus, number> = { processing: 0, active: 1, suspended: 2, closed: 3 };

export function* slackThreadWorkStatusSteps(
  q: Q,
  thread: Thread,
): Steps<{ status: SlackStatus; itemId: string } | null> {
  let best: { status: SlackStatus; itemId: string } | null = null;
  for (const task of yield* filedTasksSteps(q, thread)) {
    const found = yield* slackTaskStatusSteps(q, task.issueId);
    if (found && (!best || RANK[found.status] < RANK[best.status])) best = found;
  }
  return best;
}

export function* reconcileSlackStatusSteps(q: Q, now: number): Steps<number> {
  let queued = 0;
  for (const { key } of yield* settingsWithPrefixSteps(q, "slack.issue:")) {
    const issueId = key.slice("slack.issue:".length);
    const task = yield* slackIssueTaskSteps(q, issueId);
    const origin = task ? yield* slackSessionOriginSteps(q, task.sessionKey) : null;
    const item = task && origin ? yield* getWorkItemSteps(q, task.itemId) : null;
    if (!task || !origin?.slackUserId || !origin.linkId || !item) continue;
    if (item.sessionKey !== task.sessionKey) continue;
    const thread: Thread = { ...origin, slackUserId: origin.slackUserId };
    const member = { userId: origin.userId, linkId: origin.linkId };
    const { workspaceId, teamId, channelId, threadTs, generation } = origin;
    const generationNow = yield* linearSessionGenerationSteps(q, task.sessionKey);
    const fence = { sessionId: task.sessionKey, generation: generationNow, stop: false };
    const shown = {
      issueId,
      thread: { workspaceId, teamId, channelId, threadTs, generation },
      slackUserId: origin.slackUserId,
      member,
      item,
      key: `${issueId}:${item.state}:${now}`,
      fence,
    };
    if (yield* slackWorkMessageSteps(q, shown, now)) queued++;
    const prior = yield* markSteps(q, thread);
    if (prior?.turnAt !== undefined && now - prior.turnAt < TURN_MS) continue;
    if (liveTurns(prior, now).length) continue;
    const work = yield* slackThreadWorkStatusSteps(q, thread);
    if (work && work.itemId !== item.id) continue;
    const status = work?.status ?? slackStatusFor(item.state);
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
