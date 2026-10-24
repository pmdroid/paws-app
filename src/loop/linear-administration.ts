import type { Database } from "bun:sqlite";
import { isTerminalWorkItemState, type LinearCommand, type WorkItemState } from "../core";
import {
  applyLinearCommand,
  changeLinearTeamAccess,
  completeMergedItem,
  getConfirmedRemoteMerge,
  journal,
  advanceLinearSessionGeneration,
  dropLinearSessionDeliveries,
  getLinearSessionAccess,
  getLinearSession,
  getLinearInstallationPermissions,
  listLinearInstallationSessions,
  immediate,
  hasLinearNotification,
  linearSessionsForDelegatedTeams,
  linearSessionsForUndelegatedIssue,
  listWorkItems,
  recordLinearNotification,
  revokeLinearInstallation,
} from "../db";
import {
  parseLinearAdministration,
  type AcceptedLinearEvent,
  type LinearAdministration,
  type LinearIssueClosed,
} from "../linear";

const notifications = new WeakMap<Database, Map<string, Promise<void>>>();

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
  if (options.oauthClientId === null || administration.oauthClientId !== options.oauthClientId)
    return true;
  if (
    administration.kind !== "revoked" &&
    options.appUserId !== null &&
    options.appUserId !== administration.appUserId
  )
    return true;
  if (administration.kind === "notification") {
    if (hasLinearNotification(db, administration)) return true;
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
        .then(() => {
          recordLinearNotification(db, administration);
        })
        .finally(() => {
          pending.delete(key);
        });
      pending.set(key, work);
    }
    await work;
    return true;
  }
  let commands: LinearCommand[] = [];
  const stopped = immediate(db, () => {
    const sessions =
      administration.kind === "revoked"
        ? revokeLinearInstallation(db, { ...administration, eventKey: event.dedupeKey })
        : changeLinearTeamAccess(db, { ...administration, eventKey: event.dedupeKey });
    const affected = new Set(
      [...sessions, ...listLinearInstallationSessions(db, administration)].filter(
        (id) =>
          getLinearSessionAccess(db, id) ===
          (administration.kind === "revoked" ? "revoked" : "team_removed"),
      ),
    );
    if (administration.kind === "teams")
      for (const id of linearSessionsForDelegatedTeams(db, {
        ...administration,
        teamIds: administration.removedTeamIds,
      }))
        affected.add(id);
    commands = cancelSessions(db, affected, administration.createdAtMs);
    if (administration.kind === "revoked")
      for (const id of affected) dropLinearSessionDeliveries(db, id);
    return affected;
  });
  await deliver(commands, stopped, options);
  if (
    administration.kind === "teams" &&
    !administration.canAccessAllPublicTeams &&
    getLinearInstallationPermissions(db, administration)?.canAccessAllPublicTeams === false
  ) {
    const affected = listLinearInstallationSessions(db, administration);
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
  let commands: LinearCommand[] = [];
  const stopped = immediate(db, () => {
    const affected = new Set(linearSessionsForUndelegatedIssue(db, undelegation));
    commands = cancelSessions(db, affected, undelegation.createdAtMs);
    return affected;
  });
  await deliver(commands, stopped, options);
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
 * pull request unless a merge was recorded for it by then.
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
  const now = options.now?.() ?? Date.now();
  const response = ISSUE_CLOSED_RESPONSE[closed.stateType];
  const status = closed.stateType === "completed" ? "Done" : "Canceled";
  const commands: LinearCommand[] = [];
  const sessions = new Set<string>();
  const results = immediate(db, () => {
    const outcomes: ClosedIssueTask[] = [];
    for (const row of openIssueTasks(db, closed)) {
      const label = `item ${row.identifier}`;
      if (row.state === "merge_queue" && getConfirmedRemoteMerge(db, row.id) !== null) {
        if (completeMergedItem(db, { itemId: row.id, now }) !== null) {
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
      if (!applyLinearCommand(db, command, now, response).applied)
        throw new Error(`Could not close Linear task ${row.id}`);
      journal(`${label} cancelled: its Linear issue moved to ${status} outside this task`);
      commands.push(command);
      if (row.sessionKey !== null) sessions.add(row.sessionKey);
      outcomes.push({ itemId: row.id, outcome: "cancelled" });
    }
    return outcomes;
  });
  await deliver(commands, sessions, options);
  return results;
}

function openIssueTasks(
  db: Database,
  closed: LinearIssueClosed,
): { id: string; identifier: string; state: WorkItemState; sessionKey: string | null }[] {
  return db
    .query<
      {
        id: string;
        identifier: string;
        state: WorkItemState;
        sessionKey: string | null;
        organizationId: string | null;
      },
      [string, number]
    >(
      `SELECT w.id, w.linear_identifier AS identifier, w.state, w.session_key AS sessionKey,
              s.organization_id AS organizationId
       FROM work_item w LEFT JOIN linear_session s ON s.session_id = w.session_key
       WHERE w.linear_issue_id = ? AND w.created_at <= ?
       ORDER BY w.created_at, w.id`,
    )
    .all(closed.issueId, closed.closedAtMs)
    .filter(
      (row) =>
        !isTerminalWorkItemState(row.state) &&
        (closed.organizationId === null ||
          row.organizationId === null ||
          row.organizationId === closed.organizationId),
    );
}

function cancelSessions(
  db: Database,
  affected: ReadonlySet<string>,
  requestedAt: number,
): LinearCommand[] {
  for (const id of affected)
    if (getLinearSession(db, id)?.stoppedAt == null)
      advanceLinearSessionGeneration(db, id, { stop: true, now: requestedAt });
  const commands: LinearCommand[] = [];
  for (const item of listWorkItems(db)) {
    const sessionId = item.sessionKey;
    if (sessionId === null || !affected.has(sessionId) || isTerminalWorkItemState(item.state))
      continue;
    const command: LinearCommand = {
      type: "cancel",
      itemId: item.id,
      source: "linear",
      requestedAt,
    };
    if (!applyLinearCommand(db, command).applied)
      throw new Error(`Could not cancel Linear task ${item.id}`);
    commands.push(command);
  }
  return commands;
}

async function deliver(
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
    failures.push(error);
  }
  const results = await Promise.allSettled(
    [...sessions].map(async (id) => options.interrupt?.(id)),
  );
  for (const result of results) if (result.status === "rejected") failures.push(result.reason);
  if (failures.length > 0) throw failures[0];
}
