import { journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import { isTerminalWorkItemState, type LinearCommand, type WorkItemState } from "../core";
import {
  issueItemsCreatedBySteps,
  applyLinearCommandSteps,
  mergeCallInFlightSteps,
  changeLinearTeamAccessSteps,
  commandInstance,
  completeMergedItemSteps,
  emitJobReady,
  getConfirmedRemoteMergeSteps,
  getItemPullRequestSteps,
  getWorkItemSteps,
  journal,
  advanceLinearSessionGenerationSteps,
  dropLinearSessionDeliveriesSteps,
  getLinearSessionAccessSteps,
  getLinearSessionSteps,
  getLinearInstallationPermissionsSteps,
  listLinearInstallationSessionsSteps,
  hasLinearNotificationSteps,
  linearSessionsForDelegatedTeamsSteps,
  linearSessionsForUndelegatedIssueSteps,
  listWorkItemsSteps,
  recordLinearNotificationSteps,
  revokeLinearInstallationSteps,
  sqliteDb,
  type Db,
  type Q,
  type Steps,
} from "../db";
import {
  parseLinearAdministration,
  type AcceptedLinearEvent,
  type LinearAdministration,
  type LinearIssueClosed,
} from "../linear";
import { worktreeBranch } from "./sources";

const notifications = new WeakMap<Database, Map<string, Promise<void>>>();

/** Where commands applied in a transaction forward from, and whether a job became ready. */
type CommandContext = { self: string | undefined; notifications: { ready: boolean } };

export async function handleLinearAdministration(
  db: Database,
  event: AcceptedLinearEvent,
  options: {
    oauthClientId: string | null;
    appUserId: string | null;
    notify: (command: LinearCommand) => void;
    interrupt?: (sessionId: string) => Promise<void>;
    revalidate?: (sessionIds: readonly string[]) => Promise<void>;
    reconcile?: (
      notification: Extract<LinearAdministration, { kind: "notification" }>,
    ) => Promise<void>;
  },
): Promise<boolean> {
  const administration = parseLinearAdministration(event);
  if (administration === null) return false;
  const store = sqliteDb(db);
  if (options.oauthClientId === null || administration.oauthClientId !== options.oauthClientId)
    return true;
  if (
    administration.kind !== "revoked" &&
    options.appUserId !== null &&
    options.appUserId !== administration.appUserId
  )
    return true;
  if (administration.kind === "notification") {
    if (await store.run((q) => hasLinearNotificationSteps(q, administration))) return true;
    if (options.reconcile === undefined)
      throw new Error("Linear notification reconciliation is unavailable.");
    let pending = notifications.get(db);
    if (pending === undefined) {
      pending = new Map();
      notifications.set(db, pending);
    }
    const key = JSON.stringify([
      administration.organizationId,
      administration.oauthClientId,
      administration.appUserId,
      administration.notificationId,
    ]);
    let work = pending.get(key);
    if (work === undefined) {
      work = Promise.resolve()
        .then(async () => {
          if (administration.action === "issueUnassignedFromYou")
            await stopUndelegatedIssue(db, administration, options);
        })
        .then(() => options.reconcile?.(administration))
        .then(async () => {
          await store.run((q) => recordLinearNotificationSteps(q, administration));
        })
        .finally(() => {
          pending.delete(key);
        });
      pending.set(key, work);
    }
    await work;
    return true;
  }
  const context: CommandContext = {
    self: commandInstance(db),
    notifications: { ready: false },
  };
  const { commands, stopped } = await store.transaction(function* (q) {
    const sessions =
      administration.kind === "revoked"
        ? yield* revokeLinearInstallationSteps(q, { ...administration, eventKey: event.dedupeKey })
        : yield* changeLinearTeamAccessSteps(q, { ...administration, eventKey: event.dedupeKey });
    const affected = new Set<string>();
    for (const id of [
      ...sessions,
      ...(yield* listLinearInstallationSessionsSteps(q, administration)),
    ])
      if (
        (yield* getLinearSessionAccessSteps(q, id)) ===
        (administration.kind === "revoked" ? "revoked" : "team_removed")
      )
        affected.add(id);
    if (administration.kind === "teams")
      for (const id of yield* linearSessionsForDelegatedTeamsSteps(q, {
        ...administration,
        teamIds: administration.removedTeamIds,
      }))
        affected.add(id);
    const cancelled = yield* cancelSessionsSteps(q, affected, administration.createdAtMs, context);
    if (administration.kind === "revoked")
      for (const id of affected) yield* dropLinearSessionDeliveriesSteps(q, id);
    return { commands: cancelled, stopped: affected };
  });
  if (context.notifications.ready) emitJobReady(store);
  await deliver(store, commands, stopped, options);
  if (
    administration.kind === "teams" &&
    !administration.canAccessAllPublicTeams &&
    (await store.run((q) => getLinearInstallationPermissionsSteps(q, administration)))
      ?.canAccessAllPublicTeams === false
  ) {
    const affected = await store.run((q) => listLinearInstallationSessionsSteps(q, administration));
    if (affected.length > 0) {
      if (options.revalidate === undefined)
        throw new Error("Linear permission reconciliation is unavailable.");
      await options.revalidate(affected);
    }
  }
  return true;
}

export async function stopUndelegatedIssue(
  db: Database,
  undelegation: {
    organizationId: string;
    appUserId: string;
    issueId: string;
    createdAtMs: number;
  },
  options: {
    notify: (command: LinearCommand) => void;
    interrupt?: (sessionId: string) => Promise<void>;
  },
): Promise<void> {
  const store = sqliteDb(db);
  const context: CommandContext = {
    self: commandInstance(db),
    notifications: { ready: false },
  };
  const { commands, stopped } = await store.transaction(function* (q) {
    const affected = new Set(yield* linearSessionsForUndelegatedIssueSteps(q, undelegation));
    const cancelled = yield* cancelSessionsSteps(q, affected, undelegation.createdAtMs, context);
    return { commands: cancelled, stopped: affected };
  });
  if (context.notifications.ready) emitJobReady(store);
  await deliver(store, commands, stopped, options);
}

export const ISSUE_CLOSED_RESPONSE = {
  completed: "Closed: the issue was completed outside this task.",
  canceled: "Closed: the issue was canceled in Linear.",
} as const;

export type ClosedIssueTask = {
  itemId: string;
  outcome: "merged" | "cancelled";
};

/**
 * The issue moved to Done or Canceled in Linear. Every task of that issue that is still open,
 * failed tasks included, closes too, using only what the event delivered. A task whose own
 * branch has a confirmed merge completes as merged. Any other task is cancelled, its session
 * gets one response that completes it, and the journal says why. Tasks created after the issue
 * closed belong to a later delegation and stay. A task in the merge queue without a confirmed
 * merge is cancelled too: the cancel stops its merge job, and the stopped-pull job closes its
 * pull request unless a merge was recorded for it by then. An issue moved to Canceled or
 * Duplicate closes the task's open pull request in any state, with a comment that says why.
 */
export async function closeClosedIssueTasks(
  db: Database,
  closed: LinearIssueClosed,
  options: {
    notify: (command: LinearCommand) => void;
    interrupt?: (sessionId: string) => Promise<void>;
    now?: () => number;
  },
): Promise<ClosedIssueTask[]> {
  const store = sqliteDb(db);
  const context: CommandContext = {
    self: commandInstance(db),
    notifications: { ready: false },
  };
  const now = options.now?.() ?? Date.now();
  const response = ISSUE_CLOSED_RESPONSE[closed.stateType];
  const status = closed.stateType === "completed" ? "Done" : "Canceled";
  const commands: LinearCommand[] = [];
  const sessions = new Set<string>();
  const results = await store.transaction(function* (q) {
    const outcomes: ClosedIssueTask[] = [];
    for (const row of yield* openIssueTasksSteps(q, closed)) {
      const label = `item ${row.identifier}`;
      if (
        row.state === "merge_queue" &&
        (yield* getConfirmedRemoteMergeSteps(q, row.id)) !== null
      ) {
        if ((yield* completeMergedItemSteps(q, { itemId: row.id, now })) !== null) {
          journal(`${label} merged: its Linear issue moved to ${status}`);
          outcomes.push({ itemId: row.id, outcome: "merged" });
          continue;
        }
      }
      const command: LinearCommand = {
        type: "cancel",
        itemId: row.id,
        source: "linear",
        requestedAt: now,
      };
      const result =
        closed.stateType === "canceled"
          ? yield* cancelWithPullSteps(q, command, now, context)
          : yield* applyLinearCommandSteps(
              q,
              command,
              now,
              response,
              {},
              context.self,
              context.notifications,
            );
      if (result.deferred) continue;
      if (!result.applied) throw new Error(`Could not close Linear task ${row.id}`);
      journal(`${label} cancelled: its Linear issue moved to ${status} outside this task`);
      commands.push(command);
      if (row.sessionKey !== null) sessions.add(row.sessionKey);
      outcomes.push({ itemId: row.id, outcome: "cancelled" });
    }
    return outcomes;
  });
  if (context.notifications.ready) emitJobReady(store);
  await deliver(store, commands, sessions, options);
  return results;
}

/** The cancel for an issue canceled in Linear: it closes the pull request and says so. */
function* cancelWithPullSteps(
  q: Q,
  command: LinearCommand,
  now: number,
  context: CommandContext,
): Steps<{ applied: boolean; deferred?: boolean }> {
  const item = yield* getWorkItemSteps(q, command.itemId);
  const pull = yield* getItemPullRequestSteps(q, command.itemId);
  if (item === null) return { applied: false };
  const comment = `Closed because ${item.linearIdentifier} was canceled in Linear. The branch \`${worktreeBranch(item)}\` is kept.`;
  return pull === null
    ? yield* applyLinearCommandSteps(
        q,
        command,
        now,
        ISSUE_CLOSED_RESPONSE.canceled,
        { closePullRequest: { comment } },
        context.self,
        context.notifications,
      )
    : yield* applyLinearCommandSteps(
        q,
        command,
        now,
        `Canceled in Linear. PR #${pull.pullNumber} was closed; the branch is kept.`,
        { closePullRequest: { comment }, responseOnly: true },
        context.self,
        context.notifications,
      );
}

function* openIssueTasksSteps(
  q: Q,
  closed: LinearIssueClosed,
): Steps<{ id: string; identifier: string; state: WorkItemState; sessionKey: string | null }[]> {
  return (yield* issueItemsCreatedBySteps(q, closed.issueId, closed.closedAtMs))
    .map((row) => ({ ...row, state: row.state as WorkItemState }))
    .filter(
      (row) =>
        !isTerminalWorkItemState(row.state) &&
        (closed.organizationId === null ||
          row.organizationId === null ||
          row.organizationId === closed.organizationId),
    );
}

function* cancelSessionsSteps(
  q: Q,
  affected: ReadonlySet<string>,
  requestedAt: number,
  context: CommandContext,
): Steps<LinearCommand[]> {
  for (const id of affected)
    if ((yield* getLinearSessionSteps(q, id))?.stoppedAt == null)
      yield* advanceLinearSessionGenerationSteps(q, id, { stop: true, now: requestedAt });
  const commands: LinearCommand[] = [];
  for (const item of yield* listWorkItemsSteps(q)) {
    const sessionId = item.sessionKey;
    if (sessionId === null || !affected.has(sessionId) || isTerminalWorkItemState(item.state))
      continue;
    const command: LinearCommand = {
      type: "cancel",
      itemId: item.id,
      source: "linear",
      requestedAt,
    };
    const result = yield* applyLinearCommandSteps(
      q,
      command,
      requestedAt,
      undefined,
      {},
      context.self,
      context.notifications,
    );
    if (result.deferred) continue;
    if (!result.applied) throw new Error(`Could not cancel Linear task ${item.id}`);
    commands.push(command);
  }
  return commands;
}

function* sessionMergingSteps(q: Q, sessionId: string): Steps<boolean> {
  for (const item of yield* listWorkItemsSteps(q))
    if (item.sessionKey === sessionId && (yield* mergeCallInFlightSteps(q, item.id))) return true;
  return false;
}

async function deliver(
  store: Db,
  commands: readonly LinearCommand[],
  sessions: ReadonlySet<string>,
  options: {
    notify: (command: LinearCommand) => void;
    interrupt?: (sessionId: string) => Promise<void>;
  },
): Promise<void> {
  const failures: unknown[] = [];
  try {
    for (const command of commands) options.notify(command);
  } catch (error) {
    journalCaught(error, "linear-administration.deliver.notify", null);
    failures.push(error);
  }
  const interruptible: string[] = [];
  for (const id of sessions)
    if (!(await store.run((q) => sessionMergingSteps(q, id)))) interruptible.push(id);
  const results = await Promise.allSettled(
    interruptible.map(async (id) => options.interrupt?.(id)),
  );
  for (const result of results) if (result.status === "rejected") failures.push(result.reason);
  if (failures.length > 0) throw failures[0];
}
