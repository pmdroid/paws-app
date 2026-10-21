import type { Database } from "bun:sqlite";
import { CommandBus, TERMINAL_WORK_ITEM_STATES } from "../core";
import {
  auditWorkspaceAccess,
  getLinearSession,
  getUsageLimitPause,
  getWorkItem,
  getWorkspace,
  submitCommand,
  workspaceMember,
  workspaceSessionIds,
} from "../db";
import type { WorkspacePrincipal } from "../workspace";

export type ExecutionControlPort = {
  pauseItem(itemId: string, canAct?: () => boolean, onCommitted?: () => void): Promise<boolean>;
  resumeItem(itemId: string, canAct?: () => boolean, onCommitted?: () => void): Promise<boolean>;
  interruptItem(itemId: string): Promise<void>;
  resumeUsageLimit(
    itemId: string,
    canAct?: () => boolean,
    onCommitted?: () => void,
  ): Promise<boolean>;
};

export function createExecutionControls(input: {
  db: Database;
  bus: CommandBus;
  getPort: (workspaceId: string) => ExecutionControlPort | null;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;
  function authorized(
    itemId: string,
    principal: WorkspacePrincipal,
    sessionIds: readonly string[],
  ) {
    const member = workspaceMember(input.db, principal.workspaceId, principal.userId);
    const item = getWorkItem(input.db, itemId);
    const session = item?.sessionKey ? getLinearSession(input.db, item.sessionKey) : null;
    const workspace = getWorkspace(input.db, principal.workspaceId);
    const client = session
      ? input.db
          .query<{ id: string }, [string]>(
            "SELECT oauth_client_id AS id FROM linear_session WHERE session_id=?",
          )
          .get(session.sessionId)
      : null;
    return member?.active &&
      member.role !== "observer" &&
      item &&
      session &&
      workspace &&
      client &&
      session.stoppedAt === null &&
      session.delegationId === item.delegationId &&
      session.organizationId === workspace.organizationId &&
      sessionIds.includes(session.sessionId) &&
      workspaceSessionIds(input.db, workspace.id, member.userId, client.id).includes(
        session.sessionId,
      )
      ? item
      : null;
  }
  return {
    async handle(
      request: Request,
      principal: WorkspacePrincipal,
      sessionIds: readonly string[],
    ): Promise<Response | null> {
      const url = new URL(request.url);
      if (url.pathname !== "/api/execution-controls") return null;
      if (request.method !== "GET" && request.method !== "POST")
        return Response.json({ error: "Use GET or POST." }, { status: 405 });
      let body: Record<string, unknown> = {};
      if (request.method === "POST") {
        try {
          const reader = request.body?.getReader();
          if (!reader || !request.headers.get("content-type")?.startsWith("application/json"))
            throw new Error();
          const chunks: Uint8Array[] = [];
          let size = 0;
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > 4096) {
              await reader.cancel();
              throw new Error();
            }
            chunks.push(part.value);
          }
          body = JSON.parse(await new Blob(chunks).text());
          if (
            !body ||
            typeof body !== "object" ||
            Array.isArray(body) ||
            Object.keys(body).some((key) => !["itemId", "action"].includes(key))
          )
            throw new Error();
        } catch {
          return Response.json(
            { error: "Send an itemId and action as bounded JSON." },
            { status: 400 },
          );
        }
      }
      const itemId = request.method === "GET" ? url.searchParams.get("itemId") : body["itemId"];
      const item = typeof itemId === "string" ? authorized(itemId, principal, sessionIds) : null;
      if (!item) {
        auditWorkspaceAccess(input.db, {
          workspaceId: principal.workspaceId,
          userId: principal.userId,
          action: "access.denied",
          subject: "execution-controls",
          now: now(),
        });
        return Response.json(
          { error: "This item is not available to your workspace membership." },
          { status: 403 },
        );
      }
      const port = input.getPort(principal.workspaceId);
      const actions = (TERMINAL_WORK_ITEM_STATES as readonly string[]).includes(item.state)
        ? []
        : [
            "stop",
            ...(getUsageLimitPause(input.db, item.id)
              ? ["resume_now"]
              : item.state === "running"
                ? ["pause"]
                : item.state === "paused"
                  ? ["resume"]
                  : []),
          ];
      if (request.method === "GET")
        return Response.json(
          { available: port !== null, itemId, actions: port ? actions : [] },
          { headers: { "Cache-Control": "no-store" } },
        );
      const action = body["action"];
      if (!port)
        return Response.json(
          { error: "Execution controls are not ready. Try again." },
          { status: 503 },
        );
      if (typeof action !== "string" || !actions.includes(action))
        return Response.json(
          { error: "This action is no longer available. Refresh the run." },
          { status: 409 },
        );
      const sessionGeneration = getLinearSession(input.db, item.sessionKey!)!.generation;
      const canAct = () => {
        const current = authorized(item.id, principal, sessionIds);
        return (
          current !== null &&
          current.version === item.version &&
          current.currentRunId === item.currentRunId &&
          getLinearSession(input.db, item.sessionKey!)?.generation === sessionGeneration
        );
      };
      const onCommitted = () =>
        auditWorkspaceAccess(input.db, {
          workspaceId: principal.workspaceId,
          userId: principal.userId,
          action: `execution.${action}`,
          subject: item.id,
          now: now(),
        });
      let applied: boolean;
      try {
        if (action === "stop") {
          applied = input.db
            .transaction(() => {
              if (!canAct()) return false;
              onCommitted();
              const result = submitCommand(input.db, input.bus, {
                type: "stop",
                source: "dashboard",
                itemId: item.id,
                requestedAt: now(),
              });
              if (!result.applied) throw new Error("Item changed before Stop committed");
              return true;
            })
            .immediate();
          if (applied) await port.interruptItem(item.id);
        } else
          applied = await port[
            action === "pause"
              ? "pauseItem"
              : action === "resume_now"
                ? "resumeUsageLimit"
                : "resumeItem"
          ](item.id, canAct, onCommitted);
      } catch {
        return Response.json(
          { error: "Execution cleanup could not be confirmed. Refresh the run." },
          { status: 503 },
        );
      }
      if (!applied)
        return Response.json(
          { error: "The item changed. Refresh the run and try again." },
          { status: 409 },
        );
      return Response.json({ applied: true, itemId: item.id, action });
    },
  };
}
