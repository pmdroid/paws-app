import type { Database } from "bun:sqlite";
import { and, asc, eq, inArray, isNotNull, isNull, lt, sql, type SQL } from "drizzle-orm";
import { ensureLinearSession } from "./linear-sessions";
import { changes, orm } from "./orm";
import {
  linearAccessEvent,
  linearAppRevocation,
  linearInstallationPermission,
  linearSession,
  linearTeamAccess,
  outbox,
} from "./schema";
import { immediate } from "./tx";

export type LinearInstallationScope = {
  organizationId: string;
  oauthClientId: string;
  appUserId: string;
};

export type LinearSessionAccess = "allowed" | "revoked" | "team_removed" | "unknown";

export function hasLinearNotification(
  db: Database,
  input: LinearInstallationScope & { notificationId: string; createdAtMs: number },
): boolean {
  return (
    orm(db)
      .select({ one: sql`1` })
      .from(linearAccessEvent)
      .where(eq(linearAccessEvent.eventKey, notificationKey(input)))
      .get() !== undefined
  );
}

export function recordLinearNotification(
  db: Database,
  input: LinearInstallationScope & { notificationId: string; createdAtMs: number },
): boolean {
  return recordEvent(db, notificationKey(input), input.createdAtMs);
}

function notificationKey(
  input: LinearInstallationScope & { notificationId: string; createdAtMs: number },
): string {
  validate(input.organizationId, input.oauthClientId, input.appUserId, input.notificationId);
  validateTime(input.createdAtMs);
  return JSON.stringify([
    "notification",
    input.organizationId,
    input.oauthClientId,
    input.appUserId,
    input.notificationId,
  ]);
}

export function dropLinearSessionDeliveries(db: Database, sessionId: string): void {
  orm(db)
    .update(outbox)
    .set({ status: "dropped", error: "Linear installation access was revoked." })
    .where(
      and(
        eq(outbox.target, "linear"),
        eq(outbox.orderingKey, sessionId),
        inArray(outbox.status, ["pending", "dead"]),
      ),
    )
    .run();
}

export function recordLinearInstallation(
  db: Database,
  input: LinearInstallationScope & {
    sessionId: string;
    teamId: string | null;
    observedAtMs: number;
  },
): void {
  validate(input.organizationId, input.oauthClientId, input.appUserId, input.sessionId);
  validateTime(input.observedAtMs);
  if (input.teamId !== null) validate(input.teamId);
  immediate(db, () => {
    ensureLinearSession(db, input);
    const current = orm(db)
      .select({
        oauthClientId: linearSession.oauthClientId,
        teamId: linearSession.teamId,
        installationObservedAt: linearSession.installationObservedAt,
      })
      .from(linearSession)
      .where(eq(linearSession.sessionId, input.sessionId))
      .get()!;
    if (current.oauthClientId !== null && current.oauthClientId !== input.oauthClientId)
      throw new Error("Linear session OAuth client ownership changed");
    if (current.installationObservedAt !== null) {
      if (current.installationObservedAt > input.observedAtMs) return;
      if (current.installationObservedAt === input.observedAtMs) {
        if (input.teamId === null) return;
        if (current.teamId !== null && current.teamId !== input.teamId)
          throw new Error("Linear session team observations conflict");
      }
    }
    orm(db)
      .update(linearSession)
      .set({
        oauthClientId: input.oauthClientId,
        teamId: input.teamId,
        installationObservedAt: input.observedAtMs,
      })
      .where(eq(linearSession.sessionId, input.sessionId))
      .run();
  });
}

