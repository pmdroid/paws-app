import type { SlackFetch } from "./oauth";

export class SlackApiError extends Error {
  override readonly name = "SlackApiError";
  constructor(
    readonly method: string,
    readonly code: string,
  ) {
    super(`Slack ${method} failed: ${code}.`);
  }
}

export class SlackNotSentError extends Error {
  override readonly name = "SlackNotSentError";
  constructor(
    readonly method: string,
    readonly retryAfterMs?: number,
  ) {
    super(`Slack did not take ${method}; retrying.`);
  }
}

export type SlackCall = (
  method: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<Record<string, unknown>>;

const REFUSED = new Set(["ECONNREFUSED", "ConnectionRefused", "ENOTFOUND", "EAI_AGAIN"]);

export function slackCaller(fetchImpl: SlackFetch, token: string): SlackCall {
  return async (method, body, signal) => {
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    };
    const request = { method: "POST", signal, headers, body: JSON.stringify(body) };
    const response = await fetchImpl(`https://slack.com/api/${method}`, request).catch(
      (caught: unknown) => {
        const code = (caught as { code?: unknown } | null)?.code;
        throw typeof code === "string" && REFUSED.has(code)
          ? new SlackNotSentError(method)
          : caught;
      },
    );
    if (response.status === 429) {
      const seconds = Number(response.headers.get("retry-after"));
      throw new SlackNotSentError(method, (seconds > 0 ? Math.min(seconds, 3600) : 30) * 1000);
    }
    if (response.status >= 500) throw new SlackNotSentError(method);
    if (!response.ok) throw new SlackApiError(method, `http_${response.status}`);
    const data = (await response.json()) as Record<string, unknown> | null;
    if (data?.ok === true) return data;
    const code = typeof data?.error === "string" ? data.error : "";
    throw new SlackApiError(method, /^[a-z_]{1,64}$/.test(code) ? code : "unknown_error");
  };
}

const GONE = new Set(["channel_not_found", "not_in_channel", "is_archived"]);
const MEMBER_LIMIT = 100;
const MAX_PAGES = 50;

export type SlackAudience =
  | { kind: "unavailable" }
  | {
      kind: "public" | "private" | "org_shared" | "ext_shared" | "pending_ext_shared";
      guests: "none" | "present" | "unknown";
    };

const PENDING = ["pending_shared", "pending_connected_team_ids"];

/**
 * Sharing that Slack reports outside the boolean flags: pending invitations, connected
 * teams, or a channel that lists or belongs to another team. Anything present and not
 * proven to be this team alone counts as shared.
 */
function sharedBeyond(c: Record<string, unknown>, teamId: string) {
  if (PENDING.some((field) => c[field] !== undefined && !emptyList(c[field])))
    return "pending_ext_shared" as const;
  const connected = c.connected_team_ids;
  if (connected !== undefined && !emptyList(connected)) return "ext_shared" as const;
  const teams = c.shared_team_ids;
  if (teams !== undefined && !(Array.isArray(teams) && teams.every((team) => team === teamId)))
    return "ext_shared" as const;
  if (c.context_team_id !== undefined && c.context_team_id !== teamId) return "ext_shared" as const;
  return null;
}

export async function slackChannelAudience(
  call: SlackCall,
  input: { teamId: string; channelId: string },
  signal: AbortSignal,
  options: { guests?: boolean } = {},
): Promise<SlackAudience> {
  const { teamId, channelId } = input;
  const data = await call("conversations.info", { channel: channelId }, signal).catch(gone);
  const c = (data?.channel ?? null) as Record<string, unknown> | null;
  if (c?.id !== channelId || c.is_archived === true || c.is_channel !== true)
    return { kind: "unavailable" };
  if (c.is_im === true || c.is_mpim === true) return { kind: "unavailable" };
  const kind =
    sharedBeyond(c, teamId) ??
    (c.is_ext_shared !== false
      ? "ext_shared"
      : c.is_pending_ext_shared !== false
        ? "pending_ext_shared"
        : c.is_org_shared !== false
          ? "org_shared"
          : c.is_shared !== false
            ? "ext_shared"
            : c.is_private !== false
              ? "private"
              : "public");
  const guests = options.guests ? await channelGuests(call, channelId, signal) : "unknown";
  return { kind, guests };
}

