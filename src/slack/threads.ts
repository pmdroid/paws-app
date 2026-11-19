import { createHash, randomBytes } from "node:crypto";
import {
  auditWorkspaceAccessSteps,
  emitJobReady,
  enqueueJobOnceSteps,
  enqueueOutboxOnceSteps,
  inboxEventByKeySteps,
  insertInboxEventSteps,
  markInboxEventHandledSteps,
  readSettingSteps,
  recordSlackConversationSteps,
  settingsWithPrefixSteps,
  settleSlackOutboxSteps,
  slackConversationSteps,
  slackOutboxExistsSteps,
  slackSendingSteps,
  slackThreadContextSteps,
  stopSlackConversationSteps,
  takeSettingSteps,
  updateSettingSteps,
  workspaceMemberSteps,
  workspaceMemberUsable,
  type Db,
  type Job,
  type OutboxRow,
  type Q,
  type SlackSendOutcome,
  type Steps,
} from "../db";
import { journal } from "../journal";
import type { ContextAccess } from "../project-context";
import { isWorkspaceAdmin, requestWorkspaceSessionSteps, workspaceTokenHash } from "../workspace";
import {
  SlackApiError,
  SlackNotSentError,
  slackCaller,
  slackChannelAudience,
  type SlackCall,
} from "./api";
import {
  createSlackChannelMemory,
  slackMemoryCommand,
  slackMemoryScopeId,
  type SlackMemoryOptions,
} from "./memory";
import {
  createSlackAuth,
  installedSlackTokenSteps,
  slackInstallationRevisionSteps,
  slackTeamOwnerSteps,
  type SlackFetch,
} from "./oauth";
import type { SlackInteraction, SlackMention } from "./webhook";

export const SLACK_THREAD_JOB = "slack.thread";
export const SLACK_LINK_PATH = "/oauth/slack/link";
const LINK_CODE = /\blink\s+([A-Z2-7]{4}-[A-Z2-7]{4})\b/i;
const SLACK_ID = /^[A-Z0-9]{2,32}$/;
const STOP = /^stop[.!]?$/i;
const UNLINK = /^unlink[.!]?$/i;
const STOP_POLL_MS = 1_000;
const SLACK_STOP_ACTION = "paws_stop";

export type SlackReplyScope = {
  requestId: string;
  teamId: string;
  channelId: string;
  threadTs: string;
  memberUserId: string;
  installGeneration: number;
};

type ReplyLane<Profile> = {
  reply(request: {
    workspaceId: string;
    scope: SlackReplyScope;
    profile: Profile;
    prompt: string;
    signal: AbortSignal;
  }): Promise<{ status: string; text?: string }>;
};

type Place = {
  workspaceId: string;
  teamId: string;
  channelId: string;
  threadTs: string;
  slackUserId: string;
  generation: number;
};
type Reply = Place & {
  kind: "reply";
  userId: string;
  linkId?: string;
  mentionTs: string;
  question: string;
  text: string;
  contexts?: MemoryRef[];
};
type MemoryRef = { key: string; version: number };
type Notice = Place & {
  kind: "notice";
  text: string;
  member?: { userId: string; linkId: string };
  listing?: boolean;
};
type Payload = Reply | Notice;

const refId = (ref: MemoryRef) => `${ref.key}@${ref.version}`;

function uniqueRefs(refs: readonly MemoryRef[]): MemoryRef[] {
  return [...new Map(refs.map((ref) => [refId(ref), ref])).values()];
}
type Bound = { teamId: string; channelId: string; generation: number };
type Linked = Bound & { workspaceId: string; userId: string; id?: string };
type Code = Bound & { hash: string; userId: string; slackUserId: string; expiresAt: number };
type Held = Bound & { dedupeKey: string; expiresAt: number };
type Gate =
  | { kind: "ignore" }
  | { kind: "guide"; setup: boolean }
  | { kind: "member"; userId: string; linkId: string };

const channelKey = (workspaceId: string) => `slack.channel:${workspaceId}`;
const memberKey = (teamId: string, slackUserId: string) => `slack.member:${teamId}:${slackUserId}`;
const codePrefix = (workspaceId: string) => `slack.link:${workspaceId}:`;
const unlinkedKey = (workspaceId: string, teamId: string, slackUserId: string) =>
  `slack.unlinked:${workspaceId}:${teamId}:${slackUserId}`;
const unlinkedUserKey = (workspaceId: string, userId: string) =>
  `slack.unlinked-user:${workspaceId}:${userId}`;
