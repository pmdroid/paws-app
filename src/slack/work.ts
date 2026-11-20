import { randomBytes } from "node:crypto";
import {
  enqueueJobOnceSteps,
  lockSlackStatusSteps,
  readSettingSteps,
  settingsWithPrefixSteps,
  slackIssueKey,
  takeSettingSteps,
  updateSettingSteps,
  workspaceMemberSteps,
  workspaceMemberUsable,
  type Q,
  type Steps,
} from "../db";

export const SLACK_FILE_ACTION = "paws_file";
export const SLACK_DISCARD_ACTION = "paws_discard";
const START = /^start(?:\s+([A-Z][A-Z0-9_]{0,9}))?(?:$|[\s:,.-])/;
const DRAFT_MS = 60 * 60_000;

export type SlackIssueTeam = { id: string; key: string; name: string; private: boolean };

export type SlackWorkTracker = {
  team(key: string, signal: AbortSignal): Promise<SlackIssueTeam | null>;
  issueId(key: string): string;
  file(
    request: { key: string; teamId: string; title: string; description: string },
    signal: AbortSignal,
  ): Promise<{ id: string; identifier: string; url: string | null }>;
};

type Thread = Record<
  "workspaceId" | "teamId" | "channelId" | "threadTs" | "slackUserId",
  string
> & {
  generation: number;
};
type Brief = { title: string; scope: string; acceptance: string[] };
export type Draft = Thread &
  Brief & {
    id: string;
    slot: string;
    userId: string;
    linkId: string;
    mentionTs: string;
    context?: string;
    team: SlackIssueTeam;
    createdAt: number;
    approvedAt?: number;
    attemptedAt?: number;
  };
export type SlackTask = {
  issueId: string;
  identifier: string;
  url: string | null;
  title: string;
  teamId: string;
  filedAt: number;
};

export const slackThreadKey = (t: Thread) =>
  `${t.workspaceId}:${t.teamId}:${t.channelId}:${t.threadTs}`;
export const slackDraftIssueKey = (d: Draft) => `${slackThreadKey(d)}:${d.slot}`;
export const draftKey = (d: Draft) => `slack.draft:${slackDraftIssueKey(d)}`;
const draftPrefix = (t: Thread) => `slack.draft:${slackThreadKey(t)}:`;
const taskKey = (t: Thread) => `slack.task:${slackThreadKey(t)}`;
const parsed = <T>(value: string | null) => (value === null ? null : (JSON.parse(value) as T));
const ISSUE_KEY = /^([A-Za-z][A-Za-z0-9_]*-\d+)\b[\s:,.-]*/;

export const DRAFT_INSTRUCTIONS =
  'You are Paws, preparing a Linear issue from this Slack channel thread. Reply with only a JSON object {"title": string, "scope": string, "acceptance": string[]}: a short title, the implementation scope and constraints, and testable acceptance criteria for the work the thread asks for. Keep it under 2,000 characters. Include only what the work needs: no names, Slack messages, links, ids, secrets or quoted source code.';

export const WORK_NOTICES = {
  team: "Name the Linear team to file the work in, like `@Paws start ABC`.",
  unknown_team: "Paws can't find that Linear team or who can read it, so it filed nothing.",
  not_member: "You aren't a member of that Linear team, so Paws filed nothing.",
  no_linear: "Paws isn't connected to Linear, so it can't file work from Slack.",
  no_draft: "Paws couldn't draft a short enough issue from this thread, so it filed nothing.",
  pending: "Paws is already filing your issue from this thread.",
  discarded: "Discarded. Paws sent nothing to Linear.",
  stale: "That draft is no longer current, so Paws filed nothing.",
  changed: "Who can read that Linear team changed, so Paws filed nothing. Start again.",
};

export function slackStartCommand(question: string): { teamKey: string | null } | null {
  const match = START.exec(question.trim());
  return match ? { teamKey: match[1] ?? null } : null;
}

export function slackBrief(text: string): Brief | null {
  let value: Record<string, unknown> | null = null;
  try {
    value = JSON.parse(/\{[\s\S]*\}/.exec(text)?.[0] ?? "null") as Record<string, unknown> | null;
  } catch {
    return null;
  }
  const title = typeof value?.title === "string" ? value.title.trim() : "";
  const scope = typeof value?.scope === "string" ? value.scope.trim() : "";
  const lines = Array.isArray(value?.acceptance) ? value.acceptance : [];
  const acceptance = lines.flatMap((line) =>
    typeof line === "string" && line.trim() ? [line.trim()] : [],
  );
  return title && scope && acceptance.length ? { title, scope, acceptance } : null;
}

export function slackIssueDescription(brief: Brief): string {
  const criteria = brief.acceptance.map((line) => `- [ ] ${line}`).join("\n");
  return `${brief.scope}\n\n## Acceptance criteria\n\n${criteria}`;
}

