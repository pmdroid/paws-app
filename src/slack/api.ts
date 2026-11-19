import type { SlackFetch } from "./oauth";

export class SlackRateLimitError extends Error {
  override readonly name = "SlackRateLimitError";
  constructor(
    readonly method: string,
    readonly retryAfterMs: number,
  ) {
    super(`Slack rate-limited ${method}; retrying after ${Math.ceil(retryAfterMs / 1000)}s.`);
  }
}

export class SlackApiError extends Error {
  override readonly name = "SlackApiError";
  constructor(
    readonly method: string,
    readonly code: string,
  ) {
    super(`Slack ${method} failed: ${code}.`);
  }
}

export type SlackCall = (
  method: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<Record<string, unknown>>;

const SLACK_ERROR_CODE = /^[a-z_]{1,64}$/;

export function slackCaller(fetchImpl: SlackFetch, token: string): SlackCall {
  return async (method, body, signal) => {
    const response = await fetchImpl(`https://slack.com/api/${method}`, {
      method: "POST",
      signal,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
    if (response.status === 429) {
      const seconds = Number(response.headers.get("retry-after"));
      const retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) : 30;
      throw new SlackRateLimitError(method, retryAfterMs * 1000);
    }
    if (!response.ok) throw new SlackApiError(method, `http_${response.status}`);
    const data: unknown = await response.json().catch(() => null);
    if (data === null || typeof data !== "object" || Array.isArray(data))
      throw new SlackApiError(method, "invalid_response");
    const record = data as Record<string, unknown>;
    if (record.ok !== true) {
      const code = typeof record.error === "string" ? record.error : "";
      throw new SlackApiError(method, SLACK_ERROR_CODE.test(code) ? code : "unknown_error");
    }
    return record;
  };
}

const GONE = new Set(["channel_not_found", "not_in_channel", "is_archived"]);

export type SlackAudience = "internal" | "external" | "unavailable";

export async function slackChannelAudience(
  call: SlackCall,
  channelId: string,
  signal: AbortSignal,
): Promise<SlackAudience> {
  let data: Record<string, unknown>;
  try {
    data = await call("conversations.info", { channel: channelId }, signal);
  } catch (caught) {
    if (caught instanceof SlackApiError && GONE.has(caught.code)) return "unavailable";
    throw caught;
  }
  const channel = data.channel;
  if (channel === null || typeof channel !== "object") return "unavailable";
  const c = channel as Record<string, unknown>;
  if (c.id !== channelId || c.is_archived === true) return "unavailable";
  if (c.is_im === true || c.is_mpim === true) return "unavailable";
  if (c.is_channel !== true || c.is_private === true) return "unavailable";
  if (
    c.is_shared !== false ||
    c.is_ext_shared !== false ||
    c.is_org_shared !== false ||
    c.is_pending_ext_shared === true
  )
    return "external";
  return "internal";
}
