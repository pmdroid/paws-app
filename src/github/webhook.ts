import { createHmac, timingSafeEqual } from "node:crypto";

export type SignatureCheck =
  | { ok: true }
  | {
      ok: false;
      reason: "missing_signature" | "missing_secret" | "invalid_signature";
    };

export type GitHubWebhook = {
  accept: (delivery: { deliveryId: string; event: string; payload: string }) => void;
};

export function checkGitHubSignature(input: {
  signature: string | null;
  secret: string | null;
  body?: Uint8Array;
}): SignatureCheck {
  if (!input.signature) return { ok: false, reason: "missing_signature" };
  if (!input.secret) return { ok: false, reason: "missing_secret" };
  if (!input.body || !/^sha256=[a-f0-9]{64}$/.test(input.signature))
    return { ok: false, reason: "invalid_signature" };
  const expected = `sha256=${createHmac("sha256", input.secret).update(input.body).digest("hex")}`;
  return timingSafeEqual(Buffer.from(input.signature), Buffer.from(expected))
    ? { ok: true }
    : { ok: false, reason: "invalid_signature" };
}

export async function handleGitHubWebhook(
  request: Request,
  secret: string | null,
  inbox?: GitHubWebhook,
): Promise<Response> {
  const signature = request.headers.get("x-hub-signature-256");
  if (!signature || !secret) {
    return Response.json(
      { ok: false, reason: !signature ? "missing_signature" : "missing_secret" },
      { status: 401 },
    );
  }
  const body = new Uint8Array(await request.arrayBuffer());
  const check = checkGitHubSignature({ signature, secret, body });
  if (!check.ok) return Response.json(check, { status: 401 });
  const deliveryId = request.headers.get("x-github-delivery");
  const event = request.headers.get("x-github-event");
  if (!deliveryId || !event)
    return Response.json({ ok: false, reason: "missing_delivery" }, { status: 400 });
  const payload = Buffer.from(body).toString("utf8");
  try {
    JSON.parse(payload);
  } catch {
    return Response.json({ ok: false, reason: "invalid_payload" }, { status: 400 });
  }
  if (!inbox) return Response.json({ ok: false, reason: "inbox_unavailable" }, { status: 503 });
  try {
    inbox.accept({ deliveryId, event, payload });
  } catch {
    return Response.json({ ok: false, reason: "inbox_unavailable" }, { status: 503 });
  }
  return Response.json({ ok: true });
}