export function draftMessage(brief: Brief, team: SlackIssueTeam, id: string) {
  const criteria = brief.acceptance.map((line) => `• ${line}`).join("\n");
  const audience = team.private
    ? `members of the private Linear team ${team.key}, anyone the issue is shared with, and Linear integrations with access`
    : `every member of your Linear workspace (${team.key} is a public team), and Linear integrations with access`;
  const text = `Paws will file this issue in Linear team *${team.key}* (${team.name}) and delegate it to Paws:\n\n*${brief.title}*\n${brief.scope}\n\n*Acceptance criteria*\n${criteria}\n\nWho can read it: ${audience}. Only this title, scope and criteria are sent. To change it, mention \`@Paws start ${team.key}\` with what to change.`;
  const button = (action_id: string, label: string) => ({
    type: "button",
    action_id,
    value: id,
    text: { type: "plain_text", text: label },
  });
  const actions = [
    button(SLACK_FILE_ACTION, "Create issue"),
    button(SLACK_DISCARD_ACTION, "Discard"),
  ];
  const blocks = [
    { type: "section", text: { type: "mrkdwn", text } },
    { type: "actions", elements: actions },
  ];
  return text.length <= 3_000 ? { text, blocks } : null;
}

export function filedNotice(task: Pick<SlackTask, "identifier" | "url">): string {
  const link = task.url ? `<${task.url}|${task.identifier}>` : task.identifier;
  return `${link} is filed from this thread and delegated to Paws. It starts when a runner is free; you can keep talking here meanwhile.`;
}

export function severalWaiting(identifiers: string[]): string {
  return `Several issues are waiting: ${identifiers.join(", ")}. Start your reply with the issue key.`;
}

export function slackIssuePrefix(text: string): { identifier: string; rest: string } | null {
  const match = ISSUE_KEY.exec(text.trim());
  return match
    ? { identifier: match[1]!.toUpperCase(), rest: text.trim().slice(match[0].length) }
    : null;
}

export function filedLine(tasks: SlackTask[], teamIds: readonly string[]): string {
  if (!tasks.length) return "";
  const named = tasks.map((task) =>
    teamIds.includes(task.teamId) ? `${task.identifier} (${task.title})` : task.identifier,
  );
  return ` This thread already filed these Linear issues: ${named.join(", ")}. Don't propose or draft work they already cover.`;
}

export function* filedTasksSteps(q: Q, thread: Thread): Steps<SlackTask[]> {
  const value = parsed<unknown>(yield* readSettingSteps(q, taskKey(thread)));
  return Array.isArray(value) ? (value as SlackTask[]) : [];
}

function* threadDraftsSteps(q: Q, thread: Thread): Steps<{ key: string; draft: Draft }[]> {
  const rows = yield* settingsWithPrefixSteps(q, draftPrefix(thread));
  return rows.flatMap((row) => {
    const draft = parsed<Draft>(row.value);
    return draft ? [{ key: row.key, draft }] : [];
  });
}

function* ownDraftSteps(q: Q, thread: Thread): Steps<Draft | null> {
  const drafts = yield* threadDraftsSteps(q, thread);
  return drafts.find(({ draft }) => draft.slackUserId === thread.slackUserId)?.draft ?? null;
}

export function* filingStartedSteps(q: Q, thread: Thread): Steps<boolean> {
  if ((yield* filedTasksSteps(q, thread)).length) return true;
  return (yield* threadDraftsSteps(q, thread)).some(({ draft }) => !!draft.approvedAt);
}

export function* filingPendingSteps(q: Q, thread: Thread): Steps<boolean> {
  return (yield* threadDraftsSteps(q, thread)).some(({ draft }) => !!draft.approvedAt);
}

export function* approvedIssueKeysSteps(q: Q, thread: Thread): Steps<string[]> {
  const drafts = yield* threadDraftsSteps(q, thread);
  return drafts.flatMap(({ draft }) => (draft.approvedAt ? [slackDraftIssueKey(draft)] : []));
}

export function* startStateSteps(q: Q, thread: Thread): Steps<string | Draft | null> {
  const draft = yield* ownDraftSteps(q, thread);
  if (draft?.attemptedAt) return draft;
  return draft?.approvedAt ? WORK_NOTICES.pending : null;
}

export function* editableDraftSteps(q: Q, thread: Thread, linkId: string, at: number) {
  const draft = yield* ownDraftSteps(q, thread);
  const mine =
    draft?.slackUserId === thread.slackUserId &&
    draft.linkId === linkId &&
    draft.generation === thread.generation;
  return mine && !draft.approvedAt && draft.createdAt + DRAFT_MS > at ? draft : null;
}

export function reviseInstructions(draft: Brief): string {
  const { title, scope, acceptance } = draft;
  return `${DRAFT_INSTRUCTIONS} The member already has this draft; revise it with what their latest message asks and keep the rest: ${JSON.stringify({ title, scope, acceptance })}`;
}

