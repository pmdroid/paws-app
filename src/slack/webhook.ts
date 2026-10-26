import { journalCaught } from "../journal";
import { createHmac, timingSafeEqual } from "node:crypto";

export async function handleSlackWebhook(
  request: Request,
  secret: string | null,
  now = Date.now(),
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
  const raw = Buffer.from(await request.arrayBuffer());
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
  return new Response("Unsupported Slack event.", { status: 400 });
}