const heldKey = (place: Place) =>
  `slack.held:${place.workspaceId}:${place.teamId}:${place.slackUserId}`;
const LINK_MS = 10 * 60_000;
const parsed = <T>(value: string | null) => (value === null ? null : (JSON.parse(value) as T));
const same = (bound: Bound | null, place: Bound) =>
  bound?.teamId === place.teamId &&
  bound.channelId === place.channelId &&
  bound.generation === place.generation;

const NOTICES = {
  linked: "Linked. Mention @Paws in this thread to ask it something.",
  released: "Linked. Paws is answering the question you asked before linking, in its thread.",
  already_linked:
    "That Slack account or Paws account is already linked to another account here. Paws doesn't move links.",
  expired: "That code has expired, was already used, or isn't for you in this channel.",
  admin_required: "The first person to link must be a Paws workspace admin.",
  other_channel: "Paws already answers in another channel of this workspace.",
  stopped: "Stopped. Paws won't answer your earlier mentions in this thread.",
  memory_changed:
    "Paws's channel memory or your access changed while it was answering, so it didn't post that answer. Mention @Paws again to ask.",
  unlinked: "Unlinked. Paws no longer answers this Slack account; mention @Paws to link it again.",
};

const tsValue = (ts: string) => BigInt(ts.replace(".", ""));
const threadOf = (place: Place) => ({ ...place, installGeneration: place.generation });

function* stoppedSteps(q: Q, place: Place, ts: string): Steps<boolean> {
  const conversation = yield* slackConversationSteps(q, threadOf(place));
  const stoppedTs = conversation?.stoppedTs;
  return !!stoppedTs && tsValue(ts) <= tsValue(stoppedTs);
}

function* installationSteps(q: Q, home: string, teamId: string) {
  const team = yield* slackTeamOwnerSteps(q, home, teamId);
  const install = team.owner && (yield* installedSlackTokenSteps(q, home, team.owner.value));
  if (!install || install.teamId !== teamId) return null;
  const fallback = team.owner!.updatedAt;
  const generation = yield* slackInstallationRevisionSteps(q, install.workspaceId, fallback);
  return { ...install, generation };
}

function* gateSteps(q: Q, home: string, place: Place): Steps<Gate> {
  const install = yield* installationSteps(q, home, place.teamId);
  if (install?.workspaceId !== place.workspaceId || install.generation !== place.generation)
    return { kind: "ignore" };
  const channel = parsed<Bound>(yield* readSettingSteps(q, channelKey(place.workspaceId)));
  const admitted = channel?.generation === place.generation;
  if (admitted && !same(channel, place)) return { kind: "ignore" };
  const link = parsed<Linked>(
    yield* readSettingSteps(q, memberKey(place.teamId, place.slackUserId)),
  );
  if (!admitted || link?.workspaceId !== place.workspaceId || !same(link, place))
    return { kind: "guide", setup: !admitted };
  const member = yield* workspaceMemberSteps(q, place.workspaceId, link.userId);
  return workspaceMemberUsable(member)
    ? { kind: "member", userId: link.userId, linkId: link.id ?? "" }
    : { kind: "ignore" };
}

export type SlackLink = Linked & { slackUserId: string };

export function* slackLinksSteps(q: Q, workspaceId: string): Steps<SlackLink[]> {
  const rows = yield* settingsWithPrefixSteps(q, "slack.member:");
  return rows.flatMap((row) => {
    const link = parsed<Linked>(row.value);
    const slackUserId = row.key.split(":")[2];
    return link?.workspaceId === workspaceId && slackUserId ? [{ ...link, slackUserId }] : [];
  });
}

export function* currentSlackLinksSteps(
  q: Q,
  home: string,
  workspaceId: string,
): Steps<SlackLink[]> {
  const install = yield* installedSlackTokenSteps(q, home, workspaceId);
  if (!install) return [];
  const current = yield* installationSteps(q, home, install.teamId);
  if (current?.workspaceId !== workspaceId) return [];
  const channel = parsed<Bound>(yield* readSettingSteps(q, channelKey(workspaceId)));
  return (yield* slackLinksSteps(q, workspaceId)).filter(
    (link) =>
      link.teamId === current.teamId &&
      link.generation === current.generation &&
      same(channel, link),
  );
}

