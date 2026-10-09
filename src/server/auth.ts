import { timingSafeEqual } from "node:crypto";

export const DASHBOARD_CHALLENGE = 'Basic realm="paws", Bearer realm="paws"';

/**
 * Dashboard auth for a public listener.
 * Local mode with no token stays open. Hosted mode with no token fails closed.
 * A configured `PAWS_DASHBOARD_TOKEN` accepts `Authorization: Bearer` or HTTP Basic
 * (the password is the token; an empty password uses the username).
 */
export function dashboardAuthorized(
  request: Request,
  token: string | null,
  hosted: boolean,
): boolean {
  if (token === null || token.length === 0) return !hosted;
  const header = request.headers.get("authorization");
  if (header === null) return false;
  const bearer = /^Bearer\s+(\S.*)$/i.exec(header);
  if (bearer?.[1] && safeEqual(bearer[1].trim(), token)) return true;
  if (/^Basic\s+/i.test(header)) {
    const credentials = basicCredentials(header);
    if (credentials === null) return false;
    if (credentials.password.length > 0 && safeEqual(credentials.password, token)) return true;
    if (credentials.password.length === 0 && safeEqual(credentials.username, token)) return true;
  }
  return false;
}

export function unauthorized(): Response {
  return Response.json(
    { ok: false, reason: "unauthorized" },
    {
      status: 401,
      headers: { "www-authenticate": DASHBOARD_CHALLENGE, "cache-control": "no-store" },
    },
  );
}

function basicCredentials(header: string): { username: string; password: string } | null {
  const match = /^Basic\s+([A-Za-z0-9+/=_-]+)$/i.exec(header.trim());
  if (!match?.[1]) return null;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const index = decoded.indexOf(":");
  if (index === -1) return null;
  return { username: decoded.slice(0, index), password: decoded.slice(index + 1) };
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