async function channelGuests(
  call: SlackCall,
  channelId: string,
  signal: AbortSignal,
): Promise<"none" | "present" | "unknown"> {
  const members: string[] = [];
  let cursor = "";
  let read = 0;
  do {
    if (++read > MAX_PAGES) return "unknown";
    const page = await call(
      "conversations.members",
      { channel: channelId, limit: MEMBER_LIMIT, ...(cursor ? { cursor } : {}) },
      signal,
    ).catch(unknown);
    if (!page || !Array.isArray(page.members)) return "unknown";
    members.push(...page.members.filter((id): id is string => typeof id === "string"));
    if (members.length > MEMBER_LIMIT) return "unknown";
    const next = (page.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor;
    cursor = typeof next === "string" ? next : "";
  } while (cursor);
  if (!members.length) return "unknown";
  for (const user of members) {
    const data = await call("users.info", { user }, signal).catch(unknown);
    const u = (data?.user ?? null) as Record<string, unknown> | null;
    if (u?.id !== user) return "unknown";
    if (u.is_restricted !== false || u.is_ultra_restricted !== false) {
      if (u.is_restricted === true || u.is_ultra_restricted === true) return "present";
      if (u.is_bot !== true && u.deleted !== true) return "unknown";
    }
  }
  return "none";
}

function gone(caught: unknown): null {
  if (caught instanceof SlackApiError && GONE.has(caught.code)) return null;
  throw caught;
}

function unknown(caught: unknown): null {
  if (caught instanceof SlackApiError) return null;
  throw caught;
}

const PAGE_LIMIT = 200;
const SLACKBOT = "USLACKBOT";
const UNSHARED = ["is_shared", "is_ext_shared", "is_org_shared", "is_pending_ext_shared"];

async function pages<T>(
  call: SlackCall,
  method: string,
  body: Record<string, unknown>,
  field: string,
  signal: AbortSignal,
): Promise<T[] | null> {
  const all: T[] = [];
  let cursor = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await call(
      method,
      { ...body, limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
      signal,
    );
    const items = data[field];
    if (!Array.isArray(items)) return null;
    all.push(...(items as T[]));
    const next = (data.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor;
    if (next === undefined || next === "") return all;
    if (typeof next !== "string") return null;
    cursor = next;
  }
  return null;
}

/**
 * The Slack user IDs of every person who can read a public channel of `teamId`: the
 * workspace's full members and the channel's guests. Returns null whenever that readership
 * isn't proven: any sharing (Slack Connect, org-wide, pending), a user from another team,
 * an unknown guest flag, another bot or app in the channel, or membership too large to page.
 */
export async function slackChannelReaders(
  call: SlackCall,
  input: { teamId: string; channelId: string; botUserId: string },
  signal: AbortSignal,
): Promise<string[] | null> {
  try {
    const info = await call("conversations.info", { channel: input.channelId }, signal);
    const c = (info.channel ?? null) as Record<string, unknown> | null;
    if (c?.id !== input.channelId || c.is_channel !== true || c.is_private !== false) return null;
    if (c.is_archived === true || c.is_im === true || c.is_mpim === true) return null;
    if (UNSHARED.some((flag) => c[flag] !== false)) return null;
    if (sharedBeyond(c, input.teamId)) return null;
    const members = await pages<unknown>(
      call,
      "conversations.members",
      { channel: input.channelId },
      "members",
      signal,
    );
    const users = await pages<Record<string, unknown>>(call, "users.list", {}, "members", signal);
    if (!members || !users) return null;
    if (!members.every((id) => typeof id === "string")) return null;
    const inChannel = new Set(members as string[]);
    const known = new Set<string>();
    const readers = new Set<string>();
    for (const user of users) {
      const id = user?.id;
      if (typeof id !== "string") return null;
      known.add(id);
      if (user.deleted === true || id === input.botUserId || id === SLACKBOT) continue;
      if (user.team_id !== input.teamId || user.is_stranger === true) return null;
      if (typeof user.is_bot !== "boolean") return null;
      if (user.is_bot || user.is_app_user === true) {
        if (inChannel.has(id)) return null;
        continue;
      }
      const guest = [user.is_restricted, user.is_ultra_restricted];
      if (!guest.every((flag) => typeof flag === "boolean")) return null;
      if (guest.includes(true) && !inChannel.has(id)) continue;
      readers.add(id);
    }
    for (const id of inChannel) if (!known.has(id) && id !== input.botUserId) return null;
    return [...readers].sort();
  } catch (caught) {
    if (caught instanceof SlackApiError) return null;
    throw caught;
  }
}

const emptyList = (value: unknown) => Array.isArray(value) && value.length === 0;
