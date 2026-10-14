import type { Database } from "bun:sqlite";
import { changeDecision, decisionAnswers, listDecisions } from "../decisions";
import type { WorkspaceSession } from "../db";
import { readWorkspaceJson } from "./administration";
import { requestWorkspaceSession, validWorkspaceCsrf, type WorkspacePrincipal } from "./session";

export async function handleDecisions(
  request: Request,
  options: {
    db: Database;
    principal: WorkspacePrincipal;
    session: WorkspaceSession;
    origin: string;
    clientId: string;
    now: () => number;
  },
): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/api/workspaces/decisions") return null;
  const json = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { "cache-control": "no-store" } });
  const actor = { ...options.principal, clientId: options.clientId };
  if (request.method === "GET")
    return json({
      decisions: listDecisions(
        options.db,
        actor,
        new URL(request.url).searchParams.get("search")?.slice(0, 1000),
      ),
      answers: decisionAnswers(options.db, actor),
    });
  if (request.method !== "POST") return json({ error: "Use GET or POST." }, 405);
  if (
    request.headers.get("origin") !== options.origin ||
    !validWorkspaceCsrf(request, options.session)
  )
    return json({ error: "CSRF token required." }, 403);
  try {
    const body = await readWorkspaceJson(request);
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some(
        (key) =>
          !["questionId", "id", "revision", "retire", "statement", "scopeGlobs", "tags"].includes(
            key,
          ),
      )
    )
      throw new Error("Choose a confirmed answer or an existing decision.");
    const value = body as Record<string, unknown>;
    if (
      (value["id"] !== undefined && typeof value["id"] !== "string") ||
      (value["questionId"] !== undefined && typeof value["questionId"] !== "string") ||
      (value["revision"] !== undefined && !Number.isSafeInteger(value["revision"])) ||
      (value["retire"] !== undefined && typeof value["retire"] !== "boolean")
    )
      throw new Error("Invalid decision fields.");
    const current = requestWorkspaceSession(options.db, request, options.now());
    if (
      !current ||
      current.principal.workspaceId !== actor.workspaceId ||
      current.principal.userId !== actor.userId
    )
      return json({ error: "Sign in again before saving a decision." }, 401);
    const id = changeDecision(options.db, actor, value, options.now());
    return json({ id });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : "The decision could not be saved." },
      400,
    );
  }
}