export function revokeLinearInstallation(
  db: Database,
  input: { eventKey: string; organizationId: string; oauthClientId: string; createdAtMs: number },
): string[] {
  validate(input.eventKey, input.organizationId, input.oauthClientId);
  validateTime(input.createdAtMs);
  return immediate(db, () => {
    if (!recordEvent(db, input.eventKey, input.createdAtMs)) return [];
    const changed = changes(
      orm(db)
        .insert(linearAppRevocation)
        .values({
          organizationId: input.organizationId,
          oauthClientId: input.oauthClientId,
          revokedAt: input.createdAtMs,
        })
        .onConflictDoUpdate({
          target: [linearAppRevocation.organizationId, linearAppRevocation.oauthClientId],
          set: {
            revokedAt: sql`MAX(${linearAppRevocation.revokedAt}, excluded.revoked_at)`,
            generation: sql`${linearAppRevocation.generation} + 1`,
            restoredAfter: null,
            restoredCredentialFingerprint: null,
          },
          setWhere: sql`${linearAppRevocation.restoredAfter} IS NULL
          OR excluded.revoked_at >= ${linearAppRevocation.restoredAfter}`,
        }),
    );
    if (changed === 0) return [];
    return sessions(
      db,
      and(
        eq(linearSession.organizationId, input.organizationId),
        eq(linearSession.oauthClientId, input.oauthClientId),
      ),
    );
  });
}

export function changeLinearTeamAccess(
  db: Database,
  input: LinearInstallationScope & {
    eventKey: string;
    createdAtMs: number;
    canAccessAllPublicTeams: boolean;
    addedTeamIds: readonly string[];
    removedTeamIds: readonly string[];
  },
): string[] {
  validate(input.eventKey, input.organizationId, input.oauthClientId, input.appUserId);
  validateTime(input.createdAtMs);
  validate(...input.addedTeamIds, ...input.removedTeamIds);
  if (input.addedTeamIds.some((team) => input.removedTeamIds.includes(team)))
    throw new Error("Linear team access change contradicts itself");
  return immediate(db, () => {
    if (!recordEvent(db, input.eventKey, input.createdAtMs)) return [];
    const previous = getLinearInstallationPermissions(db, input);
    const permission = linearInstallationPermission;
    const updated = changes(
      orm(db)
        .insert(permission)
        .values({
          organizationId: input.organizationId,
          oauthClientId: input.oauthClientId,
          appUserId: input.appUserId,
          allPublicTeams: input.canAccessAllPublicTeams ? 1 : 0,
          observedAt: input.createdAtMs,
        })
        .onConflictDoUpdate({
          target: [permission.organizationId, permission.oauthClientId, permission.appUserId],
          set: {
            allPublicTeams: sql`excluded.all_public_teams`,
            observedAt: sql`excluded.observed_at`,
          },
          setWhere: sql`${permission.observedAt} < excluded.observed_at
          OR (${permission.observedAt} = excluded.observed_at AND excluded.all_public_teams = 0)`,
        }),
    );
    const installation = and(
      eq(linearSession.organizationId, input.organizationId),
      eq(linearSession.oauthClientId, input.oauthClientId),
      eq(linearSession.appUserId, input.appUserId),
    );
    const affected = new Set<string>();
    if (updated && !input.canAccessAllPublicTeams && previous?.canAccessAllPublicTeams !== false)
      for (const session of sessions(db, installation)) affected.add(session);
    for (const [teams, allowed] of [
      [input.addedTeamIds, 1],
      [input.removedTeamIds, 0],
    ] as const) {
      for (const teamId of new Set(teams)) {
        const changed = changes(
          orm(db)
            .insert(linearTeamAccess)
            .values({
              organizationId: input.organizationId,
              oauthClientId: input.oauthClientId,
              appUserId: input.appUserId,
              teamId,
              allowed,
              observedAt: input.createdAtMs,
            })
            .onConflictDoUpdate({
              target: [
                linearTeamAccess.organizationId,
                linearTeamAccess.oauthClientId,
                linearTeamAccess.appUserId,
                linearTeamAccess.teamId,
              ],
              set: { allowed: sql`excluded.allowed`, observedAt: sql`excluded.observed_at` },
              setWhere: sql`${linearTeamAccess.observedAt} < excluded.observed_at
              OR (${linearTeamAccess.observedAt} = excluded.observed_at AND excluded.allowed = 0)`,
            }),
        );
        if (allowed === 0 && changed)
          for (const session of sessions(db, and(installation, eq(linearSession.teamId, teamId))))
            affected.add(session);
      }
    }
    return [...affected].sort();
  });
}

