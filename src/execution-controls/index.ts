import { journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import { CommandBus, TERMINAL_WORK_ITEM_STATES } from "../core";
import {
  CLEANUP_BLOCKED_NOTICE,
  auditWorkspaceAccess,
  deadDeliveryIsFinalStop,
  deadDeliveryItemId,
  getConversation,
  getLinearSession,
  getWorkItem,
  getWorkspace,
  parseDeadDeliveryRef,
  resumeUsagePauseNow,
  retryDeadDelivery,
  submitCommand,
  usagePause,
  workspaceMember,
  workspaceSessionIds,
} from "../db";
import type { WorkspacePrincipal } from "../workspace";

export type ExecutionControlPort = {
  pauseItem(itemId: string, canAct?: () => boolean, onCommitted?: () => void): Promise<boolean>;
  resumeItem(itemId: string, canAct?: () => boolean, onCommitted?: () => void): Promise<boolean>;
  interruptItem(itemId: string): Promise<void>;
  /** A person vouches that the item's old agent is gone; clears its conversation block. */
  clearStuckAgent(
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
    options: { stoppedSession?: boolean } = {},
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
      item &&
      session &&
      workspace &&
      client &&
      (session.stoppedAt === null || options.stoppedSession === true) &&
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
            Object.keys(body).some((key) => !["itemId", "action", "target"].includes(key))
          )
            throw new Error();
        } catch (caughtError1) {
          journalCaught(caughtError1, "execution-controls.handle.getReader", null);
          return Response.json(
            { error: "Send an itemId and action as bounded JSON." },
            { status: 400 },
          );
        }
      }
      // Retry names a dead outbox row or job; the item is the one that row belongs to.
      const retryRef =
        request.method === "POST" && body["action"] === "retry"
          ? parseDeadDeliveryRef(body["target"])
          : null;
      if (request.method === "POST" && body["action"] === "retry" && retryRef === null)
        return Response.json(
          { error: "Send the dead delivery to retry as outbox:<id> or job:<id>." },
          { status: 400 },
        );
      const itemId =
        retryRef !== null
          ? deadDeliveryItemId(input.db, retryRef)
          : request.method === "GET"
            ? url.searchParams.get("itemId")
            : body["itemId"];
      // A dead final Stop delivery belongs to a stopped session; retrying it resumes nothing.
      const stoppedSession = retryRef !== null && deadDeliveryIsFinalStop(input.db, retryRef);
      const item =
        typeof itemId === "string"
          ? authorized(itemId, principal, sessionIds, { stoppedSession })
          : null;
      // The dashboard asks for every item it shows; "none" is an answer, not a denial.
      if (!item && request.method === "GET")
        return Response.json(
          { available: true, itemId, actions: [] },
          { headers: { "Cache-Control": "no-store" } },
        );
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
      if (retryRef !== null) {
        if (!retryDeadDelivery(input.db, item.id, retryRef, now()))
          return Response.json(
            {
              error:
                "This delivery is no longer stopped, or belongs to an earlier state of the issue. Refresh the run.",
            },
            { status: 409 },
          );
        auditWorkspaceAccess(input.db, {
          workspaceId: principal.workspaceId,
          userId: principal.userId,
          action: "execution.retry",
          subject: item.id,
          now: now(),
        });
        return Response.json({ applied: true, itemId: item.id, action: "retry" });
      }
      const port = input.getPort(principal.workspaceId);
      const blocked = getConversation(input.db, item.id).blocked;
      // Only an admin may vouch that the old agent is gone: a wrong call runs two.
      const vouches = () =>
        workspaceMember(input.db, principal.workspaceId, principal.userId)?.role === "admin";
      const actions = [
        ...((TERMINAL_WORK_ITEM_STATES as readonly string[]).includes(item.state)
          ? []
          : [
              "stop",
              ...(item.currentRunId && usagePause(input.db, item.currentRunId)
                ? ["resume_now"]
                : item.state === "running"
                  ? ["pause"]
                  : item.state === "paused"
                    ? ["resume"]
                    : []),
            ]),
        ...(blocked && vouches() ? ["clear_stuck_agent"] : []),
      ];
      if (request.method === "GET")
        return Response.json(
          {
            available: port !== null,
            itemId,
            actions: port ? actions : [],
            ...(blocked ? { notice: CLEANUP_BLOCKED_NOTICE } : {}),
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      const action = body["action"];
      if (!port)
        return Response.json(
          { error: "Execution controls are not ready. Try again." },
          { status: 503 },
        );
      if (action === "clear_stuck_agent" && !vouches()) {
        auditWorkspaceAccess(input.db, {
          workspaceId: principal.workspaceId,
          userId: principal.userId,
          action: "access.denied",
          subject: `execution.clear_stuck_agent:${item.id}`,
          now: now(),
        });
        return Response.json(
          { error: "Only a workspace admin can clear a stuck agent." },
          { status: 403 },
        );
      }
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
        } else if (action === "clear_stuck_agent") {
          applied = await port.clearStuckAgent(item.id, () => vouches() && canAct(), onCommitted);
        } else if (action === "resume_now") {
          applied = canAct() && resumeUsagePauseNow(input.db, item.currentRunId!, now());
          if (applied) onCommitted();
        } else
          applied = await port[action === "pause" ? "pauseItem" : "resumeItem"](
            item.id,
            canAct,
            onCommitted,
          );
      } catch (caughtError2) {
        journalCaught(caughtError2, "execution-controls.handle.immediate", item.id);
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
