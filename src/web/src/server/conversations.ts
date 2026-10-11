import type { Database } from "bun:sqlite";
import { readLinearConversations } from "../live/conversations";

export function handleLinearConversationsRequest(request: Request, db?: Database): Response | null {
  const url = new URL(request.url);
  if (url.pathname !== "/api/linear/conversations") return null;
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    (request.headers.has("host") &&
      request.headers.get("host")?.toLowerCase() !== url.host.toLowerCase()) ||
    (request.headers.has("origin") && request.headers.get("origin") !== url.origin) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    return new Response("Forbidden", { status: 403, headers });
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers });
  return Response.json({ sessions: db ? readLinearConversations(db) : [] }, { headers });
}