export function slackContextAccess(store: Db, home: string): ContextAccess {
  return {
    currentAccess: (requester) =>
      store.run(function* (q) {
        const { workspaceId, userId } = requester;
        const links = yield* currentSlackLinksSteps(q, home, workspaceId);
        const link = links.find((candidate) => candidate.userId === userId);
        if (!link) return null;
        const member = yield* workspaceMemberSteps(q, workspaceId, userId);
        if (!workspaceMemberUsable(member)) return null;
        const channelIds = [slackMemoryScopeId(link)];
        return { userId, teamIds: [], repositories: [], channelIds };
      }),
  };
}

export function* unlinkSlackMemberSteps(
  q: Q,
  input: {
    workspaceId: string;
    userId?: string;
    slackUserId?: string;
    actorId: string;
    action: "slack.member_unlinked" | "slack.member_revoked";
    now: number;
  },
): Steps<number> {
  const { workspaceId } = input;
  let removed = 0;
  for (const link of yield* slackLinksSteps(q, workspaceId)) {
    if (input.userId !== undefined && link.userId !== input.userId) continue;
    if (input.slackUserId !== undefined && link.slackUserId !== input.slackUserId) continue;
    if ((yield* takeSettingSteps(q, memberKey(link.teamId, link.slackUserId))) === null) continue;
    yield* takeSettingSteps(q, `slack.held:${workspaceId}:${link.teamId}:${link.slackUserId}`);
    yield* takeSettingSteps(q, `${codePrefix(workspaceId)}${link.userId}`);
    const fence = unlinkedKey(workspaceId, link.teamId, link.slackUserId);
    yield* updateSettingSteps(q, fence, () => String(input.now), input.now);
    const userFence = unlinkedUserKey(workspaceId, link.userId);
    yield* updateSettingSteps(q, userFence, () => String(input.now), input.now);
    yield* auditWorkspaceAccessSteps(q, {
      workspaceId,
      userId: input.actorId,
      action: input.action,
      subject: `slack:${link.teamId}:${link.slackUserId}`,
      now: input.now,
    });
    removed++;
  }
  return removed;
}

export function* slackReplyAllowedSteps(
  q: Q,
  home: string,
  input: {
    workspaceId: string;
    scope: Omit<SlackReplyScope, "requestId" | "threadTs">;
    issuedAt?: number;
  },
): Steps<boolean> {
  const { workspaceId, scope } = input;
  const unlinkedAt = yield* readSettingSteps(q, unlinkedUserKey(workspaceId, scope.memberUserId));
  if (unlinkedAt !== null && (input.issuedAt ?? 0) <= Number(unlinkedAt)) return false;
  const place = { ...scope, generation: scope.installGeneration };
  const install = yield* installationSteps(q, home, scope.teamId);
  if (install?.workspaceId !== workspaceId || install.generation !== place.generation) return false;
  if (!same(parsed<Bound>(yield* readSettingSteps(q, channelKey(workspaceId))), place))
    return false;
  const links = yield* settingsWithPrefixSteps(q, `slack.member:${scope.teamId}:`);
  const linked = links.some((row) => {
    const link = parsed<Linked>(row.value);
    return (
      link?.workspaceId === workspaceId && link.userId === scope.memberUserId && same(link, place)
    );
  });
  const member = yield* workspaceMemberSteps(q, workspaceId, scope.memberUserId);
  return linked && workspaceMemberUsable(member);
}

function* stopSteps(
  q: Q,
  home: string,
  place: Place,
  conversationId: string,
  ts: string,
  at: number,
): Steps<boolean> {
  const gate = yield* gateSteps(q, home, place);
  if (gate.kind !== "member") return false;
  const { slackUserId } = place;
  yield* stopSlackConversationSteps(q, { id: conversationId, ts, slackUserId }, at);
  const payload: Payload = { ...place, kind: "notice", text: NOTICES.stopped };
  yield* enqueueOutboxOnceSteps(q, {
    target: "slack",
    op: "chat.postEphemeral",
    idempotencyKey: `slack:notice:stop:${conversationId}:${ts}`,
    payload,
    now: at,
  });
  return true;
}

