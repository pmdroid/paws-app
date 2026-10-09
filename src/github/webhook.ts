export type SignatureCheck = {
  ok: false;
  reason: "missing_signature" | "missing_secret" | "not_implemented";
};

/**
 * Fail closed. The real check is HMAC-SHA256 of the raw body in `X-Hub-Signature-256`,
 * then dedupe on `X-GitHub-Delivery`, then 200 after commit.
 */
export function checkGitHubSignature(input: {
  signature: string | null;
  secret: string | null;
}): SignatureCheck {
  if (input.signature === null || input.signature.length === 0) {
    return { ok: false, reason: "missing_signature" };
  }
  if (input.secret === null || input.secret.length === 0) {
    return { ok: false, reason: "missing_secret" };
  }
  return { ok: false, reason: "not_implemented" };
}

export async function handleGitHubWebhook(
  request: Request,
  secret: string | null,
): Promise<Response> {
  const check = checkGitHubSignature({
    signature: request.headers.get("x-hub-signature-256"),
    secret,
  });
  return Response.json({ ok: false, reason: check.reason }, { status: 401 });
}