export function listLinearInstallationSessions(
  db: Database,
  scope: Pick<LinearInstallationScope, "organizationId" | "oauthClientId"> & { appUserId?: string },
): string[] {
  return sessions(
    db,
    and(
      eq(linearSession.organizationId, scope.organizationId),
      eq(linearSession.oauthClientId, scope.oauthClientId),
      scope.appUserId === undefined ? undefined : eq(linearSession.appUserId, scope.appUserId),
    ),
  );
}

export function getLinearInstallationPermissions(
  db: Database,
  scope: LinearInstallationScope,
): { canAccessAllPublicTeams: boolean; observedAtMs: number } | null {
  const permission = linearInstallationPermission;
  const row = orm(db)
    .select({ allPublicTeams: permission.allPublicTeams, observedAt: permission.observedAt })
    .from(permission)
    .where(
      and(
        eq(permission.organizationId, scope.organizationId),
        eq(permission.oauthClientId, scope.oauthClientId),
        eq(permission.appUserId, scope.appUserId),
      ),
    )
    .get();
  return row
    ? { canAccessAllPublicTeams: row.allPublicTeams === 1, observedAtMs: row.observedAt }
    : null;
}

export function getLinearSessionInstallation(
  db: Database,
  sessionId: string,
): (LinearInstallationScope & { teamId: string | null; observedAtMs: number }) | null {
  const row = orm(db)
    .select({
      organizationId: linearSession.organizationId,
      oauthClientId: linearSession.oauthClientId,
      appUserId: linearSession.appUserId,
      teamId: linearSession.teamId,
      observedAtMs: linearSession.installationObservedAt,
    })
    .from(linearSession)
    .where(eq(linearSession.sessionId, sessionId))
    .get();
  if (!row?.organizationId || !row.oauthClientId || !row.appUserId || row.observedAtMs === null)
    return null;
  return {
    organizationId: row.organizationId,
    oauthClientId: row.oauthClientId,
    appUserId: row.appUserId,
    teamId: row.teamId,
    observedAtMs: row.observedAtMs,
  };
}

export function getLinearSessionAccess(db: Database, sessionId: string): LinearSessionAccess {
  const installation = getLinearSessionInstallation(db, sessionId);
  if (installation === null) return "unknown";
  if (unrestored(db, installation.organizationId, installation.oauthClientId)) return "revoked";
  if (installation.teamId === null) return "unknown";
  return getLinearTeamAccess(db, { ...installation, teamId: installation.teamId }) === "removed"
    ? "team_removed"
    : "allowed";
}

export function getLinearTeamAccess(
  db: Database,
  input: LinearInstallationScope & { teamId: string },
): "allowed" | "removed" | "unknown" {
  const team = orm(db)
    .select({ allowed: linearTeamAccess.allowed })
    .from(linearTeamAccess)
    .where(
      and(
        eq(linearTeamAccess.organizationId, input.organizationId),
        eq(linearTeamAccess.oauthClientId, input.oauthClientId),
        eq(linearTeamAccess.appUserId, input.appUserId),
        eq(linearTeamAccess.teamId, input.teamId),
      ),
    )
    .get();
  return team === undefined ? "unknown" : team.allowed === 0 ? "removed" : "allowed";
}

export function isLinearAppRevoked(
  db: Database,
  input: { oauthClientId: string | null; appUserId: string | null },
): boolean {
  const client =
    input.oauthClientId === null ? undefined : eq(linearSession.oauthClientId, input.oauthClientId);
  const scopes =
    input.appUserId === null
      ? []
      : orm(db)
          .selectDistinct({
            organizationId: sql<string>`${linearSession.organizationId}`,
            oauthClientId: sql<string>`${linearSession.oauthClientId}`,
          })
          .from(linearSession)
          .where(
            and(
              eq(linearSession.appUserId, input.appUserId),
              isNotNull(linearSession.organizationId),
              isNotNull(linearSession.oauthClientId),
              client,
            ),
          )
          .all();
  if (scopes.length > 0)
    return scopes.some((scope) => unrestored(db, scope.organizationId, scope.oauthClientId));
  return (
    orm(db)
      .select({ one: sql`1` })
      .from(linearAppRevocation)
      .where(
        and(
          input.oauthClientId === null
            ? undefined
            : eq(linearAppRevocation.oauthClientId, input.oauthClientId),
          isNull(linearAppRevocation.restoredAfter),
        ),
      )
      .limit(1)
      .get() !== undefined
  );
}

