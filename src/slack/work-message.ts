import type { WorkItemState } from "../core";
import {
  enqueueOutboxOnceSteps,
  getItemPullRequestSteps,
  lockSlackStatusSteps,
  readSettingSteps,
  slackTaskScopeSteps,
  updateSettingSteps,
  type Q,
  type Steps,
} from "../db";
import type { SlackTaskPost } from "./delivery";
import { filedTasksSteps } from "./work";

const LATEST_CHARS = 500;

const STATE_LINES: Record<WorkItemState, string> = {
  planning: "Waiting for a runner",
  queued: "Waiting for a runner",
  running: "Working",
  recovering: "Working",
  verifying: "Checking the work",
  awaiting_input: "Waiting for an answer",
  paused: "Paused",
  merge_queue: "In the merge queue",
  manual: "Handed to a person",
  merged: "Merged",
  completed: "Done",
  failed: "Failed",
  cancelled: "Stopped",
};

type WorkMessage = { ts?: string; state?: string; update?: string };

const workKey = (issueId: string) => `slack.work:${issueId}`;

function* workMessageSteps(q: Q, issueId: string): Steps<WorkMessage | null> {
  const value = yield* readSettingSteps(q, workKey(issueId));
  return value ? (JSON.parse(value) as WorkMessage) : null;
}

export function* slackWorkTsSteps(q: Q, issueId: string): Steps<string | null> {
  return (yield* workMessageSteps(q, issueId))?.ts ?? null;
}

export function* saveSlackWorkTsSteps(q: Q, issueId: string, ts: string, now: number) {
  yield* lockSlackStatusSteps(q, workKey(issueId));
  const work = yield* workMessageSteps(q, issueId);
  if (work?.ts) return;
  const stored = JSON.stringify({ ...work, ts });
  yield* updateSettingSteps(q, workKey(issueId), () => stored, now);
}

export function* slackWorkMessageSteps(
  q: Q,
  input: {
    issueId: string;
    thread: Pick<SlackTaskPost, "workspaceId" | "teamId" | "channelId" | "threadTs" | "generation">;
    slackUserId: string;
    member: { userId: string; linkId: string };
    item: { id: string; state: WorkItemState; linearIdentifier: string; title: string };
    key: string;
    fence: { sessionId: string; generation: number; stop: boolean };
    update?: string;
    sourceId?: number;
  },
  now: number,
): Steps<boolean> {
  const { issueId, thread, item } = input;
  yield* lockSlackStatusSteps(q, workKey(issueId));
  const work = yield* workMessageSteps(q, issueId);
  const state = STATE_LINES[item.state];
  if (input.update === undefined && work?.state === state) return false;
  const update =
    input.update === undefined
      ? work?.update
      : input.update.length > LATEST_CHARS
        ? `${input.update.slice(0, LATEST_CHARS)}…`
        : input.update;
  const tasks = yield* filedTasksSteps(q, { ...thread, slackUserId: input.slackUserId });
  const task = tasks.find((filed) => filed.issueId === issueId);
  const identifier = task?.identifier ?? item.linearIdentifier;
  const url = task?.url ?? null;
  const link = url ? `<${url}|${identifier}>` : identifier;
  const pull = (yield* getItemPullRequestSteps(q, item.id))?.pullUrl;
  const text = [
    `*${link}* ${task?.title ?? item.title}`,
    `Now: ${state}`,
    ...(update ? [`Latest: ${update}`] : []),
    ...(pull ? [`Pull request: ${pull}`] : []),
  ].join("\n");
  const payload: SlackTaskPost = {
    kind: "task",
    ...thread,
    slackUserId: input.slackUserId,
    member: input.member,
    identifier,
    url,
    repositories: yield* slackTaskScopeSteps(q, item.id),
    text,
    itemId: item.id,
    fence: input.fence,
    work: issueId,
    ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
  };
  yield* enqueueOutboxOnceSteps(q, {
    target: "slack",
    op: work ? "chat.update" : "chat.postMessage",
    idempotencyKey: `slack:work:${input.key}`,
    payload,
    now,
  });
  const stored = JSON.stringify({ ...work, state, ...(update ? { update } : {}) });
  yield* updateSettingSteps(q, workKey(issueId), () => stored, now);
  return true;
}
