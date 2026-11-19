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

export type SlackAudience =
  | { kind: "unavailable" }
  | {
      kind: "public" | "private" | "org_shared" | "ext_shared" | "pending_ext_shared";
      guests: "none" | "present" | "unknown";
    };

export async function slackChannelAudience(
  call: SlackCall,
  channelId: string,
  signal: AbortSignal,
  options: { guests?: boolean } = {},
): Promise<SlackAudience> {
  const data = await call("conversations.info", { channel: channelId }, signal).catch(gone);
  const c = (data?.channel ?? null) as Record<string, unknown> | null;
  if (c?.id !== channelId || c.is_archived === true || c.is_channel !== true)
    return { kind: "unavailable" };
  if (c.is_im === true || c.is_mpim === true) return { kind: "unavailable" };
  const kind =
    c.is_ext_shared !== false
      ? "ext_shared"
      : c.is_pending_ext_shared !== false
        ? "pending_ext_shared"
        : c.is_org_shared !== false
          ? "org_shared"
          : c.is_shared !== false
            ? "ext_shared"
            : c.is_private !== false
              ? "private"
              : "public";
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
  do {
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