export async function acceptSlackInteraction(
  store: Db,
  home: string,
  interaction: SlackInteraction,
  at = Date.now(),
): Promise<void> {
  const { teamId, channelId, threadTs, messageTs, actionId, value, slackUserId } = interaction;
  const intent = [teamId, channelId, threadTs, messageTs, actionId, value];
  await store.transaction(function* (q) {
    const install = yield* installationSteps(q, home, teamId);
    if (!install || (install.appId && install.appId !== interaction.appId)) return;
    const { workspaceId, generation } = install;
    const place: Place = { workspaceId, teamId, channelId, threadTs, slackUserId, generation };
    const conversation = yield* slackConversationSteps(q, threadOf(place));
    const member = conversation && (yield* gateSteps(q, home, place)).kind === "member";
    const key = JSON.stringify(member ? intent : [...intent, slackUserId]);
    const dedupeKey = `slack:action:${createHash("sha256").update(key).digest("hex")}`;
    const inserted = yield* insertInboxEventSteps(q, {
      dedupeKey,
      deliveryId: null,
      source: "webhook",
      action: "other",
      sessionId: null,
      issueId: null,
      activityId: null,
      body: null,
      signal: null,
      updatedAtMs: at,
      payload: JSON.stringify({
        type: "SlackInteraction",
        workspaceId,
        generation,
        conversationId: conversation?.id ?? null,
        interaction,
      }),
      receivedAt: at,
    });
    if (!inserted) return;
    yield* markInboxEventHandledSteps(q, dedupeKey);
    if (member && actionId === SLACK_STOP_ACTION)
      yield* stopSteps(q, home, place, conversation.id, interaction.actionTs, at);
  });
}

export async function acceptSlackMention(
  store: Db,
  home: string,
  mention: SlackMention,
  at = Date.now(),
): Promise<void> {
  if (mention.externallyShared) return;
  const dedupeKey = `slack:${mention.teamId}:${mention.eventId}`;
  const queued = await store.transaction(function* (q) {
    const install = yield* installationSteps(q, home, mention.teamId);
    if (!install || !mention.text.includes(`<@${install.botUserId}>`)) return false;
    if (mention.appId && install.appId && mention.appId !== install.appId) return false;
    const { workspaceId, generation } = install;
    const { teamId, channelId, threadTs, slackUserId, eventId } = mention;
    const place: Place = { workspaceId, teamId, channelId, threadTs, slackUserId, generation };
    const conversation = yield* recordSlackConversationSteps(
      q,
      { ...threadOf(place), appId: mention.appId ?? install.appId ?? null, slackUserId, eventId },
      at,
    );
    const inserted = yield* insertInboxEventSteps(q, {
      dedupeKey,
      deliveryId: null,
      source: "webhook",
      action: "other",
      sessionId: null,
      issueId: null,
      activityId: null,
      body: null,
      signal: null,
      updatedAtMs: at,
      payload: JSON.stringify({
        type: "SlackMention",
        workspaceId,
        generation,
        conversationId: conversation.id,
        mention,
      }),
      receivedAt: at,
    });
    if (!inserted) return false;
    yield* markInboxEventHandledSteps(q, dedupeKey);
    if (yield* stoppedSteps(q, place, mention.ts)) return false;
    const command = mention.text.replace(/<@[A-Z0-9]+>/g, "").trim();
    if (STOP.test(command) && (yield* stopSteps(q, home, place, conversation.id, mention.ts, at)))
      return false;
    const gate = UNLINK.test(command) ? yield* gateSteps(q, home, place) : null;
    if (gate?.kind === "member") {
      const actor = { userId: gate.userId, actorId: gate.userId, slackUserId };
      const action = "slack.member_unlinked" as const;
      yield* unlinkSlackMemberSteps(q, { workspaceId, ...actor, action, now: at });
      const payload: Payload = { ...place, kind: "notice", text: NOTICES.unlinked };
      yield* enqueueOutboxOnceSteps(q, {
        target: "slack",
        op: "chat.postEphemeral",
        idempotencyKey: `slack:notice:${dedupeKey}`,
        payload,
        now: at,
      });
      return false;
    }
    const job = { queue: SLACK_THREAD_JOB, jobKey: dedupeKey, payload: { dedupeKey }, now: at };
    return (yield* enqueueJobOnceSteps(q, job)).inserted;
  });
  if (queued) emitJobReady(store);
}