export function* draftThreadSteps(
  q: Q,
  channel: { workspaceId: string; teamId: string; channelId: string },
  draftId: string,
): Steps<string | null> {
  const prefix = `slack.draft:${channel.workspaceId}:${channel.teamId}:${channel.channelId}:`;
  const drafts = (yield* settingsWithPrefixSteps(q, prefix)).map((r) => parsed<Draft>(r.value));
  return drafts.find((d) => d?.id === draftId)?.threadTs ?? null;
}

export function* reviewDraftSteps(q: Q, draft: Draft, team: SlackIssueTeam, at: number) {
  const { approvedAt: _approved, ...rest } = draft;
  const review: Draft = { ...rest, team, createdAt: at };
  yield* updateSettingSteps(q, draftKey(draft), () => JSON.stringify(review), at);
  return review;
}

export function* dropDraftSteps(q: Q, key: string): Steps<void> {
  const draft = parsed<Draft>(yield* readSettingSteps(q, key));
  if (draft && !draft.attemptedAt) yield* takeSettingSteps(q, key);
}

export function* proposeDraftSteps(
  q: Q,
  input: Thread & Brief & { userId: string; linkId: string; mentionTs: string; context: string },
  team: SlackIssueTeam,
  at: number,
): Steps<Draft | null> {
  if ((yield* startStateSteps(q, input)) !== null) return null;
  const current = yield* ownDraftSteps(q, input);
  if (current?.mentionTs === input.mentionTs) return current;
  if (current) yield* takeSettingSteps(q, draftKey(current));
  const id = randomBytes(12).toString("hex");
  const draft: Draft = { ...input, id, slot: id, team, createdAt: at };
  yield* updateSettingSteps(q, draftKey(draft), () => JSON.stringify(draft), at);
  return draft;
}

export function* decideDraftSteps(
  q: Q,
  thread: Thread,
  click: {
    draftId: string;
    linkId: string;
    approve: boolean;
    stopped: (ts: string) => Steps<boolean>;
  },
  fileJob: (draft: Draft) => { queue: string; jobKey: string; payload: unknown },
  at: number,
): Steps<string | null> {
  const drafts = yield* threadDraftsSteps(q, thread);
  const draft = drafts.find((row) => row.draft.id === click.draftId)?.draft;
  const mine =
    draft?.id === click.draftId &&
    draft.slackUserId === thread.slackUserId &&
    draft.linkId === click.linkId &&
    draft.generation === thread.generation;
  if (!mine || draft.approvedAt) return null;
  const stale = (yield* click.stopped(draft.mentionTs)) || draft.createdAt + DRAFT_MS <= at;
  if (stale || !click.approve) {
    const retired = { ...draft, id: randomBytes(12).toString("hex") };
    if (draft.attemptedAt)
      yield* updateSettingSteps(q, draftKey(draft), () => JSON.stringify(retired), at);
    yield* dropDraftSteps(q, draftKey(draft));
    return click.approve ? WORK_NOTICES.stale : WORK_NOTICES.discarded;
  }
  const approved: Draft = { ...draft, approvedAt: at };
  yield* updateSettingSteps(q, draftKey(draft), () => JSON.stringify(approved), at);
  yield* enqueueJobOnceSteps(q, { ...fileJob(approved), now: at });
  return "";
}

export function* fileReadySteps(
  q: Q,
  key: string,
  member: (draft: Draft) => Steps<boolean>,
  origin?: { issueId: string; at: number },
): Steps<Draft | null> {
  const draft = parsed<Draft>(yield* readSettingSteps(q, key));
  if (!draft?.approvedAt) return null;
  const user = yield* workspaceMemberSteps(q, draft.workspaceId, draft.userId);
  const allowed =
    (yield* member(draft)) && workspaceMemberUsable(user) && user.teamIds.includes(draft.team.id);
  if (!allowed) {
    yield* dropDraftSteps(q, key);
    return null;
  }
  if (origin) {
    const { workspaceId, teamId, channelId, threadTs, generation } = draft;
    const thread = { workspaceId, teamId, channelId, threadTs, generation };
    const { userId, slackUserId, linkId, context } = draft;
    const owner = { ...thread, ownerId: user.linearUserId, userId, slackUserId, linkId, context };
    const save = (k: string, v: unknown) =>
      updateSettingSteps(q, k, () => JSON.stringify(v), origin.at);
    yield* save(slackIssueKey(origin.issueId), owner);
    yield* save(key, { ...draft, attemptedAt: draft.attemptedAt ?? origin.at });
  }
  return draft;
}

export function* recordFiledSteps(q: Q, draft: Draft, task: SlackTask, at: number): Steps<void> {
  yield* lockSlackStatusSteps(q, taskKey(draft));
  const tasks = (yield* filedTasksSteps(q, draft)).filter((t) => t.issueId !== task.issueId);
  yield* updateSettingSteps(q, taskKey(draft), () => JSON.stringify([...tasks, task]), at);
  yield* takeSettingSteps(q, draftKey(draft));
}
