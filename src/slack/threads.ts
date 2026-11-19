import { randomBytes } from "node:crypto";
import {
  auditWorkspaceAccessSteps,
  emitJobReady,
  enqueueJobOnceSteps,
  enqueueOutboxOnceSteps,
  inboxEventByKeySteps,
  insertInboxEventSteps,
  markInboxEventHandledSteps,
  readSettingSteps,
  settingsWithPrefixSteps,
  slackThreadRepliesSteps,
  takeSettingSteps,
  updateSettingSteps,
  workspaceMemberSteps,
  workspaceMemberUsable,
  type Db,
  type Job,
  type OutboxRow,
  type Q,
  type Steps,
} from "../db";
import { journal, journalCaught } from "../journal";
import { isWorkspaceAdmin, requestWorkspaceSessionSteps, workspaceTokenHash } from "../workspace";
import { SlackApiError, slackCaller, slackChannelAudience, type SlackCall } from "./api";
import {
  createSlackAuth,
  installedSlackTokenSteps,
  slackTeamOwnerSteps,
  type InstalledSlackToken,
  type SlackFetch,
} from "./oauth";
import type { SlackMention } from "./webhook";

export const SLACK_THREAD_JOB = "slack.thread";
export const SLACK_LINK_PATH = "/oauth/slack/link";
const LINK_TTL_MS = 10 * 60_000;
const LINK_CODE = /\blink\s+([A-Z2-7]{4}-[A-Z2-7]{4})\b/i;
const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const CONTEXT_REPLIES = 20;
const REPLY_CHARS = 3_500;
const PROMPT_BYTES = 30_000;
const REPLY_EVENT = "paws_reply";

export type SlackReplyScope = {
  requestId: string;
  teamId: string;
  channelId: string;
  threadTs: string;
  memberUserId: string;
  installGeneration: number;
};

export type SlackThreadModel = (input: {
  workspaceId: string;
  scope: SlackReplyScope;
  prompt: string;
  signal: AbortSignal;
}) => Promise<string | null>;

type Place = {
  workspaceId: string;
  teamId: string;
  channelId: string;
  threadTs: string;
  slackUserId: string;
};
type Reply = Place & {
  kind: "reply";
  userId: string;
  mentionTs: string;
  question: string;
  text: string;
};
type Notice = Place & { kind: "notice"; text: string };
type Install = InstalledSlackToken & { generation: number };
type Bound = { teamId: string; channelId: string; generation: number };
type Linked = Bound & { workspaceId: string; userId: string };
type Gate =
  | { kind: "ignore" }
  | { kind: "guide"; setup: boolean; install: Install }
  | { kind: "member"; userId: string; install: Install };

const channelKey = (workspaceId: string) => `slack.channel:${workspaceId}`;
const memberKey = (teamId: string, slackUserId: string) => `slack.member:${teamId}:${slackUserId}`;
const codePrefix = (workspaceId: string) => `slack.link:${workspaceId}:`;
const parsed = <T>(value: string | null) => (value === null ? null : (JSON.parse(value) as T));

const NOTICES = {
  linked: "Linked. Mention @Paws in this thread to ask it something.",
  expired: "That code has expired, was already used, or isn't from this Paws workspace.",
  admin_required: "The first person to link must be a Paws workspace admin.",
  other_channel: "Paws already answers in another channel of this workspace.",
};

function* installationSteps(q: Q, home: string, teamId: string): Steps<Install | null> {
  const team = yield* slackTeamOwnerSteps(q, home, teamId);
  if (!team.owner) return null;
  const install = yield* installedSlackTokenSteps(q, home, team.owner.value);
  return install?.teamId === teamId ? { ...install, generation: team.owner.updatedAt } : null;
}

function same(bound: Bound | null, place: { teamId: string; channelId: string }, install: Install) {
  return (
    bound?.teamId === place.teamId &&
    bound.channelId === place.channelId &&
    bound.generation === install.generation
  );
}

