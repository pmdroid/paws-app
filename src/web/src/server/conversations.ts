import type { Database } from "bun:sqlite";
import { readLinearConversations } from "../live/conversations";
import { dashboardOrigin } from "./request-origin";

export function handleLinearConversationsRequest(
  request: Request,
  db?: Database,
  sessionIds?: readonly string[],
  trustedOrigin?: string,
): Response | null {
  const url = new URL(request.url);
  if (url.pathname !== "/api/linear/conversations") return null;
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  if (!dashboardOrigin(request, trustedOrigin))
    return new Response("Forbidden", { status: 403, headers });
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers });
  return Response.json(
    { sessions: db ? readLinearConversations(db, sessionIds) : [] },
    { headers },
  );
}
