import type { Database } from "bun:sqlite";
import type { LinearCommand } from "../core";
import {
  applyLinearCommand,
  changeLinearTeamAccess,
  advanceLinearSessionGeneration,
  dropLinearSessionDeliveries,
  getLinearSessionAccess,
  getLinearSession,
  getLinearInstallationPermissions,
  listLinearInstallationSessions,
  immediate,
  hasLinearNotification,
  linearSessionsForDelegatedTeams,
  listWorkItems,
  recordLinearNotification,
  revokeLinearInstallation,
} from "../db";
import {
  parseLinearAdministration,
  type AcceptedLinearEvent,
  type LinearAdministration,
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
  const interrupted = new Set<string>();
  const commands: LinearCommand[] = [];
  immediate(db, () => {
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
    for (const id of affected) {
      if (getLinearSession(db, id)?.stoppedAt == null)
        advanceLinearSessionGeneration(db, id, { stop: true, now: administration.createdAtMs });
      interrupted.add(id);
    }
    for (const item of listWorkItems(db)) {
      const sessionId = item.sessionKey;
      if (
        sessionId === null ||
        !affected.has(sessionId) ||
        ["cancelled", "completed", "merged"].includes(item.state)
      )
        continue;
      const command: LinearCommand = {
        type: "cancel",
        itemId: item.id,
        source: "linear",
        requestedAt: administration.createdAtMs,
      };
      if (!applyLinearCommand(db, command).applied)
        throw new Error(`Could not cancel Linear task ${item.id}`);
      commands.push(command);
    }
    if (administration.kind === "revoked")
      for (const id of affected) dropLinearSessionDeliveries(db, id);
  });
  const failures: unknown[] = [];
  try {
    for (const command of commands) options.notify(command);
  } catch (error) {
    failures.push(error);
  }
  const results = await Promise.allSettled(
    [...interrupted].map(async (id) => options.interrupt?.(id)),
  );
  for (const result of results) if (result.status === "rejected") failures.push(result.reason);
  if (failures.length > 0) throw failures[0];
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