function* gateSteps(q: Q, home: string, place: Omit<Place, "threadTs">): Steps<Gate> {
  const install = yield* installationSteps(q, home, place.teamId);
  if (!install || install.workspaceId !== place.workspaceId) return { kind: "ignore" };
  const channel = parsed<Bound>(yield* readSettingSteps(q, channelKey(place.workspaceId)));
  const admitted = channel?.generation === install.generation;
  if (admitted && !same(channel, place, install)) return { kind: "ignore" };
  const link = parsed<Linked>(
    yield* readSettingSteps(q, memberKey(place.teamId, place.slackUserId)),
  );
  if (!admitted || link?.workspaceId !== place.workspaceId || !same(link, place, install))
    return { kind: "guide", setup: !admitted, install };
  const member = yield* workspaceMemberSteps(q, place.workspaceId, link.userId);
  if (!workspaceMemberUsable(member)) return { kind: "ignore" };
  return { kind: "member", userId: link.userId, install };
}

export function* slackReplyAllowedSteps(
  q: Q,
  home: string,
  input: { workspaceId: string; scope: Omit<SlackReplyScope, "requestId" | "threadTs"> },
): Steps<boolean> {
  const { workspaceId, scope } = input;
  const install = yield* installationSteps(q, home, scope.teamId);
  if (install?.workspaceId !== workspaceId || install.generation !== scope.installGeneration)
    return false;
  if (!same(parsed<Bound>(yield* readSettingSteps(q, channelKey(workspaceId))), scope, install))
    return false;
  const links = yield* settingsWithPrefixSteps(q, `slack.member:${scope.teamId}:`);
  const linked = links.some((row) => {
    const link = parsed<Linked>(row.value);
    return (
      link?.workspaceId === workspaceId &&
      link.userId === scope.memberUserId &&
      same(link, scope, install)
    );
  });
  return (
    linked && workspaceMemberUsable(yield* workspaceMemberSteps(q, workspaceId, scope.memberUserId))
  );
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
    const payload = { type: "SlackMention", workspaceId: install.workspaceId, mention };
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
      payload: JSON.stringify(payload),
      receivedAt: at,
    });
    if (!inserted) return false;
    yield* markInboxEventHandledSteps(q, dedupeKey);
    const job = { queue: SLACK_THREAD_JOB, jobKey: dedupeKey, payload: { dedupeKey }, now: at };
    return (yield* enqueueJobOnceSteps(q, job)).inserted;
  });
  if (queued) emitJobReady(store);
}

function slackPrompt(earlier: Reply[], slackUserId: string, question: string): string {
  const lines = (replies: Reply[]) =>
    [
      "You are Paws, answering in a Slack channel thread. No repository, Linear issue or tools are attached; if the question needs code or changes, say this thread can't do that yet. Reply briefly in Slack mrkdwn.",
      "",
      ...replies.flatMap((reply) => [
        `[<@${reply.slackUserId}>]: ${reply.question}`,
        `[Paws]: ${reply.text}`,
      ]),
      `[<@${slackUserId}>]: ${question}`,
    ].join("\n");
  let kept = earlier;
  while (kept.length > 0 && Buffer.byteLength(lines(kept)) > PROMPT_BYTES) kept = kept.slice(1);
  return lines(kept);
}