function unrestored(db: Database, organizationId: string, oauthClientId: string): boolean {
  return (
    orm(db)
      .select({ one: sql`1` })
      .from(linearAppRevocation)
      .where(
        and(
          eq(linearAppRevocation.organizationId, organizationId),
          eq(linearAppRevocation.oauthClientId, oauthClientId),
          isNull(linearAppRevocation.restoredAfter),
        ),
      )
      .get() !== undefined
  );
}

export type LinearInstallationRevocation = {
  organizationId: string;
  oauthClientId: string;
  generation: number;
  revokedAtMs: number;
  appUserIds: string[];
};

export function listLinearInstallationRevocations(db: Database): LinearInstallationRevocation[] {
  return orm(db)
    .select()
    .from(linearAppRevocation)
    .where(isNull(linearAppRevocation.restoredAfter))
    .orderBy(asc(linearAppRevocation.organizationId), asc(linearAppRevocation.oauthClientId))
    .all()
    .map((row) => ({
      organizationId: row.organizationId,
      oauthClientId: row.oauthClientId,
      generation: row.generation,
      revokedAtMs: row.revokedAt,
      appUserIds: orm(db)
        .selectDistinct({ appUserId: sql<string>`${linearSession.appUserId}` })
        .from(linearSession)
        .where(
          and(
            eq(linearSession.organizationId, row.organizationId),
            eq(linearSession.oauthClientId, row.oauthClientId),
            isNotNull(linearSession.appUserId),
          ),
        )
        .orderBy(asc(linearSession.appUserId))
        .all()
        .map((user) => user.appUserId),
    }));
}

export function restoreLinearInstallation(
  db: Database,
  input: LinearInstallationScope & {
    generation: number;
    grantStartedAtMs: number;
    credentialFingerprint: string;
  },
): boolean {
  validate(input.organizationId, input.oauthClientId, input.appUserId, input.credentialFingerprint);
  validateTime(input.grantStartedAtMs);
  if (!Number.isSafeInteger(input.generation) || input.generation < 1)
    throw new Error("Linear revocation generation is invalid");
  return immediate(db, () => {
    const restored =
      changes(
        orm(db)
          .update(linearAppRevocation)
          .set({
            restoredAfter: input.grantStartedAtMs,
            restoredCredentialFingerprint: input.credentialFingerprint,
          })
          .where(
            and(
              eq(linearAppRevocation.organizationId, input.organizationId),
              eq(linearAppRevocation.oauthClientId, input.oauthClientId),
              eq(linearAppRevocation.generation, input.generation),
              isNull(linearAppRevocation.restoredAfter),
              lt(linearAppRevocation.revokedAt, input.grantStartedAtMs),
            ),
          ),
      ) === 1;
    if (restored)
      for (const sessionId of sessions(
        db,
        and(
          eq(linearSession.organizationId, input.organizationId),
          eq(linearSession.oauthClientId, input.oauthClientId),
        ),
      ))
        dropLinearSessionDeliveries(db, sessionId);
    return restored;
  });
}

function recordEvent(db: Database, eventKey: string, createdAtMs: number): boolean {
  return (
    changes(
      orm(db)
        .insert(linearAccessEvent)
        .values({ eventKey, createdAt: createdAtMs })
        .onConflictDoNothing(),
    ) === 1
  );
}

function sessions(db: Database, predicate: SQL | undefined): string[] {
  return orm(db)
    .select({ sessionId: linearSession.sessionId })
    .from(linearSession)
    .where(predicate)
    .orderBy(asc(linearSession.sessionId))
    .all()
    .map((row) => row.sessionId);
}

function validate(...values: string[]): void {
  if (values.some((value) => value.trim() === ""))
    throw new Error("Linear access identity is missing");
}

function validateTime(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Linear access timestamp is invalid");
}
