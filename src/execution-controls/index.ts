import {
  workspaceMemberUsable,
  CLEANUP_BLOCKED_NOTICE,
  auditWorkspaceAccessSteps,
  commandInstance,
  deadDeliveryIsFinalStopSteps,
  deadDeliveryItemIdSteps,
  emitJobReady,
  getConversationSteps,
  getLinearSessionSteps,
  getWorkItemSteps,
  getWorkspaceSteps,
  linearSessionClientIdSteps,
  parseDeadDeliveryRef,
  resumeUsagePauseNowSteps,
  retryDeadDeliverySteps,
  storeOf,
  type Db,
  submitCommandSteps,
  usagePauseSteps,
  workspaceMemberSteps,
  workspaceSessionIdsSteps,
  type Q,
  type Steps,
  type WorkItemRecord,
} from "../db";
import { journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import { CommandBus, TERMINAL_WORK_ITEM_STATES } from "../core";
import type { WorkspacePrincipal } from "../workspace";

export type ExecutionControlPort = {
  pauseItem(itemId: string, canAct?: CanAct, onCommitted?: OnCommitted): Promise<boolean>;
  resumeItem(itemId: string, canAct?: CanAct, onCommitted?: OnCommitted): Promise<boolean>;
  interruptItem(itemId: string): Promise<void>;
  /** A person vouches that the item's old agent is gone; clears its conversation block. */
  clearStuckAgent(itemId: string, canAct?: CanAct, onCommitted?: OnCommitted): Promise<boolean>;
};

export type CanAct = (q: Q) => Steps<boolean>;
export type OnCommitted = (q: Q) => Steps<void>;

export function createExecutionControls(input: {
  db: Database | Db;
  bus: CommandBus;
  getPort: (workspaceId: string) => ExecutionControlPort | null;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;
  const store = storeOf(input.db);
  function* authorizedSteps(
    q: Q,
    itemId: string,
    principal: WorkspacePrincipal,
    sessionIds: readonly string[],
    options: { stoppedSession?: boolean } = {},
  ): Steps<WorkItemRecord | null> {
    const member = yield* workspaceMemberSteps(q, principal.workspaceId, principal.userId);
    const item = yield* getWorkItemSteps(q, itemId);
    const session = item?.sessionKey ? yield* getLinearSessionSteps(q, item.sessionKey) : null;
    const workspace = yield* getWorkspaceSteps(q, principal.workspaceId);
    const clientId = session ? yield* linearSessionClientIdSteps(q, session.sessionId) : null;
    return workspaceMemberUsable(member) &&
      item &&
      session &&
      workspace &&
      clientId &&
      (session.stoppedAt === null || options.stoppedSession === true || item.state === "paused") &&
      session.delegationId === item.delegationId &&
      session.organizationId === workspace.organizationId &&
      sessionIds.includes(session.sessionId) &&
      (yield* workspaceSessionIdsSteps(q, workspace.id, member.userId, clientId)).includes(
        session.sessionId,
      )
      ? item
      : null;
  }
  const audit = (entry: Parameters<typeof auditWorkspaceAccessSteps>[1]) =>
    store.run((q) => auditWorkspaceAccessSteps(q, entry));
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
          ? await store.run((q) => deadDeliveryItemIdSteps(q, retryRef))
          : request.method === "GET"
            ? url.searchParams.get("itemId")
            : body["itemId"];
      // A dead final Stop delivery belongs to a stopped session; retrying it resumes nothing.
      const stoppedSession =
        retryRef !== null && (await store.run((q) => deadDeliveryIsFinalStopSteps(q, retryRef)));
      const item =
        typeof itemId === "string"
          ? await store.run((q) =>
              authorizedSteps(q, itemId, principal, sessionIds, { stoppedSession }),
            )
          : null;
      // The dashboard asks for every item it shows; "none" is an answer, not a denial.
      if (!item && request.method === "GET")
        return Response.json(
          { available: true, itemId, actions: [] },
          { headers: { "Cache-Control": "no-store" } },
        );
      if (!item) {
        await audit({
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
        if (!(await store.transaction((q) => retryDeadDeliverySteps(q, item.id, retryRef, now()))))
          return Response.json(
            {
              error:
                "This delivery is no longer stopped, or belongs to an earlier state of the issue. Refresh the run.",
            },
            { status: 409 },
          );
        await audit({
          workspaceId: principal.workspaceId,
          userId: principal.userId,
          action: "execution.retry",
          subject: item.id,
          now: now(),
        });
        return Response.json({ applied: true, itemId: item.id, action: "retry" });
      }
      const port = input.getPort(principal.workspaceId);
      const blocked = (await store.run((q) => getConversationSteps(q, item.id))).blocked;
      // Only an admin may vouch that the old agent is gone: a wrong call runs two.
      function* vouchesSteps(q: Q): Steps<boolean> {
        return (
          (yield* workspaceMemberSteps(q, principal.workspaceId, principal.userId))?.role ===
          "admin"
        );
      }
      const vouches = () => store.run(vouchesSteps);
      const pause = item.currentRunId
        ? await store.run((q) => usagePauseSteps(q, item.currentRunId!))
        : null;
      const actions = [
        ...((TERMINAL_WORK_ITEM_STATES as readonly string[]).includes(item.state)
          ? []
          : [
              "stop",
              ...(pause
                ? ["resume_now"]
                : item.state === "running"
                  ? ["pause"]
                  : item.state === "paused"
                    ? ["resume"]
                    : []),
            ]),
        ...(blocked && (await vouches()) ? ["clear_stuck_agent"] : []),
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
      if (action === "clear_stuck_agent" && !(await vouches())) {
        await audit({
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
      const sessionGeneration = (await store.run((q) =>
        getLinearSessionSteps(q, item.sessionKey!),
      ))!.generation;
      const canAct = function* (q: Q): Steps<boolean> {
        const current = yield* authorizedSteps(q, item.id, principal, sessionIds);
        return (
          current !== null &&
          current.version === item.version &&
          current.currentRunId === item.currentRunId &&
          (yield* getLinearSessionSteps(q, item.sessionKey!))?.generation === sessionGeneration
        );
      };
      const onCommitted = function* (q: Q): Steps<void> {
        yield* auditWorkspaceAccessSteps(q, {
          workspaceId: principal.workspaceId,
          userId: principal.userId,
          action: `execution.${action}`,
          subject: item.id,
          now: now(),
        });
      };
      let applied: boolean;
      try {
        if (action === "stop") {
          let ready = false;
          applied = await store.transaction(function* (q) {
            if (!(yield* canAct(q))) return false;
            yield* onCommitted(q);
            const result = yield* submitCommandSteps(
              q,
              { type: "stop", source: "dashboard", itemId: item.id, requestedAt: now() },
              (command) => input.bus.emit(command),
              () => (ready = true),
              commandInstance(input.db),
            );
            if (!result.applied) throw new Error("Item changed before Stop committed");
            return true;
          });
          if (ready) emitJobReady(input.db);
          if (applied) await port.interruptItem(item.id);
        } else if (action === "clear_stuck_agent") {
          applied = await port.clearStuckAgent(
            item.id,
            function* (q) {
              return (yield* vouchesSteps(q)) && (yield* canAct(q));
            },
            onCommitted,
          );
        } else if (action === "resume_now") {
          applied = await store.transaction(function* (q) {
            if (!(yield* canAct(q))) return false;
            if (!(yield* resumeUsagePauseNowSteps(q, item.currentRunId!, now()))) return false;
            yield* onCommitted(q);
            return true;
          });
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
