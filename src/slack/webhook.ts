import { journalCaught } from "../journal";
import { readWebhookBody } from "../webhook-body";
import { createHmac, timingSafeEqual } from "node:crypto";

export async function handleSlackWebhook(
  request: Request,
  secret: string | null,
  now = Date.now(),
  revoke?: (event: { teamId: string; appId: string | null }) => Promise<boolean>,
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
  const revocation = lifecycleRevocation(payload);
  if (revocation && revoke) {
    await revoke(revocation);
    return new Response(null, { status: 200 });
  }
  return new Response("Unsupported Slack event.", { status: 400 });
}

function lifecycleRevocation(payload: unknown): { teamId: string; appId: string | null } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const body = payload as Record<string, unknown>;
  const event = body.event as Record<string, unknown> | undefined;
  if (body.type !== "event_callback" || typeof body.team_id !== "string" || !event) return null;
  const tokens = event.tokens as { bot?: unknown } | undefined;
  const revoked =
    event.type === "app_uninstalled" ||
    (event.type === "tokens_revoked" && Array.isArray(tokens?.bot) && tokens.bot.length > 0);
  if (!revoked) return null;
  return {
    teamId: body.team_id,
    appId: typeof body.api_app_id === "string" ? body.api_app_id : null,
  };
}
