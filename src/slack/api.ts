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

export async function slackChannelAudience(
  call: SlackCall,
  channelId: string,
  signal: AbortSignal,
): Promise<"internal" | "external" | "unavailable"> {
  const data = await call("conversations.info", { channel: channelId }, signal).catch(
    (caught: unknown) => {
      if (caught instanceof SlackApiError && GONE.has(caught.code)) return null;
      throw caught;
    },
  );
  const c = (data?.channel ?? null) as Record<string, unknown> | null;
  if (c?.id !== channelId || c.is_archived === true || c.is_channel !== true) return "unavailable";
  if (c.is_private === true || c.is_im === true || c.is_mpim === true) return "unavailable";
  const shared = [c.is_shared, c.is_ext_shared, c.is_org_shared].some((flag) => flag !== false);
  return shared || c.is_pending_ext_shared === true ? "external" : "internal";
}
