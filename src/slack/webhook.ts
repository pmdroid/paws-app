import { journalCaught } from "../journal";
import { readWebhookBody } from "../webhook-body";
import { createHmac, timingSafeEqual } from "node:crypto";

export type SlackRevocation = {
  teamId: string;
  appId: string | null;
  /** Bot user ids whose tokens Slack revoked; null when the whole app was uninstalled. */
  botUserIds: string[] | null;
  /** When Slack says the event happened; a token saved after it belongs to a newer install. */
  eventTimeMs: number;
};

export type SlackMention = {
  teamId: string;
  appId: string | null;
  eventId: string;
  channelId: string;
  slackUserId: string;
  text: string;
  ts: string;
  threadTs: string;
  externallyShared: boolean;
};

export async function handleSlackWebhook(
  request: Request,
  secret: string | null,
  now = Date.now(),
  onRevoked?: (revocation: SlackRevocation) => Promise<unknown>,
  onMention?: (mention: SlackMention) => Promise<unknown>,
): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed.", { status: 405 });
  const signature = request.headers.get("x-slack-signature");
  const timestamp = request.headers.get("x-slack-request-timestamp");
  if (
    !secret ||
    !signature ||
    !/^v0=[a-f0-9]{64}$/.test(signature) ||
    !timestamp ||
    !/^\d+$/.test(timestamp) ||
    Math.abs(now / 1000 - Number(timestamp)) > 300
  )
    return new Response("Unauthorized.", { status: 401 });
  const raw = await readWebhookBody(request, 1024 * 1024);
  if (raw instanceof Response) return raw;
  const expected = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:`).update(raw).digest("hex")}`;
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected)))
    return new Response("Unauthorized.", { status: 401 });
  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch (caughtError1) {
    journalCaught(caughtError1, "webhook.handleSlackWebhook.parse", null);
    return new Response("Invalid Slack payload.", { status: 400 });
  }
  if (
    typeof payload === "object" &&
    payload !== null &&
    "type" in payload &&
    payload.type === "url_verification" &&
    "challenge" in payload &&
    typeof payload.challenge === "string"
  )
    return Response.json({ challenge: payload.challenge });
  const revocation = slackRevocation(payload);
  if (revocation && onRevoked) {
    await onRevoked(revocation);
    return new Response("ok", { status: 200 });
  }
  const mention = onMention && slackMention(payload);
  if (mention !== undefined) {
    if (mention) await onMention!(mention);
    return new Response("ok", { status: 200 });
  }
  return new Response("Unsupported Slack event.", { status: 400 });
}

function slackRevocation(payload: unknown): SlackRevocation | null {
  if (!isRecord(payload) || payload.type !== "event_callback" || !isRecord(payload.event))
    return null;
  const teamId = payload.team_id;
  if (typeof teamId !== "string" || teamId === "") return null;
  const appId = typeof payload.api_app_id === "string" ? payload.api_app_id : null;
  const time = payload.event_time;
  if (typeof time !== "number" || !Number.isFinite(time) || time <= 0) return null;
  const eventTimeMs = time * 1000;
  const event = payload.event;
  if (event.type === "app_uninstalled") return { teamId, appId, botUserIds: null, eventTimeMs };
  if (event.type !== "tokens_revoked" || !isRecord(event.tokens)) return null;
  const bot = event.tokens.bot;
  if (!Array.isArray(bot)) return null;
  const botUserIds = bot.filter((id): id is string => typeof id === "string");
  return botUserIds.length > 0 ? { teamId, appId, botUserIds, eventTimeMs } : null;
}

const ID = /^[A-Z0-9]{2,32}$/;
const TS = /^\d{9,12}\.\d{6}$/;

function slackMention(payload: unknown): SlackMention | null | undefined {
  if (!isRecord(payload) || payload.type !== "event_callback" || !isRecord(payload.event)) return;
  const event = payload.event as Record<string, string | undefined>;
  if (event.type === "message") return null;
  if (event.type !== "app_mention") return;
  const { team_id: teamId, event_id: eventId, api_app_id: appId } = payload;
  const { channel, user, text, ts, thread_ts: threadTs = ts } = event;
  const ids = [teamId, channel, user];
  if (event.subtype !== undefined || event.bot_id !== undefined || typeof text !== "string")
    return null;
  if (!ids.every((id) => typeof id === "string" && ID.test(id))) return null;
  if (!TS.test(ts ?? "") || !TS.test(threadTs ?? "")) return null;
  if (typeof eventId !== "string" || !/^Ev[A-Z0-9]{4,40}$/.test(eventId)) return null;
  return {
    teamId: teamId as string,
    appId: typeof appId === "string" ? appId : null,
    eventId,
    channelId: channel!,
    slackUserId: user!,
    text: text.slice(0, 8000),
    ts: ts!,
    threadTs: threadTs!,
    externallyShared: payload.is_ext_shared_channel !== false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
