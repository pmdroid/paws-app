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
import { CommandBus, TERMINAL_WORK_ITEM_STATES } from "../core";
import type { WorkspacePrincipal } from "../workspace";

export type ExecutionControlPort = {
  pauseItem(itemId: string, canAct?: CanAct, onCommitted?: OnCommitted): Promise<boolean>;
  resumeItem(itemId: string, canAct?: CanAct, onCommitted?: OnCommitted): Promise<boolean>;
  interruptItem(itemId: string): Promise<void>;
  clearStuckAgent(itemId: string, canAct?: CanAct, onCommitted?: OnCommitted): Promise<boolean>;
};

export type CanAct = (q: Q) => Steps<boolean>;
export type OnCommitted = (q: Q) => Steps<void>;

export type ExecutionControlCaller = {
  principal: WorkspacePrincipal;
  sessionIds: readonly string[];
};

export type ExecutionControlView = {
  itemId: string;
  available: boolean;
  actions: string[];
  notice?: string;
};

export type ExecutionControlResult =
  | { status: "applied"; itemId: string; action: string }
  | {
      status:
        | "denied"
        | "not_ready"
        | "admin_only"
        | "unavailable"
        | "changed"
        | "unconfirmed"
        | "stale_delivery"
        | "invalid_target";
    };

export type ExecutionControlRequest = {
  itemId: string;
  action: string;
  expectedVersion?: number;
  allowed?: readonly string[];
};

export function createExecutionControlsCore(input: {
  db: Db;
  bus: CommandBus;
  getPort: (workspaceId: string) => ExecutionControlPort | null;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;
  const store = input.db;
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
  const deny = async (principal: WorkspacePrincipal): Promise<ExecutionControlResult> => {
    await audit({
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action: "access.denied",
      subject: "execution-controls",
      now: now(),
    });
    return { status: "denied" };
  };
  function vouchesSteps(principal: WorkspacePrincipal) {
    return function* (q: Q): Steps<boolean> {
      return (
        (yield* workspaceMemberSteps(q, principal.workspaceId, principal.userId))?.role === "admin"
      );
    };
  }
  async function offered(principal: WorkspacePrincipal, item: WorkItemRecord) {
    const blocked = (await store.run((q) => getConversationSteps(q, item.id))).blocked;
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
      ...(blocked && (await store.run(vouchesSteps(principal))) ? ["clear_stuck_agent"] : []),
    ];
    return { blocked, actions };
  }
  return {
    async read(caller: ExecutionControlCaller, itemId: string): Promise<ExecutionControlView> {
      const { principal, sessionIds } = caller;
      const item = await store.run((q) => authorizedSteps(q, itemId, principal, sessionIds));
      if (!item) return { itemId, available: true, actions: [] };
      const port = input.getPort(principal.workspaceId);
      const { blocked, actions } = await offered(principal, item);
      return {
        itemId,
        available: port !== null,
        actions: port ? actions : [],
        ...(blocked ? { notice: CLEANUP_BLOCKED_NOTICE } : {}),
      };
    },
    async apply(
      caller: ExecutionControlCaller,
      request: ExecutionControlRequest,
    ): Promise<ExecutionControlResult> {
      const { principal, sessionIds } = caller;
      const { action } = request;
      if (request.allowed !== undefined && !request.allowed.includes(action))
        return { status: "unavailable" };
      const item = await store.run((q) =>
        authorizedSteps(q, request.itemId, principal, sessionIds),
      );
      if (!item) return deny(principal);
      if (request.expectedVersion !== undefined && request.expectedVersion !== item.version)
        return { status: "changed" };
      const port = input.getPort(principal.workspaceId);
      const { actions } = await offered(principal, item);
      if (!port) return { status: "not_ready" };
      const vouches = vouchesSteps(principal);
      if (action === "clear_stuck_agent" && !(await store.run(vouches))) {
        await audit({
          workspaceId: principal.workspaceId,
          userId: principal.userId,
          action: "access.denied",
          subject: `execution.clear_stuck_agent:${item.id}`,
          now: now(),
        });
        return { status: "admin_only" };
      }
      if (!actions.includes(action)) return { status: "unavailable" };
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
              return (yield* vouches(q)) && (yield* canAct(q));
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
        return { status: "unconfirmed" };
      }
      if (!applied) return { status: "changed" };
      return { status: "applied", itemId: item.id, action };
    },
    async retry(caller: ExecutionControlCaller, target: unknown): Promise<ExecutionControlResult> {
      const { principal, sessionIds } = caller;
      const retryRef = parseDeadDeliveryRef(target);
      if (retryRef === null) return { status: "invalid_target" };
      const itemId = await store.run((q) => deadDeliveryItemIdSteps(q, retryRef));
      const stoppedSession = await store.run((q) => deadDeliveryIsFinalStopSteps(q, retryRef));
      const item =
        typeof itemId === "string"
          ? await store.run((q) =>
              authorizedSteps(q, itemId, principal, sessionIds, { stoppedSession }),
            )
          : null;
      if (!item) return deny(principal);
      if (!(await store.transaction((q) => retryDeadDeliverySteps(q, item.id, retryRef, now()))))
        return { status: "stale_delivery" };
      await audit({
        workspaceId: principal.workspaceId,
        userId: principal.userId,
        action: "execution.retry",
        subject: item.id,
        now: now(),
      });
      return { status: "applied", itemId: item.id, action: "retry" };
    },
  };
}

export type ExecutionControlsCore = ReturnType<typeof createExecutionControlsCore>;