export function createSlackThreads(options: {
  store: Db;
  home: string;
  env: Record<string, string | undefined>;
  origin: string;
  model: SlackThreadModel;
  fetch?: SlackFetch;
  now?: () => number;
}) {
  const { store, home, env } = options;
  const now = options.now ?? Date.now;
  const origin = new URL(options.origin).origin;
  const slackFetch = options.fetch ?? fetch;

  async function slackFor(workspaceId: string): Promise<SlackCall> {
    const auth = createSlackAuth({ home, db: store, fetch: slackFetch, env, workspaceId });
    return slackCaller(slackFetch, await auth.ensureFresh());
  }

  function notice(place: Place, key: string, text: string) {
    return store.transaction((q) =>
      enqueueOutboxOnceSteps(q, {
        target: "slack",
        op: "chat.postEphemeral",
        idempotencyKey: `slack:notice:${key}`,
        payload: { ...place, kind: "notice", text } satisfies Notice,
        now: now(),
      }),
    );
  }

  function claim(place: Place, install: Install, code: string) {
    return store.transaction(function* (q): Steps<keyof typeof NOTICES> {
      const hash = workspaceTokenHash(code.toUpperCase());
      const rows = yield* settingsWithPrefixSteps(q, codePrefix(place.workspaceId));
      const row = rows.find(
        (candidate) => parsed<{ hash: string }>(candidate.value)?.hash === hash,
      );
      const issued =
        row && parsed<{ userId: string; expiresAt: number }>(yield* takeSettingSteps(q, row.key));
      if (!issued || issued.expiresAt <= now()) return "expired";
      const member = yield* workspaceMemberSteps(q, place.workspaceId, issued.userId);
      if (!workspaceMemberUsable(member)) return "expired";
      if ((yield* installationSteps(q, home, place.teamId))?.generation !== install.generation)
        return "expired";
      const bound = {
        teamId: place.teamId,
        channelId: place.channelId,
        generation: install.generation,
      };
      const channel = parsed<Bound>(yield* readSettingSteps(q, channelKey(place.workspaceId)));
      const audit = (action: string, subject: string) =>
        auditWorkspaceAccessSteps(q, {
          workspaceId: place.workspaceId,
          userId: issued.userId,
          action,
          subject,
          now: now(),
        });
      if (channel?.generation === install.generation) {
        if (!same(channel, place, install)) return "other_channel";
      } else {
        if (!isWorkspaceAdmin(member.role)) return "admin_required";
        yield* updateSettingSteps(
          q,
          channelKey(place.workspaceId),
          () => JSON.stringify(bound),
          now(),
        );
        yield* audit("slack.channel_admitted", `slack:${place.teamId}:${place.channelId}`);
      }
      const linked: Linked = { ...bound, workspaceId: place.workspaceId, userId: issued.userId };
      yield* updateSettingSteps(
        q,
        memberKey(place.teamId, place.slackUserId),
        () => JSON.stringify(linked),
        now(),
      );
      yield* audit("slack.member_linked", `slack:${place.teamId}:${place.slackUserId}`);
      return "linked";
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
    if (typeof dedupeKey !== "string") return;
    const event = await store.run((q) => inboxEventByKeySteps(q, dedupeKey));
    if (!event) return;
    const { workspaceId, mention } = JSON.parse(event.payload) as {
      workspaceId: string;
      mention: SlackMention;
    };
    const place: Place = {
      workspaceId,
      teamId: mention.teamId,
      channelId: mention.channelId,
      threadTs: mention.threadTs,
      slackUserId: mention.slackUserId,
    };
    const gate = await store.run((q) => gateSteps(q, home, place));
    if (gate.kind === "ignore") return;
    const call = await slackFor(workspaceId);
    if ((await slackChannelAudience(call, place.channelId, context.signal)) !== "internal") return;
    const code = LINK_CODE.exec(mention.text)?.[1];
    if (code)
      return void (await notice(place, dedupeKey, NOTICES[await claim(place, gate.install, code)]));
    if (gate.kind === "guide") {
      const setup = gate.setup ? " The first person to link must be a Paws workspace admin." : "";
      const text = `To talk to Paws here, open ${origin}${SLACK_LINK_PATH}, sign in, and mention @Paws in this thread with the code it shows.${setup}`;
      return void (await notice(place, dedupeKey, text));
    }
    const earlier = (await store.run((q) => slackThreadRepliesSteps(q, place))) as Reply[];
    if (earlier.some((reply) => reply.mentionTs === mention.ts)) return;
    const question = mention.text.replaceAll(`<@${gate.install.botUserId}>`, "").trim();
    const prompt = slackPrompt(
      earlier.filter((reply) => reply.mentionTs < mention.ts).slice(-CONTEXT_REPLIES),
      place.slackUserId,
      question,
    );
    const heartbeat = setInterval(() => void context.extendLease().catch(() => false), 10_000);
    let answer: string | null;
    try {
      answer = await options.model({
        workspaceId,
        scope: {
          requestId: `slack-${place.teamId}-${place.channelId}-${mention.ts.replace(".", "-")}`,
          teamId: place.teamId,
          channelId: place.channelId,
          threadTs: place.threadTs,
          memberUserId: gate.userId,
          installGeneration: gate.install.generation,
        },
        prompt,
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(240_000)]),
      });
    } finally {
      clearInterval(heartbeat);
    }
    const text = answer?.trim().slice(0, REPLY_CHARS);
    if (!text) return;
    await store.transaction(function* (q) {
      if (!(yield* context.isCurrentSteps(q))) return;
      const fence = yield* gateSteps(q, home, place);
      if (fence.kind !== "member" || fence.userId !== gate.userId) return;
      const reply: Reply = {
        ...place,
        kind: "reply",
        userId: gate.userId,
        mentionTs: mention.ts,
        question,
        text,
      };
      yield* enqueueOutboxOnceSteps(q, {
        target: "slack",
        op: "chat.postMessage",
        idempotencyKey: `slack:reply:${place.teamId}:${place.channelId}:${mention.ts}`,
        payload: reply,
        now: now(),
      });
    });
  }

  async function deliver(
    row: OutboxRow,
    context: { signal: AbortSignal; isCurrent(): Promise<boolean> },
  ): Promise<void> {
    if (row.target !== "slack") return;
    const payload = row.payload as Reply | Notice;
    const gate = await store.run((q) => gateSteps(q, home, payload));
    const allowed =
      payload.kind === "reply"
        ? gate.kind === "member" && gate.userId === payload.userId
        : gate.kind !== "ignore";
    const call = allowed ? await slackFor(payload.workspaceId) : null;
    if (
      !call ||
      (await slackChannelAudience(call, payload.channelId, context.signal)) !== "internal"
    ) {
      journal(`slack outbox ${row.id}: withheld; access or channel changed before delivery`);
      return;
    }
    if (!(await context.isCurrent())) return;
    const retried = row.attempts > 1 && !row.error?.startsWith("Slack rate-limited");
    if (payload.kind === "reply" && retried && (await posted(call, payload, context.signal)))
      return;
    try {
      if (payload.kind === "notice")
        await call(
          "chat.postEphemeral",
          {
            channel: payload.channelId,
            user: payload.slackUserId,
            thread_ts: payload.threadTs,
            text: payload.text,
          },
          context.signal,
        );
      else
        await call(
          "chat.postMessage",
          {
            channel: payload.channelId,
            thread_ts: payload.threadTs,
            text: payload.text,
            unfurl_links: false,
            unfurl_media: false,
            metadata: { event_type: REPLY_EVENT, event_payload: { id: row.idempotencyKey } },
          },
          context.signal,
        );
    } catch (caught) {
      if (!(caught instanceof SlackApiError) || /^http_5|^invalid_response$/.test(caught.code))
        throw caught;
      journalCaught(caught, "slack.threads.deliver", null);
    }
  }

  async function posted(call: SlackCall, reply: Reply, signal: AbortSignal): Promise<boolean> {
    const data = await call(
      "conversations.replies",
      { channel: reply.channelId, ts: reply.threadTs, include_all_metadata: true, limit: 200 },
      signal,
    );
    const key = `slack:reply:${reply.teamId}:${reply.channelId}:${reply.mentionTs}`;
    return (Array.isArray(data.messages) ? data.messages : []).some(
      (message: { metadata?: { event_type?: unknown; event_payload?: { id?: unknown } } }) =>
        message.metadata?.event_type === REPLY_EVENT && message.metadata.event_payload?.id === key,
    );
  }

  return { handle, deliver };
}