export function createSlackThreads<Profile>(options: {
  store: Db;
  home: string;
  env: Record<string, string | undefined>;
  origin: string;
  replies: () => Promise<ReplyLane<Profile> | null>;
  profile: () => Profile;
  fetch?: SlackFetch;
  now?: () => number;
  memory?: SlackMemoryOptions;
}) {
  const { store, home, env } = options;
  const memory = createSlackChannelMemory({
    ...options.memory,
    store,
    access: slackContextAccess(store, home),
  });
  const now = options.now ?? Date.now;
  const origin = new URL(options.origin).origin;
  const slackFetch = options.fetch ?? fetch;

  async function slackFor(workspaceId: string): Promise<SlackCall> {
    const auth = createSlackAuth({ home, db: store, fetch: slackFetch, env, workspaceId });
    return slackCaller(slackFetch, await auth.ensureFresh());
  }

  function notice(place: Place, key: string, text: string, extra: Partial<Notice> = {}) {
    const payload: Payload = { ...place, kind: "notice", text, ...extra };
    const row = { target: "slack" as const, op: "chat.postEphemeral", payload, now: now() };
    return store.transaction((q) =>
      enqueueOutboxOnceSteps(q, { ...row, idempotencyKey: `slack:notice:${key}` }),
    );
  }

  function claim(place: Place, code: string) {
    return store.transaction(function* (q): Steps<keyof typeof NOTICES> {
      const hash = workspaceTokenHash(code.toUpperCase());
      const rows = yield* settingsWithPrefixSteps(q, codePrefix(place.workspaceId));
      const row = rows.find((candidate) => parsed<Code>(candidate.value)?.hash === hash);
      const issued = row && parsed<Code>(yield* takeSettingSteps(q, row.key));
      if (!issued || issued.expiresAt <= now() || issued.slackUserId !== place.slackUserId)
        return "expired";
      const member = yield* workspaceMemberSteps(q, place.workspaceId, issued.userId);
      if (!same(issued, place) || !workspaceMemberUsable(member)) return "expired";
      const bound = {
        teamId: place.teamId,
        channelId: place.channelId,
        generation: place.generation,
      };
      const audit = (action: string, subject: string) =>
        auditWorkspaceAccessSteps(q, {
          ...place,
          userId: issued.userId,
          action,
          subject,
          now: now(),
        });
      const channel = parsed<Bound>(yield* readSettingSteps(q, channelKey(place.workspaceId)));
      if (channel?.generation === place.generation) {
        if (!same(channel, place)) return "other_channel";
      } else {
        if (!isWorkspaceAdmin(member.role)) return "admin_required";
        yield* updateSettingSteps(q, channelKey(place.workspaceId), () => JSON.stringify(bound));
        yield* audit("slack.channel_admitted", `slack:${place.teamId}:${place.channelId}`);
      }
      const linked: Linked = {
        ...bound,
        workspaceId: place.workspaceId,
        userId: issued.userId,
        id: randomBytes(12).toString("hex"),
      };
      const key = memberKey(place.teamId, place.slackUserId);
      const links = yield* settingsWithPrefixSteps(q, `slack.member:${place.teamId}:`);
      const taken = links.some((entry) => {
        const link = parsed<Linked>(entry.value);
        if (link?.workspaceId !== place.workspaceId || !same(link, place)) return false;
        return entry.key === key ? link.userId !== issued.userId : link.userId === issued.userId;
      });
      if (taken) return "already_linked";
      yield* updateSettingSteps(q, key, () => JSON.stringify(linked));
      yield* audit("slack.member_linked", `slack:${place.teamId}:${place.slackUserId}`);
      const held = parsed<Held>(yield* takeSettingSteps(q, heldKey(place)));
      if (!held || !same(held, place) || held.expiresAt <= now()) return "linked";
      const job = { queue: SLACK_THREAD_JOB, payload: { dedupeKey: held.dedupeKey }, now: now() };
      yield* enqueueJobOnceSteps(q, { ...job, jobKey: `${held.dedupeKey}:released` });
      return "released";
    });
  }

  async function handle(
    job: Job,
    context: {
      signal: AbortSignal;
      isCurrentSteps(q: Q): Steps<boolean>;
      extendLease(): Promise<boolean>;
    },
  ): Promise<void> {
    const dedupeKey = (job.payload as { dedupeKey?: unknown } | null)?.dedupeKey;
    const event =
      typeof dedupeKey === "string" && (await store.run((q) => inboxEventByKeySteps(q, dedupeKey)));
    if (!event) return;
    const { workspaceId, generation, mention } = JSON.parse(event.payload) as {
      workspaceId: string;
      generation: number;
      mention: SlackMention;
    };
    const { teamId, channelId, threadTs, slackUserId } = mention;
    const place: Place = { workspaceId, teamId, channelId, threadTs, slackUserId, generation };
    const gate = await store.run(function* (q): Steps<Gate> {
      if (yield* stoppedSteps(q, place, mention.ts)) return { kind: "ignore" };
      const unlinkedAt = yield* readSettingSteps(q, unlinkedKey(workspaceId, teamId, slackUserId));
      if (unlinkedAt !== null && event.updated_at_ms <= Number(unlinkedAt))
        return { kind: "ignore" };
      return yield* gateSteps(q, home, place);
    });
    if (gate.kind === "ignore") return;
    const call = await slackFor(workspaceId);
    if ((await slackChannelAudience(call, channelId, context.signal)) !== "internal") return;
    const code = LINK_CODE.exec(mention.text)?.[1];
    if (code) {
      const outcome = await claim(place, code);
      if (outcome === "released") emitJobReady(store);
      return void (await notice(place, dedupeKey!, NOTICES[outcome]));
    }
    if (gate.kind === "guide") {
      const held: Held = {
        teamId,
        channelId,
        generation,
        dedupeKey: dedupeKey!,
        expiresAt: now() + LINK_MS,
      };
      await store.run((q) =>
        updateSettingSteps(q, heldKey(place), () => JSON.stringify(held), now()),
      );
      const query = new URLSearchParams({ team: teamId, channel: channelId, user: slackUserId });
      const setup = gate.setup ? " The first person to link must be a Paws workspace admin." : "";
      const text = `To talk to Paws here, open ${origin}${SLACK_LINK_PATH}?${query}, sign in, and mention @Paws in this thread with the code it shows. Paws answers this question once you link within 10 minutes.${setup}`;
      return void (await notice(place, dedupeKey!, text));
    }
    const question = mention.text.replace(/<@[A-Z0-9]+>/g, "").trim();
    const scope = { workspaceId, teamId, channelId, generation };
    const command = slackMemoryCommand(question);
    const asker = { userId: gate.userId, linkId: gate.linkId };
    if (command?.kind === "memory")
      return void (await notice(place, dedupeKey!, "", { member: asker, listing: true }));
    if (command) {
      const text = await memory.command({
        scope,
        userId: gate.userId,
        admin: () =>
          store.run(function* (q) {
            const member = yield* workspaceMemberSteps(q, workspaceId, gate.userId);
            return workspaceMemberUsable(member) && isWorkspaceAdmin(member.role);
          }),
        command,
        sourceId: `${channelId}:${threadTs}:${mention.ts}`,
        revision: mention.ts,
        now: now(),
      });
      return void (await notice(place, dedupeKey!, text, { member: asker }));
    }
    const replyKey = `slack:reply:${teamId}:${channelId}:${mention.ts}`;
    const earlier = await store.run(function* (q) {
      if (yield* slackOutboxExistsSteps(q, replyKey)) return null;
      return (yield* slackThreadContextSteps(q, { ...place, userId: gate.userId })) as Reply[];
    });
    const lane = earlier && (await options.replies());
    if (!lane) return;
    const kept = new Map<string, MemoryRef>();
    const checked = new Map<string, boolean>();
    const turns: { slackUserId: string; question: string; text: string | null }[] = [];
    for (const turn of earlier!.slice(-10)) {
      const refs = uniqueRefs(turn.contexts ?? []);
      let valid = true;
      for (const ref of refs) {
        const id = refId(ref);
        if (!checked.has(id))
          checked.set(id, await memory.current({ scope, userId: gate.userId, ...ref, now: now() }));
        if (!checked.get(id)) valid = false;
      }
      if (valid) for (const ref of refs) kept.set(refId(ref), ref);
      turns.push({ ...turn, text: valid ? turn.text : null });
    }
    const thread = [...turns, { slackUserId, question, text: null }].flatMap((turn) => [
      `[<@${turn.slackUserId}>]: ${turn.question}`,
      ...(turn.text === null ? [] : [`[Paws]: ${turn.text}`]),
    ]);
    const instructions =
      "You are Paws, answering in a Slack channel thread. No repository, Linear issue or tools are attached; if the question needs code or changes, say this thread can't do that yet. Reply briefly in Slack mrkdwn.";
    const consumerKey = `slack:${workspaceId}:${teamId}:${channelId}:${mention.ts}`;
    const remembered = await memory.prepare({
      scope,
      userId: gate.userId,
      consumerKey,
      instructions,
      request: question,
      now: now(),
      signal: context.signal,
    });
    const background = remembered.text ? `${remembered.text}\n\n` : "";
    const prompt = `${instructions}\n\n${background}${thread.join("\n").slice(-28_000)}`;
    const replyScope = {
      requestId: `slack-${teamId}-${channelId}-${mention.ts.replace(".", "-")}`,
      teamId,
      channelId,
      threadTs,
      memberUserId: gate.userId,
      installGeneration: generation,
    };
    const heartbeat = setInterval(() => void context.extendLease().catch(() => false), 10_000);
    const stop = new AbortController();
    const watch = setInterval(() => {
      void store
        .run(function* (q) {
          if (yield* stoppedSteps(q, place, mention.ts)) return true;
          const current = yield* gateSteps(q, home, place);
          return current.kind !== "member" || current.linkId !== gate.linkId;
        })
        .then(
          (stopped) => stopped && stop.abort(),
          () => undefined,
        );
    }, STOP_POLL_MS);
    const signal = AbortSignal.any([context.signal, stop.signal]);
    const outcome = await lane
      .reply({ workspaceId, scope: replyScope, profile: options.profile(), prompt, signal })
      .catch((error: unknown): { status: string; text?: string } => {
        if (stop.signal.aborted) return { status: "stopped" };
        throw error;
      })
      .finally(() => {
        clearInterval(heartbeat);
        clearInterval(watch);
      });
    if (outcome.status === "busy")
      throw new Error("The member's runner conversation lane is busy.");
    const text = outcome.status === "answered" ? outcome.text?.trim().slice(0, 3_000) : undefined;
    if (!text) return journal(`slack ${dedupeKey}: no answer (${outcome.status})`);
    const contexts = uniqueRefs([
      ...kept.values(),
      ...(remembered.text ? [{ key: consumerKey, version: remembered.version }] : []),
    ]);
    if (!(await currentMemory(scope, gate.userId, contexts)))
      return void (await notice(place, replyKey, NOTICES.memory_changed));
    await store.transaction(function* (q) {
      if (!(yield* context.isCurrentSteps(q))) return;
      if (yield* stoppedSteps(q, place, mention.ts)) return;
      const fence = yield* gateSteps(q, home, place);
      if (fence.kind !== "member" || fence.linkId !== gate.linkId) return;
      const payload: Payload = {
        ...place,
        kind: "reply",
        userId: gate.userId,
        linkId: gate.linkId,
        mentionTs: mention.ts,
        question,
        text,
        ...(contexts.length ? { contexts } : {}),
      };
      yield* enqueueOutboxOnceSteps(q, {
        target: "slack",
        op: "chat.postMessage",
        idempotencyKey: replyKey,
        payload,
        now: now(),
      });
    });
  }

  async function currentMemory(
    scope: Bound & { workspaceId: string },
    userId: string,
    refs: readonly MemoryRef[],
  ) {
    for (const ref of uniqueRefs(refs))
      if (!(await memory.current({ scope, userId, ...ref, now: now() }))) return false;
    return true;
  }

  async function deliver(
    row: OutboxRow,
    context: { signal: AbortSignal; isCurrent(): Promise<boolean> },
  ): Promise<void> {
    const payload = row.payload as Payload;
    const settle = (outcome: SlackSendOutcome) => {
      if ("note" in outcome) journal(`slack outbox ${row.id}: ${outcome.kind}; ${outcome.note}`);
      return store.run((q) => settleSlackOutboxSteps(q, row, outcome, now()));
    };
    function* allowedSteps(q: Q): Steps<boolean> {
      if (payload.kind === "reply" && (yield* stoppedSteps(q, payload, payload.mentionTs)))
        return false;
      const gate = yield* gateSteps(q, home, payload);
      const bound = payload.kind === "notice" ? payload.member : undefined;
      if (payload.kind === "notice" && !bound) return gate.kind !== "ignore";
      if (bound)
        return (
          gate.kind === "member" && gate.userId === bound.userId && gate.linkId === bound.linkId
        );
      if (payload.kind !== "reply") return false;
      return (
        gate.kind === "member" &&
        gate.userId === payload.userId &&
        gate.linkId === (payload.linkId ?? "")
      );
    }
    const refs = payload.kind === "reply" ? (payload.contexts ?? []) : [];
    const allowed =
      (await store.run(allowedSteps)) &&
      (payload.kind !== "reply" || (await currentMemory(payload, payload.userId, refs)));
    const call = allowed ? await slackFor(payload.workspaceId) : null;
    if (
      !call ||
      (await slackChannelAudience(call, payload.channelId, context.signal)) !== "internal"
    )
      return settle({ kind: "withheld", note: "access or channel changed before delivery" });
    if (!(await context.isCurrent())) return;
    if (payload.kind === "reply" && !(await currentMemory(payload, payload.userId, refs)))
      return settle({ kind: "withheld", note: "memory changed before delivery" });
    const text =
      payload.kind === "notice" && payload.listing && payload.member
        ? await memory.list({ scope: payload, userId: payload.member.userId, now: now() })
        : payload.text;
    const sending = await store.transaction(function* (q) {
      if (!(yield* allowedSteps(q))) return "stopped";
      return (yield* slackSendingSteps(q, row, true)) ? "claimed" : "taken";
    });
    if (sending === "stopped")
      return settle({
        kind: "withheld",
        note: "access changed or the thread stopped before delivery",
      });
    if (sending === "taken")
      return settle({ kind: "unknown", note: "an earlier attempt may have posted it; not resent" });
    const body =
      payload.kind === "notice"
        ? { user: payload.slackUserId }
        : { unfurl_links: false, unfurl_media: false, blocks: replyBlocks(payload.text) };
    const method = payload.kind === "notice" ? "chat.postEphemeral" : "chat.postMessage";
    const fields = { channel: payload.channelId, thread_ts: payload.threadTs, text };
    let result: Record<string, unknown>;
    try {
      result = await call(method, { ...fields, ...body }, context.signal);
    } catch (caught) {
      if (caught instanceof SlackNotSentError) {
        await store.run((q) => slackSendingSteps(q, row, false));
        throw caught;
      }
      return caught instanceof SlackApiError && caught.code !== "fatal_error"
        ? settle({ kind: "refused", note: `Slack refused it (${caught.code}); not resent` })
        : settle({ kind: "unknown", note: "Slack's response was lost; not resent" });
    }
    const ts = result.ts ?? result.message_ts;
    return settle({ kind: "sent", ts: typeof ts === "string" && ts ? ts : "ok" });
  }

  return { handle, deliver };
}

