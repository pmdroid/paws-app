export type SignatureCheck = {
  ok: false;
  reason: "missing_signature" | "missing_secret" | "not_implemented";
};

export type SignatureInput = {
  signature: string | null;
  secret: string | null;
};

/**
 * Fail closed. QM-03 replaces `not_implemented` with HMAC-SHA256 over the raw body
 * (`Linear-Signature`), rejects `webhookTimestamp` older than 60 seconds, dedupes
 * `Linear-Delivery`, and returns 200 only after the row commits.
 */
export function checkLinearSignature(input: SignatureInput): SignatureCheck {
  if (input.signature === null || input.signature.length === 0) {
    return { ok: false, reason: "missing_signature" };
  }
  if (input.secret === null || input.secret.length === 0) {
    return { ok: false, reason: "missing_secret" };
  }
  return { ok: false, reason: "not_implemented" };
}

export async function handleLinearWebhook(
  request: Request,
  secret: string | null,
): Promise<Response> {
  const check = checkLinearSignature({
    signature: request.headers.get("linear-signature"),
    secret,
  });
  return Response.json({ ok: false, reason: check.reason }, { status: 401 });
}