export function createSlackLinkPage(options: { store: Db; now?: () => number }) {
  const now = options.now ?? Date.now;
  return async (request: Request): Promise<Response | null> => {
    if (new URL(request.url).pathname !== SLACK_LINK_PATH) return null;
    if (request.method !== "GET") return page("Method not allowed.", 405);
    const at = now();
    const access = await options.store.run((q) => requestWorkspaceSessionSteps(q, request, at));
    if (!access)
      return page(
        'Sign in to Paws first: <a href="/auth/linear">Sign in</a>, then open this page again.',
        401,
      );
    const { workspaceId, userId } = access.principal;
    const bytes = randomBytes(8);
    const chars = [...bytes].map((byte) => CODE_ALPHABET[byte % 32]).join("");
    const code = `${chars.slice(0, 4)}-${chars.slice(4)}`;
    const value = JSON.stringify({
      hash: workspaceTokenHash(code),
      userId,
      expiresAt: at + LINK_TTL_MS,
    });
    await options.store.run((q) =>
      updateSettingSteps(q, `${codePrefix(workspaceId)}${userId}`, () => value, at),
    );
    return page(
      `<p>In the Slack thread, mention @Paws with:</p><p><code>link ${code}</code></p><p>It works once, for 10 minutes, and links the Slack account that posts it to your Paws account. Post it yourself; never give it to anyone.</p>`,
      200,
    );
  };
}

function page(body: string, status: number): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Paws for Slack</title></head><body>${body}</body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      },
    },
  );
}