function replyBlocks(text: string) {
  const stop = {
    type: "button",
    action_id: SLACK_STOP_ACTION,
    value: "stop",
    text: { type: "plain_text", text: "Stop" },
  };
  return [
    { type: "section", text: { type: "mrkdwn", text: text.slice(0, 3_000) } },
    { type: "actions", elements: [stop] },
  ];
}

export function createSlackLinkPage(options: { store: Db; home: string; now?: () => number }) {
  const now = options.now ?? Date.now;
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (url.pathname !== SLACK_LINK_PATH) return null;
    if (request.method !== "GET") return page("Method not allowed.", 405);
    const [teamId, channelId, slackUserId] = ["team", "channel", "user"].map(
      (name) => url.searchParams.get(name) ?? "",
    ) as [string, string, string];
    if (![teamId, channelId, slackUserId].every((id) => SLACK_ID.test(id)))
      return page("Open this page from the link Paws posted in Slack.", 400);
    const at = now();
    const access = await options.store.run((q) => requestWorkspaceSessionSteps(q, request, at));
    if (!access)
      return page(
        'Sign in to Paws first: <a href="/auth/linear">Sign in</a>, then open the link from Slack again.',
        401,
      );
    const { workspaceId, userId } = access.principal;
    const install = await options.store.run((q) => installationSteps(q, options.home, teamId));
    if (install?.workspaceId !== workspaceId)
      return page("That Slack workspace isn't connected to your Paws workspace.", 403);
    const chars = [...randomBytes(8)].map((byte) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[byte % 32]);
    const code = `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
    const issued: Code = {
      hash: workspaceTokenHash(code),
      userId,
      slackUserId,
      teamId,
      channelId,
      generation: install.generation,
      expiresAt: at + LINK_MS,
    };
    await options.store.run((q) =>
      updateSettingSteps(
        q,
        `${codePrefix(workspaceId)}${userId}`,
        () => JSON.stringify(issued),
        at,
      ),
    );
    return page(
      `<p>From Slack user <code>${slackUserId}</code>, in that thread of channel <code>${channelId}</code>, mention @Paws with:</p><p><code>link ${code}</code></p><p>It works once, for 10 minutes, only from that Slack account, and links it to your Paws account. Never give it to anyone.</p>`,
      200,
    );
  };
}

function page(body: string, status: number): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Paws for Slack</title></head><body>${body}</body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    },
  });
}
